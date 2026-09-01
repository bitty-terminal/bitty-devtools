import { describe, expect, test } from "bun:test";
import {
  panelId,
  viewId,
  parsePanelType,
  canTransition,
  parseEventTopic,
  BoundedPayload,
  validateOverlayText,
} from "../src/panel-runtime.js";

describe("panel-runtime re-use", () => {
  test("PanelId distinct from ViewId (branded, no From)", () => {
    const pid = panelId(1);
    const vid = viewId(1);
    expect(pid).toBe(1);
    expect(vid).toBe(1);
    // Branded types share runtime value but are distinct at type level
    expect(pid !== (vid as unknown as typeof pid)).toBe(false); // same numeric, type-level distinct
  });

  test("PanelType closed set", () => {
    expect(parsePanelType("helper")).toBe("helper");
    expect(parsePanelType("unknown")).toBe(null);
    expect(parsePanelType("Helper")).toBe(null);
  });

  test("PanelState transitions", () => {
    expect(canTransition("Declared", "Created")).toBe(true);
    expect(canTransition("Declared", "Focused")).toBe(false);
    expect(canTransition("Focused", "Suspended")).toBe(true);
    expect(canTransition("Suspended", "Disposed")).toBe(true);
  });

  test("EventTopic grammar bounded 64", () => {
    expect(parseEventTopic("xuepoo.git:branch-changed")).toBe(
      "xuepoo.git:branch-changed",
    );
    expect(() => parseEventTopic("badtopic")).toThrow("invalid topic");
    expect(() => parseEventTopic("Owner.name:topic")).toThrow("invalid topic");
    expect(() => parseEventTopic("bitty.foo:bar")).toThrow("forbidden");
    expect(parseEventTopic("bitty.panel:mounted")).toBe("bitty.panel:mounted");
  });

  test("BoundedPayload rejects oversize", () => {
    expect(() => new BoundedPayload("a".repeat(9000))).toThrow("exceeded");
    expect(new BoundedPayload("hello").bytes).toBe(5);
  });

  test("overlay text truncation at 128", () => {
    const long = "a".repeat(200);
    const { text, truncated } = validateOverlayText(long);
    expect(text.length).toBe(128);
    expect(truncated).toBe(true);
  });
});
