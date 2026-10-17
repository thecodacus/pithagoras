import { existsSync } from "node:fs";
import http from "node:http";

/**
 * Docker's own API, over its socket: the portal's image has no docker command, and a client library for a dozen
 * endpoints is a dependency to keep up with for good. `DOCKER_SOCKET` names another socket than the usual one.
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

/** A request, answered with its status and the whole of its body as bytes. Given up after `timeoutMs` in all. */
function send(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; bytes: Buffer }> {
  if (!socketThere()) return Promise.reject(new DockerError(`Docker cannot be reached: there is no socket at ${socketPath()}`));
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath: socketPath(), path, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        // Bytes, put together once they are all there: a letter split across two chunks is two halves of one.
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(new DockerError("Docker did not answer in time")), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", (e) => reject(e instanceof DockerError ? e : new DockerError(`Docker cannot be reached: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** A request whose answer is JSON, or nothing. */
export async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const { status, bytes } = await send(method, path, body);
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
export async function checked<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, body: said } = await request<T & { message?: string }>(method, path, body);
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
      res.on("error", reject);
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

/** The end of what a container wrote, its output and its errors, as text. */
export async function logs(id: string, tail: number, tty: boolean): Promise<string> {
  const { status, bytes } = await send("GET", `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`);
  if (status >= 400) {
    let message = "";
    try {
      message = JSON.parse(bytes.toString("utf8")).message ?? "";
    } catch {
      // No reason given.
    }
    throw new DockerError(message || `Docker answered ${status}`, status);
  }
  return demux(bytes, tty);
}
