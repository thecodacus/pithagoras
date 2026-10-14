import type { SessionStatus } from "../api";
import { labelOf, msg } from "../i18n";

const LABEL: Record<SessionStatus, string> = {
  running: msg("running"),
  idle: msg("idle"),
  error: msg("error"),
  interrupted: msg("interrupted — server restarted mid-run"),
};

/**
 * How a chat is doing: the same everywhere a list of chats is shown. At rest
 * a dot; working, the app's π, breathing with a glow behind it — the way the
 * thinking in a chat breathes — rather than one more spinner or blinking dot.
 * Its title shimmers beside it (`working-text`), as "Thinking" does.
 */
export function StatusDot({
  status,
  className = "",
  bare = false,
}: {
  status: SessionStatus;
  className?: string;
  /**
   * Without its slot. In a list every mark takes the same 16px, so a title
   * stays put when its chat starts or stops; a badge placed on its own does
   * not need one.
   */
  bare?: boolean;
}) {
  const mark =
    status === "running" ? (
      <span className={`status-working ${bare ? className : ""}`} title={labelOf(LABEL, "running")} role="img" aria-label={labelOf(LABEL, "running")}>
        <span aria-hidden>π</span>
      </span>
    ) : (
      <span className={`status-dot is-${status} ${bare ? className : ""}`} title={labelOf(LABEL, status)} role="img" aria-label={labelOf(LABEL, status)} />
    );
  return bare ? mark : <span className={`status-slot ${className}`}>{mark}</span>;
}

/** A chat's title while it works: it shimmers, as "Thinking" does in the chat. */
export const workingText = (status: SessionStatus) => (status === "running" ? "working-text" : "");
