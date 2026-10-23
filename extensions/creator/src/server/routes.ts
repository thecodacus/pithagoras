import { rmSync } from "node:fs";
import { copyOf, listMade, oneAtATime, records, saveRecords, type Run } from "./made";

/**
 * Creator mode's page in Settings, at /api/x/pithagoras-creator/…, behind the portal's login.
 *
 *   GET    /made        every extension made in Creator mode, the one installed last first: its record, its chat now
 *                       (null for one deleted), and whether it is installed from its copy and switched on
 *   DELETE /made/:name  forgets one that is not installed: its copy and its record go. 409 while it is installed,
 *                       which Settings → Extensions removes; it waits for an install of it that is running
 */
export function routes(run: Run): void {
  const { router } = run.portal;
  router.get("/made", async (_req, res) => {
    try {
      res.json({ made: await listMade(run) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  router.delete("/made/:name", async (req, res) => {
    const name = req.params.name;
    try {
      const answer = await oneAtATime(async () => {
        const made = records(run);
        if (!made.has(name)) return { status: 404, body: { error: `Creator mode made nothing called ${name}` } };
        const status = await run.portal.extensions.status(name);
        if (status?.installedFrom?.extension === run.portal.extension) return { status: 409, body: { error: "It is installed: remove it in Settings → Extensions first" } };
        rmSync(copyOf(run, name), { recursive: true, force: true });
        made.delete(name);
        saveRecords(run, made);
        return { status: 200, body: { forgotten: name } };
      });
      res.status(answer.status).json(answer.body);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
