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

/** Scan from the first { or [ and return the balanced span, or the unbalanced tail plus the closers it needs. */
function firstJsonSpan(t: string): { span: string; closers: string } | null {
  let start = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '{' || t[i] === '[') {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const stack: string[] = [];
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
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return { span: t.slice(start, i + 1), closers: '' };
    }
  }
  // truncated: close an open string, then the open containers
  return { span: t.slice(start) + (inStr ? '"' : ''), closers: stack.reverse().join('') };
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

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
  if (sp.closers) {
    // cut a dangling partial token ("key": , a lone key, a half number) and close again
    const trimmed = sp.span.replace(/,?\s*"[^"]*"?\s*:?\s*[^,{}\[\]]*$/, '');
    const v = tryParse(fixCommon(trimmed + sp.closers));
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
