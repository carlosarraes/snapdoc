import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatBytes, formatDate, type Comment } from "../api";
import { Banner, CopyButton, RelativeTime, useAsync } from "../components";

type StatusFilter = "all" | "open" | "resolved";

// mm:ss (h:mm:ss past an hour); durationMs is always non-negative for videos.
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function ArtifactDetail() {
  const { id = "" } = useParams();
  const meta = useAsync(() => api.getArtifact(id), [id]);

  const [status, setStatus] = useState<StatusFilter>("all");
  const thread = useAsync(() => api.listComments(id, status === "all" ? undefined : status), [id, status]);

  // Local copy of the thread so mutations patch in place (no full reload/flicker).
  // Re-synced whenever a fetch lands (filter change or manual refresh).
  const [comments, setComments] = useState<Comment[]>([]);
  useEffect(() => {
    if (thread.data) setComments(thread.data.comments);
  }, [thread.data]);

  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [actionError, setActionError] = useState("");

  function upsert(c: Comment) {
    setComments((prev) => {
      const i = prev.findIndex((x) => x.id === c.id);
      if (i === -1) return [...prev, c];
      const next = prev.slice();
      next[i] = c;
      return next;
    });
  }

  async function postRoot() {
    if (!draft.trim()) return;
    setPosting(true);
    setActionError("");
    try {
      upsert(await api.addComment(id, draft.trim()));
      setDraft("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  async function postReply(rootId: string) {
    if (!replyDraft.trim()) return;
    setActionError("");
    try {
      upsert(await api.addComment(id, replyDraft.trim(), rootId));
      setReplyDraft("");
      setReplyTo(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleResolved(c: Comment) {
    setActionError("");
    try {
      upsert(await api.resolveComment(c.id, !c.resolved));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeComment(c: Comment) {
    if (!confirm(c.parent_id ? "Delete this reply?" : "Delete this thread (and its replies)?")) return;
    setActionError("");
    try {
      await api.deleteComment(c.id);
      // Drop the comment plus, for a root, its replies (server cascades these).
      setComments((prev) => prev.filter((x) => x.id !== c.id && x.parent_id !== c.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function expire() {
    if (!confirm("Expire this artifact now?")) return;
    try {
      await api.expireArtifact(id);
      meta.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove() {
    if (!confirm("Delete this artifact and its content?")) return;
    try {
      await api.deleteArtifact(id);
      meta.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleComments(enabled: boolean) {
    setActionError("");
    try {
      await api.setCommentsEnabled(id, enabled);
      meta.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  const a = meta.data?.artifact;
  const reviewUrl = `${location.origin}/review/${id}`;

  const roots = comments.filter((c) => c.parent_id === null);
  const repliesByRoot = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parent_id) {
      const arr = repliesByRoot.get(c.parent_id);
      if (arr) arr.push(c);
      else repliesByRoot.set(c.parent_id, [c]);
    }
  }

  return (
    <>
      <p className="subtitle">
        <Link to="/">← artifacts</Link>
      </p>
      <h2>
        <span className="prompt">$</span>
        {a?.title || id}
        {a && <span className={`kind-badge ${a.kind}`}>{a.kind}</span>}
      </h2>
      <p className="subtitle">{id}</p>

      <Banner msg={meta.error || actionError} />
      {meta.loading && <div className="loading">loading</div>}

      {a && (
        <>
          <div className="row" style={{ marginBottom: 18 }}>
            <a className="btn" href={a.url} target="_blank" rel="noreferrer">
              open ↗
            </a>
            <CopyButton text={a.url} label="copy url" />
            {a.status === "active" && (
              <button className="btn" onClick={expire}>
                expire
              </button>
            )}
            {a.kind !== "video" && a.status === "active" && (
              <button className="btn" onClick={() => toggleComments(!a.comments_enabled)}>
                {a.comments_enabled ? "disable comments" : "enable comments"}
              </button>
            )}
            {a.status !== "deleted" && (
              <button className="btn btn-danger" onClick={remove}>
                delete
              </button>
            )}
          </div>

          <div className="card">
            <dl className="meta-grid">
              <dt>status</dt>
              <dd>
                <span className={`badge ${a.status}`}>{a.status}</span>
                {a.has_passcode && <span className="lock">🔒 passcode</span>}
              </dd>
              <dt>version</dt>
              <dd>{a.current_version}</dd>
              <dt>type</dt>
              <dd>{a.content_type}</dd>
              <dt>size</dt>
              <dd>{formatBytes(a.size_bytes)}</dd>
              <dt>token</dt>
              <dd>{a.token_name ?? "—"}</dd>
              {a.kind === "video" && a.duration_ms != null && (
                <>
                  <dt>duration</dt>
                  <dd>{formatDuration(a.duration_ms)}</dd>
                </>
              )}
              {a.kind === "video" && a.width != null && a.height != null && (
                <>
                  <dt>dimensions</dt>
                  <dd>
                    {a.width}×{a.height}
                  </dd>
                </>
              )}
              {a.kind === "video" && a.video_codec && (
                <>
                  <dt>codecs</dt>
                  <dd>
                    video: {a.video_codec}, audio: {a.audio_codec ?? "none"}
                  </dd>
                </>
              )}
              {a.kind !== "video" && (
                <>
                  <dt>comments</dt>
                  <dd>
                    {a.comments_enabled ? (
                      <>
                        <span className="badge active">on</span>{" "}
                        <a href={reviewUrl} target="_blank" rel="noreferrer">
                          review ↗
                        </a>
                      </>
                    ) : (
                      <span className="muted">off</span>
                    )}
                  </dd>
                </>
              )}
              <dt>created</dt>
              <dd>{formatDate(a.created_at)}</dd>
              <dt>expires</dt>
              <dd className={a.kind === "video" ? "expires-soon" : undefined}>{formatDate(a.expires_at)}</dd>
            </dl>
          </div>

          {a.kind === "video" && (
            <>
              <div className="section-label">video</div>
              <div className="card" style={{ padding: 16 }}>
                {a.has_passcode ? (
                  // The admin dashboard's origin never holds the reader's
                  // sd_unlock_{id} cookie (it's only ever set by the watch
                  // page's own unlock flow), so a direct <video src> here
                  // would just 401 against a black player.
                  <p className="muted">
                    passcode-protected — open the{" "}
                    <a href={a.url} target="_blank" rel="noreferrer">
                      watch page
                    </a>{" "}
                    to view.
                  </p>
                ) : (
                  <video
                    className="video-player"
                    controls
                    preload="metadata"
                    src={a.file_url}
                    poster={a.poster_url ?? undefined}
                  />
                )}
                <div className="row" style={{ marginTop: 12 }}>
                  {a.file_url && <CopyButton text={a.file_url} label="copy file url" />}
                </div>
              </div>
            </>
          )}

          <div className="section-label">versions</div>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th className="num">Ver</th>
                  <th className="num">Size</th>
                  <th>Type</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {meta.data?.versions.map((v) => (
                  <tr key={v.version}>
                    <td className="num">{v.version}</td>
                    <td className="num">{formatBytes(v.size_bytes)}</td>
                    <td className="muted">{v.content_type}</td>
                    <td className="muted">{formatDate(v.created_at)}</td>
                    <td>
                      {v.kind === "video" ? (
                        <div className="actions">
                          {v.version_url && (
                            <a href={v.version_url} target="_blank" rel="noreferrer">
                              watch ↗
                            </a>
                          )}
                          {v.version_file_url && (
                            <a href={v.version_file_url} target="_blank" rel="noreferrer">
                              file ↗
                            </a>
                          )}
                          {v.version_poster_url && (
                            <a href={v.version_poster_url} target="_blank" rel="noreferrer">
                              poster ↗
                            </a>
                          )}
                        </div>
                      ) : (
                        <a href={`${a.url}/v/${v.version}`} target="_blank" rel="noreferrer">
                          view ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {a.kind !== "video" && meta.data?.assets && meta.data.assets.length > 0 && (
            <>
              <div className="section-label">images ({meta.data.assets.length})</div>
              <div className="card">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th className="num">Size</th>
                      <th>Hash</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.data.assets.map((asset) => (
                      <tr key={asset.hash}>
                        <td className="muted">{asset.content_type}</td>
                        <td className="num">{formatBytes(asset.size_bytes)}</td>
                        <td className="muted">{asset.hash.slice(0, 12)}…</td>
                        <td>
                          <a href={asset.url} target="_blank" rel="noreferrer">
                            view ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      <div className="section-label">comments</div>
      <div className="row filter-row">
        {(["all", "open", "resolved"] as const).map((s) => (
          <button key={s} className={`chip ${status === s ? "active" : ""}`} onClick={() => setStatus(s)}>
            {s}
          </button>
        ))}
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => thread.reload()} disabled={thread.loading}>
          {thread.loading ? "…" : "refresh"}
        </button>
      </div>
      {thread.error && <Banner msg={thread.error} />}

      {roots.map((c) => {
        const replies = repliesByRoot.get(c.id) ?? [];
        return (
          <div className={`comment${c.resolved ? " resolved" : ""}`} key={c.id}>
            <div className="head">
              <span className="author">{c.author}</span>
              {c.author_kind === "anon" && <span className="badge reader">reader</span>}
              {c.author_email && <span className="muted">({c.author_email})</span>}
              <span>· v{c.version}</span>
              <span>
                · <RelativeTime iso={c.created_at} />
              </span>
              {c.resolved && (
                <>
                  <span className="badge resolved">resolved</span>
                  {c.resolved_by && <span className="muted">by {c.resolved_by}</span>}
                </>
              )}
              <div className="spacer" />
              <button className="btn btn-sm" onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>
                reply
              </button>
              <button className="btn btn-sm" onClick={() => toggleResolved(c)}>
                {c.resolved ? "reopen" : "resolve"}
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => removeComment(c)}>
                delete
              </button>
            </div>
            {c.anchor && <blockquote className="quote">{c.anchor.exact}</blockquote>}
            <div className="body">{c.body}</div>

            {replies.map((r) => (
              <div className="comment reply" key={r.id}>
                <div className="head">
                  <span className="author">{r.author}</span>
                  {r.author_kind === "anon" && <span className="badge reader">reader</span>}
                  {r.author_email && <span className="muted">({r.author_email})</span>}
                  <span>· v{r.version}</span>
                  <span>
                    · <RelativeTime iso={r.created_at} />
                  </span>
                  <div className="spacer" />
                  <button className="btn btn-sm btn-danger" onClick={() => removeComment(r)}>
                    delete
                  </button>
                </div>
                <div className="body">{r.body}</div>
              </div>
            ))}

            {replyTo === c.id && (
              <div className="reply-box">
                <textarea
                  placeholder="Reply…"
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                />
                <div className="row" style={{ marginTop: 6 }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => postReply(c.id)}
                    disabled={!replyDraft.trim()}
                  >
                    reply
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setReplyTo(null);
                      setReplyDraft("");
                    }}
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {!thread.loading && roots.length === 0 && (
        <p className="muted" style={{ marginBottom: 14 }}>
          No comments yet.
        </p>
      )}

      <textarea placeholder="Leave feedback…" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" onClick={postRoot} disabled={posting || !draft.trim()}>
          {posting ? "posting…" : "post comment"}
        </button>
      </div>
    </>
  );
}
