import { type Page } from '@playwright/test';
import { test, expect } from './portal-mock';

/**
 * The voice stage's styles, where a rule that cannot win is easy to add to and hard to see: the cards that fly out
 * of the orb had three animations declared and the last one ran, and the dock's layout is set by the class that
 * every window puts on the stage, so what was set under the windows' own classes was never in effect.
 */
const card = (page: Page, classes: string) =>
  page.evaluate((cls) => {
    document.body.insertAdjacentHTML('beforeend', `<section class="voice-stage ${cls.stage}"><div class="voice-tool-activity"><div class="voice-tool-float ${cls.card}">x</div></div></section>`);
    const el = document.body.lastElementChild!.querySelector('.voice-tool-float')!;
    return getComputedStyle(el).animationName;
  }, { stage: '', card: classes });

test('a tool card flies in with one animation and out with one, and no other is kept', async ({ page }) => {
  await page.goto('/tests/orb.html');
  expect(await card(page, 'is-running')).toBe('voice-tool-arrive');
  expect(await card(page, 'is-running is-leaving')).toBe('voice-tool-leave');
  const names = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) if (rule instanceof CSSKeyframesRule && rule.name.startsWith('voice-tool-')) found.push(rule.name);
    }
    return found.sort();
  });
  expect(names).toEqual(['voice-tool-arrive', 'voice-tool-leave']);
});

test('with reduced motion a tool card does not animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/orb.html');
  expect(await card(page, 'is-running')).toBe('none');
  expect(await card(page, 'is-running is-leaving')).toBe('none');
});

test('with any window open the orb is the dock: one row with small buttons, whichever window it is', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tests/orb.html');
  const dock = (classes: string) =>
    page.evaluate((cls) => {
      document.body.insertAdjacentHTML('beforeend', `<section class="voice-stage ${cls}" style="height:600px"><div class="voice-presence"><div class="voice-avatar"></div><div class="voice-dock-center"><div class="voice-status"><span></span>x</div></div><div class="voice-stage-controls"><button class="voice-stage-action">x</button></div></div></section>`);
      const stage = document.body.lastElementChild!;
      const style = (selector: string) => getComputedStyle(stage.querySelector(selector)!);
      return { direction: style('.voice-presence').flexDirection, height: style('.voice-presence').height, avatar: style('.voice-avatar').width, button: style('.voice-stage-action').width, dot: style('.voice-status > span').display };
    }, classes);
  const expected = { direction: 'row', height: '80px', avatar: '100px', button: '32px', dot: 'none' };
  for (const classes of ['is-docked', 'is-docked is-browsing', 'is-docked has-side', 'is-docked is-browsing has-side']) expect(await dock(classes), classes).toEqual(expected);
});
