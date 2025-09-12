/* eslint-env browser */

import { registry, runBinding, scheduleRender, recordDependency } from './core.js';
import { safeEval, execute, buildCtx, preprocessExpr, unwrapRef } from './context.js';
import { toStr, isObj, deepGet, parseDuration, structuredCloneSafe } from './utils.js';
import { initState } from './state.js';
import { initSrc } from './source.js';

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
  runBinding({ el, type: 'if', update });
}

// jtx-show: toggle hidden
function bindShow(el, expr, locals) {
  function update() {
    const ok = !!safeEval(expr, el, locals);
    if (ok) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }
  runBinding({ el, type: 'show', update });
}

// jtx-text
function bindText(el, expr, locals) {
  const fallback = el.textContent;
  function update() {
    const v = safeEval(expr, el, locals);
    if (v === undefined || v === null) el.textContent = fallback;
    else el.textContent = toStr(v);
  }
  runBinding({ el, type: 'text', update });
}

// jtx-html
function bindHtml(el, expr, locals) {
  const fallback = el.innerHTML;
  function update() {
    const v = safeEval(expr, el, locals);
    if (v === undefined || v === null) el.innerHTML = fallback;
    else el.innerHTML = toStr(v);
  }
  runBinding({ el, type: 'html', update });
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
  runBinding({ el, type: 'attr', name: real, update });
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
      }
      else if (t === 'radio') {
        el.checked = (String(el.value) === String(v));
      }
      else {
        el.value = toStr(v);
      }
    }
    else if (el instanceof HTMLSelectElement) {
      if (el.multiple && Array.isArray(v)) {
        const set = new Set(v.map((x) => String(x)));
        Array.from(el.options).forEach((opt) => { opt.selected = set.has(String(opt.value)); });
      }
      else {
        el.value = toStr(v);
      }
    }
    else if (el instanceof HTMLTextAreaElement) {
      el.value = toStr(v);
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
    recordDependency(st);
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
    registry.changed.add(st);
    scheduleRender();
  }

  el.addEventListener('input', push);
  el.addEventListener('change', push);
  runBinding({ el, type: 'model', update: pull });
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
  if (forExpr) return bindInsertList(el, forExpr);

  const textExpr = el.getAttribute('text');
  const htmlExpr = el.getAttribute('html');
  if (textExpr || htmlExpr) return bindInsertScalar(el, textExpr, htmlExpr);
}

function bindInsertScalar(el, textExpr, htmlExpr) {
  const fallback = el.innerHTML;

  function scanSlotsAndHide() {
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
    return slots;
  }

  let slots = scanSlotsAndHide();

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
    const showEmpty = status === 'ready' && hasValue === false;
    if (slots.loading) isLoading ? slots.loading.removeAttribute('hidden') : slots.loading.setAttribute('hidden', '');
    if (slots.error) isError ? slots.error.removeAttribute('hidden') : slots.error.setAttribute('hidden', '');
    if (slots.empty) showEmpty ? slots.empty.removeAttribute('hidden') : slots.empty.setAttribute('hidden', '');
  }

  function update() {
    try {
      if (textExpr) {
        const v = safeEval(textExpr, el);

        const src = ownerSrc();
        const hasVal = src ? !(src.value == null || (Array.isArray(src.value) && src.value.length === 0)) : (v != null);

        if (v === undefined || v === null || !hasVal) {
          el.innerHTML = fallback;
          slots = scanSlotsAndHide();
        }
        else {
          el.textContent = toStr(v);
        }

        updateSlots(src?.status, hasVal);
      }
      else if (htmlExpr) {
        const v = safeEval(htmlExpr, el);

        const src = ownerSrc();
        const hasVal = src ? !(src.value == null || (Array.isArray(src.value) && src.value.length === 0)) : (v != null);

        if (v === undefined || v === null || !hasVal) {
          el.innerHTML = fallback;
          slots = scanSlotsAndHide();
        }
        else {
          el.innerHTML = toStr(v);
        }

        updateSlots(src?.status, hasVal);
      }
    } catch {
      el.innerHTML = fallback;
      slots = scanSlotsAndHide();
      const src = ownerSrc();
      updateSlots(src?.status, false);
    }
  }

  runBinding({ el, type: 'insert-scalar', update });
}

function bindInsertList(el, forExpr) {
  // Parse left and right of `in`
  const m = String(forExpr).match(/^(.+?)\s+in\s+(.+)$/);
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
    const showEmpty = status === 'ready' && !hasItems;
    if (slotLoading) isLoading ? slotLoading.removeAttribute('hidden') : slotLoading.setAttribute('hidden', '');
    if (slotError) isError ? slotError.removeAttribute('hidden') : slotError.setAttribute('hidden', '');
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
    const s = String(expr);
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
            else if (v === true) el.setAttribute(real, '');
            else el.setAttribute(real, toStr(v));
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
          if (k !== desiredKeys[i]) {
            same = false;
            break;
          }
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

      for (const leftover of existingMap.values()) leftover.remove();

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

  runBinding({ el, type: 'insert-list', update });
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

export { bindAll };
