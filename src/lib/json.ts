// Tolerant JSON extraction for LLM output: think blocks, code fences, prose around the JSON, trailing commas, truncation.

export function stripThinking(text: string): string {
  let t = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  t = t.replace(/<think(?:ing)?>[\s\S]*$/i, ''); // unterminated block (output cut off while thinking)
  return t.replace(/^﻿/, '').trim();
}

function stripFences(t: string): string {
  const m = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (m) return m[1]!.trim();
  return t.replace(/^```(?:json)?/i, '').trim();
}

/** Scan from the first { or [ and return the balanced span, or the unbalanced tail plus the closers it needs and the safe places to cut it. */
function firstJsonSpan(t: string): { span: string; closers: string; cuts: { pos: number; closers: string }[] } | null {
  let start = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '{' || t[i] === '[') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const stack: string[] = [];
  const cuts: { pos: number; closers: string }[] = [];
  const closersNow = () => [...stack].reverse().join('');
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
      cuts.push({ pos: i + 1 - start, closers: closersNow() }); // right after an opening bracket
    } else if (c === ',') cuts.push({ pos: i - start, closers: closersNow() }); // right before a comma: everything left of it is complete
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return { span: t.slice(start, i + 1), closers: '', cuts: [] };
    }
  }
  // truncated: close an open string, then the open containers
  return { span: t.slice(start) + (inStr ? '"' : ''), closers: closersNow(), cuts };
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** True when the text is only JSON punctuation, strings, numbers and literals, ending at most in a partial literal. */
const looksCutOff = (tail: string) =>
  /^(?:[\s,:[\]{}\d.eE+-]|true|false|null|"")*(?:t(?:r(?:ue?)?)?|f(?:a(?:l(?:se?)?)?)?|n(?:u(?:ll?)?)?)?$/.test(tail.replace(/"(?:[^"\\]|\\.)*"?/g, '""'));

function fixCommon(s: string): string {
  return s.replace(/,\s*([}\]])/g, '$1');
}

export function parseLooseJson(text: unknown): unknown | undefined {
  if (typeof text !== 'string') return undefined;
  const t = stripFences(stripThinking(text));
  const direct = tryParse(t);
  if (direct !== undefined) return direct;
  const sp = firstJsonSpan(t);
  if (!sp) return undefined;
  for (const cand of [sp.span + sp.closers, fixCommon(sp.span + sp.closers)]) {
    const v = tryParse(cand);
    if (v !== undefined) return v;
  }
  // cut a dangling partial key or value: the latest comma or opening bracket whose left side closes into valid JSON,
  // provided that what is dropped looks like cut-off JSON and not prose or garbage
  for (const cut of sp.cuts.reverse()) {
    if (!looksCutOff(sp.span.slice(cut.pos))) continue;
    const v = tryParse(fixCommon(sp.span.slice(0, cut.pos) + cut.closers));
    if (v !== undefined) return v;
  }
  return undefined;
}

export function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function asString(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}
