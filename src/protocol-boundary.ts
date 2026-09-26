/**
 * CTX-0080 live request admission boundary.
 *
 * CTX-0079 owns src/protocol.ts decoding, duplicate-key handling, payload
 * bounds, and redaction. This module owns only the live request admission
 * checks added by CTX-0080: supported protocol version, registered method,
 * exact scope, and the shared protocol encoder's size/shape validation.
 */

import {
  encodeRequest,
  isSupportedVersion,
  PROTOCOL_VERSION,
  ProtocolErrorImpl,
} from "./protocol.js";
import type { DebugScope, RequestFrame } from "./protocol.js";
import type { IpcRequest } from "./transport.js";

const METHOD_SCOPES = new Map<string, DebugScope>([
  ["bitty.debug/listPlugins", "debug.inspect"],
  ["bitty.debug/getPlugin", "debug.inspect"],
  ["bitty.debug/listSubscriptions", "debug.inspect"],
  ["bitty.debug/getBudgets", "debug.inspect"],
  ["bitty.debug/getQueueSnapshot", "debug.inspect"],
  ["bitty.debug/getSnapshot", "debug.inspect"],
  ["bitty.debug/listHandles", "debug.inspect"],
  ["bitty.debug/getGridText", "debug.inspect"],
  ["bitty.debug/getInputRing", "debug.inspect"],
  ["bitty.debug/getModifiers", "debug.inspect"],
  ["bitty.debug/getFocus", "debug.inspect"],
  ["bitty.debug/streamEvents", "debug.trace"],
  ["bitty.debug/startTrace", "debug.trace"],
  ["bitty.debug/stopTrace", "debug.trace"],
  ["bitty.debug/fetchTraceChunk", "debug.trace"],
  ["bitty.debug/captureFrame", "debug.trace"],
  ["bitty.debug/frameHash", "debug.trace"],
  ["bitty.debug/suspendHandler", "debug.control"],
  ["bitty.debug/resumePlugin", "debug.control"],
  ["bitty.debug/disposeGeneration", "debug.control"],
  ["bitty.debug/synthesizeInput", "debug.control"],
]);

function requestError(code: string, message: string): ProtocolErrorImpl {
  return new ProtocolErrorImpl({ category: "usage", code, message });
}

export function isRegisteredLiveMethod(method: string): boolean {
  return METHOD_SCOPES.has(method);
}

export function isValidLiveMethodForScope(
  method: string,
  scope: DebugScope,
): boolean {
  return METHOD_SCOPES.get(method) === scope;
}

export function validateLiveRequest(
  request: IpcRequest,
  scope: DebugScope = "debug.inspect",
): void {
  if (!isSupportedVersion(request.version)) {
    throw requestError(
      "UnsupportedVersion",
      `live requests require protocol version ${PROTOCOL_VERSION}`,
    );
  }
  if (!isValidLiveMethodForScope(request.method, scope)) {
    throw requestError(
      "UnknownMethod",
      "live request method is not registered",
    );
  }
  const frame: RequestFrame = {
    jsonrpc: "2.0",
    id: request.id,
    method: request.method,
    ...(request.params === undefined ? {} : { params: request.params }),
    version: request.version,
  };
  try {
    encodeRequest(frame);
  } catch (error) {
    if (error instanceof ProtocolErrorImpl) throw error;
    throw requestError(
      "InvalidRequest",
      "live request failed protocol validation",
    );
  }
}
