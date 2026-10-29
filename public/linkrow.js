// A link to send on: a read-only box holding it, a Copy button and, where the browser has one, a Share button.
import { announce, copyText, h, icon } from './dom.js';

/** url: the link. label: what the box is called ("Your reply link"). text: the words that go with the link in the share sheet. */
export function linkRow({ url, label, text }) {
  const box = h('input', { type: 'text', class: 'link-box', readonly: true, value: url, 'aria-label': label, spellcheck: 'false', autocomplete: 'off', onfocus: (e) => e.target.select() });
  const word = h('span', {}, 'Copy');
  const copy = h('button', { type: 'button', class: 'btn small copy', 'aria-label': `Copy ${label.toLowerCase()}`, onclick: async () => {
    const ok = await copyText(url);
    word.textContent = ok ? 'Copied' : 'Ctrl+C'; // as short as "Copied", so the row keeps its size
    announce(ok ? `${label} copied` : 'Could not copy. Select the link and press Ctrl+C.');
    if (!ok) box.select();
    setTimeout(() => (word.textContent = 'Copy'), 1800);
  } }, icon('copy', 14), word);
  // the share sheet exists on phones and some desktops; closing it without sharing rejects, and that is not an error
  const share = typeof navigator.share === 'function'
    ? h('button', { type: 'button', class: 'btn small', onclick: async () => {
      try {
        await navigator.share({ text, url });
      } catch {
        // closed without sharing, or refused
      }
    } }, 'Share')
    : null;
  return h('div', { class: 'linkrow' }, box, copy, share);
}
