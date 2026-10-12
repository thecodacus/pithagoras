import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { DATA_DIR } from "./data-dir.js";
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
  console.log(
    `The password of the portal whose data is in ${DATA_DIR} will be removed.\n` +
      "Until a new one is chosen on the setup screen, nobody can sign in, and whoever opens the portal first chooses it."
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
  console.log("The password is removed. Open the portal in a browser to choose a new one.");
} finally {
  db.close();
}
