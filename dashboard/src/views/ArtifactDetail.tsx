import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatBytes, formatDate, type Comment } from "../api";
import { Banner, CopyButton, useAsync } from "../components";

export function ArtifactDetail() {
  const { id = "" } = useParams();
  const meta = useAsync(() => api.getArtifact(id), [id]);
  const thread = useAsync(() => api.listComments(id), [id]);

  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [actionError, setActionError] = useState("");

  async function post() {
    if (!draft.trim()) return;
    setPosting(true);
    setActionError("");
    try {
      await api.addComment(id, draft.trim());
      setDraft("");
      thread.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  async function removeComment(c: Comment) {
    if (!confirm("Delete this comment?")) return;
    try {
      await api.deleteComment(c.id);
      thread.reload();
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

  const a = meta.data?.artifact;

  return (
    <>
      <p className="subtitle">
        <Link to="/">← artifacts</Link>
      </p>
      <h2>
        <span className="prompt">$</span>
        {a?.title || id}
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
              <dt>created</dt>
              <dd>{formatDate(a.created_at)}</dd>
              <dt>expires</dt>
              <dd>{formatDate(a.expires_at)}</dd>
            </dl>
          </div>

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
                      <a href={`${a.url}/v/${v.version}`} target="_blank" rel="noreferrer">
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

      <div className="section-label">comments</div>
      {thread.error && <Banner msg={thread.error} />}
      {(thread.data?.comments ?? []).map((c) => (
        <div className="comment" key={c.id}>
          <div className="head">
            <span className="author">{c.author}</span>
            <span>· v{c.version}</span>
            <span>· {formatDate(c.created_at)}</span>
            <div className="spacer" />
            <button className="btn btn-sm btn-danger" onClick={() => removeComment(c)}>
              delete
            </button>
          </div>
          <div className="body">{c.body}</div>
        </div>
      ))}
      {!thread.loading && (thread.data?.comments.length ?? 0) === 0 && (
        <p className="muted" style={{ marginBottom: 14 }}>
          No comments yet.
        </p>
      )}

      <textarea
        placeholder="Leave feedback…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" onClick={post} disabled={posting || !draft.trim()}>
          {posting ? "posting…" : "post comment"}
        </button>
      </div>
    </>
  );
}
