import { test, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The update over HTTP, on a server that is started as it is deployed, with a password: who may ask, what the
 * answers are, and that the steps run in the order the issue names. git and npm are stand-ins in front on the PATH
 * that answer from files and write down what they were asked, so that nothing is fetched, merged, installed or
 * built, and the portal only exits at the end (PORTAL_UPDATE_RESTART=exit) instead of starting itself again.
 *
 * The server runs from a copy of the install's layout in the test's home, not from the developer's checkout: an
 * update puts its node_modules and build aside and the stand-in npm and build write new ones.
 */
const home = testHome("pithagoras-update-routes-");
const bin = path.join(home, "bin");
const fake = path.join(home, "fake");
mkdirSync(bin);
mkdirSync(fake);
const repo = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
const install = path.join(home, "install");
mkdirSync(path.join(install, "core", "server"), { recursive: true });
mkdirSync(path.join(install, "core", "web", "dist"), { recursive: true });
cpSync(path.join(repo, "core", "server", "dist"), path.join(install, "core", "server", "dist"), { recursive: true });
cpSync(path.join(repo, "package.json"), path.join(install, "package.json"));
cpSync(path.join(repo, "core", "server", "package.json"), path.join(install, "core", "server", "package.json"));
writeFileSync(path.join(install, "core", "web", "dist", "index.html"), "old web app");
// What the portal loads from beside its server's folder, and its packages: the same ones, linked.
for (const name of ["node_modules", "skills", "channels", "extensions", "deploy"]) if (existsSync(path.join(repo, name))) symlinkSync(path.join(repo, name), path.join(install, name));
const root = realpathSync(install);
const PASSWORD = "a password long enough";
const CCC = "ccc".padEnd(40, "0");

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
// The portal asks systemd whether it is the main process of the service it runs in, and what the unit's restart policy is.
// A test must not depend on the machine's own: a CI runner is itself a service that is set to `Restart=no`. This one
// says that the unit has another main process, as it has for a portal that was started from a job of the service.
script("systemctl", `
echo "systemctl $*" >> "$FAKE/ran"
printf 'MainPID=1\\nRestart=no\\n'
exit 0`);
// npm ci empties node_modules and installs; the build writes a server and a web app, and a file of a build that stops halfway.
script("npm", `
echo "npm $*" >> "$FAKE/ran"
fails=$(cat "$FAKE/npm-fails" 2>/dev/null)
case "$1" in
  ci)
    # Held in the install step while a test looks at the portal meanwhile.
    while [ -e "$FAKE/npm-gate" ]; do sleep 0.05; done
    rm -rf node_modules
    if [ "$fails" = ci ]; then mkdir node_modules; echo half > node_modules/half.txt; echo "npm ERR! registry down" >&2; exit 1; fi
    ln -s "$REAL_MODULES" node_modules ;;
  run)
    mkdir -p core/server/dist core/web/dist
    echo "// the new build" > core/server/dist/index.js
    echo "half a build" > core/server/dist/partial.js
    echo "new web app" > core/web/dist/index.html
    if [ "$fails" = run ]; then echo "npm ERR! the build is broken" >&2; exit 1; fi ;;
esac
exit 0`);

const commit = (sha, subject) => `${sha.padEnd(40, "0")}\x1f${subject}\x1f2026-10-12T09:00:00+02:00\n`;
const put = (name, text) => writeFileSync(path.join(fake, name), text);
const ran = () => (existsSync(path.join(fake, "ran")) ? readFileSync(path.join(fake, "ran"), "utf8").trim().split("\n").filter(Boolean) : []);
/** What changes the checkout or the build: not the fetch, which only looks at the remote. */
const changes = () => ran().filter((c) => /^(git merge|npm)/.test(c));
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
async function boot() {
  const port = await freePort();
  ({ base, child } = await startServer(serverEnv(home, port, {
    PORTAL_PASSWORD: PASSWORD,
    PORTAL_ALLOW_NO_PASSWORD: "",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE: fake,
    ROOT: root,
    REAL_MODULES: path.join(repo, "node_modules"),
    PORTAL_UPDATE_RESTART: "exit",
  }), 5, path.join(install, "core", "server", "dist", "index.js")));
}
before(boot);

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
const text = (rel) => readFileSync(path.join(install, rel), "utf8");
const isLink = (rel) => lstatSync(path.join(install, rel)).isSymbolicLink();

test("whoever is not signed in is turned away from all of it, and nothing is run", async () => {
  reset();
  for (const [url, method] of [["/api/update", "GET"], ["/api/update/check", "POST"], ["/api/update", "POST"]]) {
    const res = await send(undefined, url, method, method === "POST" ? { expect: CCC } : undefined);
    assert.equal(res.status, 401, `${method} ${url}`);
  }
  const bogus = await send("pi_portal_auth=1.forged", "/api/update", "POST", { expect: CCC });
  assert.equal(bogus.status, 401);
  assert.deepEqual(changes(), [], "no update was started");
});

test("the status says where the checkout is, and a check says what an update would do", async () => {
  reset();
  const cookie = await login();
  const status = (await send(cookie, "/api/update")).body;
  assert.equal(status.kind, "git");
  assert.equal(status.branch, "main");
  assert.equal(status.current.subject, "Where the checkout is");
  assert.equal(status.run, null);
  assert.equal(status.rebuild, false);
  assert.match(status.boot, /^[0-9a-f]+$/);

  const check = await send(cookie, "/api/update/check", "POST");
  assert.equal(check.status, 200);
  assert.equal(check.body.behind, 2);
  assert.equal(check.body.target.subject, "Where main is");
  assert.equal(check.body.problem, null);
  assert.equal(check.body.running, 0);
  assert.equal(check.body.rebuild, false);
  assert.deepEqual(changes(), [], "looking builds nothing");
  assert.equal((await send(cookie, "/api/update")).body.notice.count, 2, "what a check found is the notice");
});

test("a start without the commit that was confirmed is refused, however the request is made, and nothing is run", async () => {
  const cookie = await login();
  reset();
  for (const body of [undefined, {}, { expect: "" }, { expect: 7 }, { expect: null }, { expect: [CCC] }]) {
    const res = await send(cookie, "/api/update", "POST", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "invalid");
    assert.match(res.body.error, /expect/);
  }
  // No body at all, and a body that is not JSON: a form from another page cannot send what the portal asks for.
  for (const [type, body] of [[undefined, undefined], ["text/plain", `{"expect":"${CCC}"}`], ["application/x-www-form-urlencoded", `expect=${CCC}`]]) {
    const res = await fetch(`${base}/api/update`, { method: "POST", headers: { Cookie: cookie, ...(type ? { "Content-Type": type } : {}) }, body });
    assert.equal(res.status, 400, `${type}`);
    assert.equal((await res.json()).code, "invalid");
  }
  assert.deepEqual(changes(), [], "nothing was merged, installed or built");
  assert.equal((await send(cookie, "/api/update")).body.run, null);
});

test("a checkout with local changes, or that cannot fast-forward, is refused with its reason, and nothing is run", async () => {
  const cookie = await login();
  reset();
  put("changed", " M server/src/server.ts\n");
  let res = await send(cookie, "/api/update", "POST", { expect: CCC });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "dirty");
  assert.match(res.body.error, /local changes \(1 file\)/);

  reset();
  put("counts", "1\t2\n");
  res = await send(cookie, "/api/update", "POST", { expect: CCC });
  assert.equal(res.body.code, "diverged");

  reset();
  put("branch", "");
  assert.equal((await send(cookie, "/api/update", "POST", { expect: CCC })).body.code, "detached");

  reset();
  put("counts", "0\t0\n");
  assert.equal((await send(cookie, "/api/update", "POST", { expect: CCC })).body.code, "current");

  reset();
  assert.equal((await send(cookie, "/api/update", "POST", { expect: "f".repeat(40) })).body.code, "moved");
  assert.deepEqual(changes(), [], "none of them ran anything");
});

test("an install that fails puts the old node_modules back, and the build was never touched", async () => {
  const cookie = await login();
  reset();
  writeFileSync(path.join(fake, "npm-fails"), "ci");
  const started = await send(cookie, "/api/update", "POST", { expect: CCC });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = await settled(cookie);
  assert.equal(run.state, "failed");
  assert.equal(run.failed.step, "install");
  assert.match(run.failed.output, /registry down/);
  assert.equal(isLink("node_modules"), true, "the link to the packages is back, not a half-made folder");
  assert.equal(existsSync(path.join(install, "node_modules", "half.txt")), false);
  assert.equal(text("core/web/dist/index.html"), "old web app");
  assert.equal(text("core/server/dist/index.js"), readFileSync(path.join(repo, "core", "server", "dist", "index.js"), "utf8"));
  assert.ok(!ran().includes("npm run build"));
  assert.deepEqual(readdirSync(install).filter((n) => n.endsWith(".update-old")), []);
});

test("a build that fails puts the old server, web app and node_modules back, and the build to do is written down in the files", async () => {
  const cookie = await login();
  reset();
  writeFileSync(path.join(fake, "npm-fails"), "run");
  const started = await send(cookie, "/api/update", "POST", { expect: CCC });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = await settled(cookie);
  assert.equal(run.state, "failed");
  assert.equal(run.failed.step, "build");
  assert.match(run.failed.output, /the build is broken/);
  // As the server was, with what the failed build wrote gone.
  assert.equal(text("core/server/dist/index.js"), readFileSync(path.join(repo, "core", "server", "dist", "index.js"), "utf8"));
  assert.equal(existsSync(path.join(install, "core", "server", "dist", "partial.js")), false);
  assert.equal(text("core/web/dist/index.html"), "old web app");
  assert.equal(isLink("node_modules"), true);
  for (const aside of ["node_modules", "core/server/dist", "core/web/dist"]) assert.equal(existsSync(path.join(install, aside + ".update-old")), false, aside);
  // What it was made from stays with it: the checkout is at ccc now, the build is of aaa.
  assert.equal(JSON.parse(text("core/server/dist/.built-from")).sha, "aaa".padEnd(40, "0"));
  const status = (await send(cookie, "/api/update")).body;
  assert.equal(status.rebuild, true);
  assert.equal(status.current.sha, CCC);
  assert.equal(child.exitCode, null, "the portal was not restarted");
});

test("a restart is refused while an update installs, and the update goes on to fail on its own", async () => {
  const cookie = await login();
  reset();
  put("npm-fails", "ci");
  put("npm-gate", "");
  try {
    assert.equal((await send(cookie, "/api/update", "POST", { expect: CCC })).status, 202);
    for (let i = 0; i < 300 && !ran().includes("npm ci --prefer-offline --no-audit --no-fund"); i++) await new Promise((r) => setTimeout(r, 20));
    // node_modules is aside and npm is at work: stopping the portal now would leave it without the files it starts from.
    const state = await send(cookie, "/api/restart");
    assert.equal(state.body.possible, false);
    assert.equal(state.body.code, "update");
    const refused = await send(cookie, "/api/restart", "POST", { confirm: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "update");
    assert.equal(child.exitCode, null, "the portal was not stopped");
  } finally {
    rmSync(path.join(fake, "npm-gate"), { force: true });
  }
  const run = await settled(cookie);
  assert.equal(run.state, "failed");
  assert.equal(child.exitCode, null);
  assert.equal(isLink("node_modules"), true, "the old modules are back");
  assert.equal((await send(cookie, "/api/restart")).body.possible, true, "and a restart is possible again");
});

test("an update fetches, merges, installs and builds in that order, refuses a second press meanwhile, and then the portal stops with the status that has it started again", async () => {
  const cookie = await login();
  reset();
  rmSync(path.join(fake, "npm-fails"), { force: true });
  // As the last one left it: the checkout is at main, and what is built is not.
  put("counts", "0\t0\n");
  put("head", commit("ccc", "Where main is"));
  const first = await send(cookie, "/api/update", "POST", { expect: CCC });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal((await send(cookie, "/api/update", "POST", { expect: CCC })).body.code, "busy");
  const run = await settled(cookie);
  assert.equal(run.state, "restarting");
  assert.deepEqual(run.steps.map((s) => s.state), ["done", "skipped", "done", "done", "running"]);
  assert.deepEqual(changes(), ["npm ci --prefer-offline --no-audit --no-fund", "npm run build"]);
  // The new build is in place, the old one thrown away, and what it was made from written with it.
  assert.equal(text("core/web/dist/index.html").trim(), "new web app");
  assert.equal(JSON.parse(text("core/server/dist/.built-from")).sha, CCC);
  for (const aside of ["node_modules", "core/server/dist", "core/web/dist"]) assert.equal(existsSync(path.join(install, aside + ".update-old")), false, aside);
  // The restart: the portal stops, as it does on SIGTERM, with the status a manager starts it again from.
  const [code] = await once(child, "exit");
  assert.equal(code, 75);
});

test("an update is refused once a restart is on its way, and nothing is run", async () => {
  // The last test ended with the portal's stop, and with the stand-in build in place of the server: this is a new start
  // of the original one.
  rmSync(path.join(install, "core", "server", "dist"), { recursive: true, force: true });
  cpSync(path.join(repo, "core", "server", "dist"), path.join(install, "core", "server", "dist"), { recursive: true });
  await boot();
  reset();
  const cookie = await login();
  const restart = await send(cookie, "/api/restart", "POST", { confirm: true });
  assert.equal(restart.status, 202, JSON.stringify(restart.body));
  const update = await send(cookie, "/api/update", "POST", { expect: CCC });
  assert.equal(update.status, 409);
  assert.equal(update.body.code, "restarting");
  assert.deepEqual(changes(), [], "no update was started");
  const [code] = await once(child, "exit");
  assert.equal(code, 75);
});
