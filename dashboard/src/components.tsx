import { useCallback, useEffect, useState } from "react";
import { formatDate } from "./api";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(() => {
    setLoading(true);
    setError("");
    run()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [run]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export function Banner({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div className="banner">{msg}</div>;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

// Relative for the last week ("3 hours ago"), absolute beyond; full ISO on hover.
export function RelativeTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <span>{iso}</span>;
  const agoSec = (Date.now() - d.getTime()) / 1000;
  if (agoSec < 0 || agoSec >= 7 * 86400) {
    return <span title={d.toISOString()}>{formatDate(iso)}</span>;
  }
  let label = "just now";
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (agoSec >= secs) {
      label = RELATIVE.format(-Math.round(agoSec / secs), unit);
      break;
    }
  }
  return <span title={d.toISOString()}>{label}</span>;
}

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "copied ✓" : label}
    </button>
  );
}
