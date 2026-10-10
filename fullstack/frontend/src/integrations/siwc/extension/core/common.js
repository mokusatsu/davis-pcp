// SPDX-License-Identifier: GPL-3.0-or-later
export class BridgeError extends Error {
  constructor(code, message = code) { super(message); this.name = 'BridgeError'; this.code = code; }
}
export function assert(ok, code, message) { if (!ok) throw new BridgeError(code, message); }
export const textEncoder = new TextEncoder();
export function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function randomId(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
export function base64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unbase64url(s) {
  assert(typeof s === 'string' && s.length <= 131072 && /^[A-Za-z0-9_-]+$/.test(s), 'INVALID_BASE64');
  try { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0)); }
  catch { throw new BridgeError('INVALID_BASE64'); }
}
export function canonical(value) {
  // No getters or cycles should enter here: only parsed/structured-cloned JSON data.
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function digest(value) {
  const data = typeof value === 'string' ? value : canonical(value);
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(data))));
}
export function boundedJSON(value, maxBytes = 1024 * 1024) {
  let json;
  try { json = JSON.stringify(value); } catch { throw new BridgeError('INVALID_JSON'); }
  assert(typeof json === 'string' && textEncoder.encode(json).length <= maxBytes, 'PAYLOAD_TOO_LARGE');
  const parsed = JSON.parse(json);
  let nodes = 0;
  function visit(v, depth) {
    assert(++nodes <= 50000 && depth <= 32, 'JSON_TOO_COMPLEX');
    if (isObject(v)) {
      for (const k of Object.keys(v)) {
        assert(!['__proto__', 'constructor', 'prototype'].includes(k), 'UNSAFE_KEY');
        visit(v[k], depth + 1);
      }
    } else if (Array.isArray(v)) for (const item of v) visit(item, depth + 1);
    else assert(v === null || ['string', 'number', 'boolean'].includes(typeof v), 'INVALID_JSON');
  }
  visit(parsed, 0); return parsed;
}
export function publicError(e) {
  // Never surface arbitrary server bodies, URLs, token strings, or stack traces.
  const code = e instanceof BridgeError ? e.code : (e?.name === 'AbortError' ? 'CANCELLED' : 'OPERATION_FAILED');
  return { code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'OPERATION_FAILED' };
}
export function abortError() { return new BridgeError('CANCELLED'); }
export function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
export function safeTarget(raw, incognito = false) {
  try {
    const u = new URL(raw);
    return !incognito && u.protocol === 'https:' && !u.username && !u.password &&
      !['auth.openai.com','api.openai.com','chatgpt.com'].includes(u.hostname);
  } catch { return false; }
}
export function linkedSignal(signals = [], timeoutMs = 120000) {
  const c = new AbortController(); const cleanups = [];
  const abort = () => c.abort();
  for (const s of signals.filter(Boolean)) {
    if (s.aborted) c.abort();
    else { s.addEventListener('abort', abort, { once: true }); cleanups.push(() => s.removeEventListener('abort', abort)); }
  }
  const timer = setTimeout(abort, Math.max(1, timeoutMs));
  return { signal: c.signal, dispose() { clearTimeout(timer); cleanups.forEach(fn => fn()); } };
}
