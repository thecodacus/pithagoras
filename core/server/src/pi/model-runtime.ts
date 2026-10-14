/**
 * Keeping a pi ModelRuntime in step with what Settings changes.
 *
 * pi builds its runtime once and does not look again on its own: a key added
 * to auth.json since, or a provider an installed package brings, is not in it.
 */

/**
 * Read models.json and auth.json again. pi's refresh() reads only models.json:
 * the keys are read once, when the runtime is made, into a store pi keeps to
 * itself and does not export — so it is reached through, and a key saved in
 * Settings reaches an open chat's model menu.
 */
export async function rereadConfig(runtime: any): Promise<void> {
  runtime?.credentials?.store?.reload?.();
  await runtime?.refresh?.({ allowNetwork: false });
}

/**
 * The providers installed packages bring, registered on a runtime made
 * outside any conversation — as a session does when it binds its extensions.
 * Without them a provider from a package was in every chat's model menu but
 * not in Settings, nor in the setup assistant waiting for a first model.
 *
 * Only the extensions are loaded, not skills or prompts, and none of them is
 * started: registering a provider is all they do when loaded.
 */
export async function addExtensionProviders(pi: any, runtime: any, cwd: string): Promise<void> {
  const loader = new pi.DefaultResourceLoader({
    cwd, agentDir: pi.getAgentDir(),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions()?.runtime;
  // One package that fails to register is left out; the rest still are.
  for (const { name, config } of loaded?.pendingProviderRegistrations ?? []) {
    try { runtime.registerProvider(name, config); } catch { /* left out */ }
  }
  for (const { provider } of loaded?.pendingNativeProviderRegistrations ?? []) {
    try { runtime.registerNativeProvider(provider); } catch { /* left out */ }
  }
  await runtime.refresh({ allowNetwork: false });
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The effort levels pi offers for a model, worked out as pi-ai's
 * getSupportedThinkingLevels does — pi does not export it, and the copy it
 * uses sits inside its own node_modules. A level the model maps to null is
 * not offered; xhigh and max only when the model names them.
 */
export function thinkingLevelsOf(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }): string[] {
  if (!model.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * The level pi starts a model on when asked for `level`: that one if the
 * model offers it, else the nearest above it, else below — as pi-ai's
 * clampThinkingLevel does, which pi does not export either. `levels` are the
 * model's, from thinkingLevelsOf.
 */
export function clampLevel(levels: string[], level: string): string {
  if (levels.includes(level)) return level;
  const asked = LEVELS.indexOf(level);
  if (asked === -1) return levels[0] ?? "off";
  for (let i = asked; i < LEVELS.length; i++) if (levels.includes(LEVELS[i])) return LEVELS[i];
  for (let i = asked - 1; i >= 0; i--) if (levels.includes(LEVELS[i])) return LEVELS[i];
  return levels[0] ?? "off";
}
