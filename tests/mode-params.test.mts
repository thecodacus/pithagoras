import test from "node:test";
import assert from "node:assert/strict";
import { addLocale, setLanguage } from "../core/web/src/i18n.ts";
import de from "../core/web/src/locales/de.ts";
import { paramsLine, temperatureName } from "../core/web/src/mode-params.ts";

test("the temperature a mode sets is named in one line, and a mode that sets none has no line", () => {
  setLanguage("en");
  assert.equal(paramsLine({ temperature: 0.2 }), "Temperature 0.2");
  assert.equal(paramsLine({ temperature: 0 }), "Temperature 0", "zero is a value that is set");
  assert.equal(paramsLine({}), "");
  assert.equal(paramsLine(undefined), "");
});

test("the name is German in German", () => {
  addLocale(de);
  setLanguage("de");
  try {
    assert.equal(temperatureName(), "Temperatur");
    assert.equal(paramsLine({ temperature: 0.2 }), "Temperatur 0.2");
  } finally {
    setLanguage("system");
  }
});
