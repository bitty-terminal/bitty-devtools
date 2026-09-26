import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Framer,
  IpcTransport,
  StdioTransportStub,
  TransportError,
  checkPayloadCap,
  decodeFrame,
  encodeFrame,
  MAX_BUFFERED_BYTES,
  MAX_FRAME_BYTES,
  RC9_PAYLOAD_CAP_BYTES,
  RC10_CHUNK_CEILING,
} from "../src/transport.js";
import { chunkText } from "../src/protocol.js";

const SEED_DIR = join(import.meta.dir, "fixtures", "fuzz", "framer-seeds");

const LOCAL_TARGET_BUDGET_MS = 60_000;
const LOCAL_RSS_CAP_BYTES = 256 * 1024 * 1024;
const SUITE_START_MS = Date.now();

type OracleVector = {
  id: string;
  target: string;
  kind: string;
  inputHex?: string;
  wireHex?: string;
  feed?: { splits?: number[]; trickleBytes?: number };
  build?: { payloadLen?: number; fillByte?: number; jsonLen?: number };
  input?: string;
  limitBytes?: number;
  note?: string;
  expect: Record<string, unknown>;
};

type Oracle = {
  manifestVersion: number;
  constants: Record<string, number>;
  vectors: OracleVector[];
};

function loadOracle(): Oracle {
  const raw = readFileSync(join(SEED_DIR, "vectors.json"), "utf8");
  return JSON.parse(raw) as Oracle;
}

function loadSeed(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SEED_DIR, name)));
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function headerOnly(declaredLen: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, declaredLen, false);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function fillBytes(len: number, byte: number): Uint8Array {
  return new Uint8Array(len).fill(byte);
}

function splitFeed(framer: Framer, wire: Uint8Array, at: number): void {
  const first = framer.pushBytes(wire.slice(0, at));
  expect(first.length).toBe(0);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof TransportError) return error.code;
    throw error;
  }
  return null;
}

function expectFailClosedP0(
  bytes: Uint8Array,
  code: "FrameTooLarge" | "PayloadTooLarge",
): void {
  const framer = new Framer();
  let frames: ReturnType<Framer["pushBytes"]> | null = null;
  let thrown: unknown = null;
  try {
    frames = framer.pushBytes(bytes);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TransportError);
  expect((thrown as TransportError).code).toBe(code);
  expect(frames).toBeNull();
  expect(framer.isEmpty()).toBe(true);
  expect(framer.bufferedLen()).toBe(0);
  const ok = framer.pushBytes(encodeFrame(new TextEncoder().encode("ok")));
  expect(ok.length).toBe(1);
  expect(new TextDecoder().decode(ok[0]!.payload)).toBe("ok");
}

function vectorById(oracle: Oracle, id: string): OracleVector {
  const found = oracle.vectors.find((v) => v.id === id);
  expect(found).toBeDefined();
  return found!;
}

function requestOfJsonLen(total: number): {
  id: number;
  method: string;
  params: { pad: string };
  version: string;
} {
  const head = '{"id":1,"method":"bitty.debug/listPlugins","params":{"pad":"';
  const tail = '"},"version":"1.0"}';
  const padLen = total - head.length - tail.length;
  expect(padLen).toBeGreaterThan(0);
  return {
    id: 1,
    method: "bitty.debug/listPlugins",
    params: { pad: "a".repeat(padLen) },
    version: "1.0",
  };
}

function requestJsonBytes(req: {
  id: number;
  method: string;
  params: { pad: string };
  version: string;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}

describe("framer fuzz smoke oracle", () => {
  test("oracle manifest version and shared constants", () => {
    const oracle = loadOracle();
    expect(oracle.manifestVersion).toBe(1);
    expect(oracle.constants["maxFrameBytes"]).toBe(MAX_FRAME_BYTES);
    expect(oracle.constants["maxFrameBytes"]).toBe(256 * 1024);
    expect(oracle.constants["maxBufferedBytes"]).toBe(MAX_BUFFERED_BYTES);
    expect(oracle.constants["framerLimitBytes"]).toBe(
      MAX_BUFFERED_BYTES + MAX_FRAME_BYTES,
    );
    expect(oracle.constants["rc9PayloadCapBytes"]).toBe(RC9_PAYLOAD_CAP_BYTES);
    expect(oracle.constants["rc9PayloadCapBytes"]).toBe(1024 * 1024);
    expect(oracle.constants["rc10ChunkBytes"]).toBe(RC10_CHUNK_CEILING);
    expect(MAX_FRAME_BYTES).toBe(262144);
    expect(MAX_BUFFERED_BYTES).toBe(262152);
  });

  test("checked-in seed files are present and benign", () => {
    expect(loadSeed("empty.bin").length).toBe(0);
    expect(new TextDecoder().decode(loadSeed("hello.bin"))).toBe("hello");
    expect(toHex(loadSeed("emoji.bin"))).toBe("f09f9880");
    expect(toHex(loadSeed("cjk.bin"))).toBe("e697a5e69cace8aa9e");
    expect(toHex(loadSeed("combining.bin"))).toBe("65cc81");
    const oracle = loadOracle();
    for (const id of ["V01", "V06", "V14", "Q05", "C01", "Q03"]) {
      expect(oracle.vectors.some((v) => v.id === id)).toBe(true);
    }
  });
});

describe("T1 framer pushBytes", () => {
  test("V01 empty push emits nothing and stays empty", () => {
    const oracle = loadOracle();
    const input = fromHex(vectorById(oracle, "V01").inputHex!);
    expect(input.length).toBe(0);
    const framer = new Framer();
    expect(framer.pushBytes(input).length).toBe(0);
    expect(framer.isEmpty()).toBe(true);
  });

  test("V02 zero-length frame decodes to one empty payload", () => {
    const oracle = loadOracle();
    const input = fromHex(vectorById(oracle, "V02").inputHex!);
    const framer = new Framer();
    const frames = framer.pushBytes(input);
    expect(frames.length).toBe(1);
    expect(frames[0]!.payload.length).toBe(0);
    expect(framer.isEmpty()).toBe(true);
  });

  test("V03 V04 V05 1-3B header splits retain then decode hello", () => {
    const oracle = loadOracle();
    for (const [id, at] of [
      ["V03", 1],
      ["V04", 2],
      ["V05", 3],
    ] as const) {
      const wire = fromHex(vectorById(oracle, id).wireHex!);
      const framer = new Framer();
      splitFeed(framer, wire, at);
      expect(framer.bufferedLen()).toBe(at);
      const frames = framer.pushBytes(wire.slice(at));
      expect(frames.length).toBe(1);
      expect(new TextDecoder().decode(frames[0]!.payload)).toBe("hello");
      expect(framer.isEmpty()).toBe(true);
    }
  });

  test("V06 1-byte trickle emits exactly one frame at the end", () => {
    const oracle = loadOracle();
    const wire = fromHex(vectorById(oracle, "V06").wireHex!);
    const framer = new Framer();
    let emitted = 0;
    for (let i = 0; i < wire.length; i += 1) {
      const frames = framer.pushBytes(wire.slice(i, i + 1));
      emitted += frames.length;
      if (i < wire.length - 1) expect(frames.length).toBe(0);
      if (frames.length > 0) {
        expect(new TextDecoder().decode(frames[0]!.payload)).toBe("hi");
      }
    }
    expect(emitted).toBe(1);
    expect(framer.isEmpty()).toBe(true);
  });

  test("V07 coalesced frames decode in order with empty tail", () => {
    const oracle = loadOracle();
    const input = fromHex(vectorById(oracle, "V07").inputHex!);
    const framer = new Framer();
    const frames = framer.pushBytes(input);
    expect(frames.map((f) => new TextDecoder().decode(f.payload))).toEqual([
      "a",
      "bb",
      "ccc",
    ]);
    expect(framer.isEmpty()).toBe(true);
  });

  test("V08 truncated 2B header retains then decodes", () => {
    const oracle = loadOracle();
    const wire = fromHex(vectorById(oracle, "V08").wireHex!);
    const framer = new Framer();
    splitFeed(framer, wire, 2);
    expect(framer.bufferedLen()).toBe(2);
    const frames = framer.pushBytes(wire.slice(2));
    expect(frames.length).toBe(1);
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe("hello");
  });

  test("V09 body-short retains bounded tail then completes", () => {
    const oracle = loadOracle();
    const wire = fromHex(vectorById(oracle, "V09").wireHex!);
    const framer = new Framer();
    splitFeed(framer, wire, 9);
    expect(framer.bufferedLen()).toBe(9);
    expect(framer.bufferedLen()).toBeLessThanOrEqual(
      MAX_BUFFERED_BYTES + MAX_FRAME_BYTES,
    );
    const frames = framer.pushBytes(wire.slice(9));
    expect(frames.length).toBe(1);
    expect(frames[0]!.payload.length).toBe(16);
    expect(toHex(frames[0]!.payload)).toBe("68656c6c6f4141414141414141414141");
  });

  test("V10 declared 256KiB+1 header-only fails closed P0", () => {
    const oracle = loadOracle();
    const input = fromHex(vectorById(oracle, "V10").inputHex!);
    expect(input.length).toBe(4);
    expectFailClosedP0(input, "FrameTooLarge");
  });

  test("V11 declared u32max fails closed P0 without allocation", () => {
    const oracle = loadOracle();
    const input = fromHex(vectorById(oracle, "V11").inputHex!);
    expect(input.length).toBe(4);
    expectFailClosedP0(input, "FrameTooLarge");
  });

  test(
    "V12 over-buffer limit+1 fails closed P0",
    () => {
      const oracle = loadOracle();
      const build = vectorById(oracle, "V12").build!;
      const input = fillBytes(build["payloadLen"]!, build["fillByte"]!);
      expect(input.length).toBe(MAX_BUFFERED_BYTES + MAX_FRAME_BYTES + 1);
      expectFailClosedP0(input, "PayloadTooLarge");
    },
    LOCAL_TARGET_BUDGET_MS,
  );

  test("V13 mixed valid then oversize emits zero frames and recovers", () => {
    const oracle = loadOracle();
    const input = fromHex(vectorById(oracle, "V13").inputHex!);
    const framer = new Framer();
    let frames: ReturnType<Framer["pushBytes"]> | null = null;
    let thrown: unknown = null;
    try {
      frames = framer.pushBytes(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TransportError);
    expect((thrown as TransportError).code).toBe("FrameTooLarge");
    expect(frames).toBeNull();
    expect(framer.isEmpty()).toBe(true);
    expect(framer.bufferedLen()).toBe(0);
    const ok = framer.pushBytes(encodeFrame(new TextEncoder().encode("ok")));
    expect(ok.length).toBe(1);
  });

  test(
    "V16 V17 256KiB-1 and exact payloads round-trip in memory",
    () => {
      const oracle = loadOracle();
      for (const id of ["V16", "V17"]) {
        const build = vectorById(oracle, id).build!;
        const payload = fillBytes(build["payloadLen"]!, build["fillByte"]!);
        const wire = encodeFrame(payload);
        expect(wire.length).toBe(4 + payload.length);
        const framer = new Framer();
        const frames = framer.pushBytes(wire);
        expect(frames.length).toBe(1);
        expect(frames[0]!.payload).toEqual(payload);
        expect(framer.isEmpty()).toBe(true);
      }
    },
    LOCAL_TARGET_BUDGET_MS,
  );

  test("V14 V15 emoji and CJK body splits stay byte-identical", () => {
    const oracle = loadOracle();
    for (const [id, at] of [
      ["V14", 6],
      ["V15", 5],
    ] as const) {
      const vec = vectorById(oracle, id);
      const wire = fromHex(vec.wireHex!);
      const framer = new Framer();
      splitFeed(framer, wire, at);
      const frames = framer.pushBytes(wire.slice(at));
      expect(frames.length).toBe(1);
      expect(toHex(frames[0]!.payload)).toBe(
        String((vec.expect["framesHex"] as string[] | undefined)?.[0] ?? ""),
      );
    }
    const emojiPayload = loadSeed("emoji.bin");
    const emojiWire = encodeFrame(emojiPayload);
    const framer = new Framer();
    splitFeed(framer, emojiWire, 6);
    const frames = framer.pushBytes(emojiWire.slice(6));
    expect(frames.length).toBe(1);
    expect(frames[0]!.payload).toEqual(emojiPayload);
  });

  test("rejected input leaves queue and drop counters unchanged", () => {
    const stub = new StdioTransportStub();
    const beforeOut = stub.outgoingLen();
    const beforeDrop = stub.droppedCount();
    expect(codeOf(() => new Framer().pushBytes(headerOnly(0xffffffff)))).toBe(
      "FrameTooLarge",
    );
    expect(stub.outgoingLen()).toBe(beforeOut);
    expect(stub.droppedCount()).toBe(beforeDrop);
  });

  test("rejected send leaves transport outgoing length unchanged", () => {
    const transport = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/tmp/ctx-0074-fuzz-smoke-fixture.sock",
    });
    transport.connect();
    expect(transport.outgoingLen()).toBe(0);
    const req = requestOfJsonLen(1024 * 1024 + 1);
    expect(() => transport.sendRequest(req, 0)).toThrow();
    expect(transport.outgoingLen()).toBe(0);
  });
});

describe("T2 encode decode round-trip", () => {
  test("fixed payloads survive single-shot and split delivery", () => {
    const payloads: Uint8Array[] = [
      loadSeed("empty.bin"),
      loadSeed("hello.bin"),
      loadSeed("emoji.bin"),
      loadSeed("cjk.bin"),
      loadSeed("combining.bin"),
      fillBytes(1024, 0x41),
    ];
    for (const payload of payloads) {
      const wire = encodeFrame(payload);
      const { frame, consumed } = decodeFrame(wire);
      expect(consumed).toBe(4 + payload.length);
      expect(frame.payload).toEqual(payload);
      for (const at of [1, 3, 7]) {
        if (at >= wire.length) continue;
        const framer = new Framer();
        splitFeed(framer, wire, at);
        const frames = framer.pushBytes(wire.slice(at));
        expect(frames.length).toBe(1);
        expect(frames[0]!.payload).toEqual(payload);
      }
    }
  });

  test("oracle fixed frames match encoder output", () => {
    const oracle = loadOracle();
    const helloWire = encodeFrame(loadSeed("hello.bin"));
    expect(toHex(helloWire)).toBe(vectorById(oracle, "V03").wireHex!);
    expect(toHex(encodeFrame(loadSeed("empty.bin")))).toBe(
      vectorById(oracle, "V02").inputHex!,
    );
  });
});

describe("T3 chunkText boundary parity", () => {
  test("C01 C02 C03 fixed chunking matches the shared oracle", () => {
    const oracle = loadOracle();
    for (const id of ["C01", "C02", "C03"]) {
      const vec = vectorById(oracle, id);
      const chunks = chunkText(vec.input!, vec.limitBytes!);
      expect(chunks).toEqual(vec.expect["chunks"] as string[]);
      expect(chunks.join("")).toBe(vec.input!);
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        expect(encoder.encode(chunk).length).toBeLessThanOrEqual(
          vec.limitBytes!,
        );
      }
    }
  });

  test("C04 too-narrow limit for emoji fails in both twins", () => {
    const oracle = loadOracle();
    const vec = vectorById(oracle, "C04");
    expect(vec.expect["disposition"]).toBe("error");
    expect(() => chunkText(vec.input!, vec.limitBytes!)).toThrow(
      "cannot fit the next Unicode scalar",
    );
  });
});

describe("T4 chunking and inbound framing model", () => {
  test("Q01 256KiB exact request is a single chunk", () => {
    const oracle = loadOracle();
    const target = vectorById(oracle, "Q01").build!["jsonLen"]!;
    const transport = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/tmp/ctx-0074-fuzz-smoke-fixture.sock",
    });
    const req = requestOfJsonLen(target);
    expect(requestJsonBytes(req).length).toBe(target);
    const chunks = transport.encodeRequest(req);
    expect(chunks.length).toBe(1);
    const { frame, consumed } = decodeFrame(chunks[0]!);
    expect(consumed).toBe(chunks[0]!.length);
    expect(frame.payload.length).toBe(target);
  });

  test("Q02 256KiB+1 request splits into two bounded chunks", () => {
    const oracle = loadOracle();
    const target = vectorById(oracle, "Q02").build!["jsonLen"]!;
    const transport = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/tmp/ctx-0074-fuzz-smoke-fixture.sock",
    });
    const req = requestOfJsonLen(target);
    expect(requestJsonBytes(req).length).toBe(target);
    const chunks = transport.encodeRequest(req);
    expect(chunks.length).toBe(2);
    const parts: Uint8Array[] = [];
    for (const chunk of chunks) {
      const { frame } = decodeFrame(chunk);
      expect(frame.payload.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      parts.push(frame.payload);
    }
    expect(concatBytes(...parts)).toEqual(requestJsonBytes(req));
  });

  test(
    "Q03 1MiB exact request splits into four bounded chunks",
    () => {
      const oracle = loadOracle();
      const target = vectorById(oracle, "Q03").build!["jsonLen"]!;
      const transport = new IpcTransport({
        runtimeUid: 1000,
        socketPath: "/tmp/ctx-0074-fuzz-smoke-fixture.sock",
      });
      const req = requestOfJsonLen(target);
      expect(requestJsonBytes(req).length).toBe(target);
      const chunks = transport.encodeRequest(req);
      expect(chunks.length).toBe(4);
      const parts: Uint8Array[] = [];
      for (const chunk of chunks) {
        const { frame } = decodeFrame(chunk);
        expect(frame.payload.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
        parts.push(frame.payload);
      }
      expect(concatBytes(...parts)).toEqual(requestJsonBytes(req));
    },
    LOCAL_TARGET_BUDGET_MS,
  );

  test("Q04 1MiB+1 request is refused with PayloadTooLarge", () => {
    const oracle = loadOracle();
    const target = vectorById(oracle, "Q04").build!["jsonLen"]!;
    const transport = new IpcTransport({
      runtimeUid: 1000,
      socketPath: "/tmp/ctx-0074-fuzz-smoke-fixture.sock",
    });
    const req = requestOfJsonLen(target);
    const bytes = requestJsonBytes(req);
    expect(bytes.length).toBe(target);
    expect(() => transport.encodeRequest(req)).toThrow();
    expect(codeOf(() => checkPayloadCap(bytes.length))).toBe("PayloadTooLarge");
  });

  test("Q05 inbound failFraming model drops pending on mock bytes only", () => {
    const oracle = loadOracle();
    const input = fromHex(vectorById(oracle, "Q05").inputHex!);
    const inbound = new Framer();
    const pending: Uint8Array[] = [];
    let framingFailed = false;
    const onData = (data: Uint8Array): void => {
      if (framingFailed) return;
      try {
        for (const frame of inbound.pushBytes(data)) {
          pending.push(frame.payload.slice());
        }
      } catch {
        framingFailed = true;
        inbound.clear();
        pending.length = 0;
      }
    };
    const good = encodeFrame(new TextEncoder().encode("queued"));
    onData(good);
    expect(pending.length).toBe(1);
    onData(input);
    expect(framingFailed).toBe(true);
    expect(inbound.isEmpty()).toBe(true);
    expect(pending.length).toBe(0);
  });
});

describe("fuzz smoke budgets", () => {
  test("suite completes within the 60s local target budget", () => {
    expect(Date.now() - SUITE_START_MS).toBeLessThan(LOCAL_TARGET_BUDGET_MS);
  });

  test("resident set stays within the 256MiB local cap", () => {
    expect(process.memoryUsage.rss()).toBeLessThan(LOCAL_RSS_CAP_BYTES);
  });
});
