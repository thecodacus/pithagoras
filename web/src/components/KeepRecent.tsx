import { useCallback, useRef } from "react";
import { api, type CompactionSettings } from "../api";

/**
 * How much of a conversation compaction leaves alone.
 *
 * The number that decides how full a session is *after* it has been compacted:
 * the most recent stretch is kept word for word and only what is older gets
 * summarised. pi's default is 20,000 tokens, which on a 64k model is a third of
 * the window spent before the summary is even added — so a compacted session
 * reads as still half full and it looks as though compaction did nothing.
 *
 * A slider rather than a number field because the useful question is not "how
 * many tokens" but "how much of my window", and that is a shape, not a figure.
 */

/** The API's own floor, so a stored value can always be shown as what it is. */
const MIN = 1_000;
const STEP = 1_000;
/**
 * Where the slider ends when the window is unknown.
 *
 * Not the API's ceiling of 500,000: a slider spanning that would put every
 * useful value in its first few pixels. A value already above this raises the
 * end instead, so a setting made elsewhere is never misrepresented or clamped
 * by a control that merely cannot draw it.
 */
const FALLBACK_MAX = 48_000;

export const formatTokens = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);

export function KeepRecent({
  value,
  onChange,
  onCommit,
  contextWindow,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  /** Fired when the drag ends, so a save is not sent on every pixel. */
  onCommit?: (next: number) => void;
  /** The model's window, when it is known — turns tokens into a proportion. */
  contextWindow?: number;
  disabled?: boolean;
}) {
  const ceiling =
    contextWindow && contextWindow > MIN ? Math.min(contextWindow, 200_000) : FALLBACK_MAX;
  const max = Math.max(ceiling, value);
  const clamped = Math.min(Math.max(value, MIN), max);
  const share = contextWindow ? (clamped / contextWindow) * 100 : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-fg-subtle">Keep recent</span>
        <span className="tabular-nums text-xs text-fg">
          {formatTokens(clamped)} tokens
          {share !== null && <span className="ml-1 text-fg-faint">· {share.toFixed(0)}% of window</span>}
        </span>
      </div>
      <input
        type="range"
        min={MIN}
        max={max}
        step={STEP}
        value={clamped}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        aria-label="Tokens kept verbatim by compaction"
        className="mt-1.5 h-1 w-full cursor-pointer appearance-none rounded-full bg-raised accent-accent disabled:opacity-40"
      />
      <div className="mt-1 flex justify-between text-[10px] text-fg-faint">
        <span>{formatTokens(MIN)}</span>
        <span>{formatTokens(max)}</span>
      </div>
    </div>
  );
}

/**
 * Save the value, in order, and only the value that is still current.
 *
 * A slider driven from the keyboard fires a commit per keypress, so several
 * saves are asked for in quick succession. Two problems, and guarding the
 * callbacks only solves the visible one.
 *
 * Requests do not have to come back in the order they were sent. An earlier
 * reply landing last would repaint the control with a value the server no
 * longer holds — the number appears to jump backwards on its own. Worse, an
 * earlier request can *arrive* last, and then the server ends up storing the
 * older value while the control quite correctly shows the newer one. No amount
 * of care on the client's side of the reply fixes that; the writes themselves
 * have to be ordered.
 *
 * So they run one at a time, and a value that a newer commit has already
 * replaced is dropped when its turn comes rather than sent — the newer one is
 * behind it in the queue and will write. Dragging a slider across twenty steps
 * makes two requests, not twenty, and the last one holds the value you left it
 * on.
 *
 * All of this is module level rather than per component: it is one setting,
 * and the two places that offer it must not race each other either.
 */
let queue: Promise<unknown> = Promise.resolve();
let newest = 0;

/** Skipped rather than sent, when something newer is already waiting behind it. */
const SUPERSEDED = Symbol("superseded");

export function useKeepRecentSave(
  onSaved: (compaction: CompactionSettings, refreshed: number) => void,
  onFailed: (error: Error) => void,
) {
  const saved = useRef(onSaved);
  const failed = useRef(onFailed);
  saved.current = onSaved;
  failed.current = onFailed;

  return useCallback(async (tokens: number) => {
    const mine = ++newest;
    const run = async () => {
      if (mine !== newest) return SUPERSEDED;
      return api.saveSettings({ keepRecentTokens: tokens });
    };
    // Chained off the previous save whether it worked or not, or one failure
    // would stop every later save from ever being sent.
    const next = queue.then(run, run);
    queue = next.then(
      () => {},
      () => {},
    );

    try {
      const r = await next;
      if (r === SUPERSEDED || mine !== newest) return;
      saved.current(r.compaction, r.refreshed);
    } catch (e) {
      if (mine !== newest) return;
      failed.current(e as Error);
    }
  }, []);
}
