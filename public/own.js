// The words of /ask when someone makes their own taste link (/ask?for=me), to send to whoever buys them gifts.
// ask.js loads this file only in that mode, so a friend's page never carries these words. Same reply format (#loves=), same caps, nothing stored.
import { MIN } from './loves.js';

export const OWN = {
  title: 'Tasteloom: your taste link',
  h1: 'Make your own taste link',
  lead: 'Name three to five things you love. Nothing is stored: your answer travels inside the link you make.',
  tooFew: `Add at least ${MIN} things you love, so your link has something to go on.`,
  button: 'Make my taste link',
  resultH: 'Your taste link',
  resultLead: 'Send this to whoever buys you gifts. They see what you love, not what you will get.',
  hint: 'Anyone who has this link can read your answer, so send it only to people you trust.',
  ready: 'Your taste link is ready.',
};
