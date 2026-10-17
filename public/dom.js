// Tiny DOM helpers. Everything the server sends is inserted as text or as an https URL, never as HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('div', { class: 'x', onclick: fn, 'aria-label': 'y' }, 'text', childNode, [more]) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

/** Like el.replaceChildren(...), but null, undefined and false are skipped; the native method would print them as the text "null". */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}

const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  back: 'M15 5l-7 7 7 7',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  alert: 'M12 4l9 16H3zM12 10v4M12 17.5v.01',
  info: 'M12 11v6M12 7.5v.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5v.01',
  dash: 'M6 12h12',
  arrow: 'M5 12h14M13 6l6 6-6 6',
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.dash);
  svg.append(p);
  return svg;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (cents) => usd.format(cents / 100);

/** Only absolute https links are ever put into href. */
/** Attributes for a shop image: the source is set only while the images switch is on, since the shop's server sees the visitor's IP. */
export const shopImage = (url) => (document.documentElement.dataset.images === 'on' ? { src: url } : { 'data-src': url });

export function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x.href : '';
  } catch {
    return '';
  }
}

/** Screen-reader announcement through the polite live region in index.html. */
export function announce(msg) {
  const el = document.getElementById('live');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => (el.textContent = msg), 30); // a changed node is announced; an identical string is not
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', class: 'sr-only' });
    t.value = text;
    document.body.append(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    t.remove();
    return ok;
  }
}

export const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });
