// Hosted-image support: detect/allow raster types, and rewrite a document's
// local <img src> references to their content-addressed hosted URLs.

// Raster formats only. SVG is intentionally excluded: it can carry inline
// <script> that executes if a viewer navigates directly to the asset URL,
// which would be stored-XSS in the artifact origin.
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

function matchesAscii(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

// Sniffs the image type from magic bytes, ignoring any client-declared type.
// Returns a canonical MIME from ALLOWED_IMAGE_TYPES, or null if unrecognized.
export function detectImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && matchesAscii(bytes, 0, "GIF8")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (bytes.length >= 12 && matchesAscii(bytes, 4, "ftyp") && (matchesAscii(bytes, 8, "avif") || matchesAscii(bytes, 8, "avis"))) {
    return "image/avif";
  }
  return null;
}

// A bare relative path that could name a local file the author bundled — i.e.
// not a URL (scheme or protocol-relative), not a root-absolute path, not a
// fragment. Only these are candidates for rewriting/upload.
export function isLocalRef(src: string): boolean {
  if (!src) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false; // http:, https:, data:, blob:, mailto:
  if (src.startsWith("//")) return false; // protocol-relative
  if (src.startsWith("/")) return false; // root-absolute
  if (src.startsWith("#")) return false; // fragment-only
  return true;
}

// Canonical form for matching a document ref against an uploaded part filename:
// percent-decode, drop a leading "./", and strip any ?query/#fragment.
export function normalizeRef(ref: string): string {
  let s = ref;
  try {
    s = decodeURIComponent(ref);
  } catch {
    s = ref;
  }
  s = s.replace(/^\.\//, "");
  const cut = s.search(/[?#]/);
  return cut === -1 ? s : s.slice(0, cut);
}

export interface RewriteResult {
  html: string;
  unresolved: string[];
}

// Rewrites <img src> values for local refs that resolve to a hosted asset,
// leaving remote/data/absolute refs untouched. Local refs with no matching
// asset are left as-is and reported in `unresolved`. Uses the runtime's
// streaming HTMLRewriter, so it never builds a DOM.
export async function rewriteImageRefs(
  html: string,
  resolve: (normalizedRef: string) => string | null,
): Promise<RewriteResult> {
  const unresolved = new Set<string>();
  const rewriter = new HTMLRewriter().on("img", {
    element(el) {
      const src = el.getAttribute("src");
      if (!src || !isLocalRef(src)) return;
      const url = resolve(normalizeRef(src));
      if (url) el.setAttribute("src", url);
      else unresolved.add(src);
    },
  });
  const transformed = rewriter.transform(new Response(html));
  const out = await transformed.text();
  return { html: out, unresolved: [...unresolved] };
}
