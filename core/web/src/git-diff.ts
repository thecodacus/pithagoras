import { msg } from "./i18n";
/**
 * A unified diff, as git or gh prints it, read into files and lines to draw.
 *
 * One file's diff and a whole pull request's are the same text, so both go
 * through here: split at each `diff --git`, and within a file numbered from
 * each hunk's header, so every line knows where it was and where it is.
 */

export interface DiffRow {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  text: string;
  /** Its number in the old file, for a line that was there. */
  old?: number;
  /** Its number in the new file, for a line that is there. */
  new?: number;
  /**
   * In a combined diff — a file in conflict, a merge — one column per parent,
   * as git prints them: `++` in both, ` +` only against the second, and so on.
   */
  mark?: string;
}

export interface DiffFile {
  path: string;
  /** Where a renamed file was. */
  from?: string;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  added: number;
  removed: number;
  rows: DiffRow[];
  /** Combined: compared with more than one parent, a column each. */
  combined?: boolean;
}

/** A name as git writes it: plain, or in quotes with C escapes when it holds something odd. */
export function unquote(name: string): string {
  if (!name.startsWith('"')) return name;
  const bytes: number[] = [];
  const body = name.slice(1, name.lastIndexOf('"') > 0 ? name.lastIndexOf('"') : undefined);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(simple[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** `a/x` or `b/x` to `x`; /dev/null stays what it is. */
const side = (raw: string) => {
  const name = unquote(raw.trim());
  return name === "/dev/null" ? name : name.replace(/^[ab]\//, "");
};

/**
 * The two names of a `diff --git` line. git quotes a name only when it holds
 * something odd — a space is not — so `a/my file.txt b/my file.txt` is split
 * where the two halves are the same name; a rename with spaces in it is split
 * at its last " b/", and put right by the "rename from/to" lines after it.
 */
function headerNames(rest: string): [string, string] | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(rest) ?? /^("(?:[^"\\]|\\.)*") (.+)$/.exec(rest);
  if (quoted && (quoted[1].startsWith('"') || quoted[2].startsWith('"'))) return [side(quoted[1]), side(quoted[2])];
  if ((rest.length - 5) % 2 === 0) {
    const name = rest.slice(2, 2 + (rest.length - 5) / 2);
    if (rest === `a/${name} b/${name}`) return [name, name];
  }
  const at = rest.lastIndexOf(" b/");
  return at > 0 ? [side(rest.slice(0, at)), side(rest.slice(at + 1))] : null;
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldAt = 0;
  let newAt = 0;
  let inHunk = false;
  // How many columns start a line: one, or one per parent in a combined diff.
  let columns = 1;
  const lines = text.split("\n");
  // The newline that ends the last line is not a line of its own.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      // The names are read from ---/+++ when there are any; this is for a file without (binary, mode only, empty).
      const combined = !line.startsWith("diff --git ");
      const names = combined ? null : headerNames(line.slice(11));
      // `diff --cc <name>`: one name, as it is, no a/ or b/.
      const named = combined ? unquote(line.replace(/^diff --(cc|combined) /, "")) : names ? names[1] : line.slice(11);
      file = { path: named, status: "modified", binary: false, added: 0, removed: 0, rows: [], ...(combined ? { combined } : {}) };
      if (names && names[0] !== names[1]) file.from = names[0];
      columns = 1;
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk || line.startsWith("@@")) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.from = unquote(line.slice(12));
        file.status = "renamed";
      } else if (line.startsWith("rename to ")) {
        file.path = unquote(line.slice(10));
        file.status = "renamed";
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        file.binary = true;
        file.rows.push({ kind: "note", text: msg("A binary file — not shown") });
      } else if (line.startsWith("--- ")) {
        if (side(line.slice(4)) === "/dev/null") file.status = "added";
      } else if (line.startsWith("+++ ")) {
        const now = side(line.slice(4));
        if (now === "/dev/null") file.status = "deleted";
        else file.path = now;
      } else if (line.startsWith("@@")) {
        const m = /^@@+ -(\d+)(?:,\d+)? (?:-\d+(?:,\d+)? )*\+(\d+)(?:,\d+)? @@+(.*)$/.exec(line);
        oldAt = m ? Number(m[1]) : 0;
        newAt = m ? Number(m[2]) : 0;
        columns = Math.max(1, (/^@+/.exec(line)?.[0].length ?? 2) - 1);
        file.rows.push({ kind: "hunk", text: line });
        inHunk = true;
      }
      continue;
    }
    if (columns > 1) {
      // Combined: a column per parent. Added against any of them is an
      // addition, gone from the result is a removal; the old number is the
      // first parent's — ours, in a conflict — and counts only its lines.
      const prefix = line.slice(0, columns);
      if (!/^[ +-]+$/.test(prefix) && !(line === "" || prefix.trim() === "")) {
        if (line.startsWith("\\")) file.rows.push({ kind: "note", text: line.slice(2) });
        else inHunk = false;
        continue;
      }
      const text = line.slice(columns);
      const gone = prefix.includes("-");
      const kind = gone ? "del" : prefix.includes("+") ? "add" : "ctx";
      const inFirst = prefix[0] !== "+";
      file.rows.push({ kind, text, mark: prefix, ...(inFirst ? { old: oldAt++ } : {}), ...(gone ? {} : { new: newAt++ }) });
      if (kind === "add") file.added++;
      if (kind === "del") file.removed++;
      continue;
    }
    const mark = line[0];
    const body = line.slice(1);
    if (mark === "+") {
      file.rows.push({ kind: "add", text: body, new: newAt++ });
      file.added++;
    } else if (mark === "-") {
      file.rows.push({ kind: "del", text: body, old: oldAt++ });
      file.removed++;
    } else if (mark === " " || line === "") {
      file.rows.push({ kind: "ctx", text: body, old: oldAt++, new: newAt++ });
    } else if (mark === "\\") {
      file.rows.push({ kind: "note", text: line.slice(2) });
    } else {
      // Something that is not a hunk line ends the hunk: the header of what comes next.
      inHunk = false;
    }
  }
  // A rename that also names itself the same both ways is not one.
  for (const f of files) if (f.from === f.path) delete f.from;
  return files;
}
