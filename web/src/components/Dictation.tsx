import { LuLoaderCircle, LuMic } from "react-icons/lu";
import type { Dictation, DictationMode } from "../use-dictation";

/** Turns dictation on and off. Hidden until voice is set up, since that is what transcribes. */
export function DictationButton({ dictation }: { dictation: Dictation }) {
  if (!dictation.available) return null;
  const on = dictation.active || dictation.starting;
  return (
    <button
      type="button"
      onClick={dictation.toggle}
      aria-pressed={on}
      aria-label={on ? "Stop dictating" : "Dictate a message"}
      title={
        on
          ? "Stop dictating"
          : dictation.mode === "send"
            ? "Dictate — what you say is sent when you pause"
            : "Dictate — what you say is typed into the box"
      }
      className="prompt-action"
    >
      {dictation.starting ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuMic aria-hidden />}
    </button>
  );
}

const MODES: { id: DictationMode; label: string; hint: string }[] = [
  { id: "review", label: "Edit first", hint: "Words are typed into the box, so you can change them before sending" },
  { id: "send", label: "Send at once", hint: "A message is sent as soon as you pause" },
];

/**
 * What dictation is doing, above the message box: whether it hears you, what it
 * has made of it so far, and where the words will go.
 */
export function DictationStrip({ dictation }: { dictation: Dictation }) {
  if (!dictation.showing) return null;
  const hearing = dictation.phase === "Hearing you";
  const working = dictation.active || dictation.starting || dictation.phase === "Transcribing" || dictation.held !== "";
  if (!working) {
    // Only a failure is left, e.g. a microphone that was refused.
    return (
      <p role="alert" className="mb-1 px-2 pt-0.5 text-xs text-danger">
        {dictation.error}
      </p>
    );
  }
  const words = [dictation.held, dictation.partial].filter(Boolean).join(" ");
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 pt-0.5 text-xs">
      <span role="status" className="flex shrink-0 items-center gap-1.5 text-fg-muted">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${
            hearing ? "animate-pulse bg-accent" : dictation.phase === "Transcribing" ? "bg-fg-subtle" : "bg-fg-faint"
          }`}
        />
        {dictation.starting ? "Starting the microphone…" : dictation.active ? dictation.phase : "Finishing…"}
      </span>
      <span className="min-w-0 flex-1 basis-40 truncate italic text-fg-subtle" aria-live="off">
        {words}
      </span>
      <div role="group" aria-label="Where dictated words go" className="flex shrink-0 rounded-lg bg-fg/5 p-0.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            title={m.hint}
            aria-pressed={dictation.mode === m.id}
            onClick={() => dictation.setMode(m.id)}
            className={`rounded-md px-2 py-0.5 transition ${
              dictation.mode === m.id ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      {dictation.error && (
        <p role="alert" className="basis-full text-danger">
          {dictation.error}
        </p>
      )}
    </div>
  );
}
