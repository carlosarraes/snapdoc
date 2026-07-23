// Flat text of a served document, approximating the review annotator's
// flatten(): concatenated visible text with the mermaid source/error chrome
// skipped (anchor.ts excludes the same nodes) and entities decoded. Used to
// decide server-side whether a comment's anchor still matches the current
// version — the same "orphaned" judgement the review page makes in-browser.

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export async function extractDocText(html: string): Promise<string> {
  // Pass 1: drop everything the annotator never flattens — head content
  // (styles, payloads), scripts, and the mermaid fallback chrome.
  const remove = {
    element(el: Element): void {
      el.remove();
    },
  };
  const stripped = await new HTMLRewriter()
    .on("head", remove)
    .on("script", remove)
    .on("style", remove)
    .on(".sd-mermaid-source", remove)
    .on(".sd-mermaid-error", remove)
    .transform(new Response(html))
    .text();

  // Pass 2: collect the remaining text in document order.
  let text = "";
  await new HTMLRewriter()
    .onDocument({
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(new Response(stripped))
    .text();

  return decodeEntities(text);
}
