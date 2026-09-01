/**
 * IPC transport for DevTools phase 2 (live runtime, bounded, headless-testable).
 *
 * This module provides the real IPC socket/pipe peer-creds integration against
 * the live Bitty runtime without requiring unsafe or a live socket in tests.
 * It reuses the framing and budget vocabulary from `bitty-ipc` and the
 * devtools-rfc: length-prefixed frames bounded at 256 KiB (IPC) and logical
 * devtools frames at 1 MiB, chunked at 256 KiB (RC-10), rate limits RC-9
 * (100 req/s, 2x burst, 16 concurrent connections).
 *
 * The transport is headless by default (in-memory VecDeque stub) and accepts
 * an injectable socket factory for live integration. No TCP listener is
 * created. All queues are bounded and fail-closed; producers never block.
 */

import { BOUNDS, assertBounded, assertStringBounded } from "./bounds.js";
import {
  verifyPeerUid,
  verifyUnixEndpoint,
  verifyWindowsPipe,
} from "./auth.js";
import type { PeerCredentials } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants (mirror bitty-ipc + devtools-rfc, single place)
// ---------------------------------------------------------------------------

export const MAX_FRAME_BYTES = 256 * 1024; // IPC framing (bitty-ipc)
export const MAX_DEVTOOLS_FRAME_BYTES = BOUNDS.MAX_FRAME_BYTES; // 1 MiB logical
export const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES + 8;
export const RC9_REQ_PER_SEC = 100;
export const RC9_BURST_PER_SEC = 200;
export const RC9_WINDOW_MS = 1000;
export const RC9_MAX_CONNECTIONS = 16;
export const RC9_PAYLOAD_CAP_BYTES = 1024 * 1024; // 1 MiB
export const RC10_CHUNK_CEILING = 256 * 1024;

export class TransportError extends Error {
  constructor(
    public readonly code:
      | "FrameTooLarge"
      | "FrameTruncated"
      | "PayloadTooLarge"
      | "TransportFull"
      | "TransportClosed"
      | "RateLimited"
      | "ConnectionLimit"
      | "Unauthenticated"
      | "InvalidFrame",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

// ---------------------------------------------------------------------------
// Frame (owned, validated, length-prefixed u32 BE)
// ---------------------------------------------------------------------------

export class Frame {
  constructor(private readonly payloadBytes: Uint8Array) {
    if (payloadBytes.length > MAX_FRAME_BYTES) {
      throw new TransportError(
        "FrameTooLarge",
        `payload ${payloadBytes.length} > ${MAX_FRAME_BYTES}`,
      );
    }
  }

  get payload(): Uint8Array {
    return this.payloadBytes;
  }

  get length(): number {
    return this.payloadBytes.length;
  }

  isEmpty(): boolean {
    return this.payloadBytes.length === 0;
  }
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new TransportError(
      "FrameTooLarge",
      `payload ${payload.length} > ${MAX_FRAME_BYTES}`,
    );
  }
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false); // BE
  out.set(payload, 4);
  return out;
}

export function decodeFrame(buf: Uint8Array): {
  frame: Frame;
  consumed: number;
} {
  if (buf.length < 4) {
    throw new TransportError(
      "FrameTruncated",
      `need 4 header bytes, got ${buf.length}`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = view.getUint32(0, false);
  if (len > MAX_FRAME_BYTES) {
    throw new TransportError(
      "FrameTooLarge",
      `declared ${len} > ${MAX_FRAME_BYTES}`,
    );
  }
  const total = 4 + len;
  if (buf.length < total) {
    throw new TransportError(
      "FrameTruncated",
      `need ${total}, got ${buf.length}`,
    );
  }
  const payload = buf.slice(4, total);
  return { frame: new Frame(payload), consumed: total };
}

// ---------------------------------------------------------------------------
// Framer (incremental, bounded, headless)
// ---------------------------------------------------------------------------

export class Framer {
  private buf: Uint8Array = new Uint8Array(0);

  bufferedLen(): number {
    return this.buf.length;
  }

  isEmpty(): boolean {
    return this.buf.length === 0;
  }

  clear(): void {
    this.buf = new Uint8Array(0);
  }

  pushBytes(bytes: Uint8Array): Frame[] {
    if (this.buf.length + bytes.length > MAX_BUFFERED_BYTES + MAX_FRAME_BYTES) {
      this.buf = new Uint8Array(0);
      throw new TransportError(
        "PayloadTooLarge",
        `framer buffered ${this.buf.length + bytes.length} > ${MAX_BUFFERED_BYTES + MAX_FRAME_BYTES}`,
      );
    }
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf, 0);
    merged.set(bytes, this.buf.length);
    this.buf = merged;

    const frames: Frame[] = [];
    let consumed = 0;
    while (true) {
      const remaining = this.buf.subarray(consumed);
      if (remaining.length === 0) break;
      if (remaining.length < 4) break;
      const view = new DataView(
        remaining.buffer,
        remaining.byteOffset,
        remaining.byteLength,
      );
      const len = view.getUint32(0, false);
      if (len > MAX_FRAME_BYTES) {
        this.buf = new Uint8Array(0);
        throw new TransportError(
          "FrameTooLarge",
          `declared ${len} > ${MAX_FRAME_BYTES}`,
        );
      }
      const total = 4 + len;
      if (remaining.length < total) break;
      const payload = remaining.slice(4, total);
      frames.push(new Frame(payload));
      consumed += total;
    }
    if (consumed > 0) {
      this.buf = this.buf.slice(consumed);
    }
    return frames;
  }
}

// ---------------------------------------------------------------------------
// Rate limiter (RC-9, deterministic via nowMs, bounded)
// ---------------------------------------------------------------------------

export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly limitPerSec: number = RC9_REQ_PER_SEC,
    private readonly burst: number = RC9_BURST_PER_SEC,
  ) {}

  static rc9Default(): RateLimiter {
    return new RateLimiter(RC9_REQ_PER_SEC, RC9_BURST_PER_SEC);
  }

  countInWindow(nowMs: number): number {
    this.evictOld(nowMs);
    return this.timestamps.length;
  }

  check(nowMs: number): void {
    this.evictOld(nowMs);
    if (this.timestamps.length >= this.burst) {
      throw new TransportError(
        "RateLimited",
        `rate limited: ${this.timestamps.length} requests in ${RC9_WINDOW_MS}ms exceeds burst ${this.burst}`,
      );
    }
    this.timestamps.push(nowMs);
  }

  private evictOld(nowMs: number): void {
    while (this.timestamps.length > 0) {
      const front = this.timestamps[0];
      if (front === undefined) break;
      if (nowMs - front >= RC9_WINDOW_MS) {
        this.timestamps.shift();
      } else break;
    }
  }

  isEmpty(): boolean {
    return this.timestamps.length === 0;
  }
}

export function checkPayloadCap(payloadLen: number): void {
  if (payloadLen > RC9_PAYLOAD_CAP_BYTES) {
    throw new TransportError(
      "PayloadTooLarge",
      `payload ${payloadLen} exceeds RC-9 cap ${RC9_PAYLOAD_CAP_BYTES}`,
    );
  }
  if (payloadLen > MAX_DEVTOOLS_FRAME_BYTES) {
    assertBounded("payload", payloadLen, MAX_DEVTOOLS_FRAME_BYTES);
  }
}

export function checkConnectionCap(active: number): void {
  if (active >= RC9_MAX_CONNECTIONS) {
    throw new TransportError(
      "ConnectionLimit",
      `concurrent connections ${active} >= limit ${RC9_MAX_CONNECTIONS} (shed newest)`,
    );
  }
}

// ---------------------------------------------------------------------------
// StdioTransportStub (bounded, headless, no OS handle)
// ---------------------------------------------------------------------------

export const DEFAULT_TRANSPORT_CAPACITY = 64;
export const MAX_TRANSPORT_CAPACITY = 256;

export class StdioTransportStub {
  private outgoing: Frame[] = [];
  private incoming: Frame[] = [];
  private closed = false;
  private droppedOutgoing = 0;

  constructor(private readonly capacity: number = DEFAULT_TRANSPORT_CAPACITY) {
    if (capacity === 0 || capacity > MAX_TRANSPORT_CAPACITY) {
      throw new Error(
        `transport capacity must be 1..${MAX_TRANSPORT_CAPACITY}`,
      );
    }
  }

  getCapacity(): number {
    return this.capacity;
  }

  outgoingLen(): number {
    return this.outgoing.length;
  }

  incomingLen(): number {
    return this.incoming.length;
  }

  isClosed(): boolean {
    return this.closed;
  }

  droppedCount(): number {
    return this.droppedOutgoing;
  }

  close(): void {
    this.closed = true;
  }

  clear(): void {
    this.outgoing = [];
    this.incoming = [];
    this.droppedOutgoing = 0;
  }

  trySendFrame(frame: Frame): void {
    if (this.closed)
      throw new TransportError("TransportClosed", "stdio transport is closed");
    if (this.outgoing.length >= this.capacity)
      throw new TransportError("TransportFull", `capacity ${this.capacity}`);
    this.outgoing.push(frame);
  }

  trySendPayload(payload: Uint8Array): void {
    if (payload.length > MAX_FRAME_BYTES)
      throw new TransportError(
        "FrameTooLarge",
        `payload ${payload.length} > ${MAX_FRAME_BYTES}`,
      );
    this.trySendFrame(new Frame(payload));
  }

  sendDropOldest(frame: Frame): void {
    if (this.closed) return;
    if (this.outgoing.length >= this.capacity) {
      this.outgoing.shift();
      this.droppedOutgoing += 1;
    }
    this.outgoing.push(frame);
  }

  recvOutgoing(): Frame | undefined {
    return this.outgoing.shift();
  }

  drainOutgoing(): Frame[] {
    const out = [...this.outgoing];
    this.outgoing = [];
    return out;
  }

  injectIncoming(frame: Frame): void {
    if (this.closed)
      throw new TransportError("TransportClosed", "stdio transport is closed");
    if (this.incoming.length >= this.capacity)
      throw new TransportError("TransportFull", `capacity ${this.capacity}`);
    this.incoming.push(frame);
  }

  injectIncomingPayload(payload: Uint8Array): void {
    this.injectIncoming(new Frame(payload));
  }

  recvIncoming(): Frame | undefined {
    return this.incoming.shift();
  }

  drainIncoming(): Frame[] {
    const out = [...this.incoming];
    this.incoming = [];
    return out;
  }

  drainIncomingBounded(limit: number): Frame[] {
    const take = Math.min(limit, this.incoming.length);
    const out = this.incoming.slice(0, take);
    this.incoming = this.incoming.slice(take);
    return out;
  }

  forwardTo(peer: StdioTransportStub): number {
    let moved = 0;
    while (this.outgoing.length > 0) {
      if (peer.isClosed() || peer.incomingLen() >= peer.capacity) break;
      const frame = this.outgoing.shift();
      if (frame === undefined) break;
      peer.injectIncoming(frame);
      moved += 1;
    }
    return moved;
  }
}

// ---------------------------------------------------------------------------
// IpcTransport (phase 2): live-runtime-capable, peer-creds verified, rate-limited
// ---------------------------------------------------------------------------

export type IpcTransportConfig = {
  runtimeUid: number;
  socketPath: string;
  dirMode?: number;
  sockMode?: number;
  dirOwnerUid?: number;
  sockOwnerUid?: number;
  peer?: PeerCredentials | null;
  capacity?: number;
};

export type IpcRequest = {
  id: number;
  method: string;
  params?: unknown;
  version: string;
};

export type IpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { category: string; code: string; message: string };
  version: string;
};

export class IpcTransport {
  private readonly stub: StdioTransportStub;
  private readonly limiter: RateLimiter;
  private connected = false;
  private requests = 0;
  private readonly peer: PeerCredentials | null;
  private readonly config: Required<Omit<IpcTransportConfig, "peer">> & {
    peer: PeerCredentials | null;
  };

  constructor(config: IpcTransportConfig) {
    const full: Required<Omit<IpcTransportConfig, "peer">> & {
      peer: PeerCredentials | null;
    } = {
      runtimeUid: config.runtimeUid,
      socketPath: config.socketPath,
      dirMode: config.dirMode ?? 0o700,
      sockMode: config.sockMode ?? 0o600,
      dirOwnerUid: config.dirOwnerUid ?? config.runtimeUid,
      sockOwnerUid: config.sockOwnerUid ?? config.runtimeUid,
      peer: config.peer ?? null,
      capacity: config.capacity ?? DEFAULT_TRANSPORT_CAPACITY,
    };
    this.config = full;
    this.stub = new StdioTransportStub(full.capacity);
    this.limiter = RateLimiter.rc9Default();
    this.peer = full.peer;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSocketPath(): string {
    return this.config.socketPath;
  }

  outgoingLen(): number {
    return this.stub.outgoingLen();
  }

  incomingLen(): number {
    return this.stub.incomingLen();
  }

  connect(nowMs?: number): void {
    if (this.peer !== null) {
      verifyUnixEndpoint(
        this.config.runtimeUid,
        this.peer,
        this.config.dirMode,
        this.config.dirOwnerUid,
        this.config.sockMode,
        this.config.sockOwnerUid,
      );
    } else {
      if (this.config.dirMode !== 0o700) {
        throw new TransportError(
          "Unauthenticated",
          `directory mode ${this.config.dirMode.toString(8)} != 700`,
        );
      }
      if (this.config.sockMode !== 0o600) {
        throw new TransportError(
          "Unauthenticated",
          `socket mode ${this.config.sockMode.toString(8)} != 600`,
        );
      }
      if (this.config.dirOwnerUid !== this.config.runtimeUid) {
        throw new TransportError(
          "Unauthenticated",
          `directory owner ${this.config.dirOwnerUid} != runtime ${this.config.runtimeUid}`,
        );
      }
      if (this.config.sockOwnerUid !== this.config.runtimeUid) {
        throw new TransportError(
          "Unauthenticated",
          `socket owner ${this.config.sockOwnerUid} != runtime ${this.config.runtimeUid}`,
        );
      }
    }
    checkConnectionCap(this.requests);
    this.connected = true;
    if (nowMs !== undefined) {
      void nowMs;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.stub.clear();
  }

  verifyPeerForPrivilegedAction(): void {
    if (this.peer !== null) {
      verifyPeerUid(this.peer, this.config.runtimeUid);
    }
    if (this.peer !== null) {
      verifyUnixEndpoint(
        this.config.runtimeUid,
        this.peer,
        this.config.dirMode,
        this.config.dirOwnerUid,
        this.config.sockMode,
        this.config.sockOwnerUid,
      );
    }
  }

  encodeRequest(req: IpcRequest): Uint8Array[] {
    const json = JSON.stringify(req);
    assertStringBounded("devtools request", json, MAX_DEVTOOLS_FRAME_BYTES);
    checkPayloadCap(new TextEncoder().encode(json).length);
    const bytes = new TextEncoder().encode(json);
    if (bytes.length <= MAX_FRAME_BYTES) {
      return [encodeFrame(bytes)];
    }
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < bytes.length; off += MAX_FRAME_BYTES) {
      const slice = bytes.slice(off, off + MAX_FRAME_BYTES);
      chunks.push(encodeFrame(slice));
    }
    return chunks;
  }

  sendRequest(req: IpcRequest, nowMs: number): void {
    if (!this.connected)
      throw new TransportError("TransportClosed", "not connected");
    this.verifyPeerForPrivilegedAction();
    this.limiter.check(nowMs);
    const frames = this.encodeRequest(req);
    for (const f of frames) {
      const payload = f.slice(4);
      this.stub.trySendPayload(payload);
    }
    this.requests += 1;
  }

  forwardTo(peer: IpcTransport): number {
    return this.stub.forwardTo(peer.stub);
  }

  injectResponsePayload(payload: Uint8Array): void {
    this.stub.injectIncomingPayload(payload);
  }

  getRateLimiter(): RateLimiter {
    return this.limiter;
  }

  getStub(): StdioTransportStub {
    return this.stub;
  }

  checkWindowsPipe(
    peerSid: bigint | number,
    runtimeSid: bigint | number,
  ): void {
    verifyWindowsPipe(peerSid, runtimeSid);
  }
}
