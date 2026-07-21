// W3C-style text anchoring: locate a highlighted span by its quoted text plus a
// bounded window of surrounding context, so a comment survives edits and new
// versions. computeSelectors/resolveSelectors are pure (no DOM) and unit-tested
// directly; flatten/toRange/rangeToOffsets bridge to a live document and are used
// only by the injected annotator.

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

const CONTEXT = 32;

export function computeSelectors(text: string, start: number, end: number): Anchor {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
    start,
    end,
  };
}

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function allIndexes(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

// Resolves an anchor against (possibly changed) text. Returns null — an
// "orphan" — when the quoted text no longer exists.
export function resolveSelectors(text: string, sel: Anchor): { start: number; end: number } | null {
  // Fast path: the recorded offsets still hold the exact quote (same version).
  if (sel.start >= 0 && sel.end <= text.length && text.slice(sel.start, sel.end) === sel.exact) {
    return { start: sel.start, end: sel.end };
  }
  const candidates = allIndexes(text, sel.exact);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { start: candidates[0], end: candidates[0] + sel.exact.length };
  }
  // Multiple matches: score each by how much of the recorded prefix/suffix it
  // reproduces, tie-broken by proximity to the original offset.
  let best = candidates[0];
  let bestScore = -1;
  for (const idx of candidates) {
    const before = text.slice(Math.max(0, idx - sel.prefix.length), idx);
    const after = text.slice(idx + sel.exact.length, idx + sel.exact.length + sel.suffix.length);
    const score = commonSuffixLen(before, sel.prefix) + commonPrefixLen(after, sel.suffix);
    if (score > bestScore || (score === bestScore && Math.abs(idx - sel.start) < Math.abs(best - sel.start))) {
      best = idx;
      bestScore = score;
    }
  }
  return { start: best, end: best + sel.exact.length };
}

// ---- DOM bridge (annotator-only; needs a live document) ----

export interface FlatText {
  text: string;
  // Ascending [globalStart, textNode] pairs, one per text node in document order.
  nodes: { start: number; node: Text }[];
}

export function flatten(root: Node): FlatText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { start: number; node: Text }[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    if (node.parentElement?.closest(".sd-mermaid-source, .sd-mermaid-error")) continue;
    nodes.push({ start: text.length, node });
    text += node.nodeValue ?? "";
  }
  return { text, nodes };
}

// Last text node whose global start is <= offset, plus the offset within it.
function locate(flat: FlatText, offset: number): { node: Text; offset: number } | null {
  const { nodes } = flat;
  if (nodes.length === 0) return null;
  let lo = 0;
  let hi = nodes.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].start <= offset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const entry = nodes[idx];
  return { node: entry.node, offset: Math.min(offset - entry.start, entry.node.length) };
}

export function toRange(flat: FlatText, start: number, end: number): Range | null {
  const a = locate(flat, start);
  const b = locate(flat, end);
  if (!a || !b) return null;
  try {
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  } catch {
    return null;
  }
}

function globalOffsetOf(flat: FlatText, container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const entry = flat.nodes.find((e) => e.node === container);
    return entry ? entry.start + offset : null;
  }
  // Element boundary: map to the start of the child text node at `offset`.
  const child = container.childNodes[offset] ?? container.childNodes[offset - 1] ?? null;
  if (!child) return null;
  const entry = flat.nodes.find((e) => e.node === child || child.contains(e.node));
  return entry ? entry.start : null;
}

export function rangeToOffsets(flat: FlatText, range: Range): { start: number; end: number } | null {
  const s = globalOffsetOf(flat, range.startContainer, range.startOffset);
  const e = globalOffsetOf(flat, range.endContainer, range.endOffset);
  if (s === null || e === null) return null;
  return s <= e ? { start: s, end: e } : { start: e, end: s };
}
