import { existsSync } from "node:fs";
import http from "node:http";

/**
 * Docker's own API, over its socket: the docker command in the portal's image is the container executor's, and a
 * portal run on the machine itself may have none; a client library for a dozen endpoints is a dependency to keep up
 * with for good. `DOCKER_SOCKET` names another socket than the usual one.
 */

export const socketPath = () => process.env.DOCKER_SOCKET || "/var/run/docker.sock";

/** Whether the socket is there: whether it answers is `ping`'s. */
export const socketThere = () => existsSync(socketPath());

/** Docker could not be reached, or said no: in Docker's own words where it gave some. */
export class DockerError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/**
 * A request, answered with its status and the whole of its body as bytes. Given up after `timeoutMs` in all (0 waits as
 * long as it takes): as a failure, or, with `keep`, answered with what had come by then and `timedOut`.
 */
function send(method: string, path: string, body?: unknown, timeoutMs = 30_000, keep = false): Promise<{ status: number; bytes: Buffer; timedOut: boolean }> {
  if (!socketThere()) return Promise.reject(new DockerError(`Docker cannot be reached: there is no socket at ${socketPath()}`));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    // Bytes, put together once they are all there: a letter split across two chunks is two halves of one.
    const chunks: Buffer[] = [];
    let status = 0;
    const req = http.request(
      { socketPath: socketPath(), path, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        status = res.statusCode ?? 0;
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status, bytes: Buffer.concat(chunks), timedOut: false }));
        res.on("error", (e) => reject(new DockerError(`Docker's answer was cut off: ${e.message}`)));
      },
    );
    if (timeoutMs > 0) {
      const deadline = setTimeout(() => {
        if (keep) resolve({ status, bytes: Buffer.concat(chunks), timedOut: true });
        req.destroy(new DockerError("Docker did not answer in time"));
      }, timeoutMs);
      req.on("close", () => clearTimeout(deadline));
    }
    req.on("error", (e) => reject(e instanceof DockerError ? e : new DockerError(`Docker cannot be reached: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** A request whose answer is JSON, or nothing. */
export async function request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: T }> {
  const { status, bytes } = await send(method, path, body, timeoutMs);
  const text = bytes.toString("utf8");
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Some answers are not JSON: the text is what they said.
  }
  return { status, body: parsed as T };
}

/** A request that has to come out right: what Docker says when it does not, as the error. */
export async function checked<T = unknown>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const { status, body: said } = await request<T & { message?: string }>(method, path, body, timeoutMs);
  if (status >= 400) throw new DockerError((said as { message?: string } | null)?.message || `Docker answered ${status}`, status);
  return said;
}

/** Whether Docker answers. */
export async function ping(): Promise<boolean> {
  try {
    return (await send("GET", "/_ping", undefined, 5_000)).status === 200;
  } catch {
    return false;
  }
}

/** Downloads an image, with each line of what Docker says of it told as it comes. Docker's own failure, said in a line, is the error. */
export function pull(image: string, onLine: (line: string) => void): Promise<void> {
  if (!socketThere()) return Promise.reject(new DockerError(`Docker cannot be reached: there is no socket at ${socketPath()}`));
  // The tag after the last colon that is not part of a registry's port.
  const at = image.lastIndexOf(":");
  const [name, tag] = at > image.lastIndexOf("/") ? [image.slice(0, at), image.slice(at + 1)] : [image, "latest"];
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socketPath(), path: `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`, method: "POST" }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let message = "";
          try {
            message = JSON.parse(Buffer.concat(chunks).toString("utf8")).message ?? "";
          } catch {
            // No reason given.
          }
          reject(new DockerError(message || `The download of ${image} was refused (${res.statusCode})`, res.statusCode));
        });
        return;
      }
      let rest = "";
      let failed: DockerError | undefined;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim() || failed) continue;
          try {
            const said = JSON.parse(line) as { status?: string; progress?: string; error?: string };
            if (said.error) failed = new DockerError(said.error);
            else if (said.status) onLine(said.progress ? `${said.status} ${said.progress}` : said.status);
          } catch {
            // Not a line of Docker's: nothing to tell.
          }
        }
      });
      res.on("end", () => (failed ? reject(failed) : resolve()));
      res.on("error", (e) => reject(new DockerError(`Docker's answer was cut off: ${e.message}`)));
    });
    req.on("error", (e) => reject(new DockerError(`Docker cannot be reached: ${e.message}`)));
    req.end();
  });
}

/**
 * What a container wrote, as text. Docker sends the output of a container with no terminal as frames, each with a
 * header of eight bytes (which stream, and how long the frame is); one with a terminal, as it was written.
 */
export function demux(bytes: Buffer, tty: boolean): string {
  if (tty) return bytes.toString("utf8");
  const parts: Buffer[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(at + 4);
    parts.push(bytes.subarray(at + 8, at + 8 + size));
    at += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Docker's no to a request whose answer is read as bytes: in its own words where it gave some. */
function refusal(status: number, bytes: Buffer): DockerError {
  let message = "";
  try {
    message = JSON.parse(bytes.toString("utf8")).message ?? "";
  } catch {
    // No reason given.
  }
  return new DockerError(message || `Docker answered ${status}`, status);
}

/** The end of what a container wrote, as text: its output and its errors, or the one of them asked for. */
export async function logs(id: string, tail: number | "all", tty: boolean, streams: { stdout: boolean; stderr: boolean } = { stdout: true, stderr: true }): Promise<string> {
  const { status, bytes } = await send("GET", `/containers/${encodeURIComponent(id)}/logs?stdout=${Number(streams.stdout)}&stderr=${Number(streams.stderr)}&tail=${tail}`);
  if (status >= 400) throw refusal(status, bytes);
  return demux(bytes, tty);
}

/**
 * Runs an exec Docker made (`POST /containers/{id}/exec`) to its end: what it wrote, as text, and its exit code. Given up
 * on after `timeoutMs` (0 waits as long as it takes), with what it wrote by then and no exit code: Docker has no way to
 * end an exec, so it may still be running in the container.
 */
export async function exec(id: string, tty: boolean, timeoutMs: number): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  const { status, bytes, timedOut } = await send("POST", `/exec/${encodeURIComponent(id)}/start`, { Detach: false, Tty: tty }, timeoutMs, true);
  if (status >= 400) throw refusal(status, bytes);
  const output = demux(bytes, tty);
  if (timedOut) return { output, exitCode: null, timedOut };
  const { ExitCode } = await checked<{ ExitCode: number | null }>("GET", `/exec/${encodeURIComponent(id)}/json`);
  return { output, exitCode: ExitCode, timedOut };
}
