import type { AvailableModel } from "./api";
import { t } from "./i18n";
import { formatTokens } from "./transcript";

/** What a model can do, in a few words: its window, whether it sees images, whether it thinks. */
export function modelTraits(m: Pick<AvailableModel, "contextWindow" | "input" | "reasoning">): string[] {
  const traits: string[] = [];
  if (m.contextWindow) traits.push(t("{n} window", { n: formatTokens(m.contextWindow) }));
  if (m.input?.includes("image")) traits.push(t("sees images"));
  if (m.reasoning) traits.push(t("thinks"));
  return traits;
}
