import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

interface CopyButtonProps {
  text: string;
  label?: string;
  ariaLabel: string;
  copiedAnnouncement?: string;
  className?: string;
  statusPlacement?: "inline" | "sr-only";
}

async function copyTextSafe(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for non-HTTPS origins or restricted permissions
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}

export function CopyButton({
  text,
  label,
  ariaLabel,
  copiedAnnouncement = "已复制",
  className = "",
  statusPlacement = "inline",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const ok = await copyTextSafe(text);
    setCopied(ok);
    setFailed(!ok);
    setStatusMessage("");
    rafRef.current = window.requestAnimationFrame(() => {
      setStatusMessage(ok ? copiedAnnouncement : "复制失败，请手动复制");
      rafRef.current = null;
    });

    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
      setStatusMessage("");
      timerRef.current = null;
    }, 2000);
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={ariaLabel}
        className={`inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5 rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
          copied
            ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : failed
              ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        } ${label ? "px-2.5 py-1 text-xs font-medium" : "p-1.5"} ${className}`}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {label && <span>{label}</span>}
      </button>
      <span
        role="status"
        className={
          statusPlacement === "sr-only"
            ? "sr-only"
            : `text-xs font-medium whitespace-nowrap ${
                failed
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-emerald-600 dark:text-emerald-400"
              }`
        }
      >
        {statusMessage}
      </span>
    </span>
  );
}
