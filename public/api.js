// Fetch helpers. Errors always carry a human message; raw server or upstream text is never shown.
export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function toApiError(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const e = body && body.error;
  return new ApiError((e && e.code) || 'http', (e && e.message) || 'Something went wrong. Please try again.', res.status);
}

const NETWORK = 'We could not reach the server. Check your connection and try again.';

export async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('network', NETWORK);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

export async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError('network', NETWORK);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/** POST, then call onEvent for every JSON line of the NDJSON response as it arrives. */
export async function streamNdjson(url, body, onEvent, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError('network', NETWORK);
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError('network', NETWORK);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (line) => {
    line = line.trim();
    if (!line) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // a damaged line is skipped, the stream goes on
    }
    onEvent(ev);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        flush(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError('network', 'The connection dropped while we were working. Try again, or try the example.');
  }
  flush(buf);
}
