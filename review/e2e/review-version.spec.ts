import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "https://review.snapdoc.test";
const ID = "ABCDEFGHIJKLMN";
const reviewDir = fileURLToPath(new URL("..", import.meta.url));
const appFile = resolve(reviewDir, "../worker/public/review/app.js");

test("clears stale selections and posts a root against the displayed version", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  await page.addInitScript(() => {
    if (location.pathname.startsWith("/review/")) {
      localStorage.setItem("snapdoc_reviewer_name", "Alex");
      localStorage.setItem("snapdoc_reviewer_email", "alex@example.com");
    }
  });

  await page.route(`${ORIGIN}/review/app.js`, async (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: await readFile(appFile) }),
  );
  await page.route(`${ORIGIN}/review/app.css`, (route) =>
    route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: "" }),
  );
  await page.route(`${ORIGIN}/v1/reader/artifacts/${ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: ID,
        title: "Versioned review",
        current_version: 2,
        comments_enabled: true,
        versions: [
          { version: 1, created_at: "2026-07-20T00:00:00.000Z" },
          { version: 2, created_at: "2026-07-21T00:00:00.000Z" },
        ],
      }),
    }),
  );
  await page.route(`${ORIGIN}/v1/reader/artifacts/${ID}/comments`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ artifact_id: ID, comments: [] }),
      });
    }
    posted = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "cmt_1234567890123456",
        author: "Alex",
        author_kind: "anon",
        version: posted.version,
        body: posted.body,
        created_at: "2026-07-21T00:00:00.000Z",
        parent_id: null,
        resolved: false,
        anchor: posted.anchor,
      }),
    });
  });

  const fakeDocument = `<!doctype html><button id="select">Select text</button><script>
const post = (message) => window.parent.postMessage({ source: "snapdoc-annotator", ...message }, "*");
post({ type: "ready", textLength: 20 });
document.getElementById("select").addEventListener("click", () => post({
  type: "selection",
  anchor: { exact: "selected", prefix: "", suffix: "", start: 0, end: 8 }
}));
</script>`;
  await page.route(new RegExp(`${ORIGIN.replaceAll(".", "\\.")}/${ID}(?:/v/\\d+)?\\?annotate=1`), (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fakeDocument }),
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
  const versionPicker = page.getByLabel("Version");
  await expect(versionPicker).toHaveValue("2");

  await page.frameLocator("iframe").locator("#select").click();
  await expect(page.getByPlaceholder("Add a comment…")).toBeVisible();

  await versionPicker.selectOption("1");
  await expect(page.getByPlaceholder("Add a comment…")).toHaveCount(0);

  await page.frameLocator("iframe").locator("#select").click();
  await page.getByPlaceholder("Add a comment…").fill("Reviewing v1");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => posted).not.toBeNull();
  expect(posted).toMatchObject({ version: 1, body: "Reviewing v1" });
});
