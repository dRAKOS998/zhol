import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTileSet, isZhol } from '@zhol/engine';

const SERVER = 'http://127.0.0.1:3101';
const ids = (s: string) => s.split(' ');

// Rigged first deal (via the test-only harness):
//  starter:     a full 14-tile hand + y01a; discards r12a normally, keeping y01a unlinked (+1).
//  next seat:   FULL_A minus k08b, plus y13b; draws k08b from the stock and closes by discarding y13b (−20).
const STARTER = ids('r01a r02a r03a r04a u05a u06a u07a k09a k10a k11a r12a u12a k12a y12a y01a');
const NEXT = ids('r01b r02b r03b r04b u08b u09b u10b y07b y08b y09b k05b k06b k07b y13b');
const THIRD = ids('u01b u02b u03b k01b k02b k03b y10b y11b y12b r08b r09b r10b r11b r12b');
const FOURTH = ids('r06a k06a u06b y06a r10a k10b u10a y10a k04a u04a y04a u11b u12b u13b');

function plan() {
  const used = new Set([...STARTER, ...NEXT, ...THIRD, ...FOURTH, 'k08b']);
  const pool = createTileSet().filter((id) => !used.has(id));
  const indicator = pool.splice(pool.findIndex((id) => !isZhol(id)), 1)[0]!;
  return { indicator, racks: [STARTER, NEXT, THIRD, FOURTH], stock: ['k08b', ...pool] };
}

async function newPlayer(browser: Browser, mobile = false): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(
    mobile ? { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 820 } },
  );
  const page = await ctx.newPage();
  return { ctx, page };
}

const rackSlot = (page: Page, tile: string) => page.locator(`[data-tile="${tile}"]`).getAttribute('data-slot');

/** The page where `selector` is visible (e.g. whose turn it is). */
async function findPage(pages: Page[], selector: string) {
  for (let i = 0; i < 40; i++) {
    for (const p of pages) if (await p.locator(selector).first().isVisible()) return p;
    await pages[0]!.waitForTimeout(150);
  }
  throw new Error(`No page shows "${selector}"`);
}

/** Drag a rack tile with the mouse and let go over `target` (my pile to throw, the stock to close). */
async function dragTileTo(page: Page, tile: string, target: string) {
  const from = (await page.locator(`.rack [data-tile="${tile}"]`).boundingBox())!;
  const to = (await page.locator(target).boundingBox())!;
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(sx + ((tx - sx) * k) / 12, sy + ((ty - sy) * k) / 12);
  await page.mouse.up();
}
const MY_PILE = '[data-drop="discard"] .pile-stack';
const STOCK = '.stock.can-close';

test('four isolated players play a round in real time', async ({ browser }) => {
  const players = [await newPlayer(browser), await newPlayer(browser), await newPlayer(browser), await newPlayer(browser, true)];
  const [a, b, c, d] = players.map((p) => p.page) as [Page, Page, Page, Page];
  const names = ['Arta', 'Besi', 'Drita', 'Gëzim'];

  // Create the room
  await a.goto('/');
  await expect(a.getByRole('heading', { name: 'Zhol' })).toBeVisible();
  await a.getByLabel('Emri yt').fill(names[0]!);
  await a.getByRole('button', { name: 'Krijo dhomë' }).click();
  await expect(a).toHaveURL(/\/room\/[A-Z2-9]{8}$/);
  const link = (await a.getByLabel('Lidhja e dhomës').textContent())!.trim();
  const code = link.split('/').pop()!;
  await expect(a.getByRole('button', { name: 'Kopjo lidhjen' })).toBeVisible();

  const rig = await fetch(`${SERVER}/__test/deal-plan/${code}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan()),
  });
  expect(rig.ok).toBe(true);

  // Friends open the invite link directly (SPA route) and join
  for (const [i, p] of [b, c, d].entries()) {
    await p.goto(link);
    await p.getByLabel('Emri yt').fill(names[i + 1]!);
    await p.getByRole('button', { name: 'Hyr në dhomë' }).click();
    await expect(p.getByText('Fto shokët')).toBeVisible();
  }
  await expect(a.getByText('Lojtarët (4/4)')).toBeVisible();

  // A fifth player cannot take a seat
  const fifth = await newPlayer(browser);
  await fifth.page.goto(link);
  await fifth.page.getByLabel('Emri yt').fill('Erion');
  await fifth.page.getByRole('button', { name: 'Hyr në dhomë' }).click();
  await expect(fifth.page.getByRole('alert')).toContainText('Dhoma është plot');
  await fifth.ctx.close();

  await d.screenshot({ path: 'test-results/lobby-360.png', fullPage: true });

  // Everyone readies up
  for (const p of [b, c, d]) await p.getByRole('button', { name: 'Jam gati' }).click();
  // The host (seat 1) starts once the others are ready.
  await a.getByRole('button', { name: /^Fillo lojën/ }).click();
  for (const p of [a, b, c, d]) await expect(p.getByRole('button', { name: 'Tabela e pikëve' })).toBeVisible();

  // 360 px portrait: no horizontal scroll; rack and actions reachable
  const overflow = await d.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(d.getByRole('group', { name: 'Rafti yt' })).toBeInViewport();

  const all = [a, b, c, d];
  const starter = await findPage(all, '.pile.can-drop');
  await starter.screenshot({ path: 'test-results/table-desktop-starter.png' });
  await d.screenshot({ path: 'test-results/table-360.png' });

  // Mobile: tap-select, then tap an empty slot to move the tile (touch), and drag with a mouse on desktop.
  const mobileTile = await d.locator('[data-tile]').first().getAttribute('data-tile');
  await d.locator(`[data-tile="${mobileTile}"]`).tap();
  await expect(d.locator(`[data-tile="${mobileTile}"]`)).toHaveAttribute('aria-pressed', 'true');
  await d.locator('[data-slot="23"]').tap();
  await expect(d.locator(`[data-tile="${mobileTile}"]`)).toHaveAttribute('data-slot', '23');

  // Keyboard reordering across rows on another player (not the starter): Shift+ArrowDown moves a tile to the lower tier.
  const kb = all.find((p) => p !== starter && p !== d)!;
  const kbTile = (await kb.locator('[data-tile]').first().getAttribute('data-tile'))!;
  const kbFrom = Number(await rackSlot(kb, kbTile));
  await kb.locator(`[data-tile="${kbTile}"]`).focus();
  await kb.keyboard.press('Shift+ArrowDown');
  await expect(kb.locator(`[data-tile="${kbTile}"]`)).toHaveAttribute('data-slot', String((kbFrom + 12) % 24));
  await expect(kb.locator(`[data-tile="${kbTile}"]`)).toBeFocused();

  // Mouse drag on the starter rack: move r01a to slot 20. Dragging never discards.
  const src = starter.locator('[data-tile="r01a"]');
  const dst = starter.locator('[data-slot="20"]');
  const sb = (await src.boundingBox())!;
  const db = (await dst.boundingBox())!;
  await starter.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await starter.mouse.down();
  await starter.mouse.move(sb.x + 20, sb.y - 10, { steps: 4 });
  await starter.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 8 });
  await starter.mouse.up();
  await expect(src).toHaveAttribute('data-slot', '20');
  await expect(starter.locator('[data-tile]')).toHaveCount(15);

  // Refresh keeps the seat and the manual order
  await kb.reload();
  await expect(kb.locator(`[data-tile="${kbTile}"]`)).toHaveAttribute('data-slot', String((kbFrom + 12) % 24));

  // Starter: ordinary discard of r12a, dragged onto their own pile
  await dragTileTo(starter, 'r12a', MY_PILE);
  await expect(starter.locator('.rack [data-tile]')).toHaveCount(14);
  await expect(starter.locator('[data-anchor] [data-tile-id="r12a"]')).toBeVisible();

  // Next seat: draw by tapping the stock (gets k08b), try an invalid close, then a valid one
  const next = await findPage(all, 'button.stock-btn:not(.stock-close)');
  await next.getByRole('button', { name: /^Tërhiq një gur nga stoku/ }).click();
  await expect(next.locator('[data-tile="k08b"]')).toBeVisible();
  // Invalid close by tap: select k05b, then tap the stock
  await next.locator('[data-tile="k05b"]').click();
  await next.getByRole('button', { name: /Mbyll raundin duke vendosur 5 e zezë mbi stok/ }).click();
  await expect(next.getByRole('alert')).toContainText('14 gurët');
  // Refused: the tile is back on the rack, nothing was thrown
  await expect(next.locator('.rack [data-tile="k05b"]:not(.is-leaving)')).toBeVisible();
  await expect(next.locator('.rack [data-tile]')).toHaveCount(15);
  // Valid close: drag the final tile (13 yellow) onto the stock
  await dragTileTo(next, 'y13b', STOCK);

  // Every screen opens the scoreboard automatically with identical totals
  const totals: string[] = [];
  for (const p of all) {
    const dialog = p.getByRole('dialog', { name: 'Tabela e pikëve' });
    await expect(dialog).toBeVisible();
    totals.push((await dialog.locator('tbody').innerText()).replace(' (ti)', ''));
  }
  expect(new Set(totals).size).toBe(1);
  expect(totals[0]).toContain('−20');
  expect(totals[0]).toContain('+1');
  // ...and shows every hand as it was scored: the starter's loose 1, and the tile that closed the round
  for (const p of all) {
    const hands = p.getByRole('dialog').locator('.hand');
    await expect(hands).toHaveCount(4);
    await expect(p.getByRole('dialog').locator('.hand-loose [data-tile-id="y01a"]')).toBeVisible();
    await expect(p.getByRole('dialog').locator('.hand.is-winner .hand-final [data-tile-id="y13b"]')).toBeVisible();
    await expect(p.getByRole('dialog').locator('.hand [data-tile-id]')).toHaveCount(4 * 14 + 1);
  }
  await d.screenshot({ path: 'test-results/score-360.png' });

  // Dismiss with Escape and reopen from the permanent button
  await d.keyboard.press('Escape');
  await expect(d.getByRole('dialog')).toHaveCount(0);
  await d.getByRole('button', { name: 'Tabela e pikëve' }).click();
  await expect(d.getByRole('dialog', { name: 'Tabela e pikëve' })).toBeVisible();
  await expect(d.getByRole('dialog').getByRole('button', { name: 'Jam gati' })).toBeVisible();

  // Next round can be readied from the scoreboard; round 2 deals after all four are ready
  for (const p of all) await p.getByRole('dialog').getByRole('button', { name: 'Jam gati' }).click();
  for (const p of all) await expect(p.getByText('Raundi 2/4')).toBeVisible();
  for (const p of all) await expect(p.getByRole('dialog')).toHaveCount(0);
  await a.screenshot({ path: 'test-results/round2-desktop.png' });

  for (const p of players) await p.ctx.close();
});
