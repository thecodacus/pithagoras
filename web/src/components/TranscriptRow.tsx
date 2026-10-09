import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DiagramPlugin } from "streamdown";
import { LuAudioLines, LuCheck, LuChevronLeft, LuChevronRight, LuClock, LuCopy, LuPencil, LuRotateCw, LuShieldAlert, LuTrash2 } from "react-icons/lu";
import { api } from "../api";
import { copyText } from "../clipboard";
import { sentPictureId, shownPictureId } from "../chat-pictures";
import { splitContext } from "../context-blocks";
import { msg, t, tp, useLanguage } from "../i18n";
import { isPictureCall } from "../picture-call";
import { isEnter, isEscape } from "../shortcuts";
import type { Item, SentImage } from "../transcript";
import { assistantText } from "../voice";
import { CommandLine } from "./CommandLine";
import { PictureButton } from "./ChatPictures";
import { CompactionMarker, ThinkingBlock, ToolCall } from "./ChatActivity";
import { Markdown, type MarkdownProps } from "./Markdown";
import { PictureCall } from "./PictureCall";
import { ReplyStatsLine } from "./ReplyStats";

function ContextChip({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`rounded-full px-2 py-0.5 text-[11px] transition ${
          open
            ? "bg-accent/20 text-accent"
            : "bg-fg/5 text-fg-faint hover:bg-fg/10 hover:text-fg-muted"
        }`}
        title={t("Context the portal attached to this message")}
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

/** What a row can do, for the chat to answer: one object that stays the same, so that a row is not told it has changed (see useStableActions). */
export type RowActions = {
  openPicture: (id: string) => void;
  showInTerminal: (callId: string) => void;
  openAgent: (id: string) => void;
  edit: (seq: number) => void;
  cancelEdit: () => void;
  saveEdit: (seq: number, text: string) => Promise<void>;
  retry: (seq: number, text: string) => void;
  again: (item: { images?: SentImage[] }, text: string) => Promise<void>;
  remove: (seq: number) => Promise<void>;
  switchVersion: (seq: number, to: number) => void;
  /** Trusts a result flagged as a suspected prompt injection; resolves once the portal has it. */
  trustFlagged: (id: string) => Promise<boolean>;
  /** Whether the person trusted that result already. */
  isTrusted: (id: string) => boolean;
};

type ToolItem = Extract<Item, { kind: "tool" }>;

/** What each sign the guard found means, said to the person (server/src/pi/injection.ts). */
const SIGNS: Record<string, string> = {
  override: msg("tells the reader to ignore its instructions"),
  addressed: msg("speaks to an AI reading it"),
  persona: msg("tries to give the reader a new role or instructions"),
  "role-markup": msg("contains chat-format markers that pretend to be another speaker"),
  hidden: msg("hides text in invisible characters"),
  "secret-request": msg("asks for keys, passwords or private files to be sent somewhere"),
};

/**
 * Under a tool result the guard flagged as a suspected prompt injection: why,
 * what that holds back, and the two ways out. Trusting it says the person read
 * it and it is fine; removing the turn takes it out of what the agent knows.
 */
function FlaggedNotice({ flag, act }: { flag: NonNullable<ToolItem["flagged"]>; act: RowActions }) {
  const [trusted, setTrusted] = useState(() => act.isTrusted(flag.id));
  const [busy, setBusy] = useState(false);
  if (trusted) return <p className="mt-1 text-[11px] text-fg-faint">{t("You trusted this result.")}</p>;
  const signs = flag.signals.map((s) => (SIGNS[s] ? t(SIGNS[s]) : s)).join("; ");
  return (
    <div role="alert" className="mt-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-warn"><LuShieldAlert className="h-3.5 w-3.5 shrink-0" />{t("This result looks like a prompt injection")}</p>
      <p className="mt-1 text-fg-muted">{t("It {signs}. Until you trust it or remove the turn it came in, this chat will not push, upload, read keys, start subagents or set up anything that runs later.", { signs })}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-raised disabled:opacity-50"
          onClick={async () => { setBusy(true); if (await act.trustFlagged(flag.id)) setTrusted(true); setBusy(false); }}>
          {t("Trust it")}
        </button>
        {flag.turnSeq !== undefined && (
          <button type="button" disabled={busy} className="rounded-lg border border-line px-2.5 py-1 text-xs text-fg-muted transition hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            onClick={() => void act.remove(flag.turnSeq!)}>
            {t("Remove the turn")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One entry of the conversation: what was said, what came back, what was run.
 *
 * Drawn again only when what it shows changes. The chat is drawn for every key
 * typed in its box, every second that ticks and every word that arrives, and a
 * long conversation is hundreds of rows, each with its markdown and its buttons:
 * so what a row is given is what it shows (primitives, and the entry, which stays
 * the same while its events do), and what it does goes through `act`.
 */
export const TranscriptRow = memo(function TranscriptRow({
  item,
  enter,
  mine,
  entering,
  running,
  editing,
  last,
  seqs,
  switching,
  sessionId,
  folder,
  mermaid,
  mermaidOptions,
  agent,
  act,
}: {
  item: Item;
  /** Classes that play a row in, and for how long (see motion.css): the chat works them out as it draws the list. */
  enter: string;
  mine: string;
  entering: boolean;
  running: boolean;
  /** This message is open for rewriting. */
  editing: boolean;
  /** The last thing the person said: the one that can be retried. */
  last: boolean;
  /** The versions of this message, if it has more than one. */
  seqs?: number[];
  /** A switch of version is on its way, for some message. */
  switching: boolean;
  sessionId: string;
  folder: string;
  mermaid: DiagramPlugin | null;
  mermaidOptions: MarkdownProps["mermaid"];
  /** The subagent this tool call started, if it did. */
  agent?: string;
  act: RowActions;
}) {
  // What it says is in the language chosen: a row that is not drawn for the chat's draws is drawn for that.
  useLanguage();
  // Worked out once per entry, not for each draw.
  const context = useMemo(() => (item.kind === "user" ? splitContext(item.text) : null), [item]);
  if (item.kind === "user") {
    const { text, blocks } = context!;
    // Nothing but framing: the portal spoke, not a person. Drawing it as
    // a message bubble with no message in it reads as something broken.
    if (!text && !item.images) {
      return (
        <div data-key={item.id} className="flex flex-wrap justify-end gap-1">
          {blocks.map((b, i) => (
            <ContextChip key={i} label={t(b.label)} body={b.body} />
          ))}
        </div>
      );
    }
    if (editing) {
      return (
        <div data-key={item.id} className="flex justify-end">
          <MessageEditor
            initial={text}
            hasImages={!!item.images}
            onCancel={act.cancelEdit}
            onSave={(next) => act.saveEdit(item.seq, next)}
          />
        </div>
      );
    }
    // Sent into the run and waiting for the agent to take it in: shown
    // as sent, at the foot of the conversation, and moved to where it
    // was read once it has been. Nothing to edit or retry until then —
    // and one that never got there can only be sent again. Waiting
    // until the server says otherwise, run or no run: pi can still
    // hold one after its run is over, or be taking it in, and offered
    // again it would be read twice.
    if (item.queued || item.unsent) {
      const waits = !item.unsent;
      return (
        <div data-key={item.id} className={`group flex flex-col items-end gap-1${enter}${mine}`}>
          <div className="max-w-[80%] rounded-2xl rounded-br-md border border-dashed border-accent/30 bg-accent/5 px-3.5 py-2 text-sm text-fg-muted">
            {text && <div className="whitespace-pre-wrap">{text}</div>}
            {item.images && <div className="mt-1 text-[11px] text-fg-subtle">{tp(item.images.length, "{n} picture", "{n} pictures")}</div>}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            {waits ? (
              <>
                <LuClock aria-hidden className="h-3 w-3" />
                <span>
                  {running
                    ? item.steer ? t("Waiting — goes in after the current step") : t("Waiting — goes in when the run ends")
                    : t("Waiting — the agent has it, and reads it next")}
                </span>
              </>
            ) : (
              <span>
                {item.unsent === "unsure"
                  ? t("May not have been sent — the portal restarted, and could not tell whether the agent took it in")
                  : item.unsent === "restarted" ? t("Not sent — the portal restarted before the agent took it in") : t("Not sent — the run was stopped before the agent took it in")}
              </span>
            )}
            {text && <CopyAction text={text} />}
            {!waits && (
              <MessageAction label={t("Send again as a new message")} onClick={() => act.again(item, text)}>
                <LuRotateCw className="h-3 w-3" />
              </MessageAction>
            )}
          </div>
        </div>
      );
    }
    return (
      <div data-key={item.id} className={`group flex flex-col items-end gap-1${enter}${mine}`}>
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/10 px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-accent/15">
          {item.audio && <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-accent" title={t("Sent in voice mode")}><LuAudioLines size={13} aria-hidden="true" /><span>{t("Audio")}</span></div>}
          {item.images && (
            <div className={`flex flex-wrap justify-end gap-1.5 ${text ? "mb-1.5" : ""}`}>
              {item.images.map((image) => (
                <PictureButton key={image.name} id={sentPictureId(item.id, image.name)} onOpen={act.openPicture} title={t("Open the picture")}>
                  <img
                    src={api.imageUrl(sessionId, image.name)}
                    alt={t("A picture sent with this message")}
                    loading="lazy"
                    className="max-h-48 max-w-full rounded-lg object-contain ring-1 ring-line"
                  />
                </PictureButton>
              ))}
            </div>
          )}
          {text && <div className="whitespace-pre-wrap">{text}</div>}
          {blocks.length > 0 && (
            <div className="mt-1.5 flex flex-wrap justify-end gap-1">
              {blocks.map((b, i) => (
                <ContextChip key={i} label={t(b.label)} body={b.body} />
              ))}
            </div>
          )}
        </div>
        {/* Only where it can be done: taking a message out from under a
            run that is answering it leaves the agent replying to
            something that no longer exists. Sending it again is fine —
            it just queues, like any other message. */}
        <div className="flex items-center gap-1">
        {seqs && (
          <VersionSwitch
            seqs={seqs}
            seq={item.seq}
            running={running}
            busy={switching}
            onSwitch={(to) => act.switchVersion(item.seq, to)}
          />
        )}
        <div className="flex items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {text && <CopyAction text={text} />}
          {last ? (
            // Retry: the same as editing without changing a word. After
            // a Stop this is what clears the half-finished answer out of
            // the agent's memory instead of stacking a second question
            // on top of it.
            <MessageAction
              label={
                running
                  ? t("Stop the run to retry")
                  : t("Retry — drops the reply and sends this message again")
              }
              disabled={running}
              onClick={() => act.retry(item.seq, text)}
            >
              <LuRotateCw className="h-3 w-3" />
            </MessageAction>
          ) : (
            <MessageAction
              label={t("Send again as a new message")}
              onClick={() => act.again(item, text)}
            >
              <LuRotateCw className="h-3 w-3" />
            </MessageAction>
          )}
          <MessageAction
            label={
              running
                ? t("Stop the run to edit")
                : last ? t("Edit — replaces this message and everything after it (↑ in an empty box)") : t("Edit — replaces this message and everything after it")
            }
            disabled={running}
            onClick={() => act.edit(item.seq)}
          >
            <LuPencil className="h-3 w-3" />
          </MessageAction>
          <MessageAction
            label={running ? t("Stop the run to delete") : t("Delete this message and the reply to it")}
            disabled={running}
            danger
            onClick={() => act.remove(item.seq)}
          >
            <LuTrash2 className="h-3 w-3" />
          </MessageAction>
        </div>
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div data-key={item.id} className={`group max-w-[90%]${enter}`}>
        {item.thinking && (
          <ThinkingBlock
            thinking={item.thinking}
            streaming={running && !item.done && !item.text}
            since={item.thinkingSince}
            until={item.thinkingUntil}
          />
        )}
        {item.text && (
          <div className="md text-sm leading-relaxed text-fg">
            {/* Streamdown rather than plain markdown: a reply arrives a
                token at a time, so half of it is briefly malformed —
                an unclosed fence, a half-written link — and a strict
                renderer flickers between interpretations as it lands.
                A reasoning model also sometimes closes a thought inside
                the answer; that stray tag is noise to whoever reads it. */}
            <Markdown
              parseIncompleteMarkdown
              animated
              isAnimating={running && !item.done}
              caret={running && !item.done ? "circle" : undefined}
              diagram={mermaid}
              mermaid={mermaidOptions}
            >
              {assistantText(item)}
            </Markdown>
          </div>
        )}
        {/* Under the answer, where it ends: only the last bubble of it,
            and only once nothing in the run follows it. One per tool
            call in between would be a Copy button after every
            paragraph, and one beside the words sat in the margin where
            the eye does not go. Each answer keeps its button when
            another message comes. */}
        {item.final && (
          <div className="reply-actions -ml-1.5 mt-1 flex items-center gap-0.5">
            <CopyAction text={assistantText(item)} />
            {item.stats && <ReplyStatsLine stats={item.stats} />}
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "compaction") {
    return (
      <div data-key={item.id} className={`chat-row${enter}`}>
        <CompactionMarker item={item} />
      </div>
    );
  }
  if (item.kind === "command") {
    return (
      <div data-key={item.id} className={`chat-row${enter}`}>
        <CommandLine item={item} />
      </div>
    );
  }
  if (item.kind === "tool") {
    // The portal's picture tools are a preview of the picture, not a tool card.
    if (isPictureCall(item)) {
      return (
        <div data-key={item.id} className={`tool-row${enter}`}>
          <PictureCall item={item} sessionId={sessionId} folder={folder} onOpen={act.openPicture} />
        </div>
      );
    }
    return (
      <div data-key={item.id} className={`tool-row${enter}`}>
      <ToolCall item={item} onOpenTerminal={act.showInTerminal} onOpenAgent={agent ? () => act.openAgent(agent) : undefined} />
      {item.flagged && <FlaggedNotice flag={item.flagged} act={act} />}
      {item.picture && (
        // In the middle of the column, with as much room above as below. Contained, never cropped: a wide or tall picture is smaller here, and whole in the viewer.
        <div className="chat-picture my-3 flex justify-center">
          <PictureButton id={shownPictureId(item.id)} onOpen={act.openPicture} title={item.picture.title ?? item.picture.path}>
            <img
              src={api.pictureUrl(sessionId, item.picture.path, item.pictureSeq)}
              alt={item.picture.title ?? item.picture.path}
              loading="lazy"
              className="max-h-80 max-w-full rounded-lg border border-line object-contain"
            />
          </PictureButton>
        </div>
      )}
      </div>
    );
  }
  return (
    <div
      data-key={item.id}
      className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-xs${enter}${entering && item.tone === "error" ? " is-error" : ""} ${
        item.tone === "error"
          ? "bg-danger/10 text-danger"
          : item.tone === "warn"
            ? "bg-warn/10 text-warn"
            : "bg-raised/60 text-fg-muted"
      }`}
    >
      {item.portal ? t(item.text) : item.text}
    </div>
  );
});

/**
 * Which version of a message is shown, and a way to the others: every time
 * it was edited or sent again, with what followed it that time. Not while a
 * run is going — it would be answering a conversation being swapped under it.
 */
function VersionSwitch({
  seqs,
  seq,
  running,
  busy,
  onSwitch,
}: {
  seqs: number[];
  seq: number;
  running: boolean;
  /** A switch is on its way: one at a time. */
  busy: boolean;
  onSwitch: (to: number) => void;
}) {
  const at = seqs.indexOf(seq);
  if (at < 0) return null;
  return (
    <div className="message-versions flex items-center text-[11px] text-fg-subtle" role="group" aria-label={t("Versions of this message")}>
      <MessageAction label={running ? t("Stop the run to switch versions") : t("Previous version")} disabled={running || busy || at === 0} onClick={() => onSwitch(seqs[at - 1])}>
        <LuChevronLeft className="h-3 w-3" />
      </MessageAction>
      <span className="min-w-[2.2rem] text-center tabular-nums" aria-live="polite">
        {at + 1} / {seqs.length}
      </span>
      <MessageAction label={running ? t("Stop the run to switch versions") : t("Next version")} disabled={running || busy || at === seqs.length - 1} onClick={() => onSwitch(seqs[at + 1])}>
        <LuChevronRight className="h-3 w-3" />
      </MessageAction>
    </div>
  );
}

/** Copies a message, and for a moment says that it did. */
function CopyAction({ text }: { text: string }) {
  const [result, setResult] = useState<"done" | "failed" | null>(null);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <MessageAction
      label={result === "done" ? t("Copied") : result === "failed" ? t("Could not copy") : t("Copy")}
      onClick={async () => {
        setResult((await copyText(text)) ? "done" : "failed");
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setResult(null), 1500);
      }}
    >
      {result === "done" ? <LuCheck className="h-3 w-3 text-ok" /> : <LuCopy className="h-3 w-3" />}
    </MessageAction>
  );
}

function MessageAction({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1.5 text-fg-faint transition disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? "hover:text-danger" : "hover:text-accent"
      }`}
    >
      {children}
    </button>
  );
}

/** A sent message, opened for rewriting in place. */
function MessageEditor({
  initial,
  hasImages,
  onSave,
  onCancel,
}: {
  initial: string;
  /** The message went with pictures: they go again, so the words may be left out. */
  hasImages?: boolean;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const changed = value.trim() !== initial.trim();
  const empty = !value.trim() && !hasImages;

  const save = async () => {
    if (empty || !changed || saving) return;
    setSaving(true);
    try {
      await onSave(value.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-[80%] rounded-2xl bg-accent/10 p-2 ring-1 ring-inset ring-accent/30">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (isEscape(e)) onCancel();
          if (isEnter(e) && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
        rows={Math.min(10, Math.max(2, value.split("\n").length))}
        aria-label={t("Edit message")}
        className="w-full resize-none bg-transparent px-1.5 py-1 text-sm text-fg outline-none"
      />
      <div className="mt-1 flex items-center gap-2 px-1">
        <span className="text-[11px] text-fg-faint">
          {hasImages ? t("Replaces this message and everything after it. The pictures go with it again.") : t("Replaces this message and everything after it.")}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto rounded-lg px-2.5 py-1 text-xs text-fg-muted transition hover:bg-fg/5"
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !changed || empty}
          className="rounded-lg bg-accent/15 px-2.5 py-1 text-xs text-accent ring-1 ring-inset ring-accent/25 transition hover:bg-accent/25 disabled:opacity-40"
        >
          {saving ? t("Sending…") : t("Send")}
        </button>
      </div>
    </div>
  );
}
