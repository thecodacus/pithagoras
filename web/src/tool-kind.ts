import type { FillerKind } from "./api";

export type ToolKind = "command" | "browser" | "search" | "read" | "edit" | "tool";

/** What a tool call is doing, in the broad strokes a listener cares about. */
export function toolKind(payload: Record<string, any> = {}): ToolKind {
  const input = payload.input ?? payload.args ?? payload.parameters ?? {};
  const name = String(payload.toolName ?? payload.name ?? "tool");
  if (/bash|terminal|shell|exec_command/.test(name)) return "command";
  if (/browser|navigate/.test(name) || /browser/.test(String(input.tool ?? ""))) return "browser";
  if (/search/.test(name)) return "search";
  if (/read/.test(name)) return "read";
  if (/write|edit|patch/.test(name)) return "edit";
  return "tool";
}

/** What to say when this call runs long: a command's purpose where it shows, else the kind of work. */
export function slowFiller(payload: Record<string, any> = {}): FillerKind {
  const kind = toolKind(payload);
  if (kind === "browser") return "slowBrowser";
  if (kind === "search") return "slowSearch";
  if (kind !== "command") return "slow";
  const input = payload.input ?? payload.args ?? payload.parameters ?? {};
  const command = String(input.command ?? input.cmd ?? "");
  if (/\b(test|tests|pytest|jest|vitest|playwright|rspec|phpunit)\b|--test\b/.test(command)) return "slowTests";
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\buv\s+(sync|add|pip)\b|\b(apt|apt-get|brew|dnf|pacman)\b.*\binstall\b|\bcargo\s+(add|install)\b|\bgo\s+get\b/.test(command)) return "slowInstall";
  if (/\b(build|compile|make|cmake|tsc|webpack|vite\s+build|gradle|mvn)\b/.test(command)) return "slowBuild";
  return "slowCommand";
}
