import { type Page } from '@playwright/test';
import { test, expect } from '../../../../tests/browser/portal-mock';

test.use({ installed: ['extensions/terminal'] });

/** Done sliding in: measured on the way, a panel is where it is going plus the slide. */
const settled = (page: Page) =>
  page.evaluate(() => Promise.all([...document.querySelectorAll('.chat-aside')].flatMap((e) => e.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished))));

/** The chat with the terminal open. */
async function chat(page: Page) {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/tests/chat.html?phase=tools');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.chat-aside').first()).toBeVisible();
  await settled(page);
}

test('the tabs of the terminals are one stop for Tab, and the arrow keys, Home and End go through them', async ({ page }) => {
  await chat(page);
  const tabs = page.getByRole('tablist', { name: 'Terminals' });
  const agent = tabs.getByRole('tab', { name: 'Agent' }), background = tabs.getByRole('tab', { name: 'Background' }), shell = tabs.getByRole('tab', { name: 'Your shell' });
  await expect(agent).toHaveAttribute('tabindex', '0');
  await expect(background).toHaveAttribute('tabindex', '-1');
  await agent.focus();
  await page.keyboard.press('ArrowRight');
  await expect(background).toBeFocused();
  await expect(background).toHaveAttribute('aria-selected', 'true');
  await expect(background).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('End');
  await expect(shell).toBeFocused();
  await expect(shell).toHaveAttribute('aria-selected', 'true');
  // Round the end.
  await page.keyboard.press('ArrowRight');
  await expect(agent).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(shell).toBeFocused();
  await page.keyboard.press('Home');
  await expect(agent).toBeFocused();
  // Tab leaves the list rather than going on to the next tab.
  await page.keyboard.press('Tab');
  await expect(tabs.getByRole('tab').and(page.locator(':focus'))).toHaveCount(0);
});
