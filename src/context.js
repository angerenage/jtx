/* eslint-env browser */

import { registry, scheduleRender, fire, recordDependency } from './core.js';
import { http } from './utils.js';
import { refreshSource } from './source.js';

export const REF_RE = /@([a-zA-Z_][\w$]*)/g;
export const preprocessExpr = (expr) => String(expr).replace(REF_RE, 'ctx.$ref("$1")');

export function execute(code, ctx, extra = {}, asExpr = true) {
  const src = preprocessExpr(code);
  const extraNames = Object.keys(extra);
  const extraVals = Object.values(extra);
  const ctxProps = ctx ? Object.keys(ctx) : [];
  const dedupCtxProps = ctxProps.filter((n) => !extraNames.includes(n));
  const allNames = ['ctx', ...extraNames, ...dedupCtxProps];
  const ctxWithLocals = Object.assign({}, ctx, { $locals: extra });
  const allVals = [ctxWithLocals, ...extraVals, ...dedupCtxProps.map((n) => ctx[n])];

  if (asExpr) {
    const body = `return ( ${src} );`;
    const fn = new Function(...allNames, body);
    return fn(...allVals);
  }

  // compile as async function so handlers can use 'await'
  const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
  const fn = new AsyncFunction(...allNames, src);
  return fn(...allVals);
}

export const JTX_REF = Symbol('jtx-ref');

export function unwrapRef(v) {
  const meta = v && v[JTX_REF];
  if (meta && meta.type === 'src') return meta.target?.value;
  if (meta && meta.type === 'state') return meta.target?.value;
  return v;
}

export function makeStateRef(state) {
  function stateDefaultPrimitive() {
    const val = state.value;
    if (val == null) return '';
    if (typeof val !== 'object') return val;
    try {
      const order = ['title', 'text', 'name', 'value'];
      for (const k of order) {
        if (Object.prototype.hasOwnProperty.call(val, k)) return val[k];
      }
      const keys = Object.keys(val);
      if (keys.length === 1) return val[keys[0]];
    } catch { /* ignore */ }
    try { return JSON.stringify(val); } catch { return String(val); }
  }

  const resolveKey = (prop) => {
    if (typeof prop !== 'string') return prop;
    const map = state.keyMap;
    if (map && map.has(prop.toLowerCase())) return map.get(prop.toLowerCase());
    return prop;
  };

  return new Proxy({ [JTX_REF]: { type: 'state', name: state.name, target: state } }, {
    get(target, prop) {
      if (prop === JTX_REF) return target[JTX_REF];
      if (prop === Symbol.toPrimitive) return (hint) => {
        const prim = stateDefaultPrimitive();
        if (hint === 'number') return typeof prim === 'number' ? prim : Number(prim);
        if (hint === 'string') return prim == null ? '' : String(prim);
        return prim;
      };
      if (prop === 'toJSON') return () => state.value;
      if (prop === 'toString') return () => String(stateDefaultPrimitive());
      if (prop === 'valueOf') return () => stateDefaultPrimitive();
      if (typeof prop === 'string') {
        const key = resolveKey(prop);
        return state.value[key];
      }
      return state.value[prop];
    },
    set(target, prop, value) {
      if (typeof prop === 'string') {
        const map = state.keyMap;
        const lower = prop.toLowerCase();
        const key = (map && map.get(lower)) || prop;
        if (map) map.set(lower, key);
        state.value[key] = value;
        state.pendingKeys.add(key);
      }
      else {
        state.value[prop] = value;
        state.pendingKeys.add(String(prop));
      }
      registry.changed.add(state);
      scheduleRender();
      return true;
    },
    has(target, prop) {
      if (typeof prop === 'string') {
        const key = resolveKey(prop);
        return Object.prototype.hasOwnProperty.call(state.value, key);
      }
      return Object.prototype.hasOwnProperty.call(state.value, prop);
    },
    ownKeys() { return Reflect.ownKeys(state.value); },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === 'string') {
        const key = resolveKey(prop);
        return Object.getOwnPropertyDescriptor(state.value, key);
      }
      return Object.getOwnPropertyDescriptor(state.value, prop);
    },
  });
}

export function makeSrcRef(src) {
  const obj = {
    [JTX_REF]: { type: 'src', name: src.name, target: src },
    refresh: () => refreshSource(src.name),
    get $status() { return src.status; },
    get $error() { return src.error; },
  };
  return new Proxy(obj, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => {
        const val = src.value;
        if (val == null) return '';
        if (typeof val !== 'object') return val;
        try { return JSON.stringify(val); } catch { return String(val); }
      };
      if (prop in target) return target[prop];
      return src.value?.[prop];
    },
  });
}

function findNearestLocalState(el, name) {
  try {
    let cur = el instanceof Element ? el : null;
    while (cur) {
      if (cur.__jtxState && cur.__jtxState.name === name) return cur.__jtxState;
      cur = cur.parentElement;
    }
  } catch { /* ignore */ }
  return null;
}

export function buildCtx(currentEl, currentEvent) {
  return {
    $ref(name) {
      // First resolve per-evaluation locals (list item variables)
      if (this && this.$locals && Object.prototype.hasOwnProperty.call(this.$locals, name)) {
        return this.$locals[name];
      }
      // Then resolve nearest scoped state in the DOM tree
      if (currentEl) {
        const local = findNearestLocalState(currentEl, name);
        if (local) {
          recordDependency(local);
          return makeStateRef(local);
        }
      }
      if (registry.states.has(name)) {
        const st = registry.states.get(name);
        recordDependency(st);
        return makeStateRef(st);
      }
      if (registry.srcs.has(name)) {
        const src = registry.srcs.get(name);
        recordDependency(src);
        return makeSrcRef(src);
      }
      console.warn(`[JTX] Unknown reference @${name}`);
      return {};
    },
    emit(name, detail) {
      if (!currentEl) return;
      fire(currentEl, name, detail);
    },
    refresh(x) {
      // accept string name or a ref proxy
      if (typeof x === 'string') return refreshSource(x);
      const meta = x && x[JTX_REF];
      if (meta?.type === 'src') return refreshSource(meta.name);
      console.warn('[JTX] refresh() expects a source name or @source');
    },
    post: (url, body, headers) => http('POST', url, body, headers),
    get: (url, headers) => http('GET', url, undefined, headers),
    put: (url, body, headers) => http('PUT', url, body, headers),
    patch: (url, body, headers) => http('PATCH', url, body, headers),
    del: (url, headers) => http('DELETE', url, undefined, headers),
    $event: currentEvent,
    $el: currentEl,
  };
}

export function safeEval(expr, el, extraCtx = {}) {
  try {
    return execute(expr, buildCtx(el, null), extraCtx, true);
  } catch (e) {
    console.error('[JTX] eval error in', expr, e);
    return undefined;
  }
}
