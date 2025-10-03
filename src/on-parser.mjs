/* eslint-env browser */

const SINGLE_QUOTE = '\'';
const DOUBLE_QUOTE = '"';
const BACKTICK = '`';
const BACKSLASH = '\\';

function splitTopLevel(expr, delimiter) {
  const out = [];
  if (!expr) return out;
  let start = 0;
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (escape) {
        escape = false;
      }
      else if (ch === BACKSLASH) {
        escape = true;
      }
      else if (ch === quote) {
        quote = null;
      }
      else if (quote === BACKTICK && ch === '$' && expr[i + 1] === '{') {
        depth++;
        i += 1;
      }
      continue;
    }

    if (ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === BACKTICK) {
      quote = ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) depth--;
      continue;
    }

    if (ch === delimiter && depth === 0) {
      const part = expr.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  const tail = expr.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function findTopLevelColon(segment) {
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (escape) {
        escape = false;
      }
      else if (ch === BACKSLASH) {
        escape = true;
      }
      else if (ch === quote) {
        quote = null;
      }
      else if (quote === BACKTICK && ch === '$' && segment[i + 1] === '{') {
        depth++;
        i += 1;
      }
      continue;
    }

    if (ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === BACKTICK) {
      quote = ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) depth--;
      continue;
    }

    if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

export function parseOnAttribute(expr) {
  if (!expr || !expr.trim()) return [];
  const segments = splitTopLevel(String(expr), ';');
  const out = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const idx = findTopLevelColon(trimmed);
    if (idx === -1) {
      if (!out.length) continue;
      const last = out[out.length - 1];
      const suffix = trimmed;
      if (!suffix) continue;
      last.code = last.code ? `${last.code}; ${suffix}` : suffix;
      continue;
    }

    const event = trimmed.slice(0, idx).trim();
    const code = trimmed.slice(idx + 1).trim();
    if (!event) continue;
    if (!code) {
      out.push({ event, code: '' });
      continue;
    }
    out.push({ event, code });
  }
  return out.filter((entry) => entry.code && entry.code.trim());
}
