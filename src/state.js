/* eslint-env browser */

import { registry, fire, parseUrlParams, registerCleanup } from './core.js';
import { execute, buildCtx } from './context.js';
import { structuredCloneSafe } from './utils.js';

function ensureStateKey(st, raw) {
  if (typeof raw !== 'string') return raw;
  const lower = raw.toLowerCase();
  if (!st.keyMap.has(lower)) st.keyMap.set(lower, raw);
  return st.keyMap.get(lower);
}

export function initState(el, locals, options) {
  const name = el.getAttribute('name');
  if (!name) return;

  const opts = options || {};
  const register = opts.register !== false; // default true
  const restore = opts.restore;

  if (register && registry.states.has(name)) {
    console.warn(`[JTX] Duplicate state name: ${name}`);
    return;
  }

  const st = {
    name,
    el,
    value: {},
    persistedKeys: new Set(),
    urlKeys: new Set(),
    pendingKeys: new Set(),
    keyMap: new Map(),
  };

  for (const { name: attrName, value } of Array.from(el.attributes)) {
    if (attrName === 'name' || attrName === 'persist' || attrName === 'persist-url' || attrName.startsWith('jtx-')) continue;
    const key = ensureStateKey(st, attrName);
    try {
      const v = execute(value, buildCtx(el, null), locals || {}, true);
      st.value[key] = v;
    } catch (e) {
      // Ensure the key exists even if evaluation fails
      if (!Object.prototype.hasOwnProperty.call(st.value, key)) st.value[key] = undefined;
      fire(el, 'error', { name, error: e });
    }
  }

  const persistAttr = el.getAttribute('persist');
  if (persistAttr) {
    for (const key of persistAttr.split(',').map((s) => s.trim()).filter(Boolean)) {
      const mapped = ensureStateKey(st, key);
      st.persistedKeys.add(mapped);
      try {
        const raw = localStorage.getItem(`jtx:${name}:${mapped}`);
        if (raw != null) st.value[mapped] = JSON.parse(raw);
      } catch (e) {
        fire(el, 'error', { name, error: e });
      }
    }
  }

  const urlAttr = el.getAttribute('persist-url');
  const urlParams = parseUrlParams();
  if (urlAttr) {
    for (const key of urlAttr.split(',').map((s) => s.trim()).filter(Boolean)) {
      const mapped = ensureStateKey(st, key);
      st.urlKeys.add(mapped);
      if (key in urlParams) st.value[mapped] = urlParams[key];
    }
  }

  if (restore && typeof restore === 'object') {
    try {
      const restored = structuredCloneSafe(restore);
      if (restored && typeof restored === 'object') {
        for (const [key, val] of Object.entries(restored)) {
          const mapped = ensureStateKey(st, key);
          st.value[mapped] = val;
        }
      }
    } catch (e) {
      fire(el, 'error', { name, error: e });
    }
  }

  // Expose on element for scoped lookup
  try { Object.defineProperty(el, '__jtxState', { value: st, configurable: true }); } catch { /* ignore */ }

  if (register) registry.states.set(name, st);
  else registry.scopedStates.add(st);

  try {
    registerCleanup(el, () => {
      if (register) {
        const current = registry.states.get(name);
        if (current === st) registry.states.delete(name);
      }
      else {
        registry.scopedStates.delete(st);
      }
    });
  } catch { /* ignore */ }

  fire(el, 'init', { name, value: structuredCloneSafe(st.value) });
}
