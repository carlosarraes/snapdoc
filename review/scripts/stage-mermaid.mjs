import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "11.15.0";
const EXPECTED_SHA384 = "yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const source = resolve(scriptDir, `../node_modules/mermaid-11-15-0/dist/mermaid.min.js`);
const outputDir = resolve(scriptDir, "../../worker/public/review");
const destination = resolve(outputDir, `mermaid-${VERSION}.min.js`);

const bytes = await readFile(source);
const actual = createHash("sha384").update(bytes).digest("base64");
if (actual !== EXPECTED_SHA384) {
  throw new Error(`Mermaid ${VERSION} integrity mismatch: expected ${EXPECTED_SHA384}, got ${actual}`);
}

await mkdir(outputDir, { recursive: true });
await copyFile(source, destination);
