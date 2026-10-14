import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { freePort, inProcessHome } from "./server-harness.mjs";

/**
 * The portal's browser tools against a real Chromium over its debugging port,
 * as they run beside the browser container: what the model is shown after
 * each call, a stale ref, a scroll past a sticky sidebar, reading and finding.
 */

inProcessHome("browser-tools-");

const FORM = `<!doctype html><title>Signup</title><h1>Sign up</h1>
<form onsubmit="event.preventDefault(); const b = document.getElementById('save'); b.disabled = true; b.textContent = 'Saved'; document.getElementById('msg').hidden = false;">
<label>Name <input id=name></label> <label>Plan <select id=plan><option>Free</option><option>Pro</option></select></label>
<button id=save>Save</button></form>
<p role=alert id=msg hidden>Thanks, you are signed up.</p>
<p><a href="/long">The long page</a></p>`;

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const LONG = `<!doctype html><title>Long</title>
<nav aria-label="Sections" style="position:fixed;top:0;left:0;width:180px"><a href="#a">Alpha</a> <a href="#b">Beta</a></nav>
<main style="margin-left:200px">${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i}: ${words(20)}</p>`).join("")}
<article id=essay><h2>Essay</h2><p>${words(600)}</p></article>
<h2>Pricing</h2><p>It costs nothing.</p></main>`;

// One link that opens a tab at once, and a button that opens one a moment after the click.
const TABS = `<!doctype html><title>Tabs</title>
<a href="/long" target="_blank">Open it in a tab</a>
<button onclick="setTimeout(() => window.open('/long', '_blank'), 150)">Open it soon</button>`;

// A button that notes where the agent's cursor was when it was clicked, and a link to the next page.
const CURSOR = (n) => `<!doctype html><title>Cursor ${n}</title>
<button id=go style="position:absolute;left:400px;top:300px;width:120px;height:40px" onclick="window.__clickedAt = window.__agentCursor && window.__agentCursor.where(); this.textContent = 'Done'">Go</button>
<a href="/cursor/${n + 1}" style="position:absolute;left:${100 + n * 60}px;top:500px">Next page</a>`;

const site = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  const cursorPage = req.url.match(/^\/cursor\/(\d+)/);
  res.end(cursorPage ? CURSOR(Number(cursorPage[1])) : req.url === "/long" ? LONG : req.url === "/tabs" ? TABS : FORM);
});
let browser;
let tools = {};
let base = "";

after(async () => {
  site.close();
  await browser?.close();
});

/**
 * A Chromium with a debugging port, as the browser container runs one: the
 * one Playwright has installed, if it has. Without one the test is skipped
 * and says why, rather than failing on a machine with no browser.
 */
const cdpPort = await freePort();
try {
  browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`, "--window-size=1280,720"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("about:blank");
} catch (e) {
  browser = undefined;
  console.log(`# no Chromium to run: ${e.message.split("\n")[0]}`);
}

async function setUp() {
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
  process.env.BROWSER_CDP_URL = `http://127.0.0.1:${cdpPort}`;
  const { browserTools } = await import("../dist/browser/tools.js");
  browserTools("chat-1")({ registerTool: (t) => (tools[t.name] = t) });
}

const call = async (name, params = {}) => {
  const result = await tools[name].execute("call", params);
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
};
const refOf = (text, pattern) => {
  const line = text.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in:\n${text}`);
  return line.match(/\[((?:f\d+)?e\d+)\]/)[1];
};

test("the browser tools, on a real browser", { skip: browser ? false : "no Chromium installed for Playwright" }, async (t) => {
  await setUp();

  await t.test("a page is shown as the view, never as HTML", async () => {
    const view = await call("browser_navigate", { url: `${base}/form` });
    assert.match(view, /^Page: Signup — /);
    assert.match(view, /textbox "Name" \[e\d+\]/);
    assert.doesNotMatch(view, /<\/?[a-z]+[\s>]/i, "no HTML in the answer");
  });

  let saveRef;
  await t.test("typing and clicking answer with what changed", async () => {
    const view = await call("browser_snapshot");
    const typed = await call("browser_type", { ref: refOf(view, /textbox "Name"/), text: "Ada" });
    assert.match(typed, /What changed on screen:/);
    assert.match(typed, /textbox "Name": Ada/);
    const chose = await call("browser_select", { ref: refOf(view, /combobox "Plan"/), option: "Pro" });
    assert.match(chose, /Pro/);
    saveRef = refOf(view, /button "Save"/);
    const clicked = await call("browser_click", { ref: saveRef });
    assert.match(clicked, /button "Saved" \[e\d+\] disabled/);
    assert.match(clicked, /\+ alert: Thanks, you are signed up\./);
    assert.ok(clicked.length < 1500, `a diff, not a page: ${clicked.length} chars`);
  });

  await t.test("a ref whose element is gone is refused, not clicked somewhere else", async () => {
    await assert.rejects(call("browser_click", { ref: saveRef }), /no longer on the page.*fresh browser_snapshot/s);
    await assert.rejects(call("browser_click", { ref: "#save" }), /not a ref/);
  });

  await t.test("following a link answers with the new page", async () => {
    const view = await call("browser_snapshot");
    const moved = await call("browser_click", { ref: refOf(view, /link "The long page"/) });
    assert.match(moved, /the page is now .*\/long/);
    assert.match(moved, /↓ [\d,]+ more below/);
  });

  await t.test("scrolling shows the next screen without repeating a pinned sidebar", async () => {
    const scrolled = await call("browser_scroll");
    assert.match(scrolled, /Paragraph \d+/);
    assert.match(scrolled, /Still on screen and unchanged, not repeated: Sections/);
    assert.doesNotMatch(scrolled, /link "Alpha"/);
  });

  await t.test("find reaches past the viewport, and get_text reads a section in pages", async () => {
    const found = await call("browser_find", { query: "pricing" });
    assert.match(found, /heading "Pricing" \[(?:f\d+)?e\d+\].* px below/);
    const essay = refOf(await call("browser_find", { query: "essay" }), /heading "Essay"|article/);
    const view = await call("browser_scroll", { ref: essay });
    const article = refOf(view, /^\s*article/);
    const page1 = await call("browser_get_text", { ref: article });
    assert.match(page1, /## Essay/);
    assert.match(page1, /get_text (?:f\d+)?e\d+ offset=\d+ for more/);
    const page2 = await call("browser_get_text", { ref: article, offset: 2000 });
    assert.match(page2, /\(chars [\d,]+–/);
  });

  await t.test("the cursor lands on the element before the real click, keeps its place over navigations and is never in what the model reads", async () => {
    // A second client on the same browser, to look at the page as the tools leave it.
    const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    try {
      const pageAt = (url) => observer.contexts().flatMap((c) => c.pages()).find((pg) => pg.url() === url);
      const view = await call("browser_navigate", { url: `${base}/cursor/1` });
      assert.doesNotMatch(view, /agent-cursor|Click ·/, "the cursor is not in the view");
      const clicked = await call("browser_click", { ref: refOf(view, /button "Go"/) });
      assert.match(clicked, /button "Done"/);
      assert.doesNotMatch(clicked, /Click ·|agent-cursor/, "nor in the diff after an action");
      const first = pageAt(`${base}/cursor/1`);
      const at = await first.evaluate(() => window.__clickedAt);
      const box = await first.locator("#go").boundingBox();
      assert.ok(at, "the cursor was on the page when the button was clicked");
      assert.ok(Math.abs(at.x - (box.x + box.width / 2)) < 1.5 && Math.abs(at.y - (box.y + box.height / 2)) < 1.5, `at the button's centre: ${JSON.stringify(at)}`);

      // Three navigations in a row: each new page has the cursor, where it was when the link was clicked.
      let current = await call("browser_snapshot");
      for (let n = 1; n <= 3; n++) {
        const link = pageAt(`${base}/cursor/${n}`).locator("a");
        const lb = await link.boundingBox();
        current = await call("browser_click", { ref: refOf(current, /link "Next page"/) });
        assert.match(current, new RegExp(`the page is now .*/cursor/${n + 1}`));
        const next = pageAt(`${base}/cursor/${n + 1}`);
        let where = null;
        for (let i = 0; i < 40 && !where; i++) where = await next.evaluate(() => window.__agentCursor?.where() ?? null).catch(() => null), where || (await new Promise((r) => setTimeout(r, 50)));
        assert.ok(where, `the cursor is on page ${n + 1}`);
        assert.ok(Math.abs(where.x - (lb.x + lb.width / 2)) < 1.5 && Math.abs(where.y - (lb.y + lb.height / 2)) < 1.5, `kept its place on page ${n + 1}: ${JSON.stringify(where)}`);
      }

      // Switched off on the Browser page, it does not move and the click does not wait for it.
      const { setBrowserCursor } = await import("../dist/db.js");
      setBrowserCursor(false);
      try {
        const page4 = pageAt(`${base}/cursor/4`);
        const before = await page4.evaluate(() => window.__agentCursor.where());
        const started = Date.now();
        await call("browser_click", { ref: refOf(current, /button "Go"/) });
        assert.deepEqual(await page4.evaluate(() => window.__clickedAt), before, "it stayed where it was");
        assert.ok(Date.now() - started < 2500, "and the click did not wait for a glide");
      } finally {
        setBrowserCursor(true);
      }
    } finally {
      // Not close(): on a browser reached over CDP that can end the browser itself, which the next test needs.
      // The connection goes when the test's browser closes.
    }
  });

  await t.test("a screenshot is an image", async () => {
    const shot = await tools.browser_screenshot.execute("call", {});
    assert.equal(shot.content[0].type, "image");
    assert.equal(shot.content[0].mimeType, "image/jpeg");
  });

  await t.test("a chat that is gone does not keep its tab and what it was shown", async () => {
    const { forgetBrowserSession } = await import("../dist/browser/tools.js");
    assert.equal(forgetBrowserSession("chat-1"), true, "it was holding them");
    assert.equal(forgetBrowserSession("chat-1"), false, "and does not any more");
    assert.equal(forgetBrowserSession("never-used-the-browser"), false);
    // Used again, it is simply given a tab.
    assert.match(await call("browser_snapshot"), /^Page: /);
  });

  await t.test("an action does not wait for a tab that never opens", async () => {
    const view = await call("browser_navigate", { url: `${base}/form` });
    const ref = refOf(view, /textbox "Name"/);
    // Once a fixed wait of a second and a half sat in each, so none could be quicker than that.
    // The fastest of three, so that a busy machine does not decide it.
    const took = [];
    for (const text of ["Ada", "Grace", "Edith"]) {
      const started = Date.now();
      await call("browser_type", { ref, text });
      took.push(Date.now() - started);
    }
    assert.ok(Math.min(...took) < 1300, `a type took ${took.join(", ")} ms`);
  });

  await t.test("a tab an action opens is still shown, at once or a moment after", async () => {
    for (const [name, pattern] of [["Open it in a tab", /link "Open it in a tab"/], ["Open it soon", /button "Open it soon"/]]) {
      const view = await call("browser_navigate", { url: `${base}/tabs` });
      const opened = await call("browser_click", { ref: refOf(view, pattern) });
      assert.match(opened, /it opened a new tab, which is where you are now/, name);
      assert.match(opened, /Page: Long/, name);
    }
  });
});
