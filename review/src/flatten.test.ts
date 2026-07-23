// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { flatten } from "./anchor";

describe("flatten", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("excludes tooltip and mermaid chrome text from the flattened text", () => {
    document.body.innerHTML = [
      "<p>before</p>",
      '<div class="sd-ref-tooltip"><pre><code>class QuoteResult(BaseModel): ...</code></pre></div>',
      '<details class="sd-mermaid-source"><summary>Diagram source</summary><pre><code>flowchart LR</code></pre></details>',
      '<p class="sd-mermaid-error">Diagram could not be rendered.</p>',
      "<p>after</p>",
    ].join("");

    const flat = flatten(document.body);
    expect(flat.text).toBe("beforeafter");
  });

  it("keeps flattened text identical when names are wrapped in sd-ref spans", () => {
    document.body.innerHTML = "<pre><code>a: QuoteResult, b: int</code></pre>";
    const plain = flatten(document.body).text;

    document.body.innerHTML =
      '<pre><code>a: <span class="sd-ref" data-sd-ref="QuoteResult" tabindex="0" role="button">QuoteResult</span>, b: int</code></pre>';
    expect(flatten(document.body).text).toBe(plain);
  });
});
