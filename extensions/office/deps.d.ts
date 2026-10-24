/** Type surface of deps.js (its plain-JS twin beside this file): what the built server imports to install this
 * package's own node_modules at boot, in the background. esbuild bundles the .js; tsc reads these declarations. */
export function missingDependencies(dir?: string, opts?: { dev?: boolean }): string[];
export function ensureDependencies(log: (line: string) => void, opts?: { dir?: string; npm?: string }): Promise<boolean>;
