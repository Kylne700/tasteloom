/** Structure of a JSON value without its content: keys, array lengths and primitive types, to the given depth. */
export function shape(v, depth = 3) {
  if (Array.isArray(v)) return `[${v.length}${v.length && depth > 0 ? ' x ' + shape(v[0], depth - 1) : ''}]`;
  if (v && typeof v === 'object') return depth > 0 ? `{${Object.entries(v).slice(0, 14).map(([k, x]) => `${k}:${shape(x, depth - 1)}`).join(',')}}` : '{...}';
  return v === null ? 'null' : typeof v;
}

/** fetch that notes "METHOD path -> status shape" per call (path only: no query string, no headers, no body content). */
export function recordingFetch(seen, depth = 3, realFetch = fetch) {
  return async (url, init) => {
    const res = await realFetch(url, init);
    let body = '(not JSON)';
    try { body = shape(JSON.parse(await res.clone().text()), depth); } catch { /* shape stays "not JSON" */ }
    seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname} -> ${res.status} ${body.slice(0, 200)}`);
    return res;
  };
}
