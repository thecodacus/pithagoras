/**
 * Where the browser listens for its debugging protocol (CDP), which the tools drive it over: `BROWSER_CDP_URL`, read as
 * it is now, or this machine's port 9222, where the container (on the host's network) and a local Chrome both listen.
 */
export const cdpUrl = () => process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222";

/** What the browser says it is (`Browser` of /json/version), or nothing when no browser answers there within 4 s. */
export async function browserVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${cdpUrl()}/json/version`, { signal: AbortSignal.timeout(4000) });
    const { Browser } = (await response.json()) as { Browser?: unknown };
    return response.ok && typeof Browser === "string" ? Browser : null;
  } catch {
    // Not running is a state, not an error: a browser can be stopped, or not there yet.
    return null;
  }
}
