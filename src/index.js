/* eslint-env browser */

// Utilities
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toStr = (v) => v == null ? '' : ('' + v);
const parseJSON = (s) => {
  if (s == null || s === '') return null;
  return JSON.parse(s);
};
const deepGet = (obj, path) => {
  if (!path) return obj;
  const parts = ('' + path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
};
function unwrapRef(v) {
  const meta = v && v[JTX_REF];
  if (meta && meta.type === 'src') return meta.target?.value;
  if (meta && meta.type === 'state') return meta.target?.value;
  return v;
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const parseDuration = (s) => {
  if (!s) return 0;
  const m = ('' + s).trim().match(/^(\d+)(ms|s|m|h)?$/i);
  if (!m) return 0;
  const unit = (m[2] || 'ms').toLowerCase();
  return parseInt(m[1], 10) * (UNIT_MS[unit] || 1);
};

const http = (method, url, body, headers) => {
  const init = { method, headers: headers ? { ...headers } : {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json', ...init.headers };
  }
  return fetch(url, init);
};

// Global registry
const registry = {
  states: new Map(), // name -> { name, el, value, persistedKeys:Set, urlKeys:Set, listeners:Set, pendingKeys:Set }
  srcs: new Map(),   // name -> { name, el, value, url, status, error, controller, kind, timers:[], io:null }
  bindings: new Set(), // set of binding objects with update()
};

// Event helpers
const fire = (el, type, detail) => {
  try { el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true })); } catch { /* ignore */ }
};

// Expression preprocessing: replace @name with ctx.$ref("name")
const REF_RE = /@([a-zA-Z_][\w$]*)/g;
const preprocessExpr = (expr) => ('' + expr).replace(REF_RE, 'ctx.$ref("$1")');

// Evaluation in restricted context
function execute(code, ctx, extra = {}, asExpr = true) {
  const src = preprocessExpr(code);
  const names = Object.keys(extra);
  const vals = Object.values(extra);
  const body = asExpr ? `return ( ${src} );` : src;
  const fn = new Function('ctx', ...names, body);
  const ctxWithLocals = Object.assign({}, ctx, { $locals: extra });
  return fn(ctxWithLocals, ...vals);
}

// Build @name reference proxies
const JTX_REF = Symbol('jtx-ref');
function makeStateRef(state) {
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
    try { return JSON.stringify(val); } catch { return ('' + val); }
  }

  return new Proxy({ [JTX_REF]: { type: 'state', name: state.name, target: state } }, {
    get(target, prop) {
      if (prop === JTX_REF) return target[JTX_REF];
      if (prop === Symbol.toPrimitive) return (hint) => {
        const prim = stateDefaultPrimitive();
        if (hint === 'number') return typeof prim === 'number' ? prim : Number(prim);
        if (hint === 'string') return prim == null ? '' : ('' + prim);
        return prim;
      };
      if (prop === 'toJSON') return () => state.value;
      if (prop === 'toString') return () => ('' + stateDefaultPrimitive());
      if (prop === 'valueOf') return () => stateDefaultPrimitive();
      if (typeof prop === 'string') {
        if (prop in state.value) return state.value[prop];
        const lc = prop.toLowerCase();
        if (lc in state.value) return state.value[lc];
      }
      return state.value[prop];
    },
    set(target, prop, value) {
      // track pending change
      if (typeof prop === 'string') {
        if (prop in state.value) state.value[prop] = value;
        else {
          const lc = prop.toLowerCase();
          if (lc in state.value) state.value[lc] = value; else state.value[prop] = value;
        }
        state.pendingKeys.add(toStr(prop));
      }
      else {
        state.value[prop] = value;
        state.pendingKeys.add(toStr(prop));
      }
      scheduleRender();
      return true;
    },
    has(target, prop) {
      if (typeof prop === 'string') {
        return (prop in state.value) || (prop.toLowerCase() in state.value);
      }
      return prop in state.value;
    },
    ownKeys() { return Reflect.ownKeys(state.value); },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === 'string') {
        if (Object.prototype.hasOwnProperty.call(state.value, prop)) return Object.getOwnPropertyDescriptor(state.value, prop);
        const lc = prop.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(state.value, lc)) return Object.getOwnPropertyDescriptor(state.value, lc);
      }
      return Object.getOwnPropertyDescriptor(state.value, prop);
    },
  });
}
function makeSrcRef(src) {
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
        try { return JSON.stringify(val); } catch { return ('' + val); }
      };
      if (prop in target) return target[prop];
      return src.value?.[prop];
    },
  });
}

// Build the evaluation context object passed as ctx
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

function buildCtx(currentEl, currentEvent) {
  return {
    $ref(name) {
      // First resolve per-evaluation locals (list item variables)
      if (this && this.$locals && Object.prototype.hasOwnProperty.call(this.$locals, name)) {
        return this.$locals[name];
      }
      // Then resolve nearest scoped state in the DOM tree
      if (currentEl) {
        const local = findNearestLocalState(currentEl, name);
        if (local) return makeStateRef(local);
      }
      if (registry.states.has(name)) return makeStateRef(registry.states.get(name));
      if (registry.srcs.has(name)) return makeSrcRef(registry.srcs.get(name));
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

// Rendering scheduler
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    flushStateUpdates();
    runAllBindings();
  });
}

function flushStateUpdates() {
  // Persist + URL sync + events
  for (const st of registry.states.values()) {
    if (st.pendingKeys.size === 0) continue;
    // persist to localStorage
    for (const key of st.pendingKeys) {
      if (st.persistedKeys.has(key)) {
        try {
          localStorage.setItem(`jtx:${st.name}:${key}`, JSON.stringify(st.value[key]));
        } catch { /* ignore */ }
      }
    }
    // URL sync
    if (st.urlKeys.size) syncUrlFromState(st);
    fire(st.el, 'update', { name: st.name, keys: Array.from(st.pendingKeys), value: st.value });
    st.pendingKeys.clear();
  }
}

function runAllBindings() {
  for (const b of registry.bindings) {
    try { b.update(); } catch (e) { console.error('[JTX] binding error', e, b); }
  }
}

// URL sync helpers
function parseUrlParams() {
  const out = Object.create(null);
  const sp = new URLSearchParams(location.search);
  for (const [k, v] of sp.entries()) {
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return out;
}
function syncUrlFromState(st) {
  const sp = new URLSearchParams(location.search);
  for (const key of st.urlKeys) {
    try {
      const val = st.value[key];
      if (val === undefined || val === null) sp.delete(key);
      else sp.set(key, JSON.stringify(val));
    } catch { /* ignore */ }
  }
  const newUrl = `${location.pathname}?${sp.toString()}${location.hash}`;
  try { history.replaceState(null, '', newUrl); } catch { /* ignore */ }
}

// Definitions: jtx-state
function initState(el, locals, options) {
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
  // defaults from attributes (excluding known)
  for (const { name: attrName, value } of Array.from(el.attributes)) {
    if (attrName === 'name' || attrName === 'persist' || attrName === 'persist-url') continue;
    const v = safeEval(value, el, locals || {});
    st.value[attrName] = v;
  }
  // localStorage persistence
  const persistAttr = el.getAttribute('persist');
  if (persistAttr) {
    for (const key of persistAttr.split(',').map((s) => s.trim()).filter(Boolean)) {
      st.persistedKeys.add(key);
      try {
        const raw = localStorage.getItem(`jtx:${name}:${key}`);
        if (raw != null) st.value[key] = JSON.parse(raw);
      } catch { /* ignore */ }
    }
  }
  // URL persistence
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

function structuredCloneSafe(v) {
  try { return structuredClone(v); } catch { try { return JSON.parse(JSON.stringify(v)); } catch { return v; } }
}

// Definitions: jtx-src
function initSrc(el) {
  const name = el.getAttribute('name');
  const url = el.getAttribute('url');
  if (!name || !url) return;

  if (registry.srcs.has(name)) {
    console.warn(`[JTX] Duplicate src name: ${name}`);
    return;
  }

  function updateStatus(status) {
    src.status = status;
    for (const [key, node] of Object.entries(src.specialNodes)) {
      if (node) {
        if (src.status === key) {
          node.removeAttribute('hidden');
        }
        else {
          node.setAttribute('hidden', '');
        }
      }
    }
  }

  const src = {
    name,
    el,
    url,
    headers: {},
    select: el.getAttribute('select') || '',
    sseEvent: el.getAttribute('sse-event') || '',
    fetchModes: parseFetchModes(el.getAttribute('fetch')),
    timers: [],
    controller: null,
    kind: url.startsWith('sse:') ? 'sse' : (url.startsWith('ws:') || url.startsWith('wss:')) ? 'ws' : 'http',
    io: null, // EventSource or WebSocket
    value: undefined,
    updateStatus: updateStatus,
    status: 'idle',
    specialNodes: { loading: null, error: null, empty: null },
    error: null,
  };

  for (const child of el.children) {
    const tag = child.tagName?.toLowerCase();
    if (tag === 'jtx-loading') {
      src.specialNodes.loading = child;
      child.setAttribute('hidden', '');
    }
    else if (tag === 'jtx-error') {
      src.specialNodes.error = child;
      child.setAttribute('hidden', '');
    }
    else if (tag === 'jtx-empty') {
      src.specialNodes.empty = child;
      child.setAttribute('hidden', '');
    }
  }

  const headersAttr = el.getAttribute('headers');
  if (headersAttr) {
    // Try expression evaluation first (allows @state references), fallback to JSON
    try {
      const evaluated = safeEval(headersAttr, el);
      if (evaluated && typeof evaluated === 'object') src.headers = evaluated;
      else if (evaluated == null) src.headers = {};
      else throw new Error('headers must evaluate to an object');
    } catch {
      try { src.headers = JSON.parse(headersAttr); }
      catch { console.warn('[JTX] Invalid headers JSON for', name); }
    }
  }

  registry.srcs.set(name, src);
  fire(el, 'init', { name });

  // Set up automatic fetch/subscribe
  setupFetchModes(src);
}

function parseFetchModes(attr) {
  const out = new Set();
  if (!attr || !attr.trim()) {
    out.add('onload');
    return out;
  }
  for (const part of attr.split(',').map((s) => s.trim()).filter(Boolean)) {
    out.add(part);
  }
  return out;
}

function setupFetchModes(src) {
  const modes = src.fetchModes;
  if (modes.has('onload') && src.kind === 'http') {
    // fetch after current tick to allow handlers to attach
    setTimeout(() => refreshSource(src.name), 0);
  }

  if (modes.has('idle') && src.kind === 'http') {
    const cb = () => refreshSource(src.name);
    if ('requestIdleCallback' in window) window.requestIdleCallback(cb);
    else setTimeout(cb, 50);
  }

  if (modes.has('visible') && src.kind === 'http') {
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries, obs) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect();
          refreshSource(src.name);
        }
      });
      io.observe(src.el);
    }
    else {
      // fallback to onload
      setTimeout(() => refreshSource(src.name), 0);
    }
  }

  for (const m of modes) {
    if (m.startsWith('every ')) {
      const ms = parseDuration(m.slice('every '.length));
      if (ms > 0) {
        const id = setInterval(() => refreshSource(src.name), ms);
        src.timers.push(id);
      }
    }
  }

  // For streams, open immediately unless manual
  if ((src.kind === 'sse' || src.kind === 'ws') && !modes.has('manual')) {
    openStream(src);
  }
}

async function refreshSource(name) {
  const src = registry.srcs.get(name);
  if (!src) return;
  if (src.kind === 'http') return fetchHttpSource(src);
  if (src.kind === 'sse' || src.kind === 'ws') return reopenStream(src);
}

async function fetchHttpSource(src) {
  const url = src.url.startsWith('sse:') ? src.url.slice(4) : src.url;
  src.updateStatus('loading');
  fire(src.el, 'fetch', { url, headers: src.headers });
  scheduleRender();
  try {
    const res = await fetch(url, { headers: src.headers });
    if (!res.ok) {
      const message = `HTTP ${res.status}`;
      src.error = { name: src.name, type: 'network', status: res.status, message };
      src.updateStatus('error');
      fire(src.el, 'error', src.error);
      scheduleRender();
      return;
    }
    const text = await res.text();
    let value = text === '' && res.status === 204 ? null : parseJSON(text);
    if (src.select) value = deepGet(value, src.select);
    src.value = value;
    src.updateStatus('ready');
    src.error = null;
    fire(src.el, 'update', { name: src.name, value });
    scheduleRender();
  } catch (e) {
    src.error = { name: src.name, type: 'network', message: e.message, raw: e };
    src.updateStatus('error');
    fire(src.el, 'error', src.error);
    scheduleRender();
  }
}

function reopenStream(src) {
  closeStream(src);
  openStream(src);
}

function closeStream(src) {
  if (!src.io) return;
  try { src.io.close(); } catch { /* ignore */ }
  src.io = null;
}

function normalizeSseUrl(u) {
  // Accept forms: sse:/path, sse://host/path, sse:http://host/path, http(s)://...
  let url = u.startsWith('sse:') ? u.slice(4) : u;
  return url;
}
function normalizeWsUrl(u) {
  // Accept forms: ws:/path, ws://host/path, ws:http://host/path, ws:https://host/path, ws(s)://...
  let rest = u.startsWith('ws:') ? u.slice(3) : (u.startsWith('wss:') ? u.slice(4) : u);
  rest = rest.trim();
  if (rest.startsWith('ws://') || rest.startsWith('wss://')) return rest;
  if (rest.startsWith('http://')) return 'ws://' + rest.slice('http://'.length);
  if (rest.startsWith('https://')) return 'wss://' + rest.slice('https://'.length);
  if (rest.startsWith('//')) return (location.protocol === 'https:' ? 'wss:' : 'ws:') + rest;
  if (rest.startsWith('/')) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + rest;
  // relative path
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/' + rest.replace(/^\.\//, '');
}

function openStream(src) {
  const rawUrl = src.kind === 'sse' ? normalizeSseUrl(src.url) : normalizeWsUrl(src.url);
  if (src.kind === 'sse') {
    try {
      const es = new EventSource(rawUrl);
      src.io = es;
      src.updateStatus('ready');
      fire(src.el, 'open', { name: src.name, type: 'sse' });
      es.addEventListener('message', (ev) => {
        if (src.sseEvent) return; // filtered elsewhere
        handleStreamMessage(src, ev.data, 'sse', ev.lastEventId);
      });
      if (src.sseEvent) {
        es.addEventListener(src.sseEvent, (ev) => {
          handleStreamMessage(src, ev.data, src.sseEvent, ev.lastEventId);
        });
      }
      es.addEventListener('error', (ev) => {
        src.error = { name: src.name, type: 'connection', message: 'SSE error', raw: ev };
        fire(src.el, 'error', src.error);
      });
    } catch (e) {
      src.error = { name: src.name, type: 'connection', message: e.message, raw: e };
      fire(src.el, 'error', src.error);
    }
  }
  else if (src.kind === 'ws') {
    try {
      const ws = new WebSocket(rawUrl);
      src.io = ws;
      ws.addEventListener('open', () => {
        src.updateStatus('ready');
        fire(src.el, 'open', { name: src.name, type: 'ws' });
      });
      ws.addEventListener('message', (ev) => {
        handleStreamMessage(src, ev.data, 'ws');
      });
      ws.addEventListener('error', (ev) => {
        src.error = { name: src.name, type: 'connection', message: 'WS error', raw: ev };
        fire(src.el, 'error', src.error);
      });
      ws.addEventListener('close', (ev) => {
        fire(src.el, 'close', { name: src.name, code: ev.code, reason: ev.reason });
      });
    } catch (e) {
      src.error = { name: src.name, type: 'connection', message: e.message, raw: e };
      fire(src.el, 'error', src.error);
    }
  }
}

function handleStreamMessage(src, data, type, lastEventId) {
  fire(src.el, 'message', { name: src.name, type, data, lastEventId });
  try {
    const value = data === '' ? null : JSON.parse(data);
    src.value = src.select ? deepGet(value, src.select) : value;
    fire(src.el, 'update', { name: src.name, value: src.value });
    scheduleRender();
  } catch (e) {
    src.error = { name: src.name, type: 'format', message: 'Invalid JSON', raw: e };
    fire(src.el, 'error', src.error);
  }
}

// Bindings
function addBinding(binding) {
  registry.bindings.add(binding);
  // Initial run
  try { binding.update(); } catch (e) { console.error('[JTX] binding error', e, binding); }
}

function safeEval(expr, el, extraCtx = {}) {
  try {
    return execute(expr, buildCtx(el, null), extraCtx, true);
  } catch (e) {
    console.error('[JTX] eval error in', expr, e);
    return undefined;
  }
}

// jtx-if: remove/insert element
function bindIf(el, expr, locals) {
  const placeholder = document.createComment('jtx-if');
  let removed = false;
  function update() {
    const ok = !!safeEval(expr, el, locals);
    if (ok && removed) {
      placeholder.replaceWith(el);
      removed = false;
    }
    else if (!ok && !removed) {
      el.replaceWith(placeholder);
      removed = true;
    }
  }
  addBinding({ el, type: 'if', update });
}

// jtx-show: toggle hidden
function bindShow(el, expr, locals) {
  function update() {
    const ok = !!safeEval(expr, el, locals);
    if (ok) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }
  addBinding({ el, type: 'show', update });
}

// jtx-text
function bindText(el, expr, locals) {
  const fallback = el.textContent;
  function update() {
    const v = safeEval(expr, el, locals);
    if (v === undefined || v === null) el.textContent = fallback;
    else el.textContent = toStr(v);
  }
  addBinding({ el, type: 'text', update });
}

// jtx-html
function bindHtml(el, expr, locals) {
  const fallback = el.innerHTML;
  function update() {
    const v = safeEval(expr, el, locals);
    if (v === undefined || v === null) el.innerHTML = fallback;
    else el.innerHTML = toStr(v);
  }
  addBinding({ el, type: 'html', update });
}

// jtx-attr-*
function bindAttr(el, attr, expr, locals) {
  const real = attr.slice('jtx-attr-'.length);
  function update() {
    const v = safeEval(expr, el, locals);
    if (v === false || v === null || v === undefined) {
      el.removeAttribute(real);
    }
    else if (v === true) {
      el.setAttribute(real, '');
    }
    else {
      el.setAttribute(real, toStr(v));
    }
  }
  addBinding({ el, type: 'attr', name: real, update });
}

// jtx-model
function bindModel(el, expr) {
  // Expect @state.key
  const m = ('' + expr).match(/^@([a-zA-Z_][\w$]*)\.(.+)$/);
  if (!m) {
    console.warn('[JTX] jtx-model expects @state.key');
    return;
  }

  const stateName = m[1];
  const key = m[2];
  function writeModel(v) {
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === 'checkbox') {
        el.checked = !!v;
        return;
      }
      if (t === 'radio') {
        el.checked = ('' + el.value) === ('' + v);
        return;
      }
      el.value = v == null ? '' : ('' + v);
    }
    else if (el instanceof HTMLSelectElement) {
      if (el.multiple && Array.isArray(v)) {
        const set = new Set(v.map((x) => '' + x));
        Array.from(el.options).forEach((opt) => { opt.selected = set.has('' + opt.value); });
      }
      else {
        el.value = v == null ? '' : ('' + v);
      }
    }
    else if (el instanceof HTMLTextAreaElement) {
      el.value = v == null ? '' : ('' + v);
    }
  }

  function readModel() {
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === 'checkbox') return !!el.checked;
      if (t === 'number' || t === 'range') return el.value === '' ? null : Number(el.value);
      // radios: value of this radio; usually bound as a group by name
      return el.value;
    }
    if (el instanceof HTMLSelectElement) {
      if (el.multiple) return Array.from(el.selectedOptions).map((o) => o.value);
      return el.value;
    }
    if (el instanceof HTMLTextAreaElement) return el.value;
    return undefined;
  }

  function pull() {
    const st = registry.states.get(stateName);
    if (!st) return;
    const v = deepGet(st.value, key);
    writeModel(v);
  }

  function push() {
    const st = registry.states.get(stateName);
    if (!st) return;
    const newVal = readModel();
    // Assign top-level key only if simple; for nested paths, set root key if available.
    if (key.includes('.')) {
      // naive deep set
      const parts = key.split('.');
      let cur = st.value;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!isObj(cur[p])) cur[p] = {};
        cur = cur[p];
      }
      cur[parts[parts.length - 1]] = newVal;
      st.pendingKeys.add(parts[0]);
    }
    else {
      st.value[key] = newVal;
      st.pendingKeys.add(key);
    }
    scheduleRender();
  }

  el.addEventListener('input', push);
  el.addEventListener('change', push);
  addBinding({ el, type: 'model', update: pull });
}

// jtx-on
const periodicMap = new WeakMap(); // el -> [timerIds]
function bindOn(el, expr, locals) {
  // format: event: stmt; event2: stmt2; ...
  const pairs = ('' + expr).split(/\s*;\s*/).filter(Boolean).map((pair) => {
    const idx = pair.indexOf(':');
    if (idx === -1) return null;
    const event = pair.slice(0, idx).trim();
    const code = pair.slice(idx + 1).trim();
    return { event, code };
  }).filter(Boolean);

  const timers = [];
  for (const { event, code } of pairs) {
    if (event.startsWith('every ')) {
      const ms = parseDuration(event.slice('every '.length));
      if (ms > 0) {
        const id = setInterval(() => {
          try { execute(code, buildCtx(el, new CustomEvent('every')), locals || {}, false); } catch (e) { console.error('[JTX] jtx-on every error', e); }
          scheduleRender();
        }, ms);
        timers.push(id);
      }
      continue;
    }

    el.addEventListener(event, (ev) => {
      try { execute(code, buildCtx(el, ev), locals || {}, false); } catch (e) { console.error('[JTX] jtx-on error', e); }
      scheduleRender();
    });
  }

  if (timers.length) periodicMap.set(el, timers);
}

// <jtx-insert>
function initInsert(el) {
  const forExpr = el.getAttribute('for');
  if (forExpr) return bindInsertList(el, forExpr);

  const textExpr = el.getAttribute('text');
  const htmlExpr = el.getAttribute('html');
  if (textExpr || htmlExpr) return bindInsertScalar(el, textExpr, htmlExpr);
}

function bindInsertScalar(el, textExpr, htmlExpr) {
  const fallback = el.innerHTML;

  const slots = { loading: null, error: null, empty: null };
  for (const child of Array.from(el.children)) {
    const tag = child.tagName?.toLowerCase();
    if (tag === 'jtx-loading') {
      slots.loading = child;
      child.setAttribute('hidden', '');
    }
    else if (tag === 'jtx-error') {
      slots.error = child;
      child.setAttribute('hidden', '');
    }
    else if (tag === 'jtx-empty') {
      slots.empty = child;
      child.setAttribute('hidden', '');
    }
  }

  function ownerSrc() {
    const srcEl = el.closest('jtx-src');
    if (!srcEl) return null;
    const name = srcEl.getAttribute('name');
    if (!name) return null;
    return registry.srcs.get(name) || null;
  }

  function updateSlots(status, hasValue) {
    const isLoading = status === 'loading';
    const isError = status === 'error';
    if (slots.loading) isLoading ? slots.loading.removeAttribute('hidden') : slots.loading.setAttribute('hidden', '');
    if (slots.error) isError ? slots.error.removeAttribute('hidden') : slots.error.setAttribute('hidden', '');
    const showEmpty = !isLoading && !isError && hasValue === false;
    if (slots.empty) showEmpty ? slots.empty.removeAttribute('hidden') : slots.empty.setAttribute('hidden', '');
  }

  function update() {
    try {
      if (textExpr) {
        const v = safeEval(textExpr, el);
        if (v === undefined || v === null) el.innerHTML = fallback; else el.textContent = toStr(v);
        const src = ownerSrc();
        updateSlots(src?.status, v === null ? false : true);
      }
      else if (htmlExpr) {
        const v = safeEval(htmlExpr, el);
        if (v === undefined || v === null) el.innerHTML = fallback; else el.innerHTML = toStr(v);
        const src = ownerSrc();
        updateSlots(src?.status, v === null ? false : true);
      }
    } catch {
      el.innerHTML = fallback;
      const src = ownerSrc();
      updateSlots(src?.status, false);
    }
  }

  addBinding({ el, type: 'insert-scalar', update });
}

function bindInsertList(el, forExpr) {
  // Parse left and right of `in`
  const m = ('' + forExpr).match(/^(.+?)\s+in\s+(.+)$/);
  if (!m) {
    console.warn('[JTX] jtx-insert for expects syntax: item in <expr> or value,key in <expr>');
    return;
  }
  const lhs = m[1].trim();
  const rhsExpr = m[2].trim();
  const names = lhs.split(',').map((s) => s.trim()).filter(Boolean);
  const hasKeyVar = names.length >= 2;
  const valVar = names[0] || '$';
  const keyVar = hasKeyVar ? names[1] : '$index';
  const keyExpr = el.getAttribute('key');
  const strategy = (el.getAttribute('strategy') || 'replace').toLowerCase();
  const windowSize = (() => {
    const w = parseInt(el.getAttribute('window') || '', 10);
    return Number.isFinite(w) && w > 0 ? w : null;
  })();

  const template = el.querySelector('jtx-template');
  if (!template || !template.firstElementChild) {
    console.warn('[JTX] jtx-insert requires a <jtx-template> with one root element');
  }
  if (template) template.setAttribute('hidden', '');

  // Cache slot children
  const slotLoading = Array.from(el.children).find((c) => c.tagName?.toLowerCase() === 'jtx-loading') || null;
  if (slotLoading) slotLoading.setAttribute('hidden', '');
  const slotError = Array.from(el.children).find((c) => c.tagName?.toLowerCase() === 'jtx-error') || null;
  if (slotError) slotError.setAttribute('hidden', '');
  const slotEmpty = Array.from(el.children).find((c) => c.tagName?.toLowerCase() === 'jtx-empty') || null;
  if (slotEmpty) slotEmpty.setAttribute('hidden', '');

  function ownerSrc() {
    const srcEl = el.closest('jtx-src');
    if (!srcEl) return null;
    const name = srcEl.getAttribute('name');
    if (!name) return null;
    return registry.srcs.get(name) || null;
  }

  function updateSlots(status, hasItems) {
    const isLoading = status === 'loading';
    const isError = status === 'error';
    if (slotLoading) isLoading ? slotLoading.removeAttribute('hidden') : slotLoading.setAttribute('hidden', '');
    if (slotError) isError ? slotError.removeAttribute('hidden') : slotError.setAttribute('hidden', '');
    const showEmpty = !isLoading && !isError && !hasItems;
    if (slotEmpty) showEmpty ? slotEmpty.removeAttribute('hidden') : slotEmpty.setAttribute('hidden', '');
  }

  function isSpecialNode(node) {
    if (!(node instanceof Element)) return true;
    const tag = node.tagName.toLowerCase();
    return tag === 'jtx-template' || tag === 'jtx-loading' || tag === 'jtx-error' || tag === 'jtx-empty';
  }

  function currentItemNodes() {
    const nodes = [];
    for (const child of Array.from(el.children)) {
      if (!isSpecialNode(child)) nodes.push(child);
    }
    return nodes;
  }

  function existingKeysSet() {
    const set = new Set();
    for (const n of currentItemNodes()) {
      const k = n.getAttribute('jtx-key');
      if (k != null) set.add(k);
    }
    return set;
  }

  function insertBeforeSpecial(node) {
    for (const child of Array.from(el.children)) {
      if (isSpecialNode(child)) {
        el.insertBefore(node, child);
        return;
      }
    }
    el.appendChild(node);
  }

  function insertAtStart(node) {
    if (template && template.parentElement === el) {
      const afterTpl = template.nextSibling;
      if (afterTpl) el.insertBefore(node, afterTpl);
      else insertBeforeSpecial(node);
    }
    else {
      const items = currentItemNodes();
      if (items.length) el.insertBefore(node, items[0]);
      else insertBeforeSpecial(node);
    }
  }

  function exprUsesLocal(expr, localNames) {
    const s = '' + expr;
    // crude detection of identifiers, good enough for our use
    for (const name of localNames) {
      if (!name) continue;
      if (name === '$') {
        if (/(^|[^\w$])\$(?=[^\w$]|$)/.test(s)) return true;
        continue;
      }
      const esc = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const re = new RegExp(`(^|[^\\w$])${esc}(?=[^\\w$]|$)`);
      if (re.test(s)) return true;
    }
    return false;
  }

  function evalWithLocalOrder(expr, targetEl, locals, namesOrder) {
    try {
      const src = preprocessExpr(expr);
      const ordered = namesOrder.filter((n) => n && Object.prototype.hasOwnProperty.call(locals, n));
      const vals = ordered.map((n) => locals[n]);
      const fn = new Function('ctx', ...ordered, `return ( ${src} );`);
      return fn(buildCtx(targetEl, null), ...vals);
    } catch (e) {
      console.error('[JTX] eval locals error in', expr, e);
      return undefined;
    }
  }

  function applyOnceOrBind(el, attrName, expr, locals, localNames) {
    const usesLocal = exprUsesLocal(expr, localNames);
    switch (attrName) {
      case 'jtx-text':
        if (usesLocal) {
          const v = evalWithLocalOrder(expr, el, locals, localNames);
          el.textContent = v == null ? '' : toStr(v);
          el.removeAttribute(attrName);
        }
        else {
          bindText(el, expr, undefined);
        }
        break;

      case 'jtx-html':
        if (usesLocal) {
          const v = evalWithLocalOrder(expr, el, locals, localNames);
          el.innerHTML = v == null ? '' : toStr(v);
          el.removeAttribute(attrName);
        }
        else {
          bindHtml(el, expr, undefined);
        }
        break;

      case 'jtx-if':
        bindIf(el, expr, undefined);
        break;

      case 'jtx-show':
        bindShow(el, expr, undefined);
        break;

      case 'jtx-model':
        bindModel(el, expr);
        break;

      case 'jtx-on':
        bindOn(el, expr, undefined);
        break;

      default:
        if (attrName.startsWith('jtx-attr-')) {
          if (usesLocal) {
            const real = attrName.slice('jtx-attr-'.length);
            const v = evalWithLocalOrder(expr, el, locals, localNames);
            if (v === false || v == null) el.removeAttribute(real);
            else if (v === true) el.setAttribute(real, ''); else el.setAttribute(real, toStr(v));
            el.removeAttribute(attrName);
          }
          else {
            bindAttr(el, attrName, expr, undefined);
          }
          return;
        }
    }
  }

  function compileTemplateOnce(rootNode, locals, localNames) {
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT, null);
    let cur = rootNode.nodeType === 1 ? rootNode : walker.nextNode();
    while (cur) {
      const el = cur;
      if (el !== rootNode && typeof el.closest === 'function' && el.closest('jtx-template')) {
        cur = walker.nextNode();
        continue;
      }
      for (const { name, value } of Array.from(el.attributes)) {
        if (name.startsWith('jtx-')) {
          applyOnceOrBind(el, name, value, locals, localNames);
        }
      }
      try { Object.defineProperty(el, '__jtxProcessed', { value: true, configurable: true }); } catch { /* ignore */ }
      cur = walker.nextNode();
    }
  }

  function createNodeFor(idx, item, rootVal, derivedKey) {
    const keyString = toStr(derivedKey);

    const blueprint = template && template.firstElementChild ? template.firstElementChild : null;
    const node = blueprint ? blueprint.cloneNode(true) : document.createElement('div');
    try { node.setAttribute('jtx-key', keyString); } catch { /* ignore */ }

    // Snapshot item/root (unwrap proxies first) to avoid future mutations affecting existing nodes
    const unwrappedItem = unwrapRef(item);
    const unwrappedRoot = unwrapRef(rootVal);
    const snapshot = isObj(unwrappedItem) ? structuredCloneSafe(unwrappedItem) : unwrappedItem;
    const rootSnapshot = isObj(unwrappedRoot) ? structuredCloneSafe(unwrappedRoot) : unwrappedRoot;

    const locals = Object.create(null);
    locals[valVar] = snapshot;
    locals.$ = snapshot;
    locals.$index = idx;
    locals.$key = keyString;
    locals.$root = rootSnapshot;
    if (hasKeyVar) locals[keyVar] = idx;

    // Initialize any scoped states within this instance before binding
    try {
      const stateNodes = node.querySelectorAll('jtx-state');
      for (const stEl of Array.from(stateNodes)) {
        initState(stEl, locals, { register: false });
      }
    } catch { /* ignore */ }

    // One-shot compile for locals-referencing attributes; others bind normally without locals
    const localNames = [valVar, hasKeyVar ? keyVar : null, '$', '$index', '$key', '$root'].filter(Boolean);
    compileTemplateOnce(node, locals, localNames);
    return node;
  }

  function computeKey(idx, item, rootVal) {
    if (keyExpr) {
      try {
        const itm = unwrapRef(item);
        const root = unwrapRef(rootVal);

        const baseLocals = Object.create(null);
        baseLocals[valVar] = itm;
        baseLocals.$ = itm;
        baseLocals.$index = idx;
        if (hasKeyVar) baseLocals[keyVar] = idx;
        baseLocals.$root = root;

        const order = [valVar, hasKeyVar ? keyVar : null, '$', '$index', '$root'].filter(Boolean);

        const v = evalWithLocalOrder(keyExpr, el, baseLocals, order);
        return v == null ? idx : v;
      } catch {
        return idx;
      }
    }
    return idx;
  }

  function materializeList(value) {
    const v = unwrapRef(value);
    if (Array.isArray(v)) return v.map((it, i) => ({ idx: i, item: unwrapRef(it) }));
    if (hasKeyVar && isObj(v)) return Object.keys(v).map((k) => ({ idx: k, item: unwrapRef(v[k]) }));
    if (v === undefined || v === null) return [];
    return [{ idx: 0, item: unwrapRef(v) }];
  }

  function update() {
    let rootVal;
    try { rootVal = unwrapRef(safeEval(rhsExpr, el)); } catch { rootVal = undefined; }
    const entries = materializeList(rootVal);

    if (strategy === 'replace') {
      const current = currentItemNodes();
      if (current.length === entries.length) {
        const desiredKeys = entries.map(({ idx, item }) => toStr(computeKey(idx, item, rootVal)));
        let same = true;
        for (let i = 0; i < current.length; i++) {
          const k = current[i].getAttribute('jtx-key') ?? '';
          if (k !== desiredKeys[i]) { same = false; break; }
        }
        if (same) {
          const src = ownerSrc();
          updateSlots(src?.status, current.length > 0);
          return;
        }
      }

      // Keyed diff: reuse existing nodes by key, create only missing, and reorder
      const existingMap = new Map();
      for (const n of current) {
        const k = n.getAttribute('jtx-key') ?? '';
        existingMap.set(k, n);
      }

      const frag = document.createDocumentFragment();
      for (const { idx, item } of entries) {
        const key = toStr(computeKey(idx, item, rootVal));
        let node = existingMap.get(key);
        if (node) {
          existingMap.delete(key);
        }
        else {
          node = createNodeFor(idx, item, rootVal, key);
        }
        frag.appendChild(node);
      }
      // Remove nodes no longer present
      for (const leftover of existingMap.values()) leftover.remove();
      // Insert in correct order (appending existing nodes moves them)
      insertBeforeSpecial(frag);
      const src = ownerSrc();
      updateSlots(src?.status, currentItemNodes().length > 0);
      return;
    }

    const existing = existingKeysSet();
    for (const { idx, item } of entries) {
      const k = toStr(computeKey(idx, item, rootVal));
      if (existing.has(k)) continue;

      const node = createNodeFor(idx, item, rootVal, k);
      if (strategy === 'prepend') insertAtStart(node);
      else insertBeforeSpecial(node);

      existing.add(k);
    }

    if (windowSize != null && windowSize >= 0) {
      const items = currentItemNodes();
      if (items.length > windowSize) {
        const excess = items.length - windowSize;
        if (strategy === 'prepend') {
          for (let i = 0; i < excess; i++) items[items.length - 1 - i]?.remove();
        }
        else {
          for (let i = 0; i < excess; i++) items[i]?.remove();
        }
      }
    }

    const src = ownerSrc();
    updateSlots(src?.status, currentItemNodes().length > 0);
  }

  addBinding({ el, type: 'insert-list', update });
}

// Bind all supported attributes within a subtree
function bindAll(root) {
  // init definitions first
  // Skip states declared inside a <jtx-template>; those are initialized per-instance
  for (const st of Array.from(root.querySelectorAll('jtx-state'))) {
    if (st.closest('jtx-template')) continue;
    initState(st);
  }
  root.querySelectorAll('jtx-src').forEach(initSrc);
  root.querySelectorAll('jtx-insert').forEach(initInsert);

  bindAllIn(root);
}

const ATTR_BINDERS = {
  'jtx-if': bindIf,
  'jtx-show': bindShow,
  'jtx-text': bindText,
  'jtx-html': bindHtml,
  'jtx-model': bindModel,
  'jtx-on': bindOn,
};

function bindAllIn(root, perItemCtx) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node = root.nodeType === 1 ? root : walker.nextNode();
  while (node) {
    const el = node;
    // Skip elements already processed to avoid double-binding (e.g., insert children)
    if (el.__jtxProcessed) {
      node = walker.nextNode();
      continue;
    }
    // Skip anything inside a <jtx-template> (blueprint only)
    if (el !== root && typeof el.closest === 'function' && el.closest('jtx-template')) {
      node = walker.nextNode();
      continue;
    }
    // skip definitions and template content root
    const tag = el.tagName.toLowerCase();
    if (tag === 'jtx-state' || tag === 'jtx-src' || tag === 'jtx-template') {
      node = walker.nextNode();
      continue;
    }
    // attributes
    for (const { name: attrName, value } of Array.from(el.attributes)) {
      if (attrName.startsWith('jtx-attr-')) {
        bindAttr(el, attrName, value, perItemCtx);
      }
      else if (ATTR_BINDERS[attrName]) {
        ATTR_BINDERS[attrName](el, value, perItemCtx);
      }
    }
    // mark as processed
    try { Object.defineProperty(el, '__jtxProcessed', { value: true, configurable: true }); } catch { /* ignore */ }
    node = walker.nextNode();
  }
}


// Expose API
const JTX = {
  init(root = document) {
    bindAll(root);
    // initial render
    scheduleRender();
  },
  refresh: refreshSource,
};

// Auto-init on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => JTX.init());
}
else {
  JTX.init();
}

// Export for ESM and UMD consumers
export default JTX;
