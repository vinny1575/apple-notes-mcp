import { describe, it, expect } from "vitest";
import { targetItem, assertTickPreserved } from "./checklistToggle.js";
import type { RichNote } from "../utils/noteRichText.js";
const note = (): RichNote => ({
  text: "Title\nalpha\nbeta\n",
  links: [],
  nativeTags: [],
  nativeObjectIds: [],
  hasNativeObjects: false,
  hasChecklist: true,
  revision: "revision",
  checklistItems: [
    { id: "a", text: "alpha", done: false, start: 6 },
    { id: "b", text: "beta", done: false, start: 12 },
  ],
  styleRuns: [],
});
describe("existing checklist safety", () => {
  it("requires exact text and checklist index", () => {
    expect(targetItem(note(), 0, "alpha").item.id).toBe("a");
    expect(() => targetItem(note(), 1, "alpha")).toThrow();
  });
  it("refuses duplicate text and missing index", () => {
    const n = note();
    n.checklistItems![1].text = "alpha";
    expect(() => targetItem(n, 0, "alpha")).toThrow();
    expect(() => targetItem(note(), 4, "alpha")).toThrow();
  });
  it("allows only target state transition", () => {
    const a = note(),
      b = note();
    b.checklistItems![0].done = true;
    expect(() => assertTickPreserved(a, b, "a", true)).not.toThrow();
    b.checklistItems![1].done = true;
    expect(() => assertTickPreserved(a, b, "a", true)).toThrow();
  });
  it.each(["text", "nativeTags", "links", "nativeObjectIds", "objects", "objectData"] as const)(
    "refuses collateral %s",
    (key) => {
      const a = note(),
        b = note();
      b.checklistItems![0].done = true;
      Object.assign(b, { [key]: key === "text" ? "changed" : ["changed"] });
      expect(() => assertTickPreserved(a, b, "a", true)).toThrow();
    }
  );
  it("refuses native identity change", () => {
    const a = note(),
      b = note();
    b.checklistItems![0].done = true;
    b.checklistItems![0].id = "replacement";
    expect(() => assertTickPreserved(a, b, "a", true)).toThrow();
  });
  it("refuses formatting change", () => {
    const a = note(),
      b = note();
    b.checklistItems![0].done = true;
    b.styleRuns = [{ start: 0, length: 6, signature: "[[3,1]]" }];
    expect(() => assertTickPreserved(a, b, "a", true)).toThrow();
  });
});
