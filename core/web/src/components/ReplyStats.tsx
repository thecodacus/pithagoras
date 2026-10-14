import type { ReplyStats } from "../transcript";
import { formatNumber, t } from "../i18n";

const speed = (perSecond: number) => formatNumber(perSecond, { maximumFractionDigits: perSecond < 100 ? 1 : 0 });
const seconds = (ms: number) => formatNumber(ms / 1000, { maximumFractionDigits: ms < 10_000 ? 2 : 1 });

/**
 * What writing a reply took, beside its Copy: how fast it was written, how fast
 * its prompt was read (prefill), and the tokens in and out. Each part only where
 * it is known; the times and the draft are in its tooltip.
 */
export function ReplyStatsLine({ stats }: { stats: ReplyStats }) {
  const parts: string[] = [];
  if (stats.outputPerSecond !== undefined) parts.push(t("{speed} t/s", { speed: speed(stats.outputPerSecond) }));
  if (stats.promptPerSecond !== undefined) parts.push(t("prefill {speed} t/s", { speed: speed(stats.promptPerSecond) }));
  if (stats.input !== undefined) parts.push(t("{count} in", { count: formatNumber(stats.input) }));
  if (stats.output !== undefined) parts.push(t("{count} out", { count: formatNumber(stats.output) }));
  if (!parts.length) return null;
  const details = [
    stats.input !== undefined && t("Prompt: {count} tokens", { count: formatNumber(stats.input) }),
    stats.cached ? t("{count} of them from the cache", { count: formatNumber(stats.cached) }) : "",
    // The time is the read part's alone: what came from the cache took none.
    stats.read !== undefined && stats.promptMs !== undefined ? t("{count} read in {seconds} s", { count: formatNumber(stats.read), seconds: seconds(stats.promptMs) }) : "",
    stats.output !== undefined && (stats.outputMs !== undefined
      ? t("Answer: {count} tokens, written in {seconds} s", { count: formatNumber(stats.output), seconds: seconds(stats.outputMs) })
      : t("Answer: {count} tokens", { count: formatNumber(stats.output) })),
    stats.draft ? t("Draft: {accepted} of {tokens} tokens kept", { accepted: formatNumber(stats.draft.accepted), tokens: formatNumber(stats.draft.tokens) }) : "",
  ].filter(Boolean).join("\n");
  // The details are in the tooltip for a pointer, and read out with the line for a screen reader, which has no hover.
  return (
    <span className="ml-1.5 select-none text-[11px] tabular-nums text-fg-faint" title={details}>
      {parts.join(" · ")}
      <span className="sr-only">{`. ${details.replace(/\n/g, ". ")}`}</span>
    </span>
  );
}
