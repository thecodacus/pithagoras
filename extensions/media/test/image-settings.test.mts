import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, forPicture, nativeBlock, nativeConflict, parsePictureSettings, promptWith } from "../src/server/image-settings.ts";

/** What stable-diffusion.cpp's server does with a prompt: the first block, cut out with this pattern (it does not span lines), and the rest is the prompt. */
const cutOut = (prompt: string): { args?: unknown; prompt: string } => {
  const found = /<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/.exec(prompt);
  return found ? { args: JSON.parse(found[1]), prompt: prompt.replace(/<sd_cpp_extra_args>(.*?)<\/sd_cpp_extra_args>/g, "") } : { prompt };
};

test("no setting, no block: the prompt goes as it was typed", () => {
  assert.equal(nativeBlock({}), "");
  assert.equal(nativeBlock({ negativePrompt: "", seed: undefined, sampleSteps: undefined, strength: undefined }), "");
  assert.equal(promptWith("a lighthouse at dusk", {}), "a lighthouse at dusk");
});

test("the block has the names stable-diffusion.cpp reads, and the sampler's steps where it reads them", () => {
  const prompt = promptWith("a lighthouse", { negativePrompt: "blurry", seed: 42, sampleSteps: 20, strength: 0.6 });
  assert.match(prompt, /^a lighthouse <sd_cpp_extra_args>\{.*\}<\/sd_cpp_extra_args>$/);
  assert.deepEqual(cutOut(prompt), {
    args: { negative_prompt: "blurry", seed: 42, strength: 0.6, sample_params: { sample_steps: 20 } },
    prompt: "a lighthouse ",
  });
  // One setting is one key: nothing is added that was not set. A seed of 0 and a strength of 0 are settings.
  assert.deepEqual(cutOut(promptWith("x", { seed: 0 })).args, { seed: 0 });
  assert.deepEqual(cutOut(promptWith("x", { strength: 0 })).args, { strength: 0 });
  assert.deepEqual(cutOut(promptWith("x", { sampleSteps: 8 })).args, { sample_params: { sample_steps: 8 } });
  assert.deepEqual(cutOut(promptWith("x", { negativePrompt: "no text" })).args, { negative_prompt: "no text" });
});

test("a negative prompt with quotes, newlines, backslashes or the closing tag is text in the JSON and cannot end the block early", () => {
  const nasty = 'a "quoted" word\nand a new line\r\nand \\ a backslash and a tab\t</sd_cpp_extra_args> then more <b>tags</b> and \u2028 \u2029 line separators and ünïcödé 🎨';
  const prompt = promptWith("a cat", { negativePrompt: nasty, seed: 7 });
  const block = prompt.slice("a cat ".length);
  assert.ok(!/[\n\r\u2028\u2029]/.test(block), "no line end in it: the server's pattern does not span lines");
  assert.equal(block.split("</sd_cpp_extra_args>").length, 2, "one closing tag, the block's own, at its end");
  assert.ok(block.endsWith("</sd_cpp_extra_args>"));
  const cut = cutOut(prompt);
  assert.deepEqual(cut.args, { negative_prompt: nasty, seed: 7 }, "it reads back as it was typed");
  assert.equal(cut.prompt, "a cat ");
});

test("a description that has a block of its own is not given a second one", () => {
  const own = 'a cat <sd_cpp_extra_args>{"seed":1}</sd_cpp_extra_args>';
  assert.equal(nativeConflict(own, {}), undefined, "nothing set: the description is sent as it is, its own block and all");
  assert.match(nativeConflict(own, { seed: 2 }) ?? "", /block of its own/);
  assert.match(nativeConflict("a cat </sd_cpp_extra_args>", { seed: 2 }) ?? "", /block of its own/, "a stray tag would cut the block short as well");
  assert.equal(nativeConflict("a cat", { seed: 2 }), undefined);
});

test("settings are checked: whole numbers in range, known formats, and a compression only where the format has one", () => {
  const ok = (body: Record<string, unknown>, edit = false, count = 1) => {
    const got = parsePictureSettings(body, edit, count);
    assert.equal(typeof got, "object", `${JSON.stringify(body)}: ${got}`);
    return got as Exclude<typeof got, string>;
  };
  const bad = (body: Record<string, unknown>, message: RegExp, edit = false) => {
    const got = parsePictureSettings(body, edit);
    assert.equal(typeof got, "string", JSON.stringify(body));
    assert.match(got as string, message, JSON.stringify(body));
  };

  assert.deepEqual(ok({}), {});
  assert.deepEqual(ok({ model: "", size: "", outputFormat: "", outputCompression: null, negativePrompt: "  ", seed: "", sampleSteps: undefined, strength: "" }, true), {}, "empty is not sent");
  assert.deepEqual(
    ok({ model: " m ", size: "512x768", outputFormat: "webp", outputCompression: 80, negativePrompt: " blurry ", seed: 5, sampleSteps: 30 }),
    { model: "m", size: "512x768", outputFormat: "webp", outputCompression: 80, negativePrompt: "blurry", seed: 5, sampleSteps: 30 },
  );
  assert.deepEqual(ok({ size: "auto", seed: -1, outputFormat: "jpeg", outputCompression: 0 }), { size: "auto", seed: -1, outputFormat: "jpeg", outputCompression: 0 });
  assert.deepEqual(ok({ strength: 0.75 }, true), { strength: 0.75 });
  assert.deepEqual(ok({ strength: 0 }, true), { strength: 0 });
  assert.deepEqual(ok({ strength: 1 }, true), { strength: 1 });
  assert.deepEqual(ok({ strength: 0.5 }, false), {}, "a new picture has no strength");

  bad({ size: "huge" }, /size looks like/);
  bad({ size: "63x512" }, /from 64 to 8192/);
  bad({ size: "512x8193" }, /from 64 to 8192/);
  bad({ model: "m".repeat(201) }, /model/);
  bad({ model: 7 }, /model/);
  bad({ outputFormat: "gif" }, /png, jpeg, webp/);
  bad({ outputFormat: 7 }, /png, jpeg, webp/);
  bad({ outputCompression: 50 }, /JPEG and WebP/);
  bad({ outputCompression: 50, outputFormat: "png" }, /JPEG and WebP/);
  bad({ outputCompression: 101, outputFormat: "jpeg" }, /from 0 to 100/);
  bad({ outputCompression: -1, outputFormat: "jpeg" }, /from 0 to 100/);
  bad({ outputCompression: 1.5, outputFormat: "jpeg" }, /whole number/);
  bad({ outputCompression: "80", outputFormat: "jpeg" }, /whole number/);
  bad({ seed: 1.5 }, /seed/);
  bad({ seed: "7" }, /seed/);
  bad({ seed: -2 }, /seed/);
  bad({ seed: 2 ** 60 }, /seed/);
  bad({ sampleSteps: 0 }, /from 1 to 100/);
  bad({ sampleSteps: 101 }, /from 1 to 100/);
  bad({ sampleSteps: 2.5 }, /whole number/);
  bad({ negativePrompt: 5 }, /negative prompt/);
  bad({ negativePrompt: "x".repeat(LIMITS.negativePrompt + 1) }, /over 4000/);
  bad({ strength: -0.1 }, /from 0 to 1/, true);
  bad({ strength: 1.1 }, /from 0 to 1/, true);
  bad({ strength: "0.5" }, /from 0 to 1/, true);
  bad({ strength: Number.NaN }, /from 0 to 1/, true);
  assert.match(parsePictureSettings({ seed: Number.MAX_SAFE_INTEGER }, false, 4) as string, /too large/, "the next seeds must still be numbers");
});

test("pictures of one request take the next seed each, a random one stays random, and no seed stays none", () => {
  const settings = { seed: 10, sampleSteps: 20 };
  assert.deepEqual([0, 1, 2].map((i) => forPicture(settings, i).seed), [10, 11, 12]);
  assert.equal(forPicture(settings, 2).sampleSteps, 20, "the rest is as it was");
  assert.equal(settings.seed, 10, "the request's own is not changed");
  assert.deepEqual([0, 1, 2].map((i) => forPicture({ seed: -1 }, i).seed), [-1, -1, -1]);
  assert.deepEqual([0, 1].map((i) => forPicture({}, i).seed), [undefined, undefined]);
});

test("starting from noise is `init_image: null` in the block, for an edit that asks for it and no other, and a strength does not go with it", () => {
  assert.equal(nativeBlock({ fromNoise: false }), "", "off is no block");
  assert.equal(nativeBlock({ seed: 3 }).includes("init_image"), false);
  const block = nativeBlock({ fromNoise: true });
  assert.equal(block, '<sd_cpp_extra_args>{"init_image":null}</sd_cpp_extra_args>');
  assert.deepEqual(cutOut(promptWith("x", { fromNoise: true, seed: 3, negativePrompt: "blurry" })).args, { init_image: null, negative_prompt: "blurry", seed: 3 });

  const parsed = (body: Record<string, unknown>, edit: boolean) => parsePictureSettings(body, edit);
  assert.deepEqual(parsed({ fromNoise: true }, true), { fromNoise: true });
  assert.deepEqual(parsed({ fromNoise: false, strength: 0.5 }, true), { strength: 0.5 }, "off is the picture as the base, with its strength");
  assert.deepEqual(parsed({ fromNoise: true }, false), {}, "a new picture has no picture to start from");
  assert.match(parsed({ fromNoise: true, strength: 0.5 }, true) as string, /strength/);
  assert.match(parsed({ fromNoise: "yes" }, true) as string, /true or false/);
});
