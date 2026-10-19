import { useEffect, useState, type ReactNode } from "react";
import { t } from "../portal";

/**
 * The "Details" of a call's card in the chat, drawn as the portal draws a
 * tool call's (its classes are the portal's own): the call itself, what it was
 * given and what an error said whole, opened and closed under the picture.
 * The portal's card would draw the picture a second time.
 */

/**
 * Opens and closes by animating its height to what the content needs. Kept
 * mounted a moment after closing, so it can animate shut; not mounted at all
 * until first opened.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return setMounted(true);
    const timer = window.setTimeout(() => setMounted(false), 320);
    return () => window.clearTimeout(timer);
  }, [open]);
  return (
    <div className={`chat-collapse ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div className="chat-collapse-inner">{(open || mounted) && children}</div>
    </div>
  );
}

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** Text worth showing as code, or long enough to need its own lines. */
const isBlock = (v: string) => v.includes("\n") || v.length > 80;

/** A parameter's name as words: `outputFormat` and `output_format` are "Output format". */
function argLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/**
 * What a call was given, each parameter a label and its value: text as text,
 * long or many-lined text in a block of its own, a list as a list, and
 * whatever is inside an object the same way, a step in.
 */
export function ToolArgs({ input }: { input: Record<string, unknown> }) {
  if (!Object.keys(input).length) return <div className="chat-tool-label">{t("No parameters")}</div>;
  return <ArgValue value={input} depth={0} />;
}

/** Deeper than this, what is left is shown as the JSON it is. */
const ARG_DEPTH = 4;

function ArgValue({ value, depth }: { value: unknown; depth: number }): ReactNode {
  if (value === null || value === undefined) return <span className="chat-arg-none">{t("none")}</span>;
  if (typeof value === "boolean") return <span className="chat-arg-scalar">{value ? t("yes") : t("no")}</span>;
  // As written: 8080 is a port, not "8,080", and 0.0001 is not 0.
  if (typeof value === "number") return <span className="chat-arg-scalar tabular-nums">{String(value)}</span>;
  if (typeof value === "string") {
    if (!value) return <span className="chat-arg-none">{t("empty")}</span>;
    return isBlock(value) ? <pre className="chat-tool-value">{value}</pre> : <span className="chat-arg-scalar">{value}</span>;
  }
  if (depth >= ARG_DEPTH) return <pre className="chat-tool-value">{JSON.stringify(value, null, 2)}</pre>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="chat-arg-none">{t("none")}</span>;
    // A list of words is read down, one to a line.
    if (value.every(isScalar)) {
      return (
        <ul className="chat-arg-list">
          {value.map((v, i) => (
            <li key={i}>
              <ArgValue value={v} depth={depth + 1} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ol className="chat-arg-items">
        {value.map((v, i) => (
          <li key={i}>
            <span className="chat-arg-index" aria-hidden>
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <ArgValue value={v} depth={depth + 1} />
            </div>
          </li>
        ))}
      </ol>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <span className="chat-arg-none">{t("none")}</span>;
  return (
    <dl className={`chat-tool-args ${depth ? "is-nested" : ""}`}>
      {entries.map(([key, v]) => (
        // Short values beside their label; a block, a list or an object under it.
        <div key={key} className={isScalar(v) && !(typeof v === "string" && isBlock(v)) ? "is-inline" : ""}>
          <dt title={key}>{argLabel(key)}</dt>
          <dd>
            <ArgValue value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The call's name, what it was given, and what a failed one said. */
export function CallBody({ name, input, error }: { name: string; input: Record<string, unknown>; error?: string }) {
  return (
    <div className="chat-tool-body">
      <span className="chat-tool-name">{name}</span>
      <ToolArgs input={input} />
      {error && (
        <div className="chat-tool-output-wrap">
          <div className="chat-tool-label">{t("Error")}</div>
          <pre className="chat-tool-output is-error">{error}</pre>
        </div>
      )}
    </div>
  );
}
