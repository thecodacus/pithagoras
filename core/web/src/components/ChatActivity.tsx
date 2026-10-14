import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNow } from "../use-now";
import {
  LuBot,
  LuBrain,
  LuChevronRight,
  LuCircleSlash,
  LuFilePen,
  LuFilePlus,
  LuFileSearch,
  LuFileText,
  LuFoldVertical,
  LuGlobe,
  LuImage,
  LuListTodo,
  LuSearch,
  LuSquareTerminal,
  LuTriangleAlert,
  LuWrench,
  LuX,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import { Markdown } from "./Markdown";
import { formatElapsed, formatTokens, lineCount, prefillShare, promptLabel, shownFrom, stripAnsi, type Activity, type Item } from "../transcript";
import { SHELL_TOOL, unwrapCall } from "../tool-activity";
import { argLabel, isBlock, isScalar } from "../tool-args";
import { useFollowBottom } from "../use-follow-bottom";
import { formatNumber, t, tp } from "../i18n";

type ToolItem = Extract<Item, { kind: "tool" }>;
type CompactionItem = Extract<Item, { kind: "compaction" }>;

const formatDuration = (ms: number) =>
  ms < 10_000 ? `${Math.max(0.1, ms / 1000).toFixed(1)}s` : formatElapsed(Math.round(ms / 1000));

/**
 * Opens and closes by animating its height to what the content needs — the
 * grid-rows trick, so nothing has to be measured.
 */
export function Collapse({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  // Kept mounted a moment after closing, so it can animate shut; not mounted
  // at all until first opened, so a long transcript does not build every body.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return setMounted(true);
    const t = window.setTimeout(() => setMounted(false), 320);
    return () => window.clearTimeout(t);
  }, [open]);
  return (
    <div className={`chat-collapse ${open ? "is-open" : ""} ${className}`} aria-hidden={!open}>
      <div className="chat-collapse-inner">{(open || mounted) && children}</div>
    </div>
  );
}

/** Text that shimmers while it is still true: "Thinking", "Loading model". */
export const Shimmer = ({ children }: { children: ReactNode }) => <span className="chat-shimmer">{children}</span>;

/** A small ring that spins — or, given a fraction, fills. */
export function Ring({ value, className = "" }: { value?: number; className?: string }) {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const determinate = value !== undefined;
  return (
    <svg viewBox="0 0 16 16" className={`chat-ring ${determinate ? "" : "is-spinning"} ${className}`} aria-hidden>
      <circle cx="8" cy="8" r={r} className="chat-ring-track" />
      <circle
        cx="8"
        cy="8"
        r={r}
        className="chat-ring-value"
        strokeDasharray={c}
        strokeDashoffset={determinate ? c * (1 - Math.min(1, Math.max(0, value))) : c * 0.7}
      />
    </svg>
  );
}

/**
 * The reasoning before an answer, folded away.
 *
 * While it is being written the header shimmers and the newest line runs
 * underneath, so there is something alive to look at without the whole of it
 * pushing the conversation down. Opened, it follows the end as it grows.
 */
export function ThinkingBlock({
  thinking,
  streaming,
  since,
  until,
}: {
  thinking: string;
  streaming: boolean;
  since?: number;
  until?: number;
}) {
  const [open, setOpen] = useState(false);
  const now = useNow(streaming);

  const seconds = since ? Math.max(0, Math.round(((streaming ? now : until ?? since) - since) / 1000)) : undefined;
  const label = streaming ? t("Thinking") : seconds && seconds >= 1 ? t("Thought for {time}", { time: formatElapsed(seconds) }) : t("Thought process");
  // The end of what it is thinking, under a closed header.
  // Where the end starts is only moved on rarely (see shownFrom): a start that
  // followed the newest token made every line wrap anew with each one.
  const from = useRef(0);
  from.current = shownFrom(thinking, from.current);
  const tail = streaming && !open ? tidyText(thinking.slice(from.current)) : "";
  // As high as what it shows, up to three lines — a sentence of reasoning is
  // not a sentence and two empty lines — and never lower again while it runs:
  // a window that shrank and grew with the text as it wrapped jumped with every
  // token at a fast model's speed.
  const stream = useRef<HTMLDivElement>(null);
  const tallest = useRef(0);
  useLayoutEffect(() => {
    const el = stream.current;
    if (!el) {
      tallest.current = 0;
      return;
    }
    const text = (el.firstElementChild as HTMLElement).offsetHeight;
    const most = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    const height = Math.max(tallest.current, Math.min(text, most));
    if (height !== tallest.current) {
      tallest.current = height;
      el.style.height = `${height}px`;
    }
    // Older lines fade out at the top only once there are some leaving.
    el.classList.toggle("is-clipped", text > height);
  }, [tail]);

  return (
    <div className={`chat-thinking ${streaming ? "is-streaming" : ""} ${open ? "is-open" : ""}`}>
      <button type="button" className="chat-thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chat-thinking-icon" aria-hidden>
          <LuBrain />
        </span>
        {streaming ? <Shimmer>{label}</Shimmer> : <span>{label}</span>}
        {streaming && seconds !== undefined && seconds >= 1 && <span className="chat-faint tabular-nums">{formatElapsed(seconds)}</span>}
        <LuChevronRight className="chat-chevron" aria-hidden />
      </button>
      {tail && (
        <div ref={stream} className="chat-thinking-stream" aria-hidden>
          <div>{tail}</div>
        </div>
      )}
      <Collapse open={open}>
        <ThinkingBody thinking={thinking} streaming={streaming} open={open} />
      </Collapse>
    </div>
  );
}

/**
 * The reasoning opened. While it is written it shows the newest lines — until
 * scrolled back to read one, which the next word must not undo: put back at
 * the end with each word, it could not be read, nor the conversation scrolled
 * over it. Written, it opens at its start and stays wherever it is read.
 *
 * Drawn only once opened, so the reasoning of a long conversation, folded
 * away, does not each keep watch over a box nobody sees.
 */
function ThinkingBody({ thinking, streaming, open }: { thinking: string; streaming: boolean; open: boolean }) {
  const { attach, onScroll, onWheel, follow } = useFollowBottom<HTMLDivElement>({ paused: () => !streaming, nested: true });
  // Opened while it is written — or written to again, open: from its newest
  // line. Opened again as well, before it has gone from closing.
  useLayoutEffect(() => {
    if (open && streaming) follow(true);
  }, [open, streaming, follow]);
  // Its last words can come with the answer's first, which ends it: they are
  // followed too, or they were left below the edge.
  const wasStreaming = useRef(streaming);
  useLayoutEffect(() => {
    if (streaming || wasStreaming.current) follow();
    wasStreaming.current = streaming;
  }, [thinking, streaming, follow]);
  return (
    <div ref={attach} onScroll={onScroll} onWheel={onWheel} className="chat-thinking-body">
      {thinking}
    </div>
  );
}

/** The text the end shows, with its blank lines closed up. */
function tidyText(text: string): string {
  return text.replace(/\n{2,}/g, "\n").trim();
}

/** The last few lines of a command's output that say something, oldest first. */
function lastLines(text: string, n = 3): string[] {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

/**
 * What a tool is, as a picture. Guessed from the words in its name — pi's tools
 * and whatever an extension adds — so `brave_web_search`, `webFetch` and
 * `github.list_issues` each find theirs, and anything else gets a wrench.
 */
export function toolIconKind(name: string): string {
  if (SHELL_TOOL.test(name)) return "shell";
  const words = new Set(name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const has = (...w: string[]) => w.some((x) => words.has(x));
  if (has("web", "browser", "fetch", "http", "url", "navigate", "scrape", "crawl")) return "web";
  if (has("edit", "multiedit", "patch", "replace")) return "edit";
  if (has("write", "create")) return "write";
  if (has("grep", "search", "query", "lookup")) return "search";
  if (has("find", "glob", "ls", "list")) return "find";
  if (has("read", "view", "cat", "open")) return "read";
  if (has("image", "picture", "screenshot", "photo")) return "image";
  if (has("todo", "todos", "task", "tasks", "plan")) return "todo";
  return "tool";
}

const TOOL_ICONS: Record<string, IconType> = {
  shell: LuSquareTerminal,
  web: LuGlobe,
  edit: LuFilePen,
  write: LuFilePlus,
  search: LuSearch,
  find: LuFileSearch,
  read: LuFileText,
  image: LuImage,
  todo: LuListTodo,
  tool: LuWrench,
};

function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS[toolIconKind(name)];
  return <Icon />;
}

/**
 * The exit code a shell tool gave in its own words, on one of the first or
 * last lines of its output: pi's "Command exited with code 2", another
 * extension's "Process exited with code 2" or "exit code: 2". Only there, so a
 * log that mentions an exit code on the way is not taken for the command's.
 */
function reportedExit(output: string): number | undefined {
  const lines = output.trim().split("\n");
  for (const line of [...lines.slice(0, 6), ...lines.slice(-4)]) {
    const m = /^[[(]?\s*(?:(?:command|process) exited with code|exit(?:[ _]code|[ _]status)?\s*[:=])\s*(-?\d+)\s*[\])]?$/i.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * How a shell command ended: an exit code, a timeout, or a stop. pi's bash
 * tool calls a non-zero exit an error, so a `done` from it is exit 0; a shell
 * tool from another extension may end "done" with a failure it only states in
 * its output, and says nothing of a success it does not state.
 */
export function shellOutcome(status: ToolItem["status"], output: string, interrupted?: boolean, tool = "bash"): { label: string; tone: "ok" | "error" | "warn" } | undefined {
  if (status === "running") return undefined;
  if (interrupted) return { label: t("interrupted"), tone: "warn" };
  if (status === "done") {
    const code = reportedExit(output) ?? (tool.toLowerCase() === "bash" ? 0 : undefined);
    return code === undefined ? undefined : { label: `exit ${code}`, tone: code === 0 ? "ok" : "error" };
  }
  const code = /Command exited with code (-?\d+)\s*$/.exec(output);
  if (code) return { label: `exit ${code[1]}`, tone: "error" };
  const timeout = /Command timed out after (\d+) seconds\s*$/.exec(output);
  if (timeout) return { label: t("timed out · {n}s", { n: timeout[1] }), tone: "warn" };
  if (/Command aborted\s*$/.test(output)) return { label: t("stopped"), tone: "warn" };
  const other = reportedExit(output);
  if (other !== undefined) return { label: `exit ${other}`, tone: "error" };
  return { label: t("failed"), tone: "error" };
}

/** Past this, the output shown in the chat is the end of it; the terminal has the rest. */
const INLINE_OUTPUT = 6000;

/**
 * One tool call: its name, and folded away what it was called with and what
 * came back. A shell command shows whole, with its output, and a way into the
 * agent terminal for all of it.
 */
export function ToolCall({
  item,
  onOpenTerminal,
  onOpenAgent,
}: {
  item: ToolItem;
  onOpenTerminal?: (callId: string) => void;
  /** The tool runs an agent of its own, which has a window: a way into it. */
  onOpenAgent?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Whatever extension it came from: nothing below is keyed to one tool but
  // the shell, which is shown as a terminal would show it. Called through the
  // MCP adapter, it is the tool inside, with what that was given.
  const call = unwrapCall(item.name, item.args);
  const name = call.name;
  const wrapped = name !== item.name;
  const shell = SHELL_TOOL.test(name);
  const args = wrapped ? call.input : item.args && typeof item.args === "object" ? (item.args as Record<string, unknown>) : undefined;
  const command = shell ? String(args?.command ?? args?.cmd ?? (typeof item.args === "string" ? item.args : "")) : "";
  const took = item.since && item.until ? item.until - item.since : undefined;
  // Stored before times were kept to the millisecond: both on a whole second,
  // so only whole seconds can be said of it.
  const coarse = took !== undefined && item.since! % 1000 === 0 && item.until! % 1000 === 0;
  const output = useMemo(() => stripAnsi(item.output ?? ""), [item.output]);
  const clipped = output.length > INLINE_OUTPUT;
  // A tool that answers in JSON is read like its parameters, not as braces and quotes.
  const structured = useMemo(() => (open && !shell && item.status === "done" && !clipped ? jsonOutput(output) : undefined), [open, shell, item.status, clipped, output]);
  const running = item.status === "running";
  const now = useNow(running);
  const elapsed = running && item.since ? Math.max(0, Math.floor((now - item.since) / 1000)) : undefined;
  // A quick call would only flash "0 s"; a command is worth timing from the start.
  const timed = elapsed !== undefined && (shell || elapsed >= 2);
  // A command given a timeout has an end to measure against; the ring fills towards it.
  const timeout = typeof args?.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
  const outcome = shell
    ? shellOutcome(item.status, output, item.interrupted, name)
    : item.interrupted
      ? ({ label: t("interrupted"), tone: "warn" } as const)
      : undefined;
  // Counted on the whole output: what is kept of it is only the end.
  const lines = shell ? (item.outputLines ?? lineCount(output)) : 0;
  // Any tool that streams what it is doing shows its newest lines while it runs.
  const recent = running && !open ? lastLines(output) : [];

  return (
    <div className={`chat-tool is-${item.status} ${item.interrupted ? "is-interrupted" : ""} ${open ? "is-open" : ""}`}>
      <button type="button" className="chat-tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chat-tool-icon" aria-hidden>
          {running ? (
            <Ring value={timeout && elapsed !== undefined ? elapsed / timeout : undefined} />
          ) : item.interrupted ? (
            <LuCircleSlash className="text-warn" />
          ) : item.status === "error" ? (
            <LuX className="text-danger" />
          ) : (
            <ToolIcon name={name} />
          )}
        </span>
        <span className="chat-tool-name" title={name !== item.name ? `${item.name} → ${name}` : undefined}>{running ? <Shimmer>{name}</Shimmer> : name}</span>
        {/* What it acted on — the command, the file — readable without opening each call. */}
        {item.detail && <span className="chat-tool-detail" title={item.detail}>{item.detail}</span>}
        {outcome && <span className={`chat-tool-badge is-${outcome.tone}`}>{outcome.label}</span>}
        {timed && (
          <span className="chat-faint tabular-nums">
            {formatElapsed(elapsed!)}
            {timeout ? ` / ${formatElapsed(timeout)}` : ""}
          </span>
        )}
        {took !== undefined && <span className="chat-faint tabular-nums">{coarse ? (took < 1000 ? "<1s" : formatElapsed(Math.round(took / 1000))) : formatDuration(took)}</span>}
        {shell && lines > 0 && (
          <span className="chat-faint tabular-nums">
            {tp(lines, "{n} line", "{n} lines")}
          </span>
        )}
        <LuChevronRight className="chat-chevron" aria-hidden />
      </button>
      {onOpenAgent && (
        <button type="button" className="chat-tool-agent" onClick={onOpenAgent}>
          <LuBot aria-hidden /> {running ? t("Watch") : t("Open")}
        </button>
      )}
      {recent.length > 0 && (
        // Keyed by place, not by text: a new line moves the others up
        // without anything being drawn afresh.
        <div className="chat-tool-stream" aria-hidden>
          {recent.map((line, i) => (
            <span key={i}>{line}</span>
          ))}
        </div>
      )}
      <Collapse open={open}>
        <div className="chat-tool-body">
          {shell ? (
            <pre className="chat-tool-command">
              <span aria-hidden>$ </span>
              {command || t("(no command)")}
            </pre>
          ) : (
            <ToolArgs args={wrapped ? call.input : item.args} />
          )}
          {output ? (
            <div className="chat-tool-output-wrap">
              <div className="chat-tool-label">
                {item.status === "error" && !item.interrupted ? t("Error") : t("Output")}
                {clipped && <span className="chat-faint"> · {t("last {n} characters", { n: formatNumber(INLINE_OUTPUT) })}</span>}
              </div>
              {structured ? (
                <div className="chat-tool-output is-structured">
                  <ArgValue value={structured} depth={0} />
                </div>
              ) : (
                <pre className={`chat-tool-output ${item.status === "error" && !item.interrupted ? "is-error" : ""}`}>{clipped ? output.slice(-INLINE_OUTPUT) : output}</pre>
              )}
            </div>
          ) : (
            item.status === "running" && <div className="chat-tool-label"><Shimmer>{t("Waiting for output…")}</Shimmer></div>
          )}
          {shell && onOpenTerminal && item.callId && (
            <button type="button" className="chat-tool-link" onClick={() => onOpenTerminal(item.callId!)}>
              <LuSquareTerminal aria-hidden />
              {clipped ? t("Show the whole output in the agent terminal") : t("Open in the agent terminal")}
            </button>
          )}
        </div>
      </Collapse>
    </div>
  );
}

/**
 * What a call was given, each parameter a label and its value: text as text,
 * long or many-lined text in a block of its own, a list as a list, and
 * whatever is inside an object the same way, a step in. See tool-args.ts.
 */
export function ToolArgs({ args }: { args: unknown }) {
  if (args === undefined || args === null) return <div className="chat-tool-label">{t("No parameters")}</div>;
  if (typeof args !== "object") return <pre className="chat-tool-value">{String(args)}</pre>;
  if (!Object.keys(args as object).length) return <div className="chat-tool-label">{t("No parameters")}</div>;
  return <ArgValue value={args} depth={0} />;
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

/**
 * An output that is a JSON object or list, read as one; anything else, or cut
 * short, is not. Nor is one with a number too long for JavaScript to hold —
 * an id, most often — which read back would be shown as another number.
 */
function jsonOutput(output: string): object | undefined {
  const t = output.trim();
  // Sixteen digits or more in a row, a point or two among them: more than a
  // JavaScript number holds, whole or after the point. A string with as many
  // is shown as text too, which is no loss. No lookbehind: Safari before 16.4
  // cannot read one, and the whole page failed to load there.
  if (!/^[[{]/.test(t) || /\d[\d.]{15,}/.test(t)) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && Object.keys(v).length ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The conversation being summarized, and then the mark where it was: what
 * came before it is what the agent now remembers only as the summary.
 */
export function CompactionMarker({ item }: { item: CompactionItem }) {
  const [open, setOpen] = useState(false);
  const running = item.status === "running";
  const now = useNow(running);
  const seconds = item.since ? Math.max(0, Math.floor((now - item.since) / 1000)) : 0;

  if (running) {
    return (
      <div className="chat-compaction is-running" role="status">
        <span className="chat-compaction-rule" />
        <span className="chat-compaction-pill">
          <span className="chat-squeeze" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          <Shimmer>{t("Compacting the conversation")}</Shimmer>
          {seconds >= 1 && <span className="chat-faint tabular-nums">{formatElapsed(seconds)}</span>}
        </span>
        <span className="chat-compaction-rule" />
      </div>
    );
  }
  const failed = item.status === "failed";
  return (
    <div className={`chat-compaction ${failed ? "is-failed" : "is-done"}`}>
      <div className="chat-compaction-line">
        <span className="chat-compaction-rule" />
        <button
          type="button"
          className="chat-compaction-pill"
          onClick={() => item.summary && setOpen((v) => !v)}
          aria-expanded={item.summary ? open : undefined}
          disabled={!item.summary}
        >
          {failed ? <LuTriangleAlert aria-hidden /> : <LuFoldVertical aria-hidden />}
          <span>
            {failed ? t("Compaction did not finish") : t("Conversation compacted")}
            {!failed && item.tokensBefore ? ` · ${t("{n} tokens summarized", { n: formatTokens(item.tokensBefore) })}` : ""}
          </span>
          {item.summary && <LuChevronRight className="chat-chevron" aria-hidden />}
        </button>
        <span className="chat-compaction-rule" />
      </div>
      {item.summary && (
        <Collapse open={open}>
          {/* pi writes the summary in markdown: headings, checklists, file lists. */}
          <div className="chat-compaction-summary md">
            <Markdown>{item.summary}</Markdown>
          </div>
        </Collapse>
      )}
    </div>
  );
}

/**
 * What the agent is doing between the things that show for themselves.
 *
 * One small pill whose contents change with the phase — loading the model,
 * reading the prompt with how far it has got, thinking before anything has
 * been said — rather than a card that grows and shrinks. Writing and tool calls
 * are drawn where they happen, so this steps aside for them.
 */
export function StatusIndicator({ phase }: { phase: Activity }) {
  // Its own clock: a second's tick redraws this pill, and not the conversation it sits under.
  const now = useNow(true);
  const seconds = phase.since ? Math.max(0, Math.floor((now - phase.since) / 1000)) : 0;
  const elapsed = seconds >= 2 ? formatElapsed(seconds) : null;
  const p = phase.prefill;
  // `processed` already counts the cached prefix.
  const { done, percent } = prefillShare(p);
  const detail = p ? `${t("{done} / {total} tokens", { done: formatNumber(done), total: formatNumber(p.total) })}${p.cache ? ` · ${t("{n} from cache", { n: formatNumber(p.cache) })}` : ""}` : undefined;
  let kind: string;
  let icon: ReactNode;
  let text: ReactNode;
  let extra: ReactNode = null;
  switch (phase.label) {
    case "loading the model":
      kind = "model";
      icon = (
        <span className="chat-model-load" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      );
      text = <Shimmer>{t("Loading model")}</Shimmer>;
      extra = phase.model ? <span className="chat-status-model">{phase.model}</span> : null;
      break;
    case "processing the prompt": {
      kind = "prefill";
      icon = <Ring value={percent !== undefined ? percent / 100 : undefined} />;
      const label = promptLabel(seconds);
      text = (
        <span key={label} className="chat-status-swap">
          <Shimmer>{label}</Shimmer>
        </span>
      );
      extra = percent !== undefined ? (
        <span className="chat-status-percent" title={detail}>
          {percent}%
        </span>
      ) : null;
      break;
    }
    case "compacting the conversation":
      kind = "compact";
      icon = (
        <span className="chat-squeeze" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
      );
      text = <Shimmer>{t("Compacting the conversation")}</Shimmer>;
      break;
    case "retrying after an error":
      kind = "retry";
      icon = <Ring />;
      text = <span className="text-warn">{t("Retrying after an error")}</span>;
      break;
    case "thinking":
    case "working":
      kind = "thinking";
      icon = <span className="chat-orbit" aria-hidden><i /><i /><i /></span>;
      text = <Shimmer>{phase.label === "thinking" ? t("Thinking") : t("Working")}</Shimmer>;
      break;
    default:
      return null;
  }

  return (
    <div className="chat-status" role="status" aria-live="polite">
      {/* Reading the prompt has a measure, and says it as one: a screen reader
          hears how far it has got, not only that something is going on. */}
      <span
        key={kind}
        className="chat-status-pill"
        {...(kind === "prefill" && percent !== undefined
          ? { role: "progressbar", "aria-label": t("Prompt processing"), "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent, "aria-valuetext": `${percent}% — ${detail}` }
          : {})}
      >
        <span className="chat-status-icon">{icon}</span>
        {text}
        {extra}
        {elapsed && <span className="chat-faint tabular-nums">{elapsed}</span>}
      </span>
    </div>
  );
}
