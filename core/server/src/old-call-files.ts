import type Database from "better-sqlite3";
import path from "node:path";
import { FILES_KEY, type ShownFile } from "./file-outputs.js";
import { calledThrough, calledToolOf } from "./pi/tools-gateway-names.js";
import { pathBelow } from "./within.js";

/**
 * A call that gave the person a file says so on its end now (see
 * file-outputs.ts), and the page, voice mode and the channels go by that
 * alone. Before, only the portal's own picture and clip tools could, each in a
 * shape of its own that the page read by the tool's name: the path and title
 * in its `details`, and on generate_image, edit_image and generate_video a
 * mark that it was the portal's tool. The ends of those calls kept in a
 * conversation, and in the versions of a message kept beside it, are given the
 * files they showed, with the kind the tool showed them as. An edit's
 * original, which the page found in what the call was given, is its `from`.
 * Nothing else is changed. Run once, by the upgrade to schema 6; the database
 * was backed up before (see db-upgrade.ts).
 */

/** What may be one of those calls, by its text: only these are read. Loosely, as a version keeps its events as JSON in JSON. */
const MAYBE = (column: string) => `(${["show_image", "show_video", "portalImage", "portalVideo"].map((word) => `${column} LIKE '%${word}%'`).join(" OR ")})`;

/** The files an old call's end showed, or nothing for an end that is not of one of those calls, failed, or says so already. */
function oldFiles(end: any, startOf: (callId: string) => any, folder: string | undefined): ShownFile[] | undefined {
  if (end?.isError || FILES_KEY in end) return undefined;
  const name = calledToolOf(end);
  const details = end.result?.details;
  if (typeof details?.path !== "string" || !details.path) return undefined;
  const kind =
    name === "show_image" || ((name === "generate_image" || name === "edit_image") && details.portalImage === true) ? "picture"
    : name === "show_video" ? "video"
    : name === "generate_video" && details.portalVideo === true ? (details.notPlayable ? "file" : "video")
    : undefined;
  if (!kind) return undefined;
  const title = typeof details.title === "string" && details.title ? details.title : undefined;
  let from: string[] = [];
  if (name === "edit_image") {
    const start = startOf(String(end.toolCallId ?? ""));
    const input = calledThrough(start?.args)?.args ?? start?.args;
    const given: unknown[] = Array.isArray(input?.paths) ? input.paths : [input?.path];
    from = given.flatMap((p) => {
      const rel = folder && typeof p === "string" && p ? pathBelow(folder, path.resolve(folder, p)) : undefined;
      return rel ? [rel] : [];
    });
  }
  return [{ path: details.path, kind, ...(title ? { title } : {}), ...(from.length ? { from } : {}) }];
}

/** A kept end's payload with the files its call showed, or nothing when it is not the end of one of those calls. */
function rewritten(payload: string, startOf: (callId: string) => any, folder: string | undefined): string | undefined {
  let end: any;
  try {
    end = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const files = oldFiles(end, startOf, folder);
  return files ? JSON.stringify({ ...end, [FILES_KEY]: files }) : undefined;
}

const parsed = (payload: unknown) => {
  try {
    return typeof payload === "string" ? JSON.parse(payload) : undefined;
  } catch {
    return undefined;
  }
};

export function filesOnOldCalls(d: Database.Database): void {
  const folders = new Map<string, string | undefined>();
  const folderOf = (session: string) => {
    if (!folders.has(session)) folders.set(session, (d.prepare("SELECT workspace FROM sessions WHERE id = ?").get(session) as { workspace?: string } | undefined)?.workspace);
    return folders.get(session);
  };
  const start = d.prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'tool_execution_start' AND json_extract(payload, '$.toolCallId') = ? LIMIT 1");
  /** Where a call started, in the conversation kept. */
  const keptStart = (session: string) => (id: string) => parsed((start.get(session, id) as { payload: string } | undefined)?.payload);

  d.transaction(() => {
    const put = d.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    const ends = d.prepare(`SELECT seq, session_id, payload FROM events WHERE type = 'tool_execution_end' AND ${MAYBE("payload")}`).all() as { seq: number; session_id: string; payload: string }[];
    for (const row of ends) {
      const payload = rewritten(row.payload, keptStart(row.session_id), folderOf(row.session_id));
      if (payload) put.run(payload, row.seq);
    }

    // A version's events, where the start of a call is among them, or else in the conversation it went on from.
    const putVersion = d.prepare("UPDATE message_versions SET rows = ? WHERE id = ?");
    const versions = d.prepare(`SELECT id, session_id, rows FROM message_versions WHERE ${MAYBE("rows")}`).all() as { id: number; session_id: string; rows: string }[];
    for (const version of versions) {
      const rows = parsed(version.rows);
      if (!Array.isArray(rows)) continue;
      const kept = keptStart(version.session_id);
      const startOf = (id: string) => {
        for (const row of rows) {
          const event = row?.type === "tool_execution_start" ? parsed(row.payload) : undefined;
          if (event?.toolCallId === id) return event;
        }
        return kept(id);
      };
      let changed = false;
      const next = rows.map((row: any) => {
        const payload = row?.type === "tool_execution_end" ? rewritten(row.payload, startOf, folderOf(version.session_id)) : undefined;
        if (!payload) return row;
        changed = true;
        return { ...row, payload };
      });
      if (changed) putVersion.run(JSON.stringify(next), version.id);
    }
  })();
}
