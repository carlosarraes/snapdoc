import { useState } from "react";
import { api, formatDate, type TokenSecret } from "../api";
import { Banner, CopyButton, useAsync } from "../components";

export function Tokens() {
  const { data, error, loading, reload } = useAsync(() => api.listTokens(), []);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [secret, setSecret] = useState<TokenSecret | null>(null);

  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    setActionError("");
    try {
      const minted = await api.createToken(name.trim());
      setSecret(minted);
      setName("");
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string, tokenName: string) {
    if (!confirm(`Revoke token "${tokenName}"? Clients using it stop working.`)) return;
    try {
      await api.revokeToken(id);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <h2>
        <span className="prompt">$</span>tokens
      </h2>
      <p className="subtitle">API tokens for publishing and reading via the CLI.</p>

      <Banner msg={error || actionError} />

      {secret && (
        <div className="secret">
          <div className="warn">⚠ Copy this secret now — it is shown only once.</div>
          <div className="row">
            <code>{secret.token}</code>
            <CopyButton text={secret.token} label="copy secret" />
            <button className="btn btn-sm" onClick={() => setSecret(null)}>
              dismiss
            </button>
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 20 }}>
        <input
          placeholder="token name (e.g. ci-bot)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          style={{ minWidth: 240 }}
        />
        <button className="btn btn-primary" onClick={create} disabled={creating || !name.trim()}>
          {creating ? "minting…" : "mint token"}
        </button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data?.tokens ?? []).map((t) => (
              <tr key={t.id}>
                <td>
                  {t.name}
                  <div className="id">{t.id}</div>
                </td>
                <td className="muted">{formatDate(t.created_at)}</td>
                <td className="muted">{t.last_used_at ? formatDate(t.last_used_at) : "never"}</td>
                <td>
                  {t.revoked_at ? (
                    <span className="badge deleted">revoked</span>
                  ) : (
                    <span className="badge active">active</span>
                  )}
                </td>
                <td>
                  {!t.revoked_at && (
                    <button className="btn btn-sm btn-danger" onClick={() => revoke(t.id, t.name)}>
                      revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="loading">loading</div>}
        {!loading && (data?.tokens.length ?? 0) === 0 && <div className="empty">No tokens.</div>}
      </div>
    </>
  );
}
