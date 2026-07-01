import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Anchor, type Meta, type ReaderComment, relativeTime } from "./api";

const rootEl = document.getElementById("root")!;
const ARTIFACT_ID = rootEl.dataset.artifactId ?? "";
const ARTIFACT_ORIGIN = rootEl.dataset.artifactOrigin ?? "";
const NAME_KEY = "snapdoc_reviewer_name";

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
    iframeRef.current?.contentWindow?.postMessage({ v: 1, source: "snapdoc-rail", ...msg }, ARTIFACT_ORIGIN);
  }, []);

  const renderAnchors = useCallback(() => {
    const anchors = roots.filter((c) => c.anchor).map((c) => ({ id: c.id, ...(c.anchor as Anchor) }));
    sendToFrame({ type: "render", anchors });
  }, [roots, sendToFrame]);

  // Load metadata + comments.
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
    async (author: string, email: string, body: string) => {
      if (!pending) return;
      const created = await api.post(ARTIFACT_ID, {
        author_name: author,
        author_email: email || undefined,
        body,
        anchor: pending,
      });
      setComments((cs) => [...cs, created]);
      setMine((s) => new Set(s).add(created.id));
      setPending(null);
    },
    [pending],
  );

  const submitReply = useCallback(async (parentId: string, author: string, body: string) => {
    const created = await api.post(ARTIFACT_ID, { author_name: author, body, parent_id: parentId });
    setComments((cs) => [...cs, created]);
    setMine((s) => new Set(s).add(created.id));
    setReplyTo(null);
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.remove(id);
    setComments((cs) => cs.filter((c) => c.id !== id && c.parent_id !== id));
  }, []);

  if (loadError) return <div className="rail-message error">{loadError}</div>;
  if (!meta || version === null) return <div className="rail-message">Loading…</div>;

  const orphanRoots = roots.filter((c) => orphans.has(c.id));
  const placedRoots = roots.filter((c) => !orphans.has(c.id));

  return (
    <div className="review">
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

      <aside className="rail">
        <header className="rail-head">
          <h1>{meta.title ?? "Untitled"}</h1>
          <VersionPicker
            versions={meta.versions.map((v) => v.version)}
            current={meta.current_version}
            shown={version}
            onPick={setVersion}
          />
        </header>

        {meta.comments_enabled ? (
          pending ? (
            <ComposeRoot anchor={pending} onCancel={() => setPending(null)} onSubmit={submitRoot} />
          ) : (
            <p className="hint">Select text in the document to comment on it.</p>
          )
        ) : (
          <p className="hint">This document isn’t accepting comments. Existing comments are shown below.</p>
        )}

        <div className="thread-list">
          {placedRoots.length === 0 && orphanRoots.length === 0 && <p className="hint">No comments yet.</p>}
          {placedRoots.map((c) => (
            <Thread
              key={c.id}
              root={c}
              replies={repliesByRoot.get(c.id) ?? []}
              focused={focusId === c.id}
              canDelete={mine.has(c.id)}
              enabled={meta.comments_enabled}
              replying={replyTo === c.id}
              onFocus={() => sendToFrame({ type: "focus", id: c.id })}
              onReply={() => setReplyTo(c.id)}
              onCancelReply={() => setReplyTo(null)}
              onSubmitReply={submitReply}
              onDelete={remove}
              registerRef={(el) => el && cardRefs.current.set(c.id, el)}
              canDeleteReply={(rid) => mine.has(rid)}
            />
          ))}

          {orphanRoots.length > 0 && (
            <section className="orphans">
              <h2>Orphaned ({orphanRoots.length})</h2>
              <p className="hint">The text these comments referred to has changed in this version.</p>
              {orphanRoots.map((c) => (
                <Thread
                  key={c.id}
                  root={c}
                  replies={repliesByRoot.get(c.id) ?? []}
                  focused={false}
                  canDelete={mine.has(c.id)}
                  enabled={meta.comments_enabled}
                  replying={replyTo === c.id}
                  orphaned
                  onFocus={() => {}}
                  onReply={() => setReplyTo(c.id)}
                  onCancelReply={() => setReplyTo(null)}
                  onSubmitReply={submitReply}
                  onDelete={remove}
                  registerRef={() => {}}
                  canDeleteReply={(rid) => mine.has(rid)}
                />
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

function ComposeRoot(props: {
  anchor: Anchor;
  onCancel: () => void;
  onSubmit: (author: string, email: string, body: string) => Promise<void>;
}) {
  const [author, setAuthor] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [email, setEmail] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      localStorage.setItem(NAME_KEY, author.trim());
      await props.onSubmit(author.trim(), email.trim(), body.trim());
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Could not post the comment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="compose" onSubmit={submit}>
      <blockquote className="quote">{props.anchor.exact}</blockquote>
      <input placeholder="Your name" value={author} required maxLength={80} onChange={(e) => setAuthor(e.target.value)} />
      <input placeholder="Email (optional)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <textarea placeholder="Add a comment…" value={body} required rows={3} onChange={(e) => setBody(e.target.value)} />
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button type="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !author.trim() || !body.trim()}>
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
  orphaned?: boolean;
  onFocus: () => void;
  onReply: () => void;
  onCancelReply: () => void;
  onSubmitReply: (parentId: string, author: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  registerRef: (el: HTMLDivElement | null) => void;
  canDeleteReply: (id: string) => boolean;
}) {
  return (
    <div ref={props.registerRef} className={`thread${props.focused ? " focused" : ""}`}>
      <CommentCard
        comment={props.root}
        canDelete={props.canDelete}
        onDelete={props.onDelete}
        onQuoteClick={props.orphaned ? undefined : props.onFocus}
      />
      {props.replies.map((r) => (
        <CommentCard key={r.id} comment={r} reply canDelete={props.canDeleteReply(r.id)} onDelete={props.onDelete} />
      ))}
      {props.enabled &&
        (props.replying ? (
          <ReplyBox parentId={props.root.id} onCancel={props.onCancelReply} onSubmit={props.onSubmitReply} />
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
  onQuoteClick?: () => void;
}) {
  const c = props.comment;
  return (
    <div className={`card${props.reply ? " reply" : ""}`}>
      {c.anchor && !props.reply && (
        <blockquote className={`quote${props.onQuoteClick ? " clickable" : ""}`} onClick={props.onQuoteClick}>
          {c.anchor.exact}
        </blockquote>
      )}
      <div className="meta">
        <span className="author">{c.author}</span>
        <span className="time">{relativeTime(c.created_at)}</span>
        {props.canDelete && (
          <button className="link danger" onClick={() => props.onDelete(c.id)}>
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
  onCancel: () => void;
  onSubmit: (parentId: string, author: string, body: string) => Promise<void>;
}) {
  const [author, setAuthor] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      localStorage.setItem(NAME_KEY, author.trim());
      await props.onSubmit(props.parentId, author.trim(), body.trim());
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "Could not post the reply.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="compose reply-box" onSubmit={submit}>
      <input placeholder="Your name" value={author} required maxLength={80} onChange={(e) => setAuthor(e.target.value)} />
      <textarea placeholder="Reply…" value={body} required rows={2} onChange={(e) => setBody(e.target.value)} />
      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button type="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !author.trim() || !body.trim()}>
          {busy ? "Posting…" : "Reply"}
        </button>
      </div>
    </form>
  );
}
