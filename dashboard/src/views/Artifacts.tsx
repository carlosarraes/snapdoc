import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatBytes, formatDate, type Artifact } from "../api";
import { Banner, CopyButton } from "../components";

const STATUSES = ["", "active", "expired", "deleted"];

export function Artifacts() {
  const [status, setStatus] = useState("");
  const [filter, setFilter] = useState("");
  const [items, setItems] = useState<Artifact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function fetchPage(reset: boolean, cur: string | null) {
    setLoading(true);
    setError("");
    try {
      const r = await api.listArtifacts({
        status: status || undefined,
        cursor: reset ? undefined : (cur ?? undefined),
      });
      setItems((prev) => (reset ? r.artifacts : [...prev, ...r.artifacts]));
      setCursor(r.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Reset and reload whenever the status filter changes (and on mount).
  useEffect(() => {
    fetchPage(true, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function patch(id: string, next: Partial<Artifact>) {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...next } : a)));
  }

  async function expire(a: Artifact) {
    try {
      const updated = await api.expireArtifact(a.id);
      patch(a.id, { status: updated.status });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(a: Artifact) {
    if (!confirm(`Delete artifact ${a.id}? This removes its content.`)) return;
    try {
      await api.deleteArtifact(a.id);
      patch(a.id, { status: "deleted" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? items.filter((a) =>
        [a.title ?? "", a.id, a.token_name ?? ""].some((s) => s.toLowerCase().includes(needle)),
      )
    : items;

  return (
    <>
      <h2>
        <span className="prompt">$</span>artifacts
      </h2>
      <p className="subtitle">Published artifacts across all tokens.</p>

      <div className="row" style={{ marginBottom: 16 }}>
        <input
          placeholder="filter title / id / token…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ minWidth: 260 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s || "all statuses"}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() => fetchPage(true, null)}>
          refresh
        </button>
      </div>

      <Banner msg={error} />

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th className="num">Ver</th>
              <th className="num">Size</th>
              <th>Expires</th>
              <th>Token</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id}>
                <td className="title-cell">
                  <Link to={`/a/${a.id}`}>{a.title || "(untitled)"}</Link>
                  <div className="id">{a.id}</div>
                </td>
                <td>
                  <span className={`badge ${a.status}`}>{a.status}</span>
                  <span className={`kind-badge ${a.kind}`}>{a.kind}</span>
                  {a.has_passcode && <span className="lock" title="passcode-protected">🔒</span>}
                </td>
                <td className="num">{a.current_version}</td>
                <td className="num">{formatBytes(a.size_bytes)}</td>
                <td className="muted">{formatDate(a.expires_at)}</td>
                <td className="muted">{a.token_name ?? "—"}</td>
                <td>
                  <div className="actions">
                    <CopyButton text={a.url} label="url" />
                    {a.status === "active" && (
                      <button className="btn btn-sm" onClick={() => expire(a)}>
                        expire
                      </button>
                    )}
                    {a.status !== "deleted" && (
                      <button className="btn btn-sm btn-danger" onClick={() => remove(a)}>
                        delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="loading">loading</div>}
        {!loading && shown.length === 0 && <div className="empty">No artifacts.</div>}
      </div>

      {cursor && !loading && (
        <div className="row" style={{ marginTop: 16, justifyContent: "center" }}>
          <button className="btn" onClick={() => fetchPage(false, cursor)}>
            load more
          </button>
        </div>
      )}
    </>
  );
}
