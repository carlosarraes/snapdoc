// Thin client for the public /v1/reader API. Same-origin (the review page is on
// the API host), so the sd_reviewer cookie rides along for self-delete.
export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface ReaderComment {
  id: string;
  author: string;
  author_kind: string;
  version: number;
  body: string;
  created_at: string;
  parent_id: string | null;
  resolved: boolean;
  anchor: Anchor | null;
}

export interface Meta {
  id: string;
  title: string | null;
  current_version: number;
  comments_enabled: boolean;
  versions: { version: number; created_at: string }[];
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
      // non-JSON error body — keep the generic message
    }
    throw new ApiError(code, message, res.headers.get("Retry-After") ?? undefined);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface PostCommentInput {
  author_name: string;
  author_email?: string;
  body: string;
  anchor?: Anchor;
  parent_id?: string;
  version?: number;
}

export const api = {
  meta: (id: string) => req<Meta>("GET", `/v1/reader/artifacts/${id}`),
  comments: (id: string) =>
    req<{ artifact_id: string; comments: ReaderComment[]; truncated?: boolean }>(
      "GET",
      `/v1/reader/artifacts/${id}/comments`,
    ),
  post: (id: string, input: PostCommentInput) =>
    req<ReaderComment>("POST", `/v1/reader/artifacts/${id}/comments`, input),
  remove: (cid: string) => req<{ id: string; deleted_at: string }>("DELETE", `/v1/reader/comments/${cid}`),
  // Resolves (or reopens) a thread; the server re-roots a reply id and
  // returns the updated root comment.
  resolve: (cid: string, resolved: boolean, authorName: string) =>
    req<ReaderComment>("PATCH", `/v1/reader/comments/${cid}`, { resolved, author_name: authorName }),
};

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
