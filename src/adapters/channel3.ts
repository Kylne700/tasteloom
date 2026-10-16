// Channel3 product search: primary source of purchasable product cards (structured prices, images, attributed shop links).
// Real response shape (verified by one live call on 2026-10-16): { products: [{ id, title, brands:[{name}], images:[{url,is_main_image}],
// offers:[{ url, domain, price:{ price, currency }, availability, condition }] }], next_page_token }. The docs example shows
// price.amount instead of price.price, so both are accepted.
import { CHANNEL3_BASE } from '../config.ts';
import { cached, callJson, type Svc } from '../lib/http.ts';
import { asObject } from '../lib/json.ts';
import { clip, fnv, hostOf, httpsUrl, toCents } from '../lib/util.ts';
import type { Card } from '../types.ts';

const BAD_AVAILABILITY = /out.?of.?stock|sold.?out|unavailable|discontinued|backorder|preorder/i;
const BAD_CONDITION = /used|refurb|open.?box|damaged/i;

export function parseChannel3(json: unknown, ideaId: string, maxPriceCents: number, limit = 8): Card[] {
  const products = asObject(json)?.products;
  if (!Array.isArray(products)) return [];
  const cards: Card[] = [];
  const perShop = new Map<string, number>();
  for (const raw of products) {
    const p = asObject(raw);
    if (!p || typeof p.title !== 'string' || !p.title.trim()) continue;
    const offers = Array.isArray(p.offers) ? p.offers : [];
    let best: { cents: number; url: string; shop: string } | undefined;
    for (const o of offers) {
      const off = asObject(o);
      const price = asObject(off?.price);
      const cents = toCents(price?.price ?? price?.amount);
      const cur = String(price?.currency ?? price?.currency_code ?? 'USD').toUpperCase();
      const url = httpsUrl(off?.url);
      if (!off || !cents || !url || cur !== 'USD') continue;
      if (maxPriceCents > 0 && cents > maxPriceCents) continue;
      if (BAD_AVAILABILITY.test(String(off.availability ?? ''))) continue;
      if (BAD_CONDITION.test(String(off.condition ?? ''))) continue;
      const shop = (typeof off.domain === 'string' && off.domain ? off.domain : hostOf(url)).toLowerCase().replace(/^www\./, '');
      if (!best || cents < best.cents) best = { cents, url, shop };
    }
    if (!best) continue;
    if ((perShop.get(best.shop) ?? 0) >= 2) continue; // keep shops varied
    perShop.set(best.shop, (perShop.get(best.shop) ?? 0) + 1);
    const images = Array.isArray(p.images) ? p.images.map(asObject).filter(Boolean) : [];
    const main = images.find((i) => i!.is_main_image) ?? images[0];
    const id = 'p' + fnv(`${String(p.id ?? p.title)}|${best.shop}`).toString(16).padStart(8, '0');
    if (cards.some((c) => c.id === id)) continue;
    cards.push({
      id,
      ideaId,
      title: clip(p.title as string, 140),
      price_cents: best.cents,
      currency: 'USD',
      shop: best.shop,
      url: best.url,
      image: httpsUrl(main?.url),
      purchasable: true,
      source: 'channel3',
    });
    if (cards.length >= limit) break;
  }
  return cards;
}

export interface ProductSearch {
  query: string;
  ideaId: string;
  maxPriceCents: number;
  limit?: number;
}

/** One Channel3 call (cached 12 h: the free key allows 1,000 searches a month). Returns [] when the adapter is off. */
export async function searchProducts(svc: Svc, s: ProductSearch): Promise<{ cards: Card[]; hit: boolean }> {
  if (svc.cfg.channel3 !== 'live' || !svc.cfg.keys.channel3) return { cards: [], hit: false };
  const query = clip(s.query, 100);
  const limit = s.limit ?? 6;
  const { value, hit } = await cached(svc, 'channel3', { query: query.toLowerCase(), max: s.maxPriceCents, limit }, 12 * 3600, async () => {
    const body = { query, limit: limit + 4, filters: { price: { max_price: s.maxPriceCents / 100 } } };
    const r = await callJson(svc, 'channel3', `${CHANNEL3_BASE}/v1/search`, {
      method: 'POST',
      headers: { 'x-api-key': svc.cfg.keys.channel3!, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return parseChannel3(r.json, 'x', s.maxPriceCents, limit);
  });
  // cached cards are stored without an idea; stamp the caller's idea id
  return { cards: value.map((c) => ({ ...c, ideaId: s.ideaId })), hit };
}
