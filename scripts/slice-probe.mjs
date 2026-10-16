import puppeteer from 'puppeteer-core';
import { startDev } from './lib/server.mjs';
import { payAsGuest } from './lib/paypal-guest.mjs';

const srv = await startDev({ fresh: true });
console.log('server up', srv.base);
let browser;
try {
  const res = await fetch(srv.base + '/api/sample', { method: 'POST' });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  console.log('sample events', events.map((e) => e.t).join(','));
  const meta = events.find((e) => e.t === 'meta');
  const idea = events.find((e) => e.t === 'idea');
  const pick = [...idea.cards].sort((a, b) => a.price_cents - b.price_cents).slice(0, 2).map((c) => c.id);
  // tampered client values must be ignored
  const co = await fetch(srv.base + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: meta.session, itemIds: pick, items: [{ id: pick[0], price: 0.01 }], total: 0.02 }) });
  const cj = await co.json();
  console.log('checkout', co.status, cj.orderId, 'total_cents', cj.total_cents, 'lines', cj.lines?.map((l) => l.price_cents).join('+'), cj.error?.code ?? '');
  browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 1400 });
  const r = await payAsGuest(page, cj.approveUrl, srv.base + '/', { log: console.log });
  console.log('pay result', r.ok, r.note, r.url.replace(/(token|PayerID)=[^&]+/g, '$1=<x>'));
  await new Promise((r) => setTimeout(r, 2500));
  console.log('after redirect url', page.url());
  const oj = await (await fetch(srv.base + '/api/orders/' + cj.orderId)).json();
  console.log('ORDER', oj.id, oj.status, oj.total_cents, oj.captureId, oj.error ?? '');
} catch (e) {
  console.log('ERR', e.message);
} finally {
  await browser?.close();
  srv.stop();
}
