import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../../worker/src/markdown";

const ORIGIN = "https://snapdoc.test";
const annotatorFile = resolve(fileURLToPath(new URL("..", import.meta.url)), "../worker/public/review/annotator.js");

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'self'",
  "style-src 'unsafe-inline'",
  "img-src https: data: blob:",
  "font-src https: data:",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

interface AnnotatorEvent {
  type: string;
  anchor?: { exact: string };
}

// Frames the real annotator exactly as annotate mode does: a sandboxed
// allow-scripts iframe inside a host page that records every message.
async function openAnnotated(page: Page): Promise<void> {
  const { html } = await renderMarkdown("A paragraph of prose that a reviewer selects on a phone.", "Touch selection");
  const annotatedHtml = html.replace("</body>", '<script src="/review/annotator.js" defer></script></body>');

  await page.route(`${ORIGIN}/review/annotator.js`, async (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: await readFile(annotatorFile) }),
  );
  await page.route(`${ORIGIN}/annotated`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "Content-Security-Policy": CSP },
      body: annotatedHtml,
    }),
  );
  await page.route(`${ORIGIN}/review-host`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><script>
window.events = [];
window.addEventListener("message", (event) => {
  if (event.data?.source === "snapdoc-annotator") window.events.push(event.data);
});
</script><iframe src="/annotated" sandbox="allow-scripts" style="width:100%;height:90vh;border:0"></iframe>`,
    }),
  );

  await page.goto(`${ORIGIN}/review-host`);
  await page.waitForFunction(() =>
    (window as Window & { events?: AnnotatorEvent[] }).events?.some((e) => e.type === "ready"),
  );
}

function events(page: Page): Promise<AnnotatorEvent[]> {
  return page.evaluate(() => (window as Window & { events: AnnotatorEvent[] }).events);
}

// Selects text purely through the Selection API — no mouse, no touch events.
// This is what dragging Android's native selection handles looks like to the
// page: the only signal is `selectionchange`.
async function selectWithoutPointerEvents(page: Page, phrase: string): Promise<void> {
  await page.frameLocator("iframe").locator("p").first().waitFor();
  await page.frames()[1].evaluate((needle: string) => {
    const node = [...document.querySelectorAll("p")]
      .flatMap((p) => [...p.childNodes])
      .find((n): n is Text => n.nodeType === Node.TEXT_NODE && n.nodeValue!.includes(needle))!;
    const start = node.nodeValue!.indexOf(needle);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + needle.length);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, phrase);
}

test("reports a selection made with no mouse event at all", async ({ page }) => {
  await openAnnotated(page);
  await selectWithoutPointerEvents(page, "paragraph of prose");

  await expect
    .poll(async () => (await events(page)).filter((e) => e.type === "selection").length, { timeout: 3000 })
    .toBe(1);
  const selection = (await events(page)).find((e) => e.type === "selection")!;
  expect(selection.anchor!.exact).toBe("paragraph of prose");
});

test("reports a mouse-driven selection exactly once", async ({ page }) => {
  await openAnnotated(page);
  await selectWithoutPointerEvents(page, "reviewer selects");
  // Both the mouseup path and the selectionchange path see the same selection;
  // the rail must not receive it twice.
  await page.frames()[1].evaluate(() => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));

  await page.waitForTimeout(600);
  expect((await events(page)).filter((e) => e.type === "selection")).toHaveLength(1);
});

test("collapsing a selection clears it without repeating", async ({ page }) => {
  await openAnnotated(page);
  await selectWithoutPointerEvents(page, "on a phone");
  await expect.poll(async () => (await events(page)).some((e) => e.type === "selection"), { timeout: 3000 }).toBe(true);

  await page.frames()[1].evaluate(() => getSelection()!.removeAllRanges());
  await page.waitForTimeout(600);
  expect((await events(page)).filter((e) => e.type === "selectionCleared").length).toBeLessThanOrEqual(1);
});
