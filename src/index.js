/* eslint-env browser */

// Utilities
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toStr = (v) => v == null ? '' : String(v);
const parseJSON = (s) => {
  if (s == null || s === '') return null;
  return JSON.parse(s);
};
const deepGet = (obj, path) => {
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
const parseDuration = (s) => {
  if (!s) return 0;
  const m = String(s).trim().match(/^(\d+)(ms|s|m|h)?$/i);
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
const preprocessExpr = (expr) => String(expr).replace(REF_RE, 'ctx.$ref("$1")');

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
  return new Proxy({ [JTX_REF]: { type: 'state', name: state.name, target: state } }, {
    get(target, prop) {
      if (prop === JTX_REF) return target[JTX_REF];
      if (prop === 'toJSON') return () => state.value;
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
        state.pendingKeys.add(String(prop));
      }
      else {
        state.value[prop] = value;
        state.pendingKeys.add(String(prop));
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
      if (prop in target) return target[prop];
      return src.value?.[prop];
    },
  });
}

// Build the evaluation context object passed as ctx
function buildCtx(currentEl, currentEvent) {
  return {
    $ref(name) {
      // First resolve per-evaluation locals (list item variables)
      if (this && this.$locals && Object.prototype.hasOwnProperty.call(this.$locals, name)) {
        return this.$locals[name];
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
function initState(el) {
  const name = el.getAttribute('name');
  if (!name) return;
  if (registry.states.has(name)) {
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
    const v = safeEval(value, el);
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

  registry.states.set(name, st);
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
    status: 'idle',
    error: null,
  };
  const headersAttr = el.getAttribute('headers');
  if (headersAttr) {
    try { src.headers = JSON.parse(headersAttr); } catch { console.warn('[JTX] Invalid headers JSON for', name); }
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
    if ('requestIdleCallback' in window) window.requestIdleCallback(cb); else setTimeout(cb, 50);
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
  src.status = 'loading';
  fire(src.el, 'fetch', { url, headers: src.headers });
  scheduleRender();
  try {
    const res = await fetch(url, { headers: src.headers });
    if (!res.ok) {
      const message = `HTTP ${res.status}`;
      src.error = { name: src.name, type: 'network', status: res.status, message };
      src.status = 'error';
      fire(src.el, 'error', src.error);
      scheduleRender();
      return;
    }
    const text = await res.text();
    let value = text === '' && res.status === 204 ? null : parseJSON(text);
    if (src.select) value = deepGet(value, src.select);
    src.value = value;
    src.status = 'ready';
    src.error = null;
    fire(src.el, 'update', { name: src.name, value });
    scheduleRender();
  } catch (e) {
    src.error = { name: src.name, type: 'network', message: e.message, raw: e };
    src.status = 'error';
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

function openStream(src) {
  const rawUrl = src.url.replace(/^sse:/, '').replace(/^ws:/, 'ws:').replace(/^wss:/, 'wss:');
  if (src.kind === 'sse') {
    try {
      const es = new EventSource(rawUrl);
      src.io = es;
      src.status = 'ready';
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
        src.status = 'ready';
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
    if (ok) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  }
  addBinding({ el, type: 'show', update });
}

// jtx-text
function bindText(el, expr, locals) {
  const fallback = el.textContent;
  function update() {
    const v = safeEval(expr, el, locals);
    if (v === undefined || v === null) el.textContent = fallback; else el.textContent = toStr(v);
  }
  addBinding({ el, type: 'text', update });
}

// jtx-html
function bindHtml(el, expr, locals) {
  const fallback = el.innerHTML;
  function update() {
    const v = safeEval(expr, el, locals);
    if (v === undefined || v === null) el.innerHTML = fallback; else el.innerHTML = toStr(v);
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
      return;
    }
    if (v === true) {
      el.setAttribute(real, '');
    }
    else {
      el.setAttribute(real, String(v));
    }
  }
  addBinding({ el, type: 'attr', name: real, update });
}

// jtx-model
function bindModel(el, expr) {
  // Expect @state.key
  const m = String(expr).match(/^@([a-zA-Z_][\w$]*)\.(.+)$/);
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
        el.checked = String(el.value) === String(v);
        return;
      }
      el.value = v == null ? '' : String(v);
      return;
    }
    if (el instanceof HTMLSelectElement) {
      if (el.multiple && Array.isArray(v)) {
        const set = new Set(v.map(String));
        Array.from(el.options).forEach((opt) => { opt.selected = set.has(String(opt.value)); });
      }
      else {
        el.value = v == null ? '' : String(v);
      }
      return;
    }
    if (el instanceof HTMLTextAreaElement) {
      el.value = v == null ? '' : String(v);
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
  const pairs = String(expr).split(/\s*;\s*/).filter(Boolean).map((pair) => {
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
  const textExpr = el.getAttribute('text');
  const htmlExpr = el.getAttribute('html');
  if (forExpr) return bindInsertList(el, forExpr);
  if (textExpr || htmlExpr) return bindInsertScalar(el, textExpr, htmlExpr);
}

function bindInsertScalar(el, textExpr, htmlExpr) {
  const fallback = el.innerHTML;
  function update() {
    if (textExpr) {
      const v = safeEval(textExpr, el);
      el.textContent = v == null ? fallback : toStr(v);
    }
    else if (htmlExpr) {
      const v = safeEval(htmlExpr, el);
      el.innerHTML = v == null ? fallback : toStr(v);
    }
  }
  addBinding({ el, type: 'insert-scalar', update });
}

function parseFor(forStr) {
  // patterns: "item in <expr>" or "value,key in <expr>"
  const m2 = forStr.match(/^\s*([a-zA-Z_$][\w$]*)\s*,\s*([a-zA-Z_$][\w$]*)\s+in\s+(.+)$/);
  if (m2) return { val: m2[1], key: m2[2], expr: m2[3] };
  const m1 = forStr.match(/^\s*([a-zA-Z_$][\w$]*)\s+in\s+(.+)$/);
  if (m1) return { val: m1[1], key: null, expr: m1[2] };
  throw new Error('Invalid for="..."');
}

function bindInsertList(el, forExpr) {
  const { val, key: keyVar, expr } = parseFor(forExpr);
  const keyExpr = el.getAttribute('key');
  const strategy = (el.getAttribute('strategy') || 'replace').toLowerCase();
  if (!['replace'].includes(strategy)) {
    console.warn('[JTX] Only strategy="replace" implemented in first version.');
  }
  const template = el.querySelector('jtx-template');
  if (!template) { console.warn('[JTX] <jtx-insert> requires a <jtx-template>'); return; }
  if (template.childElementCount !== 1) {
    console.warn('[JTX] <jtx-template> must have exactly one root element');
  }
  const rootTpl = template.firstElementChild;
  template.style.display = 'none';
  // hide slots initially
  const slotEmpty = el.querySelector('jtx-empty');
  const slotLoading = el.querySelector('jtx-loading');
  const slotError = el.querySelector('jtx-error');

  function toggleSlots(isEmpty) {
    if (slotEmpty) slotEmpty.style.display = isEmpty ? '' : 'none';
    // If nested in a src, reflect its status
    const parentSrc = findNearestSrc(el);
    if (slotLoading) slotLoading.style.display = parentSrc && parentSrc.status === 'loading' ? '' : 'none';
    if (slotError) slotError.style.display = parentSrc && parentSrc.status === 'error' ? '' : 'none';
  }

  function update() {
    // Evaluate collection
    let coll = safeEval(expr, el);
    let list = [];
    if (Array.isArray(coll)) {
      coll.forEach((v, i) => list.push({ k: String(i), v }));
    }
    else if (isObj(coll)) {
      Object.keys(coll).forEach((k2, i) => list.push({ k: k2, v: coll[k2], i }));
    }
    else {
      list = [{ k: '0', v: coll }];
    }

    // compute keys if keyExpr provided
    if (keyExpr) {
      list = list.map((it, i) => {
        const ctx = buildCtx(el, null);
        // locals available in key expression: named item var, optional named key var, and $-vars
        const local = Object.create(null);
        local['$'] = it.v;
        local['$index'] = i;
        local['$key'] = String(it.k);
        local['$root'] = coll;
        if (val) local[val] = it.v;
        if (keyVar) local[keyVar] = it.k;
        const kVal = execute(keyExpr, ctx, local, true);
        return { k: String(kVal), v: it.v, i };
      });
    }

    // Clear current rendered nodes (excluding template and slots)
    const toRemove = [];
    for (const child of Array.from(el.children)) {
      if (child === template || child.tagName.toLowerCase().startsWith('jtx-')) continue;
      toRemove.push(child);
    }
    toRemove.forEach((n) => n.remove());

    // Render fresh list (replace strategy)
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const node = rootTpl.cloneNode(true);
      // Build per-item locals: both named variables and $-style for compatibility
      const locals = { '$': it.v, $index: i, $key: String(it.k), $root: coll };
      if (val) locals[val] = it.v;
      if (keyVar) locals[keyVar] = it.k;
      // Bind attributes inside node with per-item context
      bindAllIn(node, locals);
      el.appendChild(node);
    }
    toggleSlots(list.length === 0);
  }
  addBinding({ el, type: 'insert-list', update });
}

function findNearestSrc(el) {
  let cur = el;
  while (cur) {
    if (cur.tagName && cur.tagName.toLowerCase() === 'jtx-src') {
      const name = cur.getAttribute('name');
      if (name && registry.srcs.has(name)) return registry.srcs.get(name);
    }
    cur = cur.parentElement;
  }
  return null;
}

// Bind all supported attributes within a subtree
function bindAll(root) {
  // init definitions first
  root.querySelectorAll('jtx-state').forEach(initState);
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
