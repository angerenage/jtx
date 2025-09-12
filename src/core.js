/* eslint-env browser */

export const registry = {
  states: new Map(), // name -> { name, el, value, persistedKeys:Set, urlKeys:Set, listeners:Set, pendingKeys:Set }
  srcs: new Map(),   // name -> { name, el, value, url, status, error, controller, kind, timers:[], io:null }
  // Dependency tracking
  bindingDeps: new Map(), // binding -> Set(deps)
  depBindings: new Map(), // dep (state/src object) -> Set(bindings)
  changed: new Set(), // deps that changed since last render
};

const cleanupMap = new WeakMap(); // Element -> Set<fn>
let cleanupObserver = null;

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

let currentBinding = null;

export function runBinding(binding) {
  currentBinding = binding;
  // Remove previous deps
  const prev = registry.bindingDeps.get(binding);
  if (prev) {
    for (const dep of prev) {
      const set = registry.depBindings.get(dep);
      if (set) {
        set.delete(binding);
        if (set.size === 0) registry.depBindings.delete(dep);
      }
    }
    prev.clear();
  }
  else {
    registry.bindingDeps.set(binding, new Set());
  }
  try { binding.update(); } catch (e) { console.error('[JTX] binding error', e, binding); }
  currentBinding = null;
}

export function recordDependency(dep) {
  if (!currentBinding) return;
  let deps = registry.bindingDeps.get(currentBinding);
  if (!deps) {
    deps = new Set();
    registry.bindingDeps.set(currentBinding, deps);
  }
  if (!deps.has(dep)) {
    deps.add(dep);
    let set = registry.depBindings.get(dep);
    if (!set) {
      set = new Set();
      registry.depBindings.set(dep, set);
    }
    set.add(currentBinding);
  }
}

function runBindingsFor(deps) {
  if (!deps || deps.size === 0) return;
  const toRun = new Set();
  for (const dep of deps) {
    const set = registry.depBindings.get(dep);
    if (set) {
      for (const b of set) toRun.add(b);
    }
  }
  for (const b of toRun) runBinding(b);
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
    const deps = new Set(registry.changed);
    registry.changed.clear();
    runBindingsFor(deps);
  });
}

function ensureCleanupObserver() {
  if (cleanupObserver) return;
  try {
    cleanupObserver = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of Array.from(rec.removedNodes)) {
          runCleanupDeep(node);
        }
      }
    });
    const root = document.documentElement || document.body;
    if (root) cleanupObserver.observe(root, { childList: true, subtree: true });
  } catch { /* ignore */ }
}

function runCleanupDeep(node) {
  try {
    if (!node) return;
    if (node.nodeType === 1) {
      runCleanup(node);
      const tree = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, null);
      let cur = tree.currentNode;
      while (cur) {
        if (cur !== node) runCleanup(cur);
        cur = tree.nextNode();
      }
    }
  } catch { /* ignore */ }
}

function runCleanup(el) {
  const fns = cleanupMap.get(el);
  if (!fns || !fns.size) return;
  for (const fn of Array.from(fns)) {
    try { fn(); } catch { /* ignore */ }
  }
  cleanupMap.delete(el);
}

export function registerCleanup(el, fn) {
  if (!el || typeof fn !== 'function') return;
  ensureCleanupObserver();
  let set = cleanupMap.get(el);
  if (!set) {
    set = new Set();
    cleanupMap.set(el, set);
  }
  set.add(fn);
}
