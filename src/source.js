/* eslint-env browser */

import { registry, fire, scheduleRender, registerCleanup } from './core.js';
import { safeEval } from './context.js';
import { deepGet, parseJSON, parseDuration } from './utils.js';

export function initSrc(el) {
  const name = el.getAttribute('name');
  const url = el.getAttribute('url');
  if (!name || !url) return;

  if (registry.srcs.has(name)) {
    console.warn(`[JTX] Duplicate src name: ${name}`);
    return;
  }

  function updateEmptySlot() {
    const node = src.specialNodes.empty;
    if (!node) return;
    // Show <jtx-empty> only after a fetch completes successfully
    const isEmpty = (src.status === 'ready') && (src.value == null || (Array.isArray(src.value) && src.value.length === 0));
    if (isEmpty) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  function updateStatus(status) {
    src.status = status;
    registry.changed.add(src);

    const loadingNode = src.specialNodes.loading;
    const errorNode = src.specialNodes.error;
    if (loadingNode) {
      if (src.status === 'loading') loadingNode.removeAttribute('hidden');
      else loadingNode.setAttribute('hidden', '');
    }
    if (errorNode) {
      if (src.status === 'error') errorNode.removeAttribute('hidden');
      else errorNode.setAttribute('hidden', '');
    }

    updateEmptySlot();
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
    observer: null, // IntersectionObserver for visible mode
    value: undefined,
    updateStatus,
    status: 'idle',
    specialNodes: { loading: null, error: null, empty: null },
    error: null,
    sseTypes: [], // extra SSE event types parsed from jtx-on
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
    // Preserve the original expression for dynamic evaluation on each fetch
    try { Object.defineProperty(src, 'headersExpr', { value: headersAttr, configurable: true }); } catch { /* ignore */ }
    // Also attempt an initial evaluation for visibility (non-authoritative)
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

  // Parse jtx-on for custom SSE event names and store them
  try {
    const onAttr = el.getAttribute('jtx-on') || '';
    if (onAttr && src.kind === 'sse') {
      const std = new Set(['init', 'fetch', 'open', 'message', 'update', 'error', 'close']);
      const parts = onAttr.split(/\s*;\s*/).filter(Boolean);
      const types = new Set();

      for (const p of parts) {
        const idx = p.indexOf(':');
        if (idx === -1) continue;

        const evt = p.slice(0, idx).trim();
        if (!evt || evt.startsWith('every ')) continue;
        if (std.has(evt)) continue;

        types.add(evt);
      }

      src.sseTypes = Array.from(types);
    }
  } catch { /* ignore */ }

  setupFetchModes(src);

  registerCleanup(el, () => {
    try {
      for (const id of src.timers) clearInterval(id);
      src.timers.length = 0;
    } catch { /* ignore */ }
    try { if (src.observer) src.observer.disconnect(); } catch { /* ignore */ }
    try { closeStream(src); } catch { /* ignore */ }
  });
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
      src.observer = new IntersectionObserver((entries, obs) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect();
          refreshSource(src.name);
        }
      });
      src.observer.observe(src.el);
    }
    else {
      // fallback: just fetch after a bit
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

export async function refreshSource(name) {
  const src = registry.srcs.get(name);
  if (!src) return;
  if (src.kind === 'http') return fetchHttpSource(src);
  if (src.kind === 'sse' || src.kind === 'ws') return reopenStream(src);
}

function computeHeaders(src) {
  const headersAttr = src.headersExpr || src.el.getAttribute('headers') || '';
  if (!headersAttr) return {};
  try {
    const evaluated = safeEval(headersAttr, src.el);
    if (evaluated == null) return {};
    if (typeof evaluated === 'object') return evaluated;
    throw new Error('headers must evaluate to an object');
  } catch {
    try { return JSON.parse(headersAttr); } catch { /* ignore */ }
  }
  console.warn('[JTX] Invalid headers for', src.name);
  return {};
}

async function fetchHttpSource(src) {
  const url = src.url;
  const headers = computeHeaders(src);
  src.headers = headers;

  src.updateStatus('loading');
  fire(src.el, 'fetch', { url, headers });
  scheduleRender();

  try {
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const message = `HTTP ${res.status}`;
      src.error = { name: src.name, type: 'network', status: res.status, message };
      registry.changed.add(src);
      src.updateStatus('error');
      fire(src.el, 'error', src.error);
      scheduleRender();
      return;
    }

    const text = await res.text();
    let value = text === '' && res.status === 204 ? null : parseJSON(text);

    if (src.select) value = deepGet(value, src.select);

    src.value = value;
    registry.changed.add(src);
    src.updateStatus('ready');
    src.error = null;
    fire(src.el, 'update', { name: src.name, value });
    scheduleRender();
  } catch (e) {
    src.error = { name: src.name, type: 'network', message: e.message, raw: e };
    registry.changed.add(src);
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
  try { fire(src.el, 'close', { name: src.name }); } catch { /* ignore */ }
}

function normalizeSseUrl(u) {
  // Accept forms: sse:/path, sse://host/path, sse:http://host/path, http(s)://...
  let url = u.startsWith('sse:') ? u.slice(4) : u;
  return url;
}
function normalizeWsUrl(u) {
  // Accept forms are the same as SSE but with ws/wss
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
        // Default event type is 'message'; dispatch generic + update value
        handleStreamMessage(src, ev.data, 'message', ev.lastEventId);
      });

      if (src.sseEvent) {
        es.addEventListener(src.sseEvent, (ev) => {
          try { fire(src.el, src.sseEvent, { name: src.name, type: src.sseEvent, data: ev.data, lastEventId: ev.lastEventId }); } catch { /* ignore */ }
          handleStreamMessage(src, ev.data, src.sseEvent, ev.lastEventId);
        });
      }

      // Subscribe to any additional SSE event types referenced in jtx-on
      const extras = (src.sseTypes || []).filter((t) => t && t !== src.sseEvent && t !== 'message');
      for (const t of extras) {
        try {
          es.addEventListener(t, (ev) => {
            try { fire(src.el, t, { name: src.name, type: t, data: ev.data, lastEventId: ev.lastEventId }); } catch { /* ignore */ }
            if (!src.sseEvent) handleStreamMessage(src, ev.data, t, ev.lastEventId);
          });
        } catch { /* ignore */ }
      }

      es.addEventListener('error', (ev) => {
        src.error = { name: src.name, type: 'connection', message: 'SSE error', raw: ev };
        try { src.updateStatus('error'); } catch { /* ignore */ }
        try { fire(src.el, 'error', src.error); } catch { /* ignore */ }
        try { registry.changed.add(src); } catch { /* ignore */ }
        try { scheduleRender(); } catch { /* ignore */ }
      });
    } catch (e) {
      src.error = { name: src.name, type: 'connection', message: e.message, raw: e };
      try { src.updateStatus('error'); } catch { /* ignore */ }
      try { fire(src.el, 'error', src.error); } catch { /* ignore */ }
      try { registry.changed.add(src); } catch { /* ignore */ }
      try { scheduleRender(); } catch { /* ignore */ }
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
        try { src.updateStatus('error'); } catch { /* ignore */ }
        try { fire(src.el, 'error', src.error); } catch { /* ignore */ }
        try { registry.changed.add(src); } catch { /* ignore */ }
        try { scheduleRender(); } catch { /* ignore */ }
      });
      ws.addEventListener('close', (ev) => {
        fire(src.el, 'close', { name: src.name, code: ev.code, reason: ev.reason });
      });
    } catch (e) {
      src.error = { name: src.name, type: 'connection', message: e.message, raw: e };
      try { src.updateStatus('error'); } catch { /* ignore */ }
      try { fire(src.el, 'error', src.error); } catch { /* ignore */ }
      try { registry.changed.add(src); } catch { /* ignore */ }
      try { scheduleRender(); } catch { /* ignore */ }
    }
  }
}

function handleStreamMessage(src, data, type, lastEventId) {
  fire(src.el, 'message', { name: src.name, type, data, lastEventId });
  try {
    const value = data === '' ? null : JSON.parse(data);
    src.value = src.select ? deepGet(value, src.select) : value;
    registry.changed.add(src);
    fire(src.el, 'update', { name: src.name, value: src.value });
    scheduleRender();
  } catch (e) {
    src.error = { name: src.name, type: 'format', message: 'Invalid JSON', raw: e };
    try { src.updateStatus('error'); } catch { /* ignore */ }
    try { registry.changed.add(src); } catch { /* ignore */ }
    try { fire(src.el, 'error', src.error); } catch { /* ignore */ }
    try { scheduleRender(); } catch { /* ignore */ }
  }
}
