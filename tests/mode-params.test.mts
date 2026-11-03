import test from "node:test";
import assert from "node:assert/strict";
import { addLocale, setLanguage } from "../core/web/src/i18n.ts";
import de from "../core/web/src/locales/de.ts";
import { paramName, paramsLine } from "../core/web/src/mode-params.ts";

test("the parameters a mode sets are named in one line, in a fixed order, and a mode that sets none has no line", () => {
  setLanguage("en");
  assert.equal(paramsLine({ maxTokens: 512, temperature: 0.2, topP: 0.9 }), "Temperature 0.2 · Top P 0.9 · Max tokens 512");
  assert.equal(paramsLine({ topK: 20, minP: 0.05 }), "Top K 20 · Min P 0.05");
  assert.equal(paramsLine({ temperature: 0 }), "Temperature 0", "zero is a value that is set");
  assert.equal(paramsLine({}), "");
  assert.equal(paramsLine(undefined), "");
});

test("the names are German in German", () => {
  addLocale(de);
  setLanguage("de");
  try {
    assert.equal(paramName("temperature"), "Temperatur");
    assert.equal(paramsLine({ temperature: 0.2, maxTokens: 512 }), "Temperatur 0.2 · Max. Tokens 512");
  } finally {
    setLanguage("system");
  }
});
