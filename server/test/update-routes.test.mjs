import { test, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The update over HTTP, on a server that is started as it is deployed, with a password: who may ask, what the
 * answers are, and that the steps run in the order the issue names. git and npm are stand-ins in front on the PATH
 * that answer from files and write down what they were asked, so that nothing is fetched, merged, installed or
 * built, and the portal only exits at the end (PORTAL_UPDATE_RESTART=exit) instead of starting itself again.
 */
const home = testHome("pithagoras-update-routes-");
const bin = path.join(home, "bin");
const fake = path.join(home, "fake");
mkdirSync(bin);
mkdirSync(fake);
const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const PASSWORD = "a password long enough";

const script = (name, body) => {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
};
// git is given `-c key=value` pairs before its command.
script("git", `
while [ "$1" = -c ]; do shift 2; done
echo "git $*" >> "$FAKE/ran"
case "$1" in
  rev-parse) echo "$ROOT" ;;
  symbolic-ref) [ -s "$FAKE/branch" ] && cat "$FAKE/branch" || exit 1 ;;
  log) if [[ " $* " == *" HEAD "* ]]; then cat "$FAKE/head"; else cat "$FAKE/target"; fi ;;
  status) cat "$FAKE/changed" ;;
  fetch) if [ -e "$FAKE/fetch-fails" ]; then echo "fatal: unable to access" >&2; exit 128; fi ;;
  rev-list) cat "$FAKE/counts" ;;
  merge) cp "$FAKE/target" "$FAKE/head"; printf '0\\t0\\n' > "$FAKE/counts" ;;
esac
exit 0`);
script("npm", `
echo "npm $*" >> "$FAKE/ran"
if [ -e "$FAKE/npm-fails" ] && [ "$1" = "$(cat "$FAKE/npm-fails")" ]; then echo "npm ERR! the build is broken" >&2; exit 1; fi
exit 0`);

const commit = (sha, subject) => `${sha.padEnd(40, "0")}\x1f${subject}\x1f2026-10-12T09:00:00+02:00\n`;
const put = (name, text) => writeFileSync(path.join(fake, name), text);
const ran = () => (existsSync(path.join(fake, "ran")) ? readFileSync(path.join(fake, "ran"), "utf8").trim().split("\n").filter(Boolean) : []);
/** A clean checkout on main, two commits behind. */
function reset() {
  for (const name of ["ran", "fetch-fails", "npm-fails"]) rmSync(path.join(fake, name), { force: true });
  put("branch", "main\n");
  put("changed", "");
  put("head", commit("aaa", "Where the checkout is"));
  put("target", commit("ccc", "Where main is"));
  put("counts", "0\t2\n");
}
reset();

let base;
let child;
before(async () => {
  const port = await freePort();
  ({ base, child } = await startServer(serverEnv(home, port, {
    PORTAL_PASSWORD: PASSWORD,
    PORTAL_ALLOW_NO_PASSWORD: "",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE: fake,
    ROOT: root,
    PORTAL_UPDATE_RESTART: "exit",
  })));
});

const login = async () => (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).headers.getSetCookie()[0].split(";")[0];
const send = async (cookie, url, method = "GET", body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const settled = async (cookie) => {
  for (let i = 0; i < 300; i++) {
    const { run } = (await send(cookie, "/api/update")).body;
    if (run && run.state !== "running") return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("the run did not settle");
};

test("whoever is not signed in is turned away from all of it, and nothing is run", async () => {
  reset();
  for (const [url, method] of [["/api/update", "GET"], ["/api/update/check", "POST"], ["/api/update", "POST"]]) {
    const res = await send(undefined, url, method, method === "POST" ? {} : undefined);
    assert.equal(res.status, 401, `${method} ${url}`);
  }
  const bogus = await send("pi_portal_auth=1.forged", "/api/update", "POST", {});
  assert.equal(bogus.status, 401);
  assert.ok(!ran().some((c) => /^(git (fetch|merge)|npm)/.test(c)), "no update was started");
});

test("the status says where the checkout is, and a check says what an update would do", async () => {
  reset();
  const cookie = await login();
  const status = (await send(cookie, "/api/update")).body;
  assert.equal(status.kind, "git");
  assert.equal(status.branch, "main");
  assert.equal(status.current.subject, "Where the checkout is");
  assert.equal(status.run, null);
  assert.match(status.boot, /^[0-9a-f]+$/);

  const check = await send(cookie, "/api/update/check", "POST");
  assert.equal(check.status, 200);
  assert.equal(check.body.behind, 2);
  assert.equal(check.body.target.subject, "Where main is");
  assert.equal(check.body.problem, null);
  assert.equal(check.body.running, 0);
  assert.ok(!ran().some((c) => /^(git merge|npm)/.test(c)), "looking builds nothing");
  assert.equal((await send(cookie, "/api/update")).body.notice.count, 2, "what a check found is the notice");
});

test("a checkout with local changes, or that cannot fast-forward, is refused with its reason, and nothing is run", async () => {
  const cookie = await login();
  reset();
  put("changed", " M server/src/server.ts\n");
  let res = await send(cookie, "/api/update", "POST", {});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "dirty");
  assert.match(res.body.error, /local changes \(1 file\)/);

  reset();
  put("counts", "1\t2\n");
  res = await send(cookie, "/api/update", "POST", {});
  assert.equal(res.body.code, "diverged");

  reset();
  put("branch", "");
  assert.equal((await send(cookie, "/api/update", "POST", {})).body.code, "detached");

  reset();
  put("counts", "0\t0\n");
  assert.equal((await send(cookie, "/api/update", "POST", {})).body.code, "current");

  reset();
  assert.equal((await send(cookie, "/api/update", "POST", { expect: "f".repeat(40) })).body.code, "moved");
  assert.equal((await send(cookie, "/api/update", "POST", { expect: 7 })).status, 400);
  assert.ok(!ran().some((c) => /^(git merge|npm)/.test(c)), "none of them ran anything");
});

test("a build that fails is shown with the step and what it printed, and the portal goes on", async () => {
  const cookie = await login();
  reset();
  writeFileSync(path.join(fake, "npm-fails"), "run");
  const started = await send(cookie, "/api/update", "POST", { expect: commit("ccc", "").slice(0, 40) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = await settled(cookie);
  assert.equal(run.state, "failed");
  assert.equal(run.failed.step, "build");
  assert.match(run.failed.output, /the build is broken/);
  assert.equal((await send(cookie, "/api/update")).body.rebuild, true);
  assert.equal(child.exitCode, null, "the portal was not restarted");
});

test("an update fetches, merges, installs and builds in that order, refuses a second press meanwhile, and then the portal stops to be restarted", async () => {
  const cookie = await login();
  reset();
  rmSync(path.join(fake, "npm-fails"), { force: true });
  // The build from before is pending: this one starts from it, after the merge that was made.
  put("counts", "0\t0\n");
  put("head", commit("ccc", "Where main is"));
  const first = await send(cookie, "/api/update", "POST", {});
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal((await send(cookie, "/api/update", "POST", {})).body.code, "busy");
  const run = await settled(cookie);
  assert.equal(run.state, "restarting");
  assert.deepEqual(run.steps.map((s) => s.state), ["done", "skipped", "done", "done", "running"]);
  assert.deepEqual(ran().filter((c) => /^(git (fetch|merge)|npm)/.test(c)).slice(-3), [
    "git fetch origin +refs/heads/main:refs/remotes/origin/main",
    "npm ci --prefer-offline --no-audit --no-fund",
    "npm run build",
  ]);
  // The restart: the portal stops, as it does on SIGTERM, and a manager would start it again.
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});
