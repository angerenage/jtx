/* eslint-env browser */

import { registry, fire, parseUrlParams } from './core.js';
import { execute, buildCtx } from './context.js';
import { structuredCloneSafe } from './utils.js';

export function initState(el, locals, options) {
  const name = el.getAttribute('name');
  if (!name) return;

  const opts = options || {};
  const register = opts.register !== false; // default true

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
  };

  for (const { name: attrName, value } of Array.from(el.attributes)) {
    if (attrName === 'name' || attrName === 'persist' || attrName === 'persist-url') continue;
    try {
      const v = execute(value, buildCtx(el, null), locals || {}, true);
      st.value[attrName] = v;
    } catch (e) {
      // Ensure the key exists even if evaluation fails
      if (!(attrName in st.value)) st.value[attrName] = undefined;
      fire(el, 'error', { name, error: e });
    }
  }

  const persistAttr = el.getAttribute('persist');
  if (persistAttr) {
    for (const key of persistAttr.split(',').map((s) => s.trim()).filter(Boolean)) {
      st.persistedKeys.add(key);
      try {
        const raw = localStorage.getItem(`jtx:${name}:${key}`);
        if (raw != null) st.value[key] = JSON.parse(raw);
      } catch (e) {
        fire(el, 'error', { name, error: e });
      }
    }
  }

  const urlAttr = el.getAttribute('persist-url');
  const urlParams = parseUrlParams();
  if (urlAttr) {
    for (const key of urlAttr.split(',').map((s) => s.trim()).filter(Boolean)) {
      st.urlKeys.add(key);
      if (key in urlParams) st.value[key] = urlParams[key];
    }
  }

  // Expose on element for scoped lookup
  try { Object.defineProperty(el, '__jtxState', { value: st, configurable: true }); } catch { /* ignore */ }

  if (register) {
    registry.states.set(name, st);
  }
  fire(el, 'init', { name, value: structuredCloneSafe(st.value) });
}
