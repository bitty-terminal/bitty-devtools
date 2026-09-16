import { describe, expect, test } from "bun:test";
import { DevtoolsClient } from "../src/client.js";
import { ControlClient } from "../src/control.js";
import { panelId } from "../src/panel-runtime.js";

describe("control (debug.control, audited, no bypass)", () => {
  test("inspect and trace cannot control", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.inspect");
    expect(() => c.suspendHandler(panelId(1), "h1", "test")).toThrow(
      "debug.control",
    );
    c.grantScope("debug.trace");
    expect(() => c.suspendHandler(panelId(1), "h1", "test")).toThrow(
      "debug.control",
    );
  });

  test("control scope audited and generation-owned", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.control");
    const receipt = c.suspendHandler(
      panelId(1),
      "handler-1",
      "diagnosis",
      "tester",
    );
    expect(receipt.audited.caller).toBe("tester");
    expect(receipt.audited.action).toBe("suspendHandler");
    expect(receipt.generation).toBe(2);
  });

  test("resume cannot bypass budget gate (typed receipt)", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.control");
    const r = c.resumePlugin(panelId(1), 1 as never);
    expect(r.newGeneration).toBe(2);
  });

  test("disposeGeneration reclaims bounded", () => {
    const c = new DevtoolsClient();
    c.connect();
    c.grantScope("debug.control");
    const r = c.disposeGeneration(panelId(1), 1 as never, "devtools");
    expect(r.disposed).toBe(true);
    expect(r.reclaimed.queues).toBe(1);
  });

  test("connection alone grants no control", () => {
    const c = new DevtoolsClient();
    c.connect();
    expect(() => c.disposeGeneration(panelId(1), 1 as never)).toThrow(
      "debug.control",
    );
  });

  test("audit log drops oldest at bound and preserves FIFO order (CTX-0042)", () => {
    const c = new ControlClient();
    const scope = "debug.control";
    for (let i = 0; i < 256 + 10; i++) {
      c.suspendHandler(scope, panelId(1), `h${i}`, `cause ${i}`, "tester");
    }
    expect(c.auditCount()).toBe(256);
    const logs = c.listAuditLog(scope, 256);
    expect(logs.length).toBe(256);
    // First 10 evicted; oldest live entry is h10.
    expect(logs[0]!.target).toBe("panel:1/h10");
    expect(logs[255]!.target).toBe("panel:1/h265");
    // listAuditLog is read-only: repeated reads return the same entries.
    const again = c.listAuditLog(scope, 256);
    expect(again.length).toBe(256);
    expect(again[0]!.target).toBe("panel:1/h10");
  });
});
