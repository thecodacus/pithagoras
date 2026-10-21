import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** How long an answer may take — and how such a wait is said. Node's own fetch gives up on a request that
 * has moved no bytes for five minutes; the timer here is between bytes, not against the clock, so the wait
 * is long enough for one full answer by default, settable from where the portal starts, `0` turning it off.
 * A wait as said must be whole milliseconds: a negative or a fraction would not be a wait at all, and past
 * what a timer may hold there is nothing to wait for, so what is not a number stays the default. */
export const waitMs = (raw: string | undefined, fallback: number): number => {
  if (raw == null) return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return fallback;
  return Math.min(Number(t), 2_147_483_647);
};

/** How long Node's own fetch may go quiet on an answer. Its five quiet minutes are no wait the portal chose:
 * they cut an MCP server's tool calls off mid-thought — one whose model moves no byte between the ask and the
 * one JSON it answers with — and everything else that reaches out from this process, pi's MCP adapters among
 * them (pi runs in it), ran on them too. These are the waits it takes: long enough for one run by default,
 * settable from where the portal starts, `0` turning the wait off. The timer is between bytes, not against the
 * clock: a flowing answer may go on as long as it flows.
 *
 * They ride on every fetch the process makes — pi's provider calls and any extension's included — so the default
 * is a ceiling of quiet, not of work: half an hour of silence ends a hung upstream, while an answer that keeps
 * moving is never cut by these waits. An extension that waits on a model for as long, for a tool call, takes
 * waits of its own on an agent of its own, or the call would die of the same death this exists to stop. */
export const globalWaits = {
  headers: waitMs(process.env.PORTAL_FETCH_HEADERS_TIMEOUT_MS, 30 * 60_000), // between the ask and the first byte of the answer
  body: waitMs(process.env.PORTAL_FETCH_BODY_TIMEOUT_MS, 30 * 60_000), // between the bytes of a streaming answer
};

/** Whether node itself was asked to route through the environment's proxies — the portal's rule for its fetches,
 * and now the same rule that decides whether every fetch it makes is proxied. It takes only what node takes, `1`:
 * taken wider, any truthy saying would send this process's local MCP and model calls to a corporate proxy on an
 * operator's machine that never asked for them. Node's own --use-env-proxy flag nothing here can see — operators
 * using it should say `NODE_USE_ENV_PROXY=1` as well. */
const throughEnvProxies = (): boolean => (process.env.NODE_USE_ENV_PROXY ?? "").trim() === "1";

/** An agent carrying a pair of waits — the portal's own when node was asked to take the environment's proxies,
 * the plain one otherwise. */
export const waitsAgent = (waits: { headers: number; body: number }): Agent | EnvHttpProxyAgent =>
  throughEnvProxies()
    ? new EnvHttpProxyAgent({ headersTimeout: waits.headers, bodyTimeout: waits.body })
    : new Agent({ headersTimeout: waits.headers, bodyTimeout: waits.body });

let installed = false;

/** Give the process its waits — before anything in it may reach out. Once, however often it is asked: the
 * waits are read at startup, and a second install would be the same dispatcher over the first. Called from the
 * entry on purpose rather than reached for by an import: importing a module should not change how every fetch
 * the importer makes behaves, even if its caller is the process's own start. */
export const installFetchWaits = (): void => {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(waitsAgent(globalWaits));
};
