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
