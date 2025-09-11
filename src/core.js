/* eslint-env browser */

export const registry = {
  states: new Map(), // name -> { name, el, value, persistedKeys:Set, urlKeys:Set, listeners:Set, pendingKeys:Set }
  srcs: new Map(),   // name -> { name, el, value, url, status, error, controller, kind, timers:[], io:null }
  bindings: new Set(), // set of binding objects with update()
};

export const fire = (el, type, detail) => {
  try { el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true })); } catch { /* ignore */ }
};

export function parseUrlParams() {
  const out = Object.create(null);
  const sp = new URLSearchParams(location.search);
  for (const [k, v] of sp.entries()) {
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return out;
}

export function syncUrlFromState(st) {
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

export function runAllBindings() {
  for (const b of registry.bindings) {
    try { b.update(); } catch (e) { console.error('[JTX] binding error', e, b); }
  }
}

export function flushStateUpdates() {
  for (const st of registry.states.values()) {
    if (st.pendingKeys.size === 0) continue;

    for (const key of st.pendingKeys) {
      if (st.persistedKeys.has(key)) {
        try {
          localStorage.setItem(`jtx:${st.name}:${key}`, JSON.stringify(st.value[key]));
        } catch { /* ignore */ }
      }
    }

    if (st.urlKeys.size) syncUrlFromState(st);
    fire(st.el, 'update', { name: st.name, keys: Array.from(st.pendingKeys), value: st.value });
    st.pendingKeys.clear();
  }
}

let renderQueued = false;
export function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    flushStateUpdates();
    runAllBindings();
  });
}

export function addBinding(binding) {
  registry.bindings.add(binding);
  // Initial run
  try { binding.update(); } catch (e) { console.error('[JTX] binding error', e, binding); }
}
