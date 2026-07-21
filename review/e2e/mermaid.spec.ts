import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "../../worker/src/markdown";

const ORIGIN = "https://snapdoc.test";
const DOCUMENT_URL = `${ORIGIN}/artifact`;
const RUNTIME_PATH = "/review/mermaid-11.15.0.min.js";
const RUNTIME_URL = `${ORIGIN}${RUNTIME_PATH}`;
const runtimeFile = resolve(fileURLToPath(new URL("..", import.meta.url)), "../worker/public/review/mermaid-11.15.0.min.js");
const annotatorFile = resolve(fileURLToPath(new URL("..", import.meta.url)), "../worker/public/review/annotator.js");

async function openMarkdown(page: Page, markdown: string, opts: { runtimeAvailable?: boolean } = {}): Promise<void> {
  const { html } = await renderMarkdown(markdown, "Mermaid browser test");
  const runtimeAvailable = opts.runtimeAvailable ?? true;

  await page.route(RUNTIME_URL, async (route) => {
    if (!runtimeAvailable) return route.abort();
    await route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(runtimeFile),
    });
  });
  await page.route(DOCUMENT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Content-Security-Policy": [
          "default-src 'none'",
          `script-src 'unsafe-inline' ${RUNTIME_URL}`,
          "style-src 'unsafe-inline'",
          "img-src https: data: blob:",
          "font-src https: data:",
          "frame-ancestors 'none'",
          "form-action 'none'",
          "base-uri 'none'",
        ].join("; "),
      },
      body: html,
    }),
  );
  await page.goto(DOCUMENT_URL);
  await page.waitForFunction(() => document.documentElement.dataset.snapdocMermaidSettled === "1");
}

test("renders ER, class, architecture service, and sequence diagrams", async ({ page }) => {
  await openMarkdown(
    page,
    [
      "```mermaid\nerDiagram\n  CUSTOMER ||--o{ ORDER : places\n```",
      "```mermaid\nclassDiagram\n  class Customer\n  Customer <|-- BusinessCustomer\n```",
      "```mermaid\narchitecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api\n  service db(database)[DB] in api\n  web:R --> L:db\n```",
      "```mermaid\nsequenceDiagram\n  Browser->>API: GET /deals\n  API-->>Browser: 200 OK\n```",
    ].join("\n\n"),
  );

  const figures = page.locator('[data-snapdoc-mermaid="rendered"]');
  await expect(figures).toHaveCount(4);
  await expect(figures.locator(".sd-mermaid-output > svg")).toHaveCount(4);
  await expect(figures.locator(".sd-mermaid-output > svg[aria-roledescription]")).toHaveCount(4);
  for (let index = 0; index < 4; index++) {
    await expect(figures.nth(index).locator(".sd-mermaid-source")).not.toHaveAttribute("open", "");
  }
});

test("strict rendering neutralizes hostile labels, links, handlers, and config overrides", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __snapdocPwned?: number }).__snapdocPwned = 0;
  });
  await openMarkdown(
    page,
    `\`\`\`mermaid
---
config:
  securityLevel: loose
  htmlLabels: true
  flowchart:
    htmlLabels: true
---
flowchart LR
  A["<img src=x onerror=window.__snapdocPwned=1>"] --> B[Safe]
  click A "javascript:window.__snapdocPwned=2"
\`\`\``,
  );

  const output = page.locator('[data-snapdoc-mermaid="rendered"] .sd-mermaid-output');
  await expect(output.locator("svg")).toHaveCount(1);
  await expect(output.locator("script")).toHaveCount(0);
  await expect(output.locator("[onerror], [onclick], [onload]")).toHaveCount(0);
  await expect(output.locator('[href^="javascript:" i]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __snapdocPwned?: number }).__snapdocPwned)).toBe(0);
});

test("isolates syntax errors and leaves failed source readable", async ({ page }) => {
  await openMarkdown(
    page,
    [
      "```mermaid\nflowchart LR\nA-->B\n```",
      "```mermaid\nthis is not a diagram\n```",
      "```mermaid\nsequenceDiagram\nA->>B: Still renders\n```",
    ].join("\n\n"),
  );

  await expect(page.locator('[data-snapdoc-mermaid="rendered"]')).toHaveCount(2);
  const failed = page.locator('[data-snapdoc-mermaid="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed.locator(".sd-mermaid-error")).toBeVisible();
  await expect(failed.locator(".sd-mermaid-source")).toHaveAttribute("open", "");
  await expect(failed.locator(".sd-mermaid-source code")).toContainText("this is not a diagram");
});

test("falls back to readable source when the pinned runtime cannot load", async ({ page }) => {
  await openMarkdown(page, "```mermaid\nflowchart LR\nA-->B\n```", { runtimeAvailable: false });

  const failed = page.locator('[data-snapdoc-mermaid="failed"]');
  await expect(failed.locator(".sd-mermaid-error")).toBeVisible();
  await expect(failed.locator(".sd-mermaid-source")).toHaveAttribute("open", "");
  await expect(failed.locator(".sd-mermaid-source code")).toContainText("flowchart LR");
});

test("annotation readiness waits for diagrams and excludes fallback chrome", async ({ page }) => {
  const { html } = await renderMarkdown("```mermaid\nflowchart LR\nBrowser-->API\n```", "Annotated Mermaid");
  const monitor = `<script>
document.addEventListener("snapdoc:mermaid-settled", () => {
  const excluded = Array.from(document.querySelectorAll(".sd-mermaid-source, .sd-mermaid-error"))
    .reduce((length, element) => length + (element.textContent || "").length, 0);
  window.parent.postMessage({ source: "snapdoc-test", type: "settled", expectedTextLength: document.body.textContent.length - excluded }, "*");
}, { once: true });
</script>`;
  const annotatedHtml = html
    .replace("</head>", `${monitor}</head>`)
    .replace("</body>", '<script src="/review/annotator.js" defer></script></body>');

  await page.route(`${ORIGIN}/review/annotator.js`, async (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: await readFile(annotatorFile) }),
  );
  await page.route(RUNTIME_URL, async (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: await readFile(runtimeFile) }),
  );
  await page.route(`${ORIGIN}/annotated`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Content-Security-Policy": [
          "default-src 'none'",
          "script-src 'unsafe-inline' 'self'",
          "style-src 'unsafe-inline'",
          "img-src https: data: blob:",
          "font-src https: data:",
          "frame-ancestors 'self'",
          "form-action 'none'",
          "base-uri 'none'",
        ].join("; "),
      },
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
  if (event.data?.source === "snapdoc-test") window.events.push(event.data);
  if (event.data?.source === "snapdoc-annotator" && event.data.type === "ready") window.events.push(event.data);
});
</script><iframe src="/annotated" sandbox="allow-scripts"></iframe>`,
    }),
  );

  await page.goto(`${ORIGIN}/review-host`);
  await page.waitForFunction(() => (window as Window & { events?: unknown[] }).events?.length === 2);
  const events = await page.evaluate(
    () => (window as Window & { events: Array<{ type: string; expectedTextLength?: number; textLength?: number }> }).events,
  );
  expect(events.map((event) => event.type)).toEqual(["settled", "ready"]);
  expect(events[1].textLength).toBe(events[0].expectedTextLength);
});
