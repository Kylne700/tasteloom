// The page a friend opens: "what do you love lately?" Everything stays in this page's memory.
// It makes no request, and the answer leaves only as a link that the person copies and sends back (#loves=…, see loves.js).
import { announce, h, icon } from './dom.js';
import { favouritesField } from './favs.js';
import { linkRow } from './linkrow.js';
import { decodeLoves, encodeLoves, MIN } from './loves.js';

const TOO_FEW = `Add at least ${MIN} things you love, so your friend has something to go on.`;

const result = h('section', { class: 'panel result', 'aria-labelledby': 'result-h', hidden: true });
const { field, favs, input, err, setError, addFromInput } = favouritesField({
  initial: [],
  label: 'Things you love',
  hint: 'An artist, a book, a brand, a place, a game. Press Enter to add each one, and pick a type when a name could mean several things.',
  tooFew: TOO_FEW,
  onChange: () => { result.hidden = true; }, // an old link must not stay on show once the list changes
});

function makeLink() {
  const token = encodeLoves(favs);
  const back = decodeLoves(token); // the link has to read back as what was typed, or it is not shown
  if (!back.ok || back.items.length !== favs.length) {
    setError('That could not be made into a link. Please check the names and try again.', true);
    return;
  }
  const url = `${location.origin}/#${token}`;
  result.replaceChildren(
    h('h2', { id: 'result-h', tabindex: '-1' }, 'Your reply link'),
    h('p', { class: 'result-lead' }, 'Send this link back to your friend. When they open it, your answer is there.'),
    linkRow({ url, label: 'Your reply link', text: 'Here is what I love lately:' }),
    h('p', { class: 'hint tight' }, 'Anyone who has this link can read your answer, so send it only to your friend.'),
  );
  result.hidden = false;
  result.querySelector('h2').focus();
  announce('Your reply link is ready.');
}

const form = h(
  'form',
  {
    class: 'panel form',
    novalidate: true,
    onsubmit: (e) => {
      e.preventDefault(); // never a page load: nothing may be sent anywhere
      if (input.value.trim()) addFromInput();
      if (err.textContent) return;
      if (favs.length < MIN) {
        setError(TOO_FEW, true);
        return;
      }
      makeLink();
    },
  },
  field,
  h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary big' }, 'Make my reply link', icon('arrow', 18))),
);

document.getElementById('view').append(
  h(
    'div',
    { class: 'screen ask-main' },
    h('h1', {}, 'What do you love lately?'),
    h('p', { class: 'lead' }, 'A friend wants to know what you love lately. Nothing is stored: your answer travels inside the link you send back.'),
    form,
    result,
  ),
);
