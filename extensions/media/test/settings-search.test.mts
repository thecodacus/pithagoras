import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { Portal } from "@pithagoras/extension-api";
import { SETTINGS_INDEX, searchSettings } from "../../../core/web/src/settings-search.ts";

/**
 * What Settings' search finds of Media's page there: the entries the browser half gives its `settings.page`, among all
 * of Settings' own, as Settings puts them in its index (ConfigModal): in English, with the title and the section among
 * the words, on the extension's page, which is where they are said to be.
 */

// The browser half's own stylesheet is the build's to make: here it is nothing.
registerHooks({ load: (url, context, next) => (url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context)) });
const { default: media } = await import("../src/client.tsx");
const pages: any[] = [];
media({
  extension: "pithagoras-media",
  locale: { add: () => {} },
  t: (text: string) => text,
  ui: { lazy: () => () => null },
  slots: { register: (slot: string, entry: unknown) => void (slot === "settings.page" && pages.push(entry)) },
} as unknown as Portal);
const [page] = pages;
const index = [
  ...SETTINGS_INDEX,
  ...(page.search as { title: string; section?: string; words?: string }[]).map((found) => ({
    tab: "extensions",
    ext: "pithagoras-media",
    title: found.title,
    ...(found.section ? { section: found.section } : {}),
    words: `${found.words ?? ""} ${found.title} ${found.section ?? ""}`,
    where: page.title,
  })),
];
const search = (q: string) => searchSettings(q, index);

test("the image endpoint is found on Media's page, at its image model", () => {
  for (const q of ["image generation", "image editing", "bildgenerierung"]) {
    const found = search(q);
    assert.ok(found.length && found.every((e) => e.ext === "pithagoras-media" && e.section === "Image model"), `${q} leads to the image model of Media`);
  }
});

test("the video endpoint is found on Media's page, at its video model", () => {
  for (const q of ["video generation", "videogenerierung", "frame rate"]) {
    const found = search(q);
    assert.ok(found.length && found.every((e) => e.ext === "pithagoras-media" && e.section === "Video model"), `${q} leads to the video model of Media`);
  }
  // The server both models can be are named by the same word: the video model, and the picture settings only that server reads.
  assert.deepEqual(search("stable-diffusion.cpp").map((e) => `${e.section}: ${e.title}`).sort(), ["More options: Stable Diffusion extra settings", "Video model: Video generation"]);
});
