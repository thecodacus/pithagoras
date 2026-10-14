import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { agentHome } from "./agent-home.js";
import { writeFileAtomic } from "./atomic-write.js";
import { understoryOn } from "./features.js";
import { WATCH_FILE } from "./pi/context-files.js";
import { CHANGED, FileError, baseDir, writeText } from "./workspace-files.js";

/**
 * The agent's home directory.
 *
 * These three are handed to pi as context files when a session starts, through
 * the resource loader's agentsFilesOverride. Nothing is generated from them:
 * an earlier version composed an AGENTS.md because pi only discovers one
 * context file per directory, but the SDK takes an explicit list, which leaves
 * no second copy to drift and puts MEMORY.md genuinely in context rather than
 * relying on the agent to go and read it.
 */

export const AGENT_FILES = ["SOUL.md", "PrimaryUser.md", "MEMORY.md"] as const;

/**
 * The files shown and edited on the agent's page: those three, and WATCH.md,
 * what its heartbeat keeps an eye on. WATCH.md is not context and is not made
 * by the wizard: an agent without one simply has nothing to watch.
 */
const EDITABLE_FILES = [...AGENT_FILES, WATCH_FILE] as const;

/** A file of an agent's: the first agent's, unless another's home is given. */
const filePath = (name: string, home = agentHome()) => path.join(home, name);

/**
 * Whether the three files are there. By lstat, as the wizard asks: a link that leads
 * nowhere is something there, and the wizard does not write through it, so asking
 * `existsSync` would offer a wizard that can never finish.
 */
export const isInitialised = (home = agentHome()): boolean =>
  AGENT_FILES.every((f) => lstatSync(filePath(f, home), { throwIfNoEntry: false }));

/**
 * A file of the agent's as it is now: its text and when it last changed, or
 * nothing when it is not there or is not a plain file.
 *
 * Opened without following a link, and without waiting on a pipe. With the
 * container executor the home is mounted into the container, so the agent can
 * leave a link in place of SOUL.md that points at something the portal reads
 * and writes as itself, such as its own database.
 */
function readPlain(name: string, home: string): { content: string; mtime: number } | undefined {
  let fd: number;
  try {
    fd = openSync(filePath(name, home), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() ? { content: readFileSync(fd, "utf8"), mtime: st.mtimeMs } : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function readAgentFile(name: string, home = agentHome()): string {
  return readPlain(name, home)?.content ?? "";
}

export function agentFileStatus(home = agentHome()) {
  return {
    home,
    initialised: isInitialised(home),
    // Where the agent's memory is kept: while Understory holds it, MEMORY.md is not read.
    memory: understoryOn() ? ("understory" as const) : ("file" as const),
    files: EDITABLE_FILES.map((name) => {
      const read = readPlain(name, home);
      // `mtime` is what a save sends back as `expected`: the agent writes these files too.
      // `link`: a link is shown as nothing and not written through, so the page says so, not offers an empty editor.
      const link = Boolean(lstatSync(filePath(name, home), { throwIfNoEntry: false })?.isSymbolicLink());
      return { name, exists: existsSync(filePath(name, home)), content: read?.content ?? "", mtime: read?.mtime ?? 0, link };
    }),
  };
}

/**
 * Saves one of the agent's files, put in place whole (see writeText).
 *
 * `expected` is the modification time the page was showing. If the file has
 * changed since, the save is refused with a FileError "conflict" instead of
 * putting the page's older text over what the agent wrote. 0 is what the page
 * saw of a file that was not there (WATCH.md, until it is first written): it is
 * made, unless the agent has made it since. Nothing expected saves whatever is there.
 */
export function writeAgentFile(name: string, content: string, home = agentHome(), expected?: number): void {
  if (!(EDITABLE_FILES as readonly string[]).includes(name)) {
    throw new Error(`"${name}" is not one of the agent's files`);
  }
  // A link is left alone, as the read leaves it: writing "through" one inside the folder would change what it leads to.
  if (lstatSync(filePath(name, home), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new FileError("invalid", `${name} is a link, so it is left alone`);
  }
  try {
    writeText(baseDir(home), name, content.endsWith("\n") ? content : `${content}\n`, expected || undefined, expected === 0);
  } catch (e) {
    if (e instanceof FileError && e.code === "exists") throw new FileError("conflict", CHANGED);
    throw e;
  }
}

export interface WizardInput {
  agentName: string;
  vibe?: string;
  principles?: string;
  userName: string;
  userAbout?: string;
  userPrefers?: string;
}

/**
 * Write the three files from the wizard's answers, those that are not there.
 *
 * The templates are opinionated on purpose: an empty SOUL.md produces a
 * characterless agent, and someone setting this up for the first time has no
 * reason to know what belongs in one.
 *
 * A file that is there is left as it is, and named in the answer. A folder
 * kept when its agent was deleted holds a SOUL.md and a PrimaryUser.md written
 * by hand, and the agent made again under the name is told it picks them up.
 * MEMORY.md above all: it is the one file here that cannot be reconstructed.
 */
export function runWizard(input: WizardInput, home = agentHome()): { kept: string[] } {
  const name = input.agentName.trim() || "the agent";
  const vibe = input.vibe?.trim();
  const principles = input.principles?.trim();
  const userName = input.userName.trim() || "the primary user";

  // Every file opens by saying what it is and what to do with it. Content on
  // its own is ambiguous — handed the same words with no instruction, the model
  // read SOUL.md as notes about a third party and answered as itself.
  const soul = `# SOUL.md — who you are

**This file is your identity.** It is not notes about someone else. The name,
character and working style below are yours: answer as this, in every
conversation, on every channel. If it conflicts with a habit of yours, this
wins.

To change how you behave, edit this file.

---

# ${name}

${vibe || `You are ${name}. You work for one person and you know them well.`}

## How you work

${
  principles ||
  [
    "- Answer the question. No preamble, no restating what was asked.",
    "- Have a view. If something is a bad idea, say so and say why.",
    "- Be brief. A sentence that does the job beats a paragraph that also does the job.",
    "- Say when you are unsure, and say what would settle it.",
    "- You are often reached from a phone. Long replies are hard to read there.",
  ].join("\n")
}

## What you do not do

- Guess at facts you could check.
- Claim something is done when it is not.
- Pad an answer to look thorough.
`;

  const user = `# PrimaryUser.md — who you work for

**This file describes the person you are talking to.** Assume what it says
rather than asking them to repeat it, and answer the way it describes. If you
learn something lasting about them, it belongs in MEMORY.md, not here — this
file is theirs to write.

---

# ${userName}

${input.userAbout?.trim() || "_What they work on, what they care about, what you should assume._"}

## Working with them

${input.userPrefers?.trim() || "_How they like to be answered — length, tone, how much detail, what to skip._"}
`;

  const memory = `# MEMORY.md — what you have learned

**This file is your long-term memory and you maintain it.** You are given it at
the start of every conversation, so anything written here you simply know.

Append to it when you learn something worth having next week: a decision and
the reason behind it, a preference you were corrected on, how something is set
up. Write what would not be obvious from the conversation you are in. Do not
record what you could look up, and do not restate what is already here.

Keep it in the sections below. Newest last.

---

## Decisions

_Choices that were made and why, so they are not argued twice._

## Preferences

_How things should be done, learned from being corrected._

## Context

_Names, systems, how things are set up. True and not obvious._
`;

  const kept: string[] = [];
  for (const [file, text] of [["SOUL.md", soul], ["PrimaryUser.md", user], ["MEMORY.md", memory]] as const) {
    // lstat, not exists: a link that points nowhere is something there, and is not written through.
    if (lstatSync(filePath(file, home), { throwIfNoEntry: false })) kept.push(file);
    else writeFileAtomic(filePath(file, home), text);
  }
  return { kept };
}
