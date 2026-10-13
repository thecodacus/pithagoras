import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { DATA_DIR } from "./data-dir.js";
import { PASSWORD_KEY } from "./password.js";
import { dbFile } from "./schema-version.js";
import { SSO_ONLY_KEY } from "./sso-keys.js";

/**
 * `npm run sso-only-off`: for a portal whose sign-in provider is gone, or will not let anybody in, while the
 * password login is switched off (Settings → Authentication, "OIDC only"). It switches the password login back
 * on after asking; the provider's settings and the password stay as they are, and a running portal takes it at once.
 *
 * It opens the database file itself and nothing else of the server, so that it can run beside a portal that is up.
 */
const file = dbFile();
if (!existsSync(file)) {
  console.error(`There is no portal database in ${DATA_DIR}. Run this from the folder the portal runs from, or with the same DATA_DIR.`);
  process.exit(1);
}

const db = new Database(file, { fileMustExist: true });
try {
  const on = db.prepare("SELECT 1 FROM settings WHERE key = ? AND value = '1'").get(SSO_ONLY_KEY) !== undefined;
  if (!on) {
    console.log("The password login is not switched off: there is nothing to switch back on.");
    process.exit(0);
  }
  const password = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(PASSWORD_KEY) !== undefined;
  console.log(
    `The portal whose data is in ${DATA_DIR} signs in through its single sign-on provider only.\n` +
      "This switches the password login back on: the portal's password signs in again, beside the provider.\n" +
      "Every login ends with it, the provider's too, and everyone signs in again." +
      (password ? "" : "\nNo password is set: open the portal in a browser to choose one.")
  );
  // Resolved by the answer; an input that ends without one is no.
  const answer = await new Promise<string>((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stdout });
    lines.once("close", () => resolve(""));
    lines.question("Type on to switch the password login back on: ", (typed) => {
      resolve(typed);
      lines.close();
    });
  });
  if (answer.trim().toLowerCase() !== "on") {
    console.log("Nothing was changed.");
    process.exit(1);
  }
  db.prepare("DELETE FROM settings WHERE key = ?").run(SSO_ONLY_KEY);
  console.log("The password login is on again. A running portal takes it at once: sign in with the password.");
} finally {
  db.close();
}
