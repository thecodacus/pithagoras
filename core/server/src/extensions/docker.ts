import http from "node:http";
import { existsSync } from "node:fs";

/**
 * Just enough of the Docker API to run one container.
 *
 * Over the socket rather than the CLI: the portal image has no docker binary,
 * and shelling out would mean shipping one. No client library either — this is
 * five endpoints, and a dependency for five endpoints is a dependency to
 * upgrade forever.
 */

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

/**
 * Is the socket there?
 *
 * This used require() inside an ES module, which throws — and the throw was
 * caught and read as "no Docker here", so a deployment with a working socket
 * silently took the fallback path and reported no browser was possible.
 */
export const dockerAvailable = (): boolean => existsSync(SOCKET);

/** `timeoutMs`: given up once so long has passed in all, answer or not — not only after a silence. */
export function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCKET,
        path,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        // Bytes, put together once they are all there: a letter split across
        // two chunks is two halves of one, not two broken ones.
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = raw;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            // Some endpoints answer with newline-delimited JSON or nothing.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
      }
    );
    const deadline = timeoutMs
      ? setTimeout(() => req.destroy(Object.assign(new Error("Docker did not answer in time"), { code: "ETIMEDOUT" })), timeoutMs)
      : undefined;
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A pull, reported as it goes.
 *
 * The image is measured in gigabytes, so a request that simply blocks until it
 * finishes looks identical to one that has hung. onProgress is called with
 * whatever the daemon last said.
 */
export function pullImage(image: string, onProgress: (line: string) => void): Promise<void> {
  const [name, tag = "latest"] = image.split(":");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        path: `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
        method: "POST",
      },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          res.resume();
          return reject(new Error(`Pull failed with ${res.statusCode}`));
        }
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const m = JSON.parse(line) as { status?: string; progress?: string; error?: string };
              if (m.error) return reject(new Error(m.error));
              if (m.status) onProgress(`${m.status}${m.progress ? " " + m.progress : ""}`);
            } catch {
              // A partial line; the next chunk completes it.
            }
          }
        });
        res.on("end", () => resolve());
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export async function imagePresent(image: string): Promise<boolean> {
  const { status } = await request("GET", `/images/${encodeURIComponent(image)}/json`);
  return status === 200;
}

export async function containerState(
  name: string
): Promise<{ exists: boolean; running: boolean; id?: string }> {
  const { status, body } = await request<{ State?: { Running?: boolean }; Id?: string }>(
    "GET",
    `/containers/${name}/json`
  );
  if (status !== 200) return { exists: false, running: false };
  return { exists: true, running: Boolean(body?.State?.Running), id: body?.Id };
}

/**
 * A call to the daemon that has to come out right: what Docker says when it does not.
 * The one place a refusal is turned into an error, so that every add-on says it alike.
 */
export async function checked<T = unknown>(method: string, path: string, body?: unknown) {
  const result = await request<T & { message?: string }>(method, path, body);
  if (result.status >= 400) throw new Error(result.body?.message || `Docker returned ${result.status}`);
  return result;
}

/** What a pull says before the daemon has said anything. */
export const PULL_STARTING = "starting";

/** How a pull is going, for the page that shows it: under way with what the daemon last said, or ended with or without a failure. */
export interface PullState {
  active: boolean;
  line: string;
  error?: string;
}

/**
 * The image is there, or is pulled, with `onState` told as it goes. `timeoutMs`
 * stops waiting for a download that does not come; it goes on without being
 * waited for.
 */
export async function ensureImage(image: string, onState: (state: PullState) => void = () => {}, timeoutMs?: number): Promise<void> {
  if (await imagePresent(image)) return;
  onState({ active: true, line: PULL_STARTING });
  const pull = pullImage(image, (line) => onState({ active: true, line })).then(
    () => onState({ active: false, line: "done" }),
    (e) => {
      onState({ active: false, line: "", error: (e as Error).message });
      throw e;
    },
  );
  if (!timeoutMs) return pull;
  pull.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pull, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${image} was not downloaded in time`)), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts, stops or removes a container, by name or id, with the answers that
 * mean it is already as asked taken for done: a container that is running is
 * what a start asks for (304), and one that is gone is what a stop and a remove
 * ask for. Anything else Docker says is an error, in its own words.
 */
export async function containerAction(name: string, verb: "start" | "stop" | "remove"): Promise<void> {
  if (verb === "remove") {
    // A running one is stopped first, so that it ends what it was doing; one that will not stop is removed all the same.
    if ((await containerState(name)).running) await request("POST", `/containers/${name}/stop?t=10`).catch(() => {});
    const res = await request<{ message?: string }>("DELETE", `/containers/${name}?force=true`);
    if (res.status >= 400 && res.status !== 404) throw new Error(res.body?.message || `Remove failed (${res.status})`);
    return;
  }
  const res = await request<{ message?: string }>("POST", `/containers/${name}/${verb}${verb === "stop" ? "?t=10" : ""}`);
  // 304 is Docker saying it is as asked already, and is no error to begin with.
  if (res.status >= 400 && !(verb === "stop" && res.status === 404)) {
    throw new Error(res.body?.message || `${verb === "start" ? "Start" : "Stop"} failed (${res.status})`);
  }
}
