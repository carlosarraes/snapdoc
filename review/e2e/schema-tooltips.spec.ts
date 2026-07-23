import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../../worker/src/markdown";

const ORIGIN = "https://snapdoc.test";
const DOCUMENT_URL = `${ORIGIN}/artifact`;
const annotatorFile = resolve(fileURLToPath(new URL("..", import.meta.url)), "../worker/public/review/annotator.js");

const FIXTURE = [
  "```python",
  "class QuoteSummary(BaseModel):",
  "    id: UUID",
  "    marker_field_xyz: str",
  "```",
  "",
  "```python",
  "class QuoteResult(QuoteSummary):",
  "    line_items: list",
  "```",
  "",
  "```python",
  "async def get(self) -> QuoteResult: ...",
  "```",
  "",
  "Returns a `QuoteResult`; `Money` values are strings.",
  "",
  "Tail paragraph words to select.",
].join("\n");

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

async function openFixture(page: Page): Promise<void> {
  const { html } = await renderMarkdown(FIXTURE, "Schema tooltip test");
  await page.route(DOCUMENT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "Content-Security-Policy": CSP },
      body: html,
    }),
  );
  await page.goto(DOCUMENT_URL);
  await page.waitForSelector(".sd-ref");
}

test("wraps defined names everywhere and leaves undefined names plain", async ({ page }) => {
  await openFixture(page);

  // Declarations stay plain: only the later usage + inline mention count.
  await expect(page.locator('.sd-ref[data-sd-ref="QuoteResult"]')).toHaveCount(2);
  await expect(page.locator('.sd-ref[data-sd-ref="QuoteSummary"]')).toHaveCount(1);
  await expect(page.locator('.sd-ref[data-sd-ref="Money"]')).toHaveCount(0);
  await expect(page.locator('.sd-ref[data-sd-ref="BaseModel"]')).toHaveCount(0);
});

test("hover shows the definition tooltip and mouse-away hides it", async ({ page }) => {
  await openFixture(page);

  await page.locator('.sd-ref[data-sd-ref="QuoteResult"]').last().hover();
  const tooltip = page.locator("#sd-ref-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("class QuoteResult(QuoteSummary):");

  // Move to the top of the doc — the open tooltip covers the content below.
  await page.locator("pre").first().hover();
  await expect(tooltip).toBeHidden();
});

test("click pins the tooltip; click-away and Escape dismiss it", async ({ page }) => {
  await openFixture(page);
  const ref = page.locator('.sd-ref[data-sd-ref="QuoteResult"]').last();
  const tooltip = page.locator("#sd-ref-tooltip");

  await ref.click();
  await expect(ref).toHaveAttribute("data-sd-pinned", "1");
  await page.locator("pre").first().hover();
  await expect(tooltip).toBeVisible();

  await page.locator("pre").first().click();
  await expect(tooltip).toBeHidden();

  await ref.click();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(ref).not.toHaveAttribute("data-sd-pinned", "1");
});

test("keyboard focus shows the tooltip and Enter pins it", async ({ page }) => {
  await openFixture(page);
  const ref = page.locator('.sd-ref[data-sd-ref="QuoteSummary"]').first();
  const tooltip = page.locator("#sd-ref-tooltip");

  await ref.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("marker_field_xyz");

  await page.keyboard.press("Enter");
  await expect(ref).toHaveAttribute("data-sd-pinned", "1");
  await page.locator("p").last().focus();
  await expect(tooltip).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
});

test("annotator anchors never include pinned tooltip text in annotate mode", async ({ page }) => {
  const { html } = await renderMarkdown(FIXTURE, "Annotated schema tooltips");
  // Drives the doc from inside the sandboxed frame: pin a tooltip, then select
  // the tail paragraph so the annotator computes an anchor whose suffix would
  // contain the tooltip definition text if flatten() failed to exclude it.
  const driver = `<script>
window.addEventListener("load", () => {
  setTimeout(() => {
    document.querySelector('.sd-ref[data-sd-ref="QuoteSummary"]').click();
    setTimeout(() => {
      const paragraphs = document.querySelectorAll("p");
      const tail = paragraphs[paragraphs.length - 1].firstChild;
      const range = document.createRange();
      range.setStart(tail, 0);
      range.setEnd(tail, tail.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, 100);
  }, 100);
});
</script>`;
  const annotatedHtml = html
    .replace("</head>", `${driver}</head>`)
    .replace("</body>", '<script src="/review/annotator.js" defer></script></body>');

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
</script><iframe src="/annotated" sandbox="allow-scripts"></iframe>`,
    }),
  );

  await page.goto(`${ORIGIN}/review-host`);
  await page.waitForFunction(() =>
    (window as Window & { events?: Array<{ type: string }> }).events?.some((e) => e.type === "selection"),
  );
  const events = await page.evaluate(
    () => (window as Window & { events: Array<{ type: string; anchor?: { exact: string; prefix: string; suffix: string } }> }).events,
  );

  const ready = events.find((e) => e.type === "ready");
  expect(ready).toBeTruthy();
  const selection = events.find((e) => e.type === "selection")!;
  expect(selection.anchor!.exact).toContain("Tail paragraph words");
  const anchorText = JSON.stringify(selection.anchor);
  expect(anchorText).not.toContain("marker_field_xyz");
  expect(anchorText).not.toContain("class QuoteSummary");
});
