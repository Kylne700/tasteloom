// Drives PayPal's hosted SANDBOX guest-card page with the documented sandbox test card and synthetic buyer data.
// Selectors and the card come from the 2026-10-16 spike (research/08): only Visa 4005519200000004 was accepted by the guest form.
// Never creates a PayPal account: the "create account" switch is verified off before paying.
export const TEST_CARD = { number: '4005519200000004', exp: '12/30', cvv: '123' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickByText(page, re, selector = 'button', last = false) {
  const hits = [];
  for (const h of await page.$$(selector)) {
    const t = await h.evaluate((e) => (e.offsetParent ? e.innerText.trim() : ''));
    if (t && re.test(t)) hits.push([h, t]);
  }
  const pick = last ? hits.at(-1) : hits[0];
  if (!pick) return null;
  await pick[0].click();
  return pick[1];
}

async function fill(page, sel, v, log) {
  const el = await page.$(sel);
  if (!el) return log(`  missing field ${sel}`);
  await el.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(sel, v, { delay: 25 });
}

/** Opens `approveUrl`, pays as a guest, and resolves when the browser lands on `returnPrefix`. Returns { ok, url, note }. */
export async function payAsGuest(page, approveUrl, returnPrefix, { log = console.log, shot } = {}) {
  await page.goto(approveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input[name=cardnumber], input[name=login_email]', { timeout: 60000 });
  if (!(await page.$('input[name=cardnumber]'))) {
    // login-first layout: open the guest path
    await clickByText(page, /Pay with (a )?(debit|credit|card)|Debit or Credit Card|Pay by card/i, 'button, a');
    await sleep(6000);
    if (!(await page.$('input[name=cardnumber]'))) {
      await page.type('input[name=login_email]', 'synthetic.buyer@example.com');
      await clickByText(page, /.+/, 'button');
    }
    await page.waitForSelector('input[name=cardnumber]', { timeout: 45000 });
  }
  if (shot) await shot(page, 'paypal-guest-form');
  await fill(page, 'input[name=email]', 'synthetic.buyer@example.com', log);
  await fill(page, '#phone', '4085551234', log);
  await fill(page, 'input[name=cardnumber]', TEST_CARD.number, log);
  await fill(page, 'input[name=exp-date]', TEST_CARD.exp, log);
  await fill(page, 'input[name=cvv]', TEST_CARD.cvv, log);
  await fill(page, 'input[name=fname]', 'Test', log);
  await fill(page, 'input[name=lname]', 'Buyer', log);
  await fill(page, 'input[name=billingLine1]', '1 Main St', log);
  await fill(page, 'input[name=billingCity]', 'San Jose', log);
  await page.select('select[name=billingState]', 'CA').catch(() => log('  state select failed'));
  await fill(page, 'input[name=billingPostalCode]', '95131', log);
  // never create an account: the "Save info & create your PayPal account" switch is on by default and must be off before paying
  const sw = await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].map((e) => ({ id: e.id, checked: e.checked, text: (e.closest('label')?.innerText || e.parentElement?.parentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 80) })));
  log('  checkboxes: ' + JSON.stringify(sw));
  for (const row of sw) {
    if (!row.checked) continue;
    await page.evaluate((id) => document.getElementById(id)?.click(), row.id);
    await sleep(500);
    if (await page.evaluate((id) => document.getElementById(id)?.checked, row.id)) return { ok: false, url: page.url(), note: 'account switch could not be turned off; stopped without paying' };
  }
  const exact = await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.offsetParent && /^\s*(Pay Now|Continue as Guest)\s*$/i.test(b.innerText) && !/create account/i.test(b.innerText)), { timeout: 15000 }).then(() => true, () => false);
  if (!exact) return { ok: false, url: page.url(), note: 'only account creation offered; stopped without paying' };
  await sleep(800);
  const nav = page.waitForFunction((p) => location.href.startsWith(p), { timeout: 60000 }, returnPrefix).catch(() => null);
  const clicked = await clickByText(page, /^\s*(Pay Now|Continue as Guest)\s*$/i, 'button', true);
  if (!clicked) return { ok: false, url: page.url(), note: 'no guest pay button (only account creation offered); stopped' };
  // synthetic address can trigger a "We can't verify your address" modal: accept as entered
  const modal = await Promise.race([nav.then(() => 'nav'), sleep(9000).then(() => 'wait')]);
  if (modal === 'wait' && !page.url().startsWith(returnPrefix)) await clickByText(page, /^\s*Continue\s*$/i);
  await nav;
  const ok = page.url().startsWith(returnPrefix);
  let note = ok ? 'returned to the merchant' : 'did not return';
  if (!ok) note += ': ' + (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 200);
  return { ok, url: page.url(), note };
}
