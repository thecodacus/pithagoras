import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api, type PiCommand, type PortalEvent, type Session } from "../api";
import { buildTranscript } from "../transcript";
import { ComposerBar } from "./ComposerBar";

const COMPOSER_HEIGHT_KEY = "pithagoras.composerHeight";
const DEFAULT_COMPOSER_HEIGHT = 72;
const MIN_COMPOSER_HEIGHT = 56;

function storedComposerHeight(): number {
  try {
    const stored = Number.parseInt(localStorage.getItem(COMPOSER_HEIGHT_KEY) ?? "", 10);
    return Number.isFinite(stored) && stored >= MIN_COMPOSER_HEIGHT
      ? stored
      : DEFAULT_COMPOSER_HEIGHT;
  } catch {
    return DEFAULT_COMPOSER_HEIGHT;
  }
}

function persistComposerHeight(height: number) {
  try {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // Resizing should still work when browser storage is unavailable.
  }
}

/**
 * Context the portal attaches to a message, and what to call it.
 *
 * The agent needs to be told who is speaking and what it said while nobody was
 * talking to it. A person reading the transcript does not — they wrote the
 * message, so seeing their own words buried under three framing blocks is
 * noise. Folded away rather than dropped: it is still what the model saw, and
 * when a reply looks strange this is usually why.
 */
/** Keep in step with what the server attaches — see channels/supervisor.ts. */
const CONTEXT_BLOCKS: { tag: string; label: string }[] = [
  { tag: "speaker", label: "Speaker" },
  { tag: "sent-since-you-last-spoke", label: "Sent while idle" },
  { tag: "answer-from-primary", label: "Answer" },
  { tag: "channel-instructions", label: "Channel instructions" },
  { tag: "routine", label: "Routine" },
];

function splitContext(raw: string): { text: string; blocks: { label: string; body: string }[] } {
  let text = raw;
  const blocks: { label: string; body: string }[] = [];
  for (const { tag, label } of CONTEXT_BLOCKS) {
    // The opening tag may carry attributes, as <routine name="..."> does.
    const re = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g");
    text = text.replace(re, (match) => {
      const body = match
        .replace(new RegExp(`^<${tag}(\\s[^>]*)?>`), "")
        .replace(new RegExp(`</${tag}>$`), "")
        .trim();
      if (body) blocks.push({ label, body });
      return "";
    });
  }
  return { text: text.trim(), blocks };
}

function ContextChip({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`rounded-full px-2 py-0.5 text-[11px] transition ${
          open
            ? "bg-accent/20 text-accent"
            : "bg-fg/5 text-fg-faint hover:bg-fg/10 hover:text-fg-muted"
        }`}
        title="Context the portal attached to this message"
      >
        {label}
      </button>
      {open && (
        <pre className="mt-1 w-full whitespace-pre-wrap rounded-lg bg-fg/5 p-2 text-left text-[11px] leading-relaxed text-fg-muted">
          {body}
        </pre>
      )}
    </>
  );
}

export function Chat({
  session,
  events,
  onSend,
  onAbort,
  onClientCommand,
}: {
  session: Session;
  events: PortalEvent[];
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
  /** Builtins the portal itself services — /settings, /new, /name. */
  onClientCommand: (name: string, args: string) => void | Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [panelRequest, setPanelRequest] = useState<"model" | "effort" | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [composerHeight, setComposerHeight] = useState(storedComposerHeight);
  const items = useMemo(() => buildTranscript(events), [events]);
  const running = session.status === "running";

  // Commands come from pi at runtime, so anything a newly installed package
  // registers shows up here without the portal knowing about it in advance.
  const [commands, setCommands] = useState<PiCommand[]>([]);
  useEffect(() => {
    api
      .commands(session.id)
      .then((r) => setCommands(r.commands))
      .catch(() => setCommands([]));
    // Refetch when a run ends: installing an extension mid-session should make
    // its commands show up without a reload.
  }, [session.id, running]);

  // Show the palette while the composer holds a bare "/name" prefix.
  const slashQuery = /^\/([\w:-]*)$/.exec(input.trimStart());
  const matches = slashQuery
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery[1].toLowerCase())).slice(0, 8)
    : [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length, events.length]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const startComposerResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const maxHeight = Math.round(window.innerHeight * 0.45);
    const startHeight = Math.min(
      maxHeight,
      composerRef.current?.getBoundingClientRect().height ?? composerHeight,
    );

    const move = (moveEvent: PointerEvent) => {
      const nextHeight = Math.max(
        MIN_COMPOSER_HEIGHT,
        Math.min(maxHeight, startHeight + startY - moveEvent.clientY),
      );
      setComposerHeight(nextHeight);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      resizeCleanupRef.current = null;
    };
    const finish = () => {
      cleanup();
      const height = composerRef.current?.getBoundingClientRect().height ?? composerHeight;
      persistComposerHeight(height);
    };

    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const send = async () => {
    const msg = input.trim();
    if (!msg || sending) return;

    // Some builtins are UI, not prompts: /model opens the picker the pill uses,
    // /settings opens the modal. Sending them to pi would just be a chat line.
    const parsed = /^\/([\w-]+)\s*(.*)$/.exec(msg);
    const client = parsed
      ? commands.find((c) => c.name === parsed[1] && c.where === "client")
      : undefined;
    if (client && parsed) {
      setInput("");
      if (client.name === "model") setPanelRequest("model");
      else await onClientCommand(client.name, parsed[2]);
      return;
    }

    setSending(true);
    setInput("");
    try {
      await onSend(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-fg">{session.title}</h2>
          <p className="truncate font-mono text-[11px] text-fg-faint">{session.workspace}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {session.status === "interrupted" && (
            <span className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
              interrupted — send a message to resume
            </span>
          )}
          {running && (
            <button
              onClick={onAbort}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg"
            >
              Stop
            </button>
          )}
        </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-3">
        {items.length === 0 && (
          <div className="pt-16 text-center">
            <p className="text-sm text-fg-muted">Give pi a task.</p>
            <p className="mt-1 text-xs text-fg-faint">You can close this tab — it keeps working.</p>
          </div>
        )}

        {items.map((item) => {
          if (item.kind === "user") {
            const { text, blocks } = splitContext(item.text);
            // Nothing but framing: the portal spoke, not a person. Drawing it as
            // a message bubble with no message in it reads as something broken.
            if (!text) {
              return (
                <div key={item.id} className="flex flex-wrap justify-end gap-1">
                  {blocks.map((b, i) => (
                    <ContextChip key={i} label={b.label} body={b.body} />
                  ))}
                </div>
              );
            }
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-accent/15">
                  <div className="whitespace-pre-wrap">{text}</div>
                  {blocks.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap justify-end gap-1">
                      {blocks.map((b, i) => (
                        <ContextChip key={i} label={b.label} body={b.body} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className="max-w-[90%]">
                {item.thinking && (
                  <details className="mb-1 text-xs text-fg-subtle">
                    <summary className="cursor-pointer hover:text-fg-muted">thinking</summary>
                    <div className="mt-1 whitespace-pre-wrap border-l border-line pl-2">
                      {item.thinking}
                    </div>
                  </details>
                )}
                {item.text && (
                  <div className="md text-sm leading-relaxed text-fg">
                    {/* A reasoning model sometimes closes a thought inside the
                        answer; the stray tag is noise to whoever is reading. */}
                    <ReactMarkdown>{item.text.replace(/<\/?think(ing)?>/gi, "")}</ReactMarkdown>
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === "tool") {
            const tone =
              item.status === "error"
                ? "text-danger"
                : item.status === "running"
                  ? "text-accent"
                  : "text-fg-faint";
            return (
              <div
                key={item.id}
                className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-fg-faint"
              >
                <span className={`shrink-0 ${tone}`}>
                  {item.status === "running" ? "◇" : item.status === "error" ? "✕" : "◆"}
                </span>
                <span className="shrink-0 text-fg-subtle">{item.name}</span>
                {item.detail && <span className="truncate opacity-60">{item.detail}</span>}
              </div>
            );
          }
          return (
            <div
              key={item.id}
              className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-xs ${
                item.tone === "error"
                  ? "bg-danger/10 text-danger"
                  : "bg-raised/60 text-fg-muted"
              }`}
            >
              {item.text}
            </div>
          );
        })}

          {running && (
            <div className="flex items-center gap-1.5 py-1 text-xs text-fg-subtle">
              <span className="h-1 w-1 animate-pulse rounded-full bg-accent" />
              working…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-line px-4 py-3"
      >
        <div className="relative mx-auto w-full max-w-3xl">
        {matches.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
            {matches.map((c) => (
              <button
                key={c.name}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(`/${c.name} `);
                }}
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left transition hover:bg-fg/5"
              >
                <span className="font-mono text-xs text-accent">/{c.name}</span>
                <span className="truncate text-xs text-fg-subtle">{c.description}</span>
                <span className="ml-auto shrink-0 text-[10px] text-fg-faint">{c.source}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onPointerDown={startComposerResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const maxHeight = Math.round(window.innerHeight * 0.45);
            const direction = event.key === "ArrowUp" ? 16 : -16;
            const nextHeight = Math.max(
              MIN_COMPOSER_HEIGHT,
              Math.min(maxHeight, composerHeight + direction),
            );
            setComposerHeight(nextHeight);
            persistComposerHeight(nextHeight);
          }}
          aria-label="Resize message composer vertically"
          aria-valuemin={MIN_COMPOSER_HEIGHT}
          aria-valuemax={Math.round(window.innerHeight * 0.45)}
          aria-valuenow={Math.round(composerHeight)}
          title="Drag up or down to resize"
          className="group flex h-3 w-full touch-none cursor-ns-resize items-center justify-center"
        >
          <span className="h-1 w-12 rounded-full bg-fg/15 transition group-hover:bg-accent/60" />
        </button>
        <textarea
          ref={composerRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          aria-label="Message composer"
          style={{ height: composerHeight, minHeight: MIN_COMPOSER_HEIGHT, maxHeight: "45vh" }}
          placeholder={running ? "pi is working — send to queue a follow-up…" : "Describe the task…"}
          className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
          <ComposerBar
            sessionId={session.id}
            session={session}
            running={running}
            panelRequest={panelRequest}
            onPanelConsumed={() => setPanelRequest(null)}
          />
        </div>
      </form>
    </div>
  );
}
