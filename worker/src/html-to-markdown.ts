import { parseDocument } from "htmlparser2";
import { type AnyNode, type Element, isTag, isText } from "domhandler";

// Reconstructs Markdown from a stored snapdoc HTML document. The common input is
// `marked`'s GFM output wrapped by renderMarkdown (markdown.ts), so this targets
// that tag vocabulary; arbitrary HTML-authored artifacts degrade gracefully
// (unknown tags fall through to their text). Pure and request-local — no module
// state leaks across requests (Workers reuse module globals).

// Document chrome that never contributes content.
const SKIP_TAGS = new Set(["head", "style", "script", "title", "meta", "link", "noscript"]);

// Block-level tags whose children become their own paragraphs/lines.
const BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "blockquote", "pre", "table", "hr", "div", "section", "article",
]);

interface Ctx {
  listDepth: number;
}

export function htmlToMarkdown(html: string): string {
  const doc = parseDocument(html, { decodeEntities: true });
  const body = findBody(doc.children) ?? doc.children;
  return normalize(renderBlocks(body, { listDepth: 0 }));
}

function findBody(nodes: AnyNode[]): AnyNode[] | null {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    if (node.name === "body") return node.children;
    const nested = findBody(node.children);
    if (nested) return nested;
  }
  return null;
}

function renderBlocks(nodes: AnyNode[], ctx: Ctx): string {
  const blocks: string[] = [];
  for (const node of nodes) {
    if (isText(node)) {
      const text = node.data.replace(/\s+/g, " ").trim();
      if (text) blocks.push(text);
      continue;
    }
    if (!isTag(node)) continue;
    if (SKIP_TAGS.has(node.name)) continue;
    if (node.name === "nav" && (node.attribs.class ?? "").includes("toc")) continue;
    const block = renderBlock(node, ctx).trimEnd();
    if (block.trim()) blocks.push(block);
  }
  return blocks.join("\n\n");
}

function renderBlock(el: Element, ctx: Ctx): string {
  switch (el.name) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return "#".repeat(Number(el.name[1])) + " " + renderInline(el.children, ctx).trim();
    case "p":
      return renderInline(el.children, ctx).trim();
    case "hr":
      return "---";
    case "br":
      return "";
    case "blockquote":
      return renderBlocks(el.children, ctx)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "pre":
      return renderPre(el);
    case "ul": case "ol":
      return renderList(el, ctx);
    case "table":
      return renderTable(el, ctx);
    default:
      // Unknown/structural container — recurse so nothing is silently dropped.
      return renderBlocks(el.children, ctx);
  }
}

function renderInline(nodes: AnyNode[], ctx: Ctx): string {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) {
      out += node.data.replace(/\s+/g, " ");
      continue;
    }
    if (!isTag(node)) continue;
    switch (node.name) {
      case "strong": case "b":
        out += `**${renderInline(node.children, ctx).trim()}**`;
        break;
      case "em": case "i":
        out += `*${renderInline(node.children, ctx).trim()}*`;
        break;
      case "del": case "s": case "strike":
        out += `~~${renderInline(node.children, ctx).trim()}~~`;
        break;
      case "code":
        out += `\`${textContent(node)}\``;
        break;
      case "a":
        out += `[${renderInline(node.children, ctx).trim()}](${node.attribs.href ?? ""})`;
        break;
      case "img":
        out += `![${node.attribs.alt ?? ""}](${node.attribs.src ?? ""})`;
        break;
      case "br":
        out += "\n";
        break;
      default:
        out += renderInline(node.children, ctx);
    }
  }
  return out;
}

function renderList(el: Element, ctx: Ctx): string {
  const ordered = el.name === "ol";
  const items: string[] = [];
  let index = 1;
  for (const li of el.children) {
    if (!isTag(li) || li.name !== "li") continue;
    const marker = ordered ? `${index}. ` : "- ";
    index++;
    const indent = " ".repeat(marker.length);
    const content = renderListItem(li, { listDepth: ctx.listDepth + 1 });
    const lines = content.split("\n");
    const first = marker + (lines[0] ?? "");
    const rest = lines.slice(1).map((line) => (line ? indent + line : line));
    items.push([first, ...rest].join("\n"));
  }
  return items.join("\n");
}

// A list item mixes leading inline text with nested lists/blocks (tight vs loose
// lists). Buffer inline runs, flushing when a block child interrupts them.
function renderListItem(li: Element, ctx: Ctx): string {
  const parts: string[] = [];
  let inline: AnyNode[] = [];
  const flush = () => {
    if (inline.length === 0) return;
    const text = renderInline(inline, ctx).trim();
    if (text) parts.push(text);
    inline = [];
  };
  for (const child of li.children) {
    if (isTag(child) && (child.name === "ul" || child.name === "ol" || BLOCK_TAGS.has(child.name))) {
      flush();
      parts.push(renderBlock(child, ctx));
    } else {
      inline.push(child);
    }
  }
  flush();
  return parts.join("\n");
}

function renderPre(el: Element): string {
  const code = el.children.find((c): c is Element => isTag(c) && c.name === "code");
  const target = code ?? el;
  const cls = (code?.attribs.class ?? "").match(/language-([\w-]+)/);
  const lang = cls ? cls[1] : "";
  const content = textContent(target).replace(/\n$/, "");
  return "```" + lang + "\n" + content + "\n```";
}

function renderTable(el: Element, ctx: Ctx): string {
  const rows = findAll(el, "tr").map((tr) =>
    findAll(tr, "th", "td").map((cell) => renderInline(cell.children, ctx).trim().replace(/\|/g, "\\|")),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (cells: string[]) => {
    const filled = [...cells];
    while (filled.length < width) filled.push("");
    return `| ${filled.join(" | ")} |`;
  };
  const header = pad(rows[0]);
  const separator = `| ${Array(width).fill("---").join(" | ")} |`;
  const body = rows.slice(1).map(pad);
  return [header, separator, ...body].join("\n");
}

// Collects matching descendant elements without descending into nested matches
// of the same kind beyond what callers need (depth-first, all matches).
function findAll(node: Element, ...names: string[]): Element[] {
  const found: Element[] = [];
  const walk = (current: Element) => {
    for (const child of current.children) {
      if (!isTag(child)) continue;
      if (names.includes(child.name)) found.push(child);
      else walk(child);
    }
  };
  walk(node);
  return found;
}

function textContent(node: AnyNode): string {
  if (isText(node)) return node.data;
  if (isTag(node)) return node.children.map(textContent).join("");
  return "";
}

function normalize(markdown: string): string {
  return markdown
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}
