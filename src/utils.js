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

// Parse bracket/dot notation: a.b[0].c or a["x"].b['y']
export function parsePath(path) {
  const s = String(path);
  const out = [];
  let i = 0;

  function isIdentChar(ch) { return /[A-Za-z0-9_$]/.test(ch); }

  function readIdent() {
    let start = i;
    while (i < s.length && isIdentChar(s[i])) i++;
    if (i > start) out.push(s.slice(start, i));
  }

  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') {
      i++;
      readIdent();
      continue;
    }
    if (ch === '[') {
      i++;
      // skip whitespace
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;
      const q = s[i];
      if (q === '"' || q === '\'') {
        i++;
        let buf = '';
        while (i < s.length) {
          const c = s[i++];
          if (c === '\\' && i < s.length) {
            buf += s[i++];
            continue;
          }
          if (c === q) break;
          buf += c;
        }
        out.push(buf);
        while (i < s.length && s[i] !== ']') i++;
        if (s[i] === ']') i++;
      }
      else {
        // unquoted: number or identifier
        let buf = '';
        while (i < s.length && s[i] !== ']') buf += s[i++];
        if (s[i] === ']') i++;
        out.push(String(buf).trim());
      }
      continue;
    }
    // start or after unexpected char: read identifier
    readIdent();
    // if not at start of ident and not a dot/bracket next, skip char to avoid infinite loop
    if (i < s.length && s[i] !== '.' && s[i] !== '[') i++;
  }
  return out.filter((p) => p !== '');
}

export function deepGetByPath(obj, segments) {
  if (!Array.isArray(segments) || segments.length === 0) return obj;
  let cur = obj;
  for (const seg of segments) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function deepSetByPath(obj, segments, value) {
  if (!Array.isArray(segments) || segments.length === 0) return obj;
  let cur = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[segments[segments.length - 1]] = value;
  return obj;
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
export const parseDuration = (s) => {
  if (!s) return 0;
  const m = String(s).trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!m) return 0;
  const unit = (m[2] || 'ms');
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
