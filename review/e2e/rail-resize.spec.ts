import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://review.snapdoc.test";
const ID = "ABCDEFGHIJKLMN";
const reviewDir = fileURLToPath(new URL("..", import.meta.url));
const appFile = resolve(reviewDir, "../worker/public/review/app.js");
const cssFile = resolve(reviewDir, "../worker/public/review/app.css");

const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 260;

async function openReview(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/review/app.js`, async (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: await readFile(appFile) }),
  );
  // The real stylesheet: the sheet's width is a CSS grid track, so a stub
  // would make every measurement meaningless.
  await page.route(`${ORIGIN}/review/app.css`, async (route) =>
    route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: await readFile(cssFile) }),
  );
  await page.route(`${ORIGIN}/v1/reader/artifacts/${ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: ID,
        title: "Resizable review",
        current_version: 1,
        comments_enabled: true,
        versions: [{ version: 1, created_at: "2026-07-27T00:00:00.000Z" }],
      }),
    }),
  );
  await page.route(`${ORIGIN}/v1/reader/artifacts/${ID}/comments`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ artifact_id: ID, comments: [] }) }),
  );
  await page.route(new RegExp(`${ORIGIN.replaceAll(".", "\\.")}/${ID}(?:/v/\\d+)?\\?annotate=1`), (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><p>document</p>" }),
  );
  await page.route(`${ORIGIN}/review/${ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html>
<link rel="stylesheet" href="/review/app.css">
<div id="root" data-artifact-id="${ID}" data-artifact-origin=""></div>
<script type="module" src="/review/app.js"></script>`,
    }),
  );
  await page.goto(`${ORIGIN}/review/${ID}`);
  await expect(page.locator(".rail")).toBeVisible();
}

async function railWidth(page: Page): Promise<number> {
  const box = await page.locator(".rail").boundingBox();
  return Math.round(box!.width);
}

// Drags the handle horizontally; negative dx widens the sheet (the handle
// sits on its left edge).
async function dragHandle(page: Page, dx: number): Promise<void> {
  const handle = page.locator(".rail-resizer");
  const box = (await handle.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 8 });
  await page.mouse.up();
}

test("drag resizes the comment sheet and the width survives a reload", async ({ page }) => {
  await openReview(page);
  expect(await railWidth(page)).toBe(DEFAULT_WIDTH);

  await dragHandle(page, -180);
  const widened = await railWidth(page);
  expect(widened).toBeGreaterThan(DEFAULT_WIDTH + 150);

  await page.reload();
  await expect(page.locator(".rail")).toBeVisible();
  expect(await railWidth(page)).toBe(widened);
});

test("clamps the sheet so the document always keeps room", async ({ page }) => {
  await openReview(page);

  // Far past the right edge: the sheet stops at its minimum, never collapses.
  await dragHandle(page, 900);
  expect(await railWidth(page)).toBe(MIN_WIDTH);

  // Far past the left edge: the document keeps its reserved minimum.
  await dragHandle(page, -3000);
  const viewport = page.viewportSize()!.width;
  const width = await railWidth(page);
  expect(width).toBeLessThanOrEqual(viewport - 320);
  expect(viewport - width).toBeGreaterThanOrEqual(320);
});

test("keyboard resizes the sheet and double-click restores the default", async ({ page }) => {
  await openReview(page);
  const handle = page.locator(".rail-resizer");

  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(await railWidth(page)).toBe(DEFAULT_WIDTH + 16);
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await railWidth(page)).toBe(DEFAULT_WIDTH + 80);
  await page.keyboard.press("ArrowRight");
  expect(await railWidth(page)).toBe(DEFAULT_WIDTH + 64);

  await handle.dblclick();
  expect(await railWidth(page)).toBe(DEFAULT_WIDTH);

  // The separator reports its range to assistive tech.
  await expect(handle).toHaveAttribute("aria-valuenow", String(DEFAULT_WIDTH));
  await expect(handle).toHaveAttribute("aria-valuemin", String(MIN_WIDTH));
});

test("hiding the comments gives the document the whole viewport", async ({ page }) => {
  await openReview(page);
  await page.getByTitle("Hide comments").click();

  await expect(page.locator(".rail")).toBeHidden();
  await expect(page.locator(".rail-resizer")).toBeHidden();
  const doc = (await page.locator("iframe.doc").boundingBox())!;
  expect(Math.round(doc.width)).toBe(page.viewportSize()!.width);
});
