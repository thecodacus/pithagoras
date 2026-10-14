import { labelOf, msg } from "./i18n";

/**
 * pi's thinking levels, lowest first, and what each is called — one list, so
 * a level pi adds is offered and named together. One it adds before this list
 * knows it is shown by pi's own word.
 */
const LABELS: Record<string, string> = {
  off: msg("off"),
  minimal: msg("minimal"),
  low: msg("low"),
  medium: msg("medium"),
  high: msg("high"),
  xhigh: msg("xhigh"),
  max: msg("max"),
};

export const EFFORT_LEVELS: string[] = Object.keys(LABELS);

export const effortLabel = (level: string): string => labelOf(LABELS, level);
