import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { extractDefinitions, serializeDefs, wrapCode } from "../src/schema-refs";
import { escapeHtml } from "../src/markdown";

function extract(markdown: string) {
  const md = new Marked({ gfm: true });
  return extractDefinitions(md.lexer(markdown));
}

function defs(markdown: string) {
  return extract(markdown).defs;
}

function fence(lang: string, code: string): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

describe("extractDefinitions — python", () => {
  it("captures a class body up to the dedent", () => {
    const code = [
      "class QuoteSummary(BaseModel):",
      "    id: UUID",
      "    title: str",
      "",
      "NEXT = 1",
    ].join("\n");
    const found = defs(fence("python", code));
    expect([...found.keys()]).toEqual(["QuoteSummary"]);
    const def = found.get("QuoteSummary")!;
    expect(def.lang).toBe("python");
    expect(def.code).toBe("class QuoteSummary(BaseModel):\n    id: UUID\n    title: str");
  });

  it("keeps blank lines inside a body and includes nested defs", () => {
    const code = [
      "class QuoteService:",
      '    """Doc."""',
      "",
      "    async def get(self) -> QuoteResult: ...",
      "",
      "    async def create(self) -> QuoteResult: ...",
    ].join("\n");
    const def = defs(fence("py", code)).get("QuoteService")!;
    expect(def.code).toContain("async def create");
  });

  it("captures multiple classes from one block and decorators above them", () => {
    const code = [
      "@dataclass",
      "class A:",
      "    x: int",
      "",
      "class B(A):",
      "    y: int",
    ].join("\n");
    const found = defs(fence("python", code));
    expect([...found.keys()]).toEqual(["A", "B"]);
    expect(found.get("A")!.code.startsWith("@dataclass\nclass A:")).toBe(true);
    expect(found.get("B")!.code).toBe("class B(A):\n    y: int");
  });

  it("handles one-line class stubs", () => {
    const found = defs(fence("python", "class NotFound(Exception): ...\nclass Overlap(Exception): ..."));
    expect([...found.keys()]).toEqual(["NotFound", "Overlap"]);
    expect(found.get("NotFound")!.code).toBe("class NotFound(Exception): ...");
  });
});

describe("extractDefinitions — typescript", () => {
  it("captures interface and enum bodies with nested braces", () => {
    const code = [
      "export interface Quote {",
      "  refs: { dealId: string | null };",
      "}",
      "enum Mode { A, B }",
    ].join("\n");
    const found = defs(fence("ts", code));
    expect([...found.keys()]).toEqual(["Quote", "Mode"]);
    expect(found.get("Quote")!.code).toBe("export interface Quote {\n  refs: { dealId: string | null };\n}");
    expect(found.get("Mode")!.code).toBe("enum Mode { A, B }");
  });

  it("ignores braces inside strings and comments when matching", () => {
    const code = [
      "class Renderer {",
      '  open = "{";',
      "  // } not a close",
      "  /* } neither */",
      "  render(): string { return `x${this.open}`; }",
      "}",
      "type After = string;",
    ].join("\n");
    const found = defs(fence("typescript", code));
    expect(found.get("Renderer")!.code).toContain("render(): string");
    expect(found.get("Renderer")!.code.endsWith("}")).toBe(true);
    expect(found.has("After")).toBe(true);
  });

  it("terminates type aliases at a depth-0 semicolon, blank line, or EOF", () => {
    const code = [
      "type Money = { amount: string; currency: string };",
      "type Id = string",
      "",
      "type Pair = [Id, Money]",
    ].join("\n");
    const found = defs(fence("tsx", code));
    expect(found.get("Money")!.code).toBe("type Money = { amount: string; currency: string };");
    expect(found.get("Id")!.code).toBe("type Id = string");
    expect(found.get("Pair")!.code).toBe("type Pair = [Id, Money]");
  });

  it("falls back to end-of-block for unbalanced braces", () => {
    const code = "class Broken {\n  x = 1;";
    expect(defs(fence("js", code)).get("Broken")!.code).toBe(code);
  });

  it("only matches definitions at the start of a line", () => {
    const found = defs(fence("ts", "const x = class Hidden {};\n  interface Indented {}"));
    expect(found.size).toBe(0);
  });
});

describe("extractDefinitions — general", () => {
  it("first definition wins on name collisions, across languages too", () => {
    const md = `${fence("python", "class Dup:\n    x: int")}\n\n${fence("ts", "interface Dup { y: string }")}`;
    const found = defs(md);
    expect(found.get("Dup")!.lang).toBe("python");
  });

  it("skips non-code tokens and unsupported languages", () => {
    const md = `# Title\n\n${fence("mermaid", "classDiagram\n  class NotASchema")}\n\n${fence("go", "type S struct{}")}`;
    expect(defs(md).size).toBe(0);
  });

  it("truncates oversized snippets", () => {
    const body = Array.from({ length: 200 }, (_, i) => `    field_${i}: int`).join("\n");
    const def = defs(fence("python", `class Big:\n${body}`)).get("Big")!;
    expect(def.code.split("\n").length).toBeLessThan(70);
    expect(def.code.endsWith("… (truncated)")).toBe(true);
  });
});

describe("wrapCode", () => {
  const names = ["QuoteSummary", "QuoteResult", "Quote"];

  it("wraps exact-name occurrences with word boundaries", () => {
    const out = wrapCode("a: QuoteSummary, b: QuoteSummaryX, c: XQuoteSummary", names, escapeHtml);
    expect(out).toContain('<span class="sd-ref" data-sd-ref="QuoteSummary" tabindex="0" role="button">QuoteSummary</span>');
    expect(out).toContain("QuoteSummaryX");
    expect(out).not.toContain('data-sd-ref="QuoteSummary" tabindex="0" role="button">QuoteSummary</span>X');
    expect(out.match(/<span/g)).toHaveLength(1);
  });

  it("prefers the longest name on overlaps", () => {
    const out = wrapCode("QuoteResult", names, escapeHtml);
    expect(out).toContain('data-sd-ref="QuoteResult"');
    expect(out.match(/<span/g)).toHaveLength(1);
  });

  it("escapes plain segments and supports $ in names", () => {
    const out = wrapCode("if (a < b) use($State)", ["$State"], escapeHtml);
    expect(out).toContain("a &lt; b");
    expect(out).toContain('data-sd-ref="$State" tabindex="0" role="button">$State</span>');
  });

  it("returns plain escaped text when no names are given", () => {
    expect(wrapCode("a < b", [], escapeHtml)).toBe("a &lt; b");
  });
});

describe("definition sites", () => {
  it("records each definition's character range keyed by block text", () => {
    const block = "class A:\n    x: int\n\nclass B(A):\n    y: int";
    const { sites } = extract(fence("python", block));
    const ranges = sites.get(block)!;
    expect(ranges).toHaveLength(2);
    expect(block.slice(ranges[0].start, ranges[0].end)).toBe("class A:\n    x: int");
    expect(ranges[1].name).toBe("B");
  });

  it("wrapCode skips a name inside its own definition but wraps other names there", () => {
    const blockA = "class A:\n    x: int";
    const blockB = "class B(A):\n    y: int\n    peer: B";
    const { sites } = extract(`${fence("python", blockA)}\n\n${fence("python", blockB)}`);
    // Rendering the block that defines B: A is foreign there, B is itself.
    const out = wrapCode(blockB, ["A", "B"], escapeHtml, sites.get(blockB));
    expect(out).toContain('data-sd-ref="A"');
    expect(out).not.toContain('data-sd-ref="B"');
  });
});

describe("serializeDefs", () => {
  it("escapes < so a definition cannot break out of the script element", () => {
    const found = defs(fence("ts", 'type Evil = "</script><script>alert(1)</script>";'));
    const json = serializeDefs(found);
    expect(json).not.toContain("</script>");
    const parsed = JSON.parse(json) as Record<string, { code: string }>;
    expect(parsed.Evil.code).toContain("</script>");
  });
});
