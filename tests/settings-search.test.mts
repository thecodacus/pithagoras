import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_INDEX, fold, searchSettings } from "../core/web/src/settings-search.ts";
import { ago, compactCount, packageName } from "../core/web/src/package-names.ts";
import { forget, load, peek } from "../core/web/src/settings-cache.ts";

test("a setting is found by its title first, then by what it is about", () => {
  const titles = (q: string) => searchSettings(q, SETTINGS_INDEX).map((e) => e.title);
  assert.equal(titles("theme")[0], "Theme");
  assert.equal(titles("context")[0], "Context window");
  assert.deepEqual(titles("dunkel"), ["Theme"], "a German word finds it too");
  assert.equal(titles("schlussel")[0], "API keys", "without its umlaut as well");
  assert.deepEqual(titles("openrouter key"), ["API keys"], "every word must match somewhere");
  assert.deepEqual(titles("   "), []);
  assert.deepEqual(titles("nothing like this"), []);
});

test("changing the password is found on its own page, by the English word and the German", () => {
  for (const q of ["password", "passwort", "kennwort", "change password"]) {
    assert.ok(searchSettings(q, SETTINGS_INDEX).some((e) => e.tab === "authentication" && e.title === "Change password"), `${q} leads to Authentication`);
  }
});

test("single sign-on is found on its own page, by what people call it", () => {
  for (const q of ["sso", "oidc", "openid connect", "keycloak", "single sign-on", "einmalanmeldung"]) {
    assert.ok(searchSettings(q, SETTINGS_INDEX).some((e) => e.tab === "authentication"), `${q} leads to Single sign-on`);
  }
  assert.ok(searchSettings("oidc only", SETTINGS_INDEX).some((e) => e.tab === "authentication" && e.title === "OIDC only"));
});

test("the sites the agent's tools may reach are found in Settings → Guard, by what people call the list", () => {
  for (const q of ["allowlist", "browser allowlist", "domains", "sites", "playwright", "erlaubte domänen"]) {
    assert.ok(searchSettings(q, SETTINGS_INDEX).some((e) => e.tab === "guard" && e.section === "Sites the agent's tools may reach"), `${q} leads to the guard's list`);
  }
});

test("where an entry is, is searched too", () => {
  const found = searchSettings("web access brave", [{ tab: "extensions", ext: "npm:pi-web-access", title: "Brave API key", where: "pi-web-access" }]);
  assert.equal(found.length, 1);
  assert.equal(fold("Schlüssel Ärger"), "schlussel arger");
});

test("a package spec is told apart by its npm name", () => {
  assert.equal(packageName("npm:pi-web-access"), "pi-web-access");
  assert.equal(packageName("npm:pi-web-access@0.31.0"), "pi-web-access");
  assert.equal(packageName("npm:@scope/pkg@1.2.0"), "@scope/pkg");
  assert.equal(packageName("npm:@scope/pkg"), "@scope/pkg");
  assert.equal(packageName("git:github.com/u/r"), "git:github.com/u/r");
});

test("counts and ages are said in one short word", () => {
  assert.equal(compactCount(950), "950");
  assert.equal(compactCount(1500), "1.5k");
  assert.equal(compactCount(198311), "198k");
  assert.equal(compactCount(1013749), "1M");
  const now = Date.parse("2026-09-24T12:00:00Z");
  assert.equal(ago("2026-09-24T11:59:30Z", now), "just now");
  assert.equal(ago("2026-09-22T12:00:00Z", now), "2 days ago");
  assert.equal(ago("2025-08-01T00:00:00Z", now), "1 year ago");
  assert.equal(ago(undefined, now), "");
});

test("what Settings keeps is fetched once for everyone asking, and again once forgotten", async () => {
  let fetched = 0;
  const fetcher = async () => ++fetched;
  const [a, b] = await Promise.all([load("k", fetcher), load("k", fetcher)]);
  assert.deepEqual([a, b, fetched], [1, 1, 1], "two at once share one fetch");
  assert.equal(await load("k", fetcher, 60_000), 1, "a fresh one is not fetched again");
  forget("k");
  assert.equal(peek("k"), 1, "forgotten, it is still shown until the new one comes");
  assert.equal(await load("k", fetcher, 60_000), 2);
  await assert.rejects(load("k", async () => { throw new Error("down"); }), /down/);
  assert.equal(peek("k"), 2, "a failed fetch keeps the last value");
});

test("a fetch forgotten on its way does not land over one fetched since", async () => {
  let release!: (v: string) => void;
  const old = load("m", () => new Promise<string>((r) => (release = r)));
  // A provider is saved: what was on its way is from before it.
  forget("m");
  assert.equal(await load("m", async () => "after the save"), "after the save");
  release("before the save");
  await old;
  assert.equal(peek("m"), "after the save");

  // Forgotten with nothing asked since, its answer is still not kept.
  let again!: (v: string) => void;
  const stale = load("m", () => new Promise<string>((r) => (again = r)), 0);
  forget("m");
  again("stale");
  await stale;
  assert.equal(peek("m"), "after the save");
});

test("fetched again after a change, a fetch that started before it does not answer", async () => {
  let release!: (v: string) => void;
  const before = load("d", () => new Promise<string>((r) => (release = r)));
  // Saved, then fetched again: the one on its way asked the server before the save.
  const after = load("d", async () => "after the save", 0, true);
  release("before the save");
  assert.equal(await after, "after the save");
  await before;
  assert.equal(peek("d"), "after the save");
});
