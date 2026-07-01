import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Anchor, type Meta, type ReaderComment, relativeTime } from "./api";

const rootEl = document.getElementById("root")!;
const ARTIFACT_ID = rootEl.dataset.artifactId ?? "";
// Prod: the worker injects the (cross-origin) artifact host. Dev: it's empty, so
// fall back to our own origin — the doc is same-origin under wrangler dev.
const ARTIFACT_ORIGIN = rootEl.dataset.artifactOrigin || location.origin;
const NAME_KEY = "snapdoc_reviewer_name";
const EMAIL_KEY = "snapdoc_reviewer_email";
const COLLAPSE_KEY = "snapdoc_rail_collapsed";

interface Identity {
  name: string;
  email: string;
}

type AnnMsg =
  | { source: "snapdoc-annotator"; type: "ready"; textLength: number }
  | { source: "snapdoc-annotator"; type: "selection"; anchor: Anchor }
  | { source: "snapdoc-annotator"; type: "selectionCleared" }
  | { source: "snapdoc-annotator"; type: "resolved"; results: { id: string; ok: boolean }[] }
  | { source: "snapdoc-annotator"; type: "highlightClicked"; id: string };

function docUrl(version: number, current: number): string {
  const path = version === current ? `/${ARTIFACT_ID}` : `/${ARTIFACT_ID}/v/${version}`;
  return `${ARTIFACT_ORIGIN}${path}?annotate=1`;
}

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [comments, setComments] = useState<ReaderComment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [pending, setPending] = useState<Anchor | null>(null);
  const [orphans, setOrphans] = useState<Set<string>>(new Set());
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  // Identity is captured once and reused for every comment this session.
  const [identity, setIdentity] = useState<Identity>(() => ({
    name: localStorage.getItem(NAME_KEY) ?? "",
    email: localStorage.getItem(EMAIL_KEY) ?? "",
  }));
  const [editingIdentity, setEditingIdentity] = useState(() => !localStorage.getItem(NAME_KEY));
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const roots = useMemo(() => comments.filter((c) => c.parent_id === null), [comments]);
  const repliesByRoot = useMemo(() => {
    const m = new Map<string, ReaderComment[]>();
    for (const c of comments) {
      if (!c.parent_id) continue;
      const arr = m.get(c.parent_id);
      if (arr) arr.push(c);
      else m.set(c.parent_id, [c]);
    }
    return m;
  }, [comments]);

  const sendToFrame = useCallback((msg: Record<string, unknown>) => {
    // The doc iframe is sandboxed without allow-same-origin, so its origin is
    // opaque ("null") and a specific targetOrigin would never match — the browser
    // would silently drop the message. "*" is safe here: the payload is only
    // public anchors/ids, and the annotator still validates source + tag.
    iframeRef.current?.contentWindow?.postMessage({ v: 1, source: "snapdoc-rail", ...msg }, "*");
  }, []);

  const renderAnchors = useCallback(() => {
    const anchors = roots.filter((c) => c.anchor).map((c) => ({ id: c.id, ...(c.anchor as Anchor) }));
    sendToFrame({ type: "render", anchors });
  }, [roots, sendToFrame]);

  // Scroll the document to a comment's span and mark both sides focused.
  const focusComment = useCallback(
    (id: string) => {
      setFocusId(id);
      sendToFrame({ type: "focus", id });
    },
    [sendToFrame],
  );

  const saveIdentity = useCallback((name: string, email: string) => {
    const n = name.trim();
    const e = email.trim();
    localStorage.setItem(NAME_KEY, n);
    localStorage.setItem(EMAIL_KEY, e);
    setIdentity({ name: n, email: e });
    setEditingIdentity(false);
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [m, c] = await Promise.all([api.meta(ARTIFACT_ID), api.comments(ARTIFACT_ID)]);
        if (!live) return;
        setMeta(m);
        setVersion(m.current_version);
        setComments(c.comments);
      } catch (e) {
        if (live) setLoadError(e instanceof ApiError ? e.message : "Failed to load this document.");
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Handle messages from the annotator inside the doc iframe.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as AnnMsg | null;
      if (!data || data.source !== "snapdoc-annotator") return;
      if (data.type === "ready") renderAnchors();
      else if (data.type === "selection") setPending(data.anchor);
      // selectionCleared is intentionally ignored: once compose is open, clicking
      // elsewhere in the doc should not discard what the reviewer is writing.
      else if (data.type === "resolved") setOrphans(new Set(data.results.filter((r) => !r.ok).map((r) => r.id)));
      else if (data.type === "highlightClicked") {
        setFocusId(data.id);
        cardRefs.current.get(data.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [renderAnchors]);

  // Re-render highlights whenever the anchored set changes.
  useEffect(() => {
    renderAnchors();
  }, [renderAnchors]);

  const submitRoot = useCallback(
    async (body: string) => {
      if (!pending || !identity.name) return;
      const created = await api.post(ARTIFACT_ID, {
        author_name: identity.name,
        author_email: identity.email || undefined,
        body,
        anchor: pending,
      });
      setComments((cs) => [...cs, created]);
      setMine((s) => new Set(s).add(created.id));
      setPending(null);
    },
    [pending, identity],
  );

  const submitReply = useCallback(
    async (parentId: string, body: string) => {
      if (!identity.name) return;
      const created = await api.post(ARTIFACT_ID, {
        author_name: identity.name,
        author_email: identity.email || undefined,
        body,
        parent_id: parentId,
      });
      setComments((cs) => [...cs, created]);
      setMine((s) => new Set(s).add(created.id));
      setReplyTo(null);
    },
    [identity],
  );

  const remove = useCallback(async (id: string) => {
    await api.remove(id);
    setComments((cs) => cs.filter((c) => c.id !== id && c.parent_id !== id));
  }, []);

  if (loadError) return <div className="rail-message error">{loadError}</div>;
  if (!meta || version === null) return <div className="rail-message">Loading…</div>;

  const orphanRoots = roots.filter((c) => orphans.has(c.id));
  const placedRoots = roots.filter((c) => !orphans.has(c.id));
  const hasName = !!identity.name;

  const threadProps = (c: ReaderComment, clickable: boolean) => ({
    root: c,
    replies: repliesByRoot.get(c.id) ?? [],
    focused: focusId === c.id,
    canDelete: mine.has(c.id),
    enabled: meta.comments_enabled,
    replying: replyTo === c.id,
    hasName,
    onFocus: clickable ? () => focusComment(c.id) : undefined,
    onReply: () => setReplyTo(c.id),
    onCancelReply: () => setReplyTo(null),
    onSubmitReply: submitReply,
    onNeedName: () => setEditingIdentity(true),
    onDelete: remove,
    registerRef: (el: HTMLDivElement | null) => {
      if (el) cardRefs.current.set(c.id, el);
    },
    canDeleteReply: (rid: string) => mine.has(rid),
  });

  return (
    <div className={`review${collapsed ? " collapsed" : ""}`}>
      {meta.comments_enabled ? (
        <iframe
          ref={iframeRef}
          className="doc"
          title="document"
          src={docUrl(version, meta.current_version)}
          sandbox="allow-scripts"
        />
      ) : (
        <div className="doc doc-disabled">
          <p>Commenting is turned off for this document.</p>
        </div>
      )}

      {collapsed && (
        <button className="rail-toggle" onClick={toggleCollapse} title="Show comments">
          💬 Comments{roots.length ? ` (${roots.length})` : ""}
        </button>
      )}

      <aside className="rail">
        <header className="rail-head">
          <div className="rail-title">
            <h1>{meta.title ?? "Untitled"}</h1>
            <button className="link" onClick={toggleCollapse} title="Hide comments">
              hide ✕
            </button>
          </div>
          <VersionPicker
            versions={meta.versions.map((v) => v.version)}
            current={meta.current_version}
            shown={version}
            onPick={setVersion}
          />
        </header>

        {meta.comments_enabled && (
          <IdentityBar identity={identity} editing={editingIdentity} onEdit={() => setEditingIdentity(true)} onSave={saveIdentity} />
        )}

        {meta.comments_enabled ? (
          pending ? (
            <ComposeRoot
              anchor={pending}
              hasName={hasName}
              onCancel={() => setPending(null)}
              onSubmit={submitRoot}
              onNeedName={() => setEditingIdentity(true)}
            />
          ) : (
            <p className="hint">Select text in the document to comment on it.</p>
          )
        ) : (
          <p className="hint">This document isn’t accepting comments. Existing comments are shown below.</p>
        )}

        <div className="thread-list">
          {placedRoots.length === 0 && orphanRoots.length === 0 && <p className="hint">No comments yet.</p>}
          {placedRoots.map((c) => (
            <Thread key={c.id} {...threadProps(c, true)} />
          ))}

          {orphanRoots.length > 0 && (
            <section className="orphans">
              <h2>Orphaned ({orphanRoots.length})</h2>
              <p className="hint">The text these comments referred to has changed in this version.</p>
              {orphanRoots.map((c) => (
                <Thread key={c.id} {...threadProps(c, false)} orphaned />
              ))}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function VersionPicker(props: { versions: number[]; current: number; shown: number; onPick: (v: number) => void }) {
  if (props.versions.length <= 1) return null;
  return (
    <label className="version-picker">
      Version{" "}
      <select value={props.shown} onChange={(e) => props.onPick(Number(e.target.value))}>
        {props.versions.map((v) => (
          <option key={v} value={v}>
            v{v}
            {v === props.current ? " (latest)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// One-time identity: captured on first use, editable, reused for every comment.
function IdentityBar(props: {
  identity: Identity;
  editing: boolean;
  onEdit: () => void;
  onSave: (name: string, email: string) => void;
}) {
  const [name, setName] = useState(props.identity.name);
  const [email, setEmail] = useState(props.identity.email);
  useEffect(() => {
    setName(props.identity.name);
    setEmail(props.identity.email);
  }, [props.identity]);

  if (!props.editing && props.identity.name) {
    return (
      <div className="identity">
        <span>
          Commenting as <strong>{props.identity.name}</strong>
        </span>
        <button className="link" onClick={props.onEdit}>
          edit
        </button>
      </div>
    );
  }
  return (
    <form
      className="identity-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) props.onSave(name, email);
      }}
    >
      <input placeholder="Your name" value={name} required maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
      <input placeholder="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button type="submit" disabled={!name.trim()}>
        Save
      </button>
    </form>
  );
}

function ComposeRoot(props: {
  anchor: Anchor;
  hasName: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
  onNeedName: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await props.onSubmit(body.trim());
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Could not post the comment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="compose" onSubmit={submit}>
      <blockquote className="quote">{props.anchor.exact}</blockquote>
      <textarea placeholder="Add a comment…" value={body} required rows={3} autoFocus onChange={(e) => setBody(e.target.value)} />
      {err && <p className="error">{err}</p>}
      {!props.hasName && (
        <button type="button" className="link" onClick={props.onNeedName}>
          Add your name above to post
        </button>
      )}
      <div className="actions">
        <button type="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !body.trim() || !props.hasName}>
          {busy ? "Posting…" : "Comment"}
        </button>
      </div>
    </form>
  );
}

function Thread(props: {
  root: ReaderComment;
  replies: ReaderComment[];
  focused: boolean;
  canDelete: boolean;
  enabled: boolean;
  replying: boolean;
  hasName: boolean;
  orphaned?: boolean;
  onFocus?: () => void;
  onReply: () => void;
  onCancelReply: () => void;
  onSubmitReply: (parentId: string, body: string) => Promise<void>;
  onNeedName: () => void;
  onDelete: (id: string) => Promise<void>;
  registerRef: (el: HTMLDivElement | null) => void;
  canDeleteReply: (id: string) => boolean;
}) {
  return (
    <div ref={props.registerRef} className={`thread${props.focused ? " focused" : ""}`}>
      <CommentCard comment={props.root} canDelete={props.canDelete} onDelete={props.onDelete} onCardClick={props.onFocus} />
      {props.replies.map((r) => (
        <CommentCard key={r.id} comment={r} reply canDelete={props.canDeleteReply(r.id)} onDelete={props.onDelete} />
      ))}
      {props.enabled &&
        (props.replying ? (
          <ReplyBox
            parentId={props.root.id}
            hasName={props.hasName}
            onCancel={props.onCancelReply}
            onSubmit={props.onSubmitReply}
            onNeedName={props.onNeedName}
          />
        ) : (
          <button className="link" onClick={props.onReply}>
            Reply
          </button>
        ))}
    </div>
  );
}

function CommentCard(props: {
  comment: ReaderComment;
  reply?: boolean;
  canDelete: boolean;
  onDelete: (id: string) => Promise<void>;
  onCardClick?: () => void;
}) {
  const c = props.comment;
  return (
    <div
      className={`card${props.reply ? " reply" : ""}${props.onCardClick ? " clickable" : ""}`}
      onClick={props.onCardClick}
      title={props.onCardClick ? "Jump to this comment in the document" : undefined}
    >
      {c.anchor && !props.reply && <blockquote className="quote">{c.anchor.exact}</blockquote>}
      <div className="meta">
        <span className="author">{c.author}</span>
        <span className="time">{relativeTime(c.created_at)}</span>
        {props.canDelete && (
          <button
            className="link danger"
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete(c.id);
            }}
          >
            Delete
          </button>
        )}
      </div>
      <p className="body">{c.body}</p>
    </div>
  );
}

function ReplyBox(props: {
  parentId: string;
  hasName: boolean;
  onCancel: () => void;
  onSubmit: (parentId: string, body: string) => Promise<void>;
  onNeedName: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await props.onSubmit(props.parentId, body.trim());
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Could not post the reply.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="compose reply-box" onSubmit={submit}>
      <textarea placeholder="Reply…" value={body} required rows={2} autoFocus onChange={(e) => setBody(e.target.value)} />
      {err && <p className="error">{err}</p>}
      {!props.hasName && (
        <button type="button" className="link" onClick={props.onNeedName}>
          Add your name above to post
        </button>
      )}
      <div className="actions">
        <button type="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !body.trim() || !props.hasName}>
          {busy ? "Posting…" : "Reply"}
        </button>
      </div>
    </form>
  );
}
