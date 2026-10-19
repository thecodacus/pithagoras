import type { Response } from "express";
import type { ServerPortal } from "@pithagoras/extension-api/server";
import { agentDocker, type AgentUser } from "./agent";
import { composeRunner } from "./compose";
import { dockerFor } from "./docker";
import { DockerError } from "./engine";
import { hostPaths } from "./host-paths";
import { registerTools } from "./tools";

/**
 * Docker's server half: what each extension that builds on it is given (api.ts, `portal.provide`), the agent's tools in
 * each chat (tools.ts), and the routes of its page in Settings, at /api/x/pithagoras-docker/…, where the person sees
 * every extension's containers and volumes and may start, stop and remove them, and read what a container wrote.
 *
 *   GET    /overview                      whether Docker is reached, its version, and every extension's containers and volumes
 *   POST   /containers/:name/start|stop
 *   DELETE /containers/:name
 *   GET    /containers/:name/logs?tail=   the end of what it wrote, as text
 *   DELETE /volumes/:name
 */

/** What a failure is to the page: Docker's own words, with the status that says what kind it is. */
function fail(res: Response, e: unknown) {
  const status = e instanceof DockerError ? (e.status === 403 || e.status === 404 || e.status === 409 ? e.status : 502) : 500;
  res.status(status).json({ error: (e as Error).message });
}

export default function docker(portal: ServerPortal) {
  const { forExtension, person } = dockerFor(portal.dataDir());
  portal.provide((consumer) => forExtension(consumer.name));

  // What the agent runs is this extension's, by the chat's folder.
  const own = forExtension(portal.extension);
  const onHost = hostPaths();
  const runner = composeRunner(portal.extension, (image) => own.images.ensure(image), onHost);
  const agent = agentDocker({ owner: portal.extension, runner, onHost, inside: portal.files.inside });
  // With the sandbox on, the chat's agent is a user of its own, and what Docker does with its folder is done as it.
  async function agentUser(chatId: string): Promise<AgentUser | undefined> {
    if (!portal.sandbox.on()) return undefined;
    const ran = await portal.sandbox.run(chatId, ["sh", "-c", "id -u; id -g; id -G"]);
    const [uid, gid, groups = ""] = ran.stdout.toString("utf8").trim().split("\n");
    if (ran.code !== 0 || !/^\d+$/.test(uid ?? "") || !/^\d+$/.test(gid ?? "")) throw new DockerError(`Who the chat's agent is could not be told: ${ran.stderr || `exit ${ran.code}`}`);
    return {
      uid: Number(uid),
      gid: Number(gid),
      groups: groups.split(/\s+/).filter(Boolean).map(Number).filter((g) => g !== Number(gid)),
      run: (argv) => portal.sandbox.run(chatId, argv),
    };
  }
  portal.chats.extend((pi, chat) => registerTools(pi, () => agent(portal.chats.folder(chat.id), () => agentUser(chat.id))));

  const route = (work: (req: { params: Record<string, string>; query: Record<string, unknown> }, res: Response) => Promise<unknown>) => (req: any, res: Response) =>
    void work(req, res).catch((e) => fail(res, e));
  portal.router.get("/overview", route(async (_req, res) => res.json(await person.overview())));
  for (const verb of ["start", "stop"] as const) {
    portal.router.post(`/containers/:name/${verb}`, route(async (req, res) => {
      await person[verb](req.params.name);
      res.json({ ok: true });
    }));
  }
  portal.router.delete("/containers/:name", route(async (req, res) => {
    await person.remove(req.params.name);
    res.json({ ok: true });
  }));
  portal.router.get("/containers/:name/logs", route(async (req, res) => {
    const tail = Number(req.query.tail);
    res.json({ text: await person.logs(req.params.name, Number.isFinite(tail) && tail > 0 ? tail : undefined) });
  }));
  portal.router.delete("/volumes/:name", route(async (req, res) => {
    await person.removeVolume(req.params.name);
    res.json({ ok: true });
  }));
}
