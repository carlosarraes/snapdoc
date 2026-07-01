// Injected into the artifact document when it is served in annotate mode and
// framed by the review page. It holds no secrets: it only reads the (public)
// document text, reports selections, and paints highlights the rail asks for.
// A direct hit on /:id?annotate=1 (not framed) is a no-op.
import { type Anchor, type FlatText, computeSelectors, flatten, rangeToOffsets, resolveSelectors, toRange } from "./anchor";

// CSS Custom Highlight API — not in every TS DOM lib yet, and absent on old
// engines. Access defensively; highlights degrade to invisible if unavailable
// (comments still work).
const highlightRegistry: Map<string, unknown> | undefined = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
const HighlightCtor: (new (...ranges: Range[]) => { add(r: Range): void }) | undefined = (globalThis as { Highlight?: new (...ranges: Range[]) => { add(r: Range): void } }).Highlight;

interface Placed {
  id: string;
  range: Range;
}

type RailMessage =
  | { source: "snapdoc-rail"; type: "render"; anchors: (Anchor & { id: string })[] }
  | { source: "snapdoc-rail"; type: "clear" }
  | { source: "snapdoc-rail"; type: "focus"; id: string };

if (window.parent !== window) main();

function main(): void {
  let parentOrigin = "*";
  let activeId: string | null = null;
  const placed: Placed[] = [];
  let flat: FlatText = flatten(document.body);

  injectStyle();

  const post = (msg: Record<string, unknown>): void => {
    window.parent.postMessage({ v: 1, source: "snapdoc-annotator", ...msg }, parentOrigin);
  };

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const data = e.data as RailMessage | null;
    if (!data || data.source !== "snapdoc-rail") return;
    // Lock onto the rail's real origin the first time we hear from it.
    if (parentOrigin === "*" && typeof e.origin === "string" && e.origin !== "null") parentOrigin = e.origin;
    if (data.type === "render") render(data.anchors);
    else if (data.type === "clear") clearHighlights();
    else if (data.type === "focus") focus(data.id);
  });

  // Report the user's text selection as a candidate anchor.
  document.addEventListener("mouseup", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      post({ type: "selectionCleared" });
      return;
    }
    const range = sel.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer)) return;
    flat = flatten(document.body);
    const offsets = rangeToOffsets(flat, range);
    if (!offsets || offsets.start === offsets.end) {
      post({ type: "selectionCleared" });
      return;
    }
    const anchor = computeSelectors(flat.text, offsets.start, offsets.end);
    const r = range.getBoundingClientRect();
    post({ type: "selection", anchor, rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right } });
  });

  // Clicking a highlighted span opens its thread in the rail.
  document.addEventListener("click", (e: MouseEvent) => {
    const hit = placed.find((p) => rangeContainsPoint(p.range, e.clientX, e.clientY));
    if (hit) post({ type: "highlightClicked", id: hit.id });
  });

  // Announce readiness; the rail replies with the anchors to render.
  post({ type: "ready", textLength: flat.text.length });

  function render(anchors: (Anchor & { id: string })[]): void {
    flat = flatten(document.body);
    placed.length = 0;
    const results: { id: string; ok: boolean }[] = [];
    for (const a of anchors) {
      const resolved = resolveSelectors(flat.text, a);
      const range = resolved ? toRange(flat, resolved.start, resolved.end) : null;
      if (!range) {
        results.push({ id: a.id, ok: false });
        continue;
      }
      placed.push({ id: a.id, range });
      results.push({ id: a.id, ok: true });
    }
    paint();
    post({ type: "resolved", results });
  }

  function focus(id: string): void {
    const p = placed.find((x) => x.id === id);
    if (!p) return;
    activeId = id;
    paint();
    const rect = p.range.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: "smooth" });
  }

  function paint(): void {
    if (!highlightRegistry || !HighlightCtor) return;
    const base = new HighlightCtor();
    const active = new HighlightCtor();
    for (const p of placed) (p.id === activeId ? active : base).add(p.range);
    highlightRegistry.set("sd-hl", base);
    highlightRegistry.set("sd-hl-active", active);
  }

  function clearHighlights(): void {
    placed.length = 0;
    activeId = null;
    highlightRegistry?.delete("sd-hl");
    highlightRegistry?.delete("sd-hl-active");
  }
}

function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

function injectStyle(): void {
  const style = document.createElement("style");
  style.textContent =
    "::highlight(sd-hl){background:rgba(255,213,0,.35);}::highlight(sd-hl-active){background:rgba(255,145,0,.55);}";
  (document.head ?? document.documentElement).appendChild(style);
}
