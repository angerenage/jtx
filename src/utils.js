/* eslint-env browser */

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const toStr = (v) => v == null ? '' : String(v);

export const parseJSON = (s) => {
  if (s == null || s === '') return null;
  return JSON.parse(s);
};

export const deepGet = (obj, path) => {
  if (!path) return obj;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
};

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
export const parseDuration = (s) => {
  if (!s) return 0;
  const m = String(s).trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!m) return 0;
  const unit = (m[2] || 'ms').toLowerCase();
  return parseInt(m[1], 10) * (UNIT_MS[unit] || 1);
};

export const http = (method, url, body, headers) => {
  const init = { method, headers: headers ? { ...headers } : {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json', ...init.headers };
  }
  return fetch(url, init);
};

export function structuredCloneSafe(v) {
  try {
    return structuredClone(v);
  } catch {
    try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
  }
}
