// Thin client for the /v1/admin API. Same-origin fetch rides the Cloudflare
// Access session; the SPA does no auth itself. All business rules are server-side.

export interface Artifact {
  id: string;
  url: string;
  title: string | null;
  status: "active" | "expired" | "deleted";
  current_version: number;
  content_type: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
  has_passcode: boolean;
  comments_enabled: boolean;
  token_name?: string | null;
}

export interface Version {
  version: number;
  size_bytes: number;
  content_type: string;
  created_at: string;
}

export interface Asset {
  hash: string;
  content_type: string;
  size_bytes: number;
  url: string;
  created_at: string;
}

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface Comment {
  id: string;
  author: string;
  author_kind: "access" | "anon";
  version: number;
  body: string;
  created_at: string;
  parent_id: string | null;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  author_email?: string | null;
  anchor?: Anchor | null;
}

export interface TokenInfo {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface TokenSecret {
  id: string;
  name: string;
  token: string;
  created_at: string;
}

export class ApiError extends Error {
  code: string;
  retryAfter?: string;
  constructor(code: string, message: string, retryAfter?: string) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed (${res.status}).`;
    try {
      const j = (await res.json()) as { error?: { code: string; message: string } };
      if (j.error) {
        code = j.error.code;
        message = j.error.message;
      }
    } catch {
      // non-JSON error body (e.g. an Access/proxy page) — keep the generic message
    }
    throw new ApiError(code, message, res.headers.get("Retry-After") ?? undefined);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listArtifacts: (params: { status?: string; cursor?: string }) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return req<{ artifacts: Artifact[]; next_cursor: string | null }>(
      "GET",
      `/v1/admin/artifacts${qs ? `?${qs}` : ""}`,
    );
  },
  getArtifact: (id: string) =>
    req<{ artifact: Artifact; versions: Version[]; assets?: Asset[] }>("GET", `/v1/admin/artifacts/${id}`),
  expireArtifact: (id: string) => req<Artifact>("POST", `/v1/admin/artifacts/${id}/expire`),
  deleteArtifact: (id: string) =>
    req<{ id: string; status: string }>("DELETE", `/v1/admin/artifacts/${id}`),
  setCommentsEnabled: (id: string, enabled: boolean) =>
    req<Artifact>("POST", `/v1/admin/artifacts/${id}/comment-settings`, { enabled }),

  listComments: (id: string, status?: string) =>
    req<{ artifact_id: string; comments: Comment[]; truncated?: boolean }>(
      "GET",
      `/v1/admin/artifacts/${id}/comments${status ? `?status=${status}` : ""}`,
    ),
  addComment: (id: string, body: string, parentId?: string) =>
    req<Comment>(
      "POST",
      `/v1/admin/artifacts/${id}/comments`,
      parentId ? { body, parent_id: parentId } : { body },
    ),
  resolveComment: (cid: string, resolved: boolean) =>
    req<Comment>("PATCH", `/v1/admin/comments/${cid}`, { resolved }),
  deleteComment: (cid: string) =>
    req<{ id: string; deleted_at: string }>("DELETE", `/v1/admin/comments/${cid}`),

  listTokens: () => req<{ tokens: TokenInfo[] }>("GET", "/v1/admin/tokens"),
  createToken: (name: string) => req<TokenSecret>("POST", "/v1/admin/tokens", { name }),
  revokeToken: (id: string) =>
    req<{ id: string; revoked_at: string }>("DELETE", `/v1/admin/tokens/${id}`),
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}
