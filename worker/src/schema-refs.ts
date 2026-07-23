// Publish-time schema reference detection: scans fenced code blocks for
// Python/TypeScript type definitions so renderMarkdown can turn every
// exact-name mention into a hoverable reference with a definition tooltip.
import type { Token } from "marked";

export interface SchemaDef {
  name: string;
  lang: "python" | "typescript";
  code: string;
}

const PYTHON_LANGS = new Set(["python", "py"]);
const TYPESCRIPT_LANGS = new Set(["typescript", "ts", "tsx", "javascript", "js", "jsx"]);

const MAX_SNIPPET_LINES = 60;
const MAX_SNIPPET_CHARS = 4000;

function truncateSnippet(code: string): string {
  const lines = code.split("\n");
  if (lines.length <= MAX_SNIPPET_LINES && code.length <= MAX_SNIPPET_CHARS) return code;
  const kept = lines.slice(0, MAX_SNIPPET_LINES).join("\n").slice(0, MAX_SNIPPET_CHARS);
  return `${kept}\n… (truncated)`;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

const PYTHON_CLASS = /^([ \t]*)class[ \t]+([A-Za-z_][A-Za-z0-9_]*)/;

function scanPython(text: string, add: (name: string, code: string) => void): void {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = PYTHON_CLASS.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;

    // Include contiguous decorator lines at the same indent directly above.
    let start = i;
    while (start > 0 && /^[ \t]*@/.test(lines[start - 1]) && indentOf(lines[start - 1]) === indent) start--;

    // Body runs until the first non-blank line at the class indent or less.
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) <= indent) break;
      end = j;
    }
    add(match[2], lines.slice(start, end + 1).join("\n"));
  }
}

const TS_DEFINITION =
  /^(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(interface|class|enum|type)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/;

// Steps over string literals (with escapes; template interpolations are
// consumed as part of the template) and comments so their braces never count.
function skipInert(text: string, i: number): number {
  const ch = text[i];
  if (ch === "'" || ch === '"' || ch === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === ch) return j + 1;
      else if (ch !== "`" && text[j] === "\n") return j;
    }
    return text.length;
  }
  if (ch === "/" && text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl === -1 ? text.length : nl;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const close = text.indexOf("*/", i + 2);
    return close === -1 ? text.length : close + 2;
  }
  return i;
}

// End index (exclusive) of a braced body starting at the first `{` at or
// after `from`; text.length when braces never balance (fallback: whole block).
function braceEnd(text: string, from: number): number {
  let depth = 0;
  let seen = false;
  for (let i = from; i < text.length; i++) {
    const skipped = skipInert(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if (text[i] === "{") {
      depth++;
      seen = true;
    } else if (text[i] === "}") {
      depth--;
      if (seen && depth === 0) return i + 1;
    }
  }
  return text.length;
}

// A `type X = …` alias ends at the first `;` at zero bracket depth, else the
// first blank line at zero depth, else the end of the block.
function aliasEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const skipped = skipInert(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return i + 1;
    else if (ch === "\n" && depth === 0 && text.slice(i + 1, text.indexOf("\n", i + 1) === -1 ? text.length : text.indexOf("\n", i + 1)).trim() === "") {
      return i;
    }
  }
  return text.length;
}

function scanTypescript(text: string, add: (name: string, code: string) => void): void {
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    const match = TS_DEFINITION.exec(line);
    if (match) {
      const end = match[1] === "type" ? aliasEnd(text, offset + match[0].length) : braceEnd(text, offset + match[0].length);
      add(match[2], text.slice(offset, end).trimEnd());
    }
    offset += line.length + 1;
  }
}

// Walks lexed markdown tokens and returns name -> definition for every
// Python/TypeScript type defined in a fenced code block. First wins.
export function extractDefinitions(tokens: Token[]): Map<string, SchemaDef> {
  const found = new Map<string, SchemaDef>();
  for (const token of tokens) {
    if (token.type !== "code") continue;
    const lang = (token.lang ?? "").trim().toLowerCase().split(/\s+/)[0];
    const scanner = PYTHON_LANGS.has(lang) ? scanPython : TYPESCRIPT_LANGS.has(lang) ? scanTypescript : null;
    if (!scanner) continue;
    scanner(token.text, (name, code) => {
      if (!found.has(name)) {
        found.set(name, {
          name,
          lang: PYTHON_LANGS.has(lang) ? "python" : "typescript",
          code: truncateSnippet(code),
        });
      }
    });
  }
  return found;
}

// Escapes raw code text while wrapping every exact-name occurrence in a
// reference span. Matching happens on the raw (unescaped) source, so entity
// text like `&quot;` can never produce a false match.
export function wrapCode(rawText: string, names: string[], escape: (s: string) => string): string {
  if (names.length === 0) return escape(rawText);
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/\$/g, "\\$"))
    .join("|");
  const matcher = new RegExp(`(?<![A-Za-z0-9_$])(?:${alternatives})(?![A-Za-z0-9_$])`, "g");

  let out = "";
  let last = 0;
  for (const match of rawText.matchAll(matcher)) {
    out += escape(rawText.slice(last, match.index));
    const name = escape(match[0]);
    out += `<span class="sd-ref" data-sd-ref="${name}" tabindex="0" role="button">${name}</span>`;
    last = match.index + match[0].length;
  }
  return out + escape(rawText.slice(last));
}

// JSON payload for the in-document tooltip runtime. `<` is escaped so no
// definition source can close the surrounding <script> element.
export function serializeDefs(defs: Map<string, SchemaDef>): string {
  return JSON.stringify(Object.fromEntries(defs)).replace(/</g, "\\u003c");
}
