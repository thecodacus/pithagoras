import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The extensions a portal starts with: extensions/defaults.json names folders
 * of the portal's own, each installed once with `pi install <folder>` and an
 * ordinary package from then on. pi is a stand-in that keeps what was
 * installed in a file, and fails to install a folder named "broken" while
 * there is a file "failing" beside it.
 */
const home = inProcessHome("default-extensions-");
const bin = path.join(home, "bin");
mkdirSync(bin);
const state = path.join(home, "installed.txt");
writeFileSync(state, "");
const settingsFile = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(settingsFile, JSON.stringify({ packages: [] }));

writeFileSync(
  path.join(bin, "pi"),
  `#!/bin/bash
state=${JSON.stringify(state)}
settings=${JSON.stringify(settingsFile)}
case "$1" in
  list)
    echo "User packages:"
    while read -r dir; do [ -n "$dir" ] && printf '  %s\\n    %s\\n' "$dir" "$dir"; done < "$state"
    ;;
  install)
    if [ -f ${JSON.stringify(path.join(home, "failing"))} ]; then case "$2" in *broken*) echo "npm error: could not install $2" >&2; exit 1;; esac; fi
    if [ -f ${JSON.stringify(path.join(home, "failing-themes"))} ]; then case "$2" in */themes) echo "npm error: could not install $2" >&2; exit 1;; esac; fi
    echo "$2" >> "$state"
    node -e 'const fs=require("fs");const [file,dir]=process.argv.slice(1);const s=JSON.parse(fs.readFileSync(file,"utf8"));s.packages.push(dir);fs.writeFileSync(file,JSON.stringify(s))' "$settings" "$2"
    ;;
esac
`,
);
chmodSync(path.join(bin, "pi"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

/** A folder of extensions, each a package by these names, and the list a fresh portal installs. */
function shipped(names, defaults, requires = {}) {
  const dir = path.join(home, `shipped-${Math.random().toString(36).slice(2)}`);
  for (const [folder, name] of Object.entries(names)) {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, "package.json"), JSON.stringify({ name, version: "1.0.0", ...(requires[folder] ? { pithagoras: { requires: requires[folder] } } : {}) }));
  }
  writeFileSync(path.join(dir, "defaults.json"), JSON.stringify(defaults));
  return dir;
}

const installedNow = () => readFileSync(state, "utf8").split("\n").filter(Boolean);
/** Takes a package out, as `pi remove` does: from pi's list and its settings. */
function removed(dir) {
  writeFileSync(state, installedNow().filter((d) => d !== dir).map((d) => `${d}\n`).join(""));
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  settings.packages = settings.packages.filter((d) => d !== dir);
  writeFileSync(settingsFile, JSON.stringify(settings));
}

const { defaultExtensions, defaultsChoice, extensionPresets, installDefaultExtensions, replaceRetiredExtensions } = await import("../dist/default-extensions.js");
const { extensionStash, putSetting, setExtensionStash } = await import("../dist/db.js");

test("what the list names is installed once, from its folder, and one removed is not put back", async () => {
  const dir = shipped({ terminal: "pithagoras-terminal", git: "pithagoras-git" }, ["terminal", "git"]);
  assert.deepEqual(await installDefaultExtensions(dir), ["terminal", "git"]);
  assert.deepEqual(installedNow(), [path.join(dir, "terminal"), path.join(dir, "git")]);

  assert.deepEqual(await installDefaultExtensions(dir), [], "a second start installs nothing again");
  removed(path.join(dir, "git"));
  assert.deepEqual(await installDefaultExtensions(dir), [], "removed by hand, it stays removed");
  assert.deepEqual(installedNow(), [path.join(dir, "terminal")]);
});

test("a package the list adds later is installed on the next start, and one installed already under its name is left as it is", async () => {
  removed(installedNow()[0]);
  const dir = shipped({ terminal: "pithagoras-terminal", files: "pithagoras-files" }, ["terminal"]);
  // Someone's own copy of Files, installed before the portal's list named it.
  const own = shipped({ files: "pithagoras-files" }, []);
  writeFileSync(state, `${path.join(own, "files")}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [path.join(own, "files")] }));
  writeFileSync(path.join(dir, "defaults.json"), JSON.stringify(["terminal", "files"]));
  assert.deepEqual(await installDefaultExtensions(dir), [], "Terminal was installed once already, from the first test's folder of the same name");
  assert.deepEqual(installedNow(), [path.join(own, "files")], "the portal's Files is not pushed in beside someone's own");
});

test("an install that fails is tried again on the next start, and the rest still go in", async () => {
  const dir = shipped({ broken: "pithagoras-broken", notes: "pithagoras-notes" }, ["broken", "notes"]);
  writeFileSync(path.join(home, "failing"), "");
  assert.deepEqual(await installDefaultExtensions(dir), ["notes"]);
  assert.ok(!installedNow().includes(path.join(dir, "broken")));
  rmSync(path.join(home, "failing"));
  assert.deepEqual(await installDefaultExtensions(dir), ["broken"], "the next start installs it");
  assert.deepEqual(await installDefaultExtensions(dir), []);
});

test("the list names only folders of the portal's own that hold a package", () => {
  const dir = shipped({ terminal: "pithagoras-terminal" }, ["terminal", "../outside", ".hidden", "missing", 3, null, "terminal/../terminal"]);
  assert.deepEqual(defaultExtensions(dir).map((ext) => ext.folder), ["terminal"]);
  assert.deepEqual(defaultExtensions(path.join(home, "no-such-folder")), []);
  assert.ok(!existsSync(path.join(home, "outside")));
});

test("PORTAL_DEFAULT_EXTENSIONS=off installs none of them, and leaves them to be installed once it is on", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  process.env.PORTAL_DEFAULT_EXTENSIONS = "off";
  try {
    assert.deepEqual(await installDefaultExtensions(dir), []);
    assert.ok(!installedNow().includes(path.join(dir, "themes")));
  } finally {
    delete process.env.PORTAL_DEFAULT_EXTENSIONS;
  }
  assert.deepEqual(await installDefaultExtensions(dir), ["themes"], "nothing was recorded as installed while it was off");
});

test("Dusk and Warm, which are themes of the themes package now, are taken out of pi's list and the person keeps the theme", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const oldFolder = (folder) => path.join(home, "image", "extensions", folder);
  const dusk = oldFolder("theme-dusk");
  // The state an older portal left: the folders are gone, the entries are there, and so is what the portal kept for one.
  const own = shipped({ "theme-dusk": "somebody-elses-dusk" }, []);
  const ownDusk = path.join(own, "theme-dusk");
  writeFileSync(state, `${dusk}\n${ownDusk}\n`);
  writeFileSync(settingsFile, JSON.stringify({ theme: "x", packages: [dusk, ownDusk, { source: oldFolder("theme-warm"), themes: [] }, "npm:other-package"] }));
  setExtensionStash({ [dusk]: { source: dusk }, "npm:other-package": { source: "npm:other-package" } });

  assert.deepEqual(await replaceRetiredExtensions(dir), [dusk, oldFolder("theme-warm")]);
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings.packages, [ownDusk, "npm:other-package", path.join(dir, "themes")], "a folder of that name that is there is someone's own");
  assert.equal(settings.theme, "x", "the rest of the file is as it was");
  assert.deepEqual(Object.keys(extensionStash()), ["npm:other-package"], "what was kept for the package that is gone goes with it");

  assert.deepEqual(await replaceRetiredExtensions(dir), [], "nothing is left to take out the next time");
  assert.deepEqual(installedNow().filter((d) => d === path.join(dir, "themes")), [path.join(dir, "themes")], "installed once");
});

test("the theme package is not installed in place of Dusk where it is installed already or where Dusk was switched off", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const gone = path.join(home, "image", "extensions");
  writeFileSync(state, `${path.join(dir, "themes")}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [path.join(dir, "themes"), path.join(gone, "theme-dusk")] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-dusk")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [path.join(dir, "themes")]);

  writeFileSync(state, "");
  writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: path.join(gone, "theme-warm"), extensions: [], skills: [], prompts: [], themes: [] }] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-warm")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [], "it was off, so the person has no use for the replacement");
  assert.deepEqual(installedNow(), []);
});

test("the start takes the entries out before it installs what the list names, also with the defaults off", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const dusk = path.join(home, "image", "extensions", "theme-dusk");
  writeFileSync(state, `${dusk}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [dusk] }));
  writeFileSync(path.join(dir, "defaults.json"), JSON.stringify([]));
  process.env.PORTAL_DEFAULT_EXTENSIONS = "off";
  try {
    assert.deepEqual(await installDefaultExtensions(dir), []);
  } finally {
    delete process.env.PORTAL_DEFAULT_EXTENSIONS;
  }
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [path.join(dir, "themes")]);
});

test("the theme package installed and switched off is switched on where Dusk was in use, and stays off where Dusk was off too", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const gone = path.join(home, "image", "extensions");
  const themes = path.join(dir, "themes");
  const off = { source: themes, extensions: [], skills: [], prompts: [], themes: [] };
  writeFileSync(state, `${themes}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [off, path.join(gone, "theme-dusk")] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-dusk")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [themes], "on, as an entry the switch writes");
  assert.deepEqual(installedNow(), [themes], "not installed again");

  writeFileSync(settingsFile, JSON.stringify({ packages: [off, { source: path.join(gone, "theme-warm"), extensions: [], skills: [], prompts: [], themes: [] }] }));
  assert.deepEqual(await replaceRetiredExtensions(dir), [path.join(gone, "theme-warm")]);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [off], "both off: left as the person had them");
});

test("an install of the theme package that fails leaves the entries in, and the next start installs it and takes them out", async () => {
  const dir = shipped({ themes: "pithagoras-themes" }, ["themes"]);
  const dusk = path.join(home, "image", "extensions", "theme-dusk");
  writeFileSync(state, "");
  writeFileSync(settingsFile, JSON.stringify({ packages: [dusk] }));
  setExtensionStash({ [dusk]: { source: dusk } });
  writeFileSync(path.join(home, "failing-themes"), "");
  await assert.rejects(replaceRetiredExtensions(dir), /could not install/);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [dusk], "nothing was taken out");
  assert.deepEqual(Object.keys(extensionStash()), [dusk]);
  // The start itself says so and goes on.
  assert.deepEqual(await installDefaultExtensions(dir), []);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [dusk]);

  rmSync(path.join(home, "failing-themes"));
  assert.deepEqual(await installDefaultExtensions(dir), []);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).packages, [path.join(dir, "themes")]);
  assert.deepEqual(Object.keys(extensionStash()), []);
});

/** A portal as a new one: nothing installed, nothing remembered. */
function fresh() {
  writeFileSync(state, "");
  writeFileSync(settingsFile, JSON.stringify({ packages: [] }));
  putSetting("default_extensions_installed", "[]");
}

/** Runs `fn` with PORTAL_DEFAULT_EXTENSIONS set to `value` (unset for undefined), and says what the portal logged as an error. */
async function withChoice(value, fn) {
  const was = process.env.PORTAL_DEFAULT_EXTENSIONS;
  if (value === undefined) delete process.env.PORTAL_DEFAULT_EXTENSIONS;
  else process.env.PORTAL_DEFAULT_EXTENSIONS = value;
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = error;
    if (was === undefined) delete process.env.PORTAL_DEFAULT_EXTENSIONS;
    else process.env.PORTAL_DEFAULT_EXTENSIONS = was;
  }
}

/** The portal's own folder as it ships: every extension a preset names, Voice needing Docker for extensions. */
const everyFolder = () =>
  shipped(
    { terminal: "pithagoras-terminal", files: "pithagoras-files", themes: "pithagoras-themes", git: "pithagoras-git", docker: "pithagoras-docker", docs: "pithagoras-docs", media: "pithagoras-media", canvas: "pithagoras-canvas", voice: "pithagoras-voice", browser: "pithagoras-browser" },
    ["terminal", "files", "themes"],
    { voice: { "pithagoras-docker": "^1.0.0" }, browser: { "pithagoras-docker": "^1.0.0" } },
  );

test("a portal that has Git, Canvases and Media keeps them when the list no longer names them, and one without them is not given them", async () => {
  fresh();
  const dir = shipped(
    { terminal: "pithagoras-terminal", git: "pithagoras-git", files: "pithagoras-files", themes: "pithagoras-themes", canvas: "pithagoras-canvas", media: "pithagoras-media" },
    ["terminal", "git", "files", "themes", "canvas", "media"],
  );
  assert.equal((await installDefaultExtensions(dir)).length, 6, "a portal of the older list installed all six");
  const before = installedNow();
  const kept = readFileSync(settingsFile, "utf8");

  // The list the portal ships now.
  writeFileSync(path.join(dir, "defaults.json"), JSON.stringify(["terminal", "files", "themes"]));
  assert.deepEqual(await installDefaultExtensions(dir), []);
  assert.deepEqual(installedNow(), before, "nothing is taken out");
  assert.equal(readFileSync(settingsFile, "utf8"), kept, "nor is pi's list touched");

  // One installed by hand and never recorded is as safe.
  fresh();
  writeFileSync(state, `${path.join(dir, "git")}\n`);
  writeFileSync(settingsFile, JSON.stringify({ packages: [path.join(dir, "git")] }));
  assert.deepEqual(await installDefaultExtensions(dir), ["terminal", "files", "themes"], "a new portal gets the three, and Git is left as it is");
  assert.deepEqual(installedNow(), [path.join(dir, "git"), ...["terminal", "files", "themes"].map((f) => path.join(dir, f))]);
});

test("what a portal records is the folders it installed", async () => {
  fresh();
  const dir = shipped({ terminal: "pithagoras-terminal", files: "pithagoras-files", themes: "pithagoras-themes" }, ["terminal", "files", "themes"]);
  await installDefaultExtensions(dir);
  const { getSetting } = await import("../dist/db.js");
  assert.deepEqual(JSON.parse(getSetting("default_extensions_installed")), ["terminal", "files", "themes"]);
});

test("the real list is Terminal, Files and the theme pack, and each preset adds to it from the folders the portal ships", () => {
  const real = path.resolve(import.meta.dirname, "../../../extensions");
  assert.deepEqual(defaultExtensions(real).map((ext) => ext.folder), ["terminal", "files", "themes"]);
  const presets = Object.fromEntries(extensionPresets(real).map((preset) => [preset.id, preset]));
  assert.deepEqual(Object.keys(presets), ["minimal", "developer", "creative", "everything"]);
  assert.deepEqual(presets.minimal.folders, ["terminal", "files", "themes"]);
  assert.deepEqual(presets.developer.folders, ["terminal", "files", "themes", "git", "docker", "docs"]);
  assert.deepEqual(presets.creative.folders, ["terminal", "files", "themes", "media", "canvas", "voice"]);
  assert.deepEqual(presets.developer.extensions, ["pithagoras-terminal", "pithagoras-files", "pithagoras-themes", "pithagoras-git", "pithagoras-docker", "pithagoras-docs"]);
  const all = readdirSync(real, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(path.join(real, e.name, "package.json"))).map((e) => e.name);
  assert.deepEqual([...presets.everything.folders].sort(), all.sort(), "everything is every extension that comes with the portal");
  for (const preset of Object.values(presets)) assert.equal(preset.folders.length, new Set(preset.folders).size, `${preset.id} names each once`);
});

test("PORTAL_DEFAULT_EXTENSIONS is off, the default set, a preset's name, or a list of the portal's extensions, and anything else is refused", () => {
  const dir = everyFolder();
  assert.deepEqual(defaultsChoice("off", dir), { folders: [] });
  assert.deepEqual(defaultsChoice(" OFF ", dir), { folders: [] });
  for (const same of [undefined, "", "on", "1", "true", "default"]) assert.deepEqual(defaultsChoice(same, dir), { folders: ["terminal", "files", "themes"] }, String(same));
  assert.deepEqual(defaultsChoice("Developer", dir).folders, ["terminal", "files", "themes", "git", "docker", "docs"]);
  assert.equal(defaultsChoice("everything", dir).folders.length, 10);
  assert.deepEqual(defaultsChoice("terminal, git,pithagoras-media,git", dir), { folders: ["terminal", "git", "media"] }, "by folder or package name, each once");
  for (const bad of ["developr", "terminal,gti", "terminal,", ",", "../outside", "on,off"]) {
    const choice = defaultsChoice(bad, dir);
    assert.deepEqual(choice.folders, ["terminal", "files", "themes"], `${bad}: the default set is what is installed`);
    assert.match(choice.refused, /PORTAL_DEFAULT_EXTENSIONS=.*is refused.*preset \(minimal, developer, creative, everything\)/, bad);
  }
});

test("a preset in PORTAL_DEFAULT_EXTENSIONS is installed at the start, with Docker for extensions before what needs it, and recorded", async () => {
  fresh();
  const dir = everyFolder();
  const { result, logged } = await withChoice("creative", () => installDefaultExtensions(dir));
  assert.deepEqual(result, ["terminal", "files", "themes", "media", "canvas", "docker", "voice"], "Docker comes in because Voice needs it, ahead of Voice");
  assert.deepEqual(logged, []);
  const { getSetting } = await import("../dist/db.js");
  assert.deepEqual(JSON.parse(getSetting("default_extensions_installed")), result);
  assert.deepEqual((await withChoice("creative", () => installDefaultExtensions(dir))).result, [], "once");
});

test("a list in PORTAL_DEFAULT_EXTENSIONS is installed in place of the default set", async () => {
  fresh();
  const dir = everyFolder();
  const { result } = await withChoice("files,browser", () => installDefaultExtensions(dir));
  assert.deepEqual(result, ["files", "docker", "browser"]);
  assert.ok(!installedNow().includes(path.join(dir, "terminal")), "the default set is not added to a list");
});

test("a value that is refused installs the default set and says why in the log", async () => {
  fresh();
  const dir = everyFolder();
  const { result, logged } = await withChoice("developr", () => installDefaultExtensions(dir));
  assert.deepEqual(result, ["terminal", "files", "themes"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[extensions\] PORTAL_DEFAULT_EXTENSIONS="developr" is refused: developr is neither a preset nor an extension that comes with the portal/);
});

test("off installs nothing, whatever else is named", async () => {
  fresh();
  const { result, logged } = await withChoice("off", () => installDefaultExtensions(everyFolder()));
  assert.deepEqual(result, []);
  assert.deepEqual(logged, []);
  assert.deepEqual(installedNow(), []);
});
