import { describe, expect, it } from "vitest";
import { computeSelectors, resolveSelectors } from "./anchor";

const TEXT = "The quick brown fox jumps over the lazy dog";
const START = TEXT.indexOf("brown");
const SEL = computeSelectors(TEXT, START, START + "brown".length);

describe("computeSelectors", () => {
  it("captures the exact quote plus bounded context", () => {
    expect(SEL.exact).toBe("brown");
    expect(SEL.prefix.endsWith("quick ")).toBe(true);
    expect(SEL.suffix.startsWith(" fox")).toBe(true);
  });
});

describe("resolveSelectors", () => {
  it("fast-paths to the exact offsets on unchanged text", () => {
    expect(resolveSelectors(TEXT, SEL)).toEqual({ start: START, end: START + 5 });
  });

  it("refloats after text is inserted above the quote", () => {
    const edited = "A new intro paragraph.\n\n" + TEXT;
    const r = resolveSelectors(edited, SEL)!;
    expect(r).not.toBeNull();
    expect(edited.slice(r.start, r.end)).toBe("brown");
    expect(r.start).toBe(edited.indexOf("brown"));
  });

  it("disambiguates duplicate quotes using surrounding context", () => {
    const doc = "a red car and a red bike";
    const second = doc.lastIndexOf("red");
    const sel = computeSelectors(doc, second, second + 3);
    const edited = "x".repeat(40) + doc; // shift offsets so the quote path runs
    const r = resolveSelectors(edited, sel)!;
    expect(edited.slice(r.start, r.end)).toBe("red");
    // Context (" bike") must select the second occurrence, not the first.
    expect(r.start).toBe(edited.lastIndexOf("red"));
  });

  it("uses suffix context to pick the right duplicate", () => {
    const doc = "foo bar baz then foo bar qux";
    const target = doc.lastIndexOf("bar");
    const sel = computeSelectors(doc, target, target + 3);
    const edited = "HEADER\n" + doc;
    const r = resolveSelectors(edited, sel)!;
    expect(edited.slice(r.start, r.start + "bar qux".length)).toBe("bar qux");
  });

  it("returns null (orphan) when the quoted text is gone", () => {
    expect(resolveSelectors("completely different content", SEL)).toBeNull();
  });
});
