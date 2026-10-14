import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { DATA_DIR } from "./data-dir.js";
import { allowNoPassword } from "./http-security.js";
import { PASSWORD_KEY, PASSWORD_SHORT_KEY } from "./password.js";
import { dbFile } from "./schema-version.js";

/**
 * `npm run reset-password`: for a password that is lost. It removes the portal's password after asking,
 * and the portal asks for a new one on its setup screen — a running portal needs no restart.
 *
 * It opens the database file itself and nothing else of the server, so that it can run beside a portal
 * that is up: the portal keeps no copy of the password that would still let the old one in.
 */
const file = dbFile();
if (!existsSync(file)) {
  console.error(`There is no portal database in ${DATA_DIR}. Run this from the folder the portal runs from, or with the same DATA_DIR.`);
  process.exit(1);
}

const db = new Database(file, { fileMustExist: true });
try {
  const has = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(PASSWORD_KEY) !== undefined;
  if (!has) {
    console.log("The portal has no password to remove: it is waiting on its setup screen, or it runs without a login.");
    process.exit(0);
  }
  // A running portal never goes open: it waits on its setup screen, and what it had open under the password is ended.
  // A restarted one is told by its environment, which is this one in a container.
  const restart = allowNoPassword()
    ? "\nPORTAL_ALLOW_NO_PASSWORD is set: a portal that is started again with no password runs with no login at all (on this\n" +
      "machine only, unless ALLOW_OPEN is set), so choose a new password before it is restarted, or take the variable out."
    : "";
  console.log(
    `The password of the portal whose data is in ${DATA_DIR} will be removed.\n` +
      "Until a new one is chosen on the setup screen, nobody can sign in, and whoever opens the portal first chooses it." +
      restart
  );
  // Resolved by the answer; an input that ends without one is no.
  const answer = await new Promise<string>((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stdout });
    lines.once("close", () => resolve(""));
    lines.question("Type reset to remove it: ", (typed) => {
      resolve(typed);
      lines.close();
    });
  });
  if (answer.trim().toLowerCase() !== "reset") {
    console.log("Nothing was changed.");
    process.exit(1);
  }
  db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(PASSWORD_KEY, PASSWORD_SHORT_KEY);
  console.log(
    "The password is removed. A running portal is waiting on its setup screen: open it in a browser to choose a new one." +
      (allowNoPassword() ? " Do it before the portal is restarted." : "")
  );
} finally {
  db.close();
}
