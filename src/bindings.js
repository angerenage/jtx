/* eslint-env browser */

import { registry, runBinding, scheduleRender, recordDependency, registerCleanup, fire, sanitizeHtml } from './core.js';
import { safeEval, execute, buildCtx, preprocessExpr, unwrapRef, resolveState } from './context.js';
import { toStr, isObj, deepGet, parseDuration, structuredCloneSafe, parsePath, deepGetByPath, deepSetByPath } from './utils.js';
import { parseOnAttribute } from './on-parser.mjs';
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
    if (v === undefined || v === null) el.innerHTML = sanitizeHtml(fallback, el);
    else el.innerHTML = sanitizeHtml(toStr(v), el);
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
  const pathSegs = parsePath(key);
  const topKey = pathSegs[0] ?? key;
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
    const st = resolveState(stateName, el);
    if (!st) return;
    recordDependency(st);
    const v = Array.isArray(pathSegs) && pathSegs.length ? deepGetByPath(st.value, pathSegs) : deepGet(st.value, key);
    writeModel(v);
  }

  function push() {
    const st = resolveState(stateName, el);
    if (!st) return;
    const newVal = readModel();
    if (Array.isArray(pathSegs) && pathSegs.length > 1) {
      deepSetByPath(st.value, pathSegs, newVal);
      st.pendingKeys.add(topKey);
    }
    else {
      st.value[topKey] = newVal;
      st.pendingKeys.add(topKey);
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
  const pairs = parseOnAttribute(expr);

  const timers = [];
  for (const { event, code } of pairs) {
    if (event.startsWith('every ')) {
      const ms = parseDuration(event.slice('every '.length));
      if (ms > 0) {
        const id = setInterval(async () => {
          try { await execute(code, buildCtx(el, new CustomEvent('every')), locals || {}, false); }
          catch (e) { console.error('[JTX] jtx-on every error', e); }
          finally { scheduleRender(); }
        }, ms);
        timers.push(id);
      }
      continue;
    }

    el.addEventListener(event, async (ev) => {
      try { await execute(code, buildCtx(el, ev), locals || {}, false); }
      catch (e) { console.error('[JTX] jtx-on error', e); }
      finally { scheduleRender(); }
    });
  }

  if (timers.length) {
    periodicMap.set(el, timers);
    // Cleanup timers when element is removed
    registerCleanup(el, () => {
      const arr = periodicMap.get(el) || [];
      for (const id of arr) {
        try { clearInterval(id); } catch { /* ignore */ }
      }
      periodicMap.delete(el);
    });
  }
}

// jtx-on for definition elements (self-only)
function bindOnSelf(el, expr, locals) {
  const pairs = parseOnAttribute(expr);

  const timers = [];
  for (const { event, code } of pairs) {
    if (event.startsWith('every ')) {
      const ms = parseDuration(event.slice('every '.length));
      if (ms > 0) {
        const id = setInterval(async () => {
          try { await execute(code, buildCtx(el, new CustomEvent('every')), locals || {}, false); }
          catch (e) { console.error('[JTX] jtx-on every error', e); }
          finally { scheduleRender(); }
        }, ms);
        timers.push(id);
      }
      continue;
    }

    el.addEventListener(event, async (ev) => {
      if (ev.target !== el) return; // ignore bubbled events from children
      try { await execute(code, buildCtx(el, ev), locals || {}, false); }
      catch (e) { console.error('[JTX] jtx-on error', e); }
      finally { scheduleRender(); }
    });
  }

  if (timers.length) {
    periodicMap.set(el, timers);
    // Cleanup timers when element is removed
    registerCleanup(el, () => {
      const arr = periodicMap.get(el) || [];
      for (const id of arr) {
        try { clearInterval(id); } catch { /* ignore */ }
      }
      periodicMap.delete(el);
    });
  }
}

function getOwnerSrc(el) {
  const srcEl = el.closest('jtx-src');
  if (!srcEl) return null;
  const name = srcEl.getAttribute('name');
  if (!name) return null;
  return registry.srcs.get(name) || null;
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

  const slots = scanSlotsAndHide();

  // Use shared helper to query owning src
  const ownerSrc = () => getOwnerSrc(el);

  function isSpecialNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName.toLowerCase();
    return tag === 'jtx-loading' || tag === 'jtx-error' || tag === 'jtx-empty';
  }

  function updateSlots(status, hasValue) {
    const isLoading = status === 'loading';
    const isError = status === 'error';
    const isEmpty = status === 'ready' && hasValue === false;
    if (slots.loading) isLoading ? slots.loading.removeAttribute('hidden') : slots.loading.setAttribute('hidden', '');
    if (slots.error) isError ? slots.error.removeAttribute('hidden') : slots.error.setAttribute('hidden', '');
    if (slots.empty) isEmpty ? slots.empty.removeAttribute('hidden') : slots.empty.setAttribute('hidden', '');

    if ((slots.loading && isLoading) || (slots.error && isError) || (slots.empty && isEmpty)) {
      for (const child of Array.from(el.childNodes)) {
        if (!isSpecialNode(child)) child.remove();
      }
    }
  }

  function update() {
    if (textExpr) {
      const v = safeEval(textExpr, el);

      const src = ownerSrc();
      const hasVal = src ? !(src.value == null || (Array.isArray(src.value) && src.value.length === 0)) : (v != null);

      if (v !== undefined && v !== null && hasVal) {
        el.textContent = toStr(v);
      }
      updateSlots(src?.status, hasVal);
    }
    else if (htmlExpr) {
      const v = safeEval(htmlExpr, el);

      const src = ownerSrc();
      const hasVal = src ? !(src.value == null || (Array.isArray(src.value) && src.value.length === 0)) : (v != null);

      if (v !== undefined && v !== null && hasVal) {
        for (const child of Array.from(el.childNodes)) {
          if (!isSpecialNode(child)) child.remove();
        }
        el.insertAdjacentHTML('afterbegin', toStr(v));
      }
      updateSlots(src?.status, hasVal);
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
  const strategyAttr = (el.getAttribute('strategy') || 'replace').toLowerCase();
  const strategyTokens = new Set(strategyAttr.split(/\s+/).filter(Boolean));
  const isReplaceStrategy = strategyTokens.has('replace') || (!strategyTokens.has('append') && !strategyTokens.has('prepend') && !strategyTokens.has('merge'));
  const isAppendOnly = strategyTokens.has('append') && !strategyTokens.has('merge');
  const isPrependOnly = strategyTokens.has('prepend') && !strategyTokens.has('merge');
  const isMergeStrategy = strategyTokens.has('merge');
  const windowSize = (() => {
    const w = parseInt(el.getAttribute('window') || '', 10);
    return Number.isFinite(w) && w > 0 ? w : null;
  })();

  const template = el.querySelector('jtx-template');
  if (!template || !template.firstElementChild) {
    console.warn('[JTX] jtx-insert requires a <jtx-template> with one root element');
  }
  if (template) template.setAttribute('hidden', '');

  function scanSlots() {
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
        // Intentionally do NOT hide here so it's visible from the start
      }
    }
    return slots;
  }

  const slots = scanSlots();
  const mergeState = isMergeStrategy ? { order: [], map: new Map() } : null;
  let prevCount = 0;
  let initFired = false;

  // Use shared helper to query owning src
  const ownerSrc = () => getOwnerSrc(el);

  function updateSlots(status, hasItems) {
    const isLoading = status === 'loading';
    const isError = status === 'error';
    const isEmpty = !hasItems && !isLoading && !isError;
    if (slots.loading) isLoading ? slots.loading.removeAttribute('hidden') : slots.loading.setAttribute('hidden', '');
    if (slots.error) isError ? slots.error.removeAttribute('hidden') : slots.error.setAttribute('hidden', '');
    if (slots.empty) isEmpty ? slots.empty.removeAttribute('hidden') : slots.empty.setAttribute('hidden', '');
  }

  function isSpecialNode(node) {
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

  // Trim helpers to keep window size under control without changing semantics
  function trimWindowNodes(windowSize, fromEnd) {
    if (windowSize == null || windowSize < 0) return [];
    const items = currentItemNodes();
    if (items.length <= windowSize) return [];
    const excess = items.length - windowSize;
    const removedKeys = [];
    if (fromEnd) {
      for (let i = 0; i < excess; i++) {
        const n = items[items.length - 1 - i];
        if (!n) continue;
        const rk = n.getAttribute('jtx-key');
        if (rk != null) removedKeys.push(rk);
        try { n.remove(); } catch { /* ignore */ }
      }
    }
    else {
      for (let i = 0; i < excess; i++) {
        const n = items[i];
        if (!n) continue;
        const rk = n.getAttribute('jtx-key');
        if (rk != null) removedKeys.push(rk);
        try { n.remove(); } catch { /* ignore */ }
      }
    }
    return removedKeys;
  }

  function seedMergeStateFromDOMOnce() {
    if (!mergeState) return;
    if (mergeState.order.length !== 0 || mergeState.map.size !== 0) return;
    const existing = currentItemNodes();
    const seen = new Set();
    for (const n of existing) {
      const k = n.getAttribute('jtx-key');
      if (k == null) continue;
      if (seen.has(k)) { try { n.remove(); } catch { /* ignore */ } continue; }
      seen.add(k);
      mergeState.order.push(k);
      mergeState.map.set(k, n);
    }
  }

  function trimWindowMerge(windowSize, prependMode) {
    if (windowSize == null || windowSize < 0) return [];
    const itemsCount = mergeState.order.length;
    if (itemsCount <= windowSize) return [];
    const excess = itemsCount - windowSize;
    const removedKeys = [];
    if (prependMode) {
      for (let i = 0; i < excess; i++) {
        const rk = mergeState.order.pop();
        if (rk == null) continue;
        removedKeys.push(rk);
        const node = mergeState.map.get(rk);
        try { node?.remove(); } catch { /* ignore */ }
        mergeState.map.delete(rk);
      }
    }
    else {
      for (let i = 0; i < excess; i++) {
        const rk = mergeState.order.shift();
        if (rk == null) continue;
        removedKeys.push(rk);
        const node = mergeState.map.get(rk);
        try { node?.remove(); } catch { /* ignore */ }
        mergeState.map.delete(rk);
      }
    }
    return removedKeys;
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

  function evalWithLocalOrder(expr, targetEl, locals, namesOrder, throwOnError = false) {
    try {
      const src = preprocessExpr(expr);
      const ordered = namesOrder.filter((n) => n && Object.prototype.hasOwnProperty.call(locals, n));
      const vals = ordered.map((n) => locals[n]);
      const fn = new Function('ctx', ...ordered, `return ( ${src} );`);
      return fn(buildCtx(targetEl, null), ...vals);
    } catch (e) {
      if (throwOnError) throw e;
      // If this insert is owned by a <jtx-src> that isn't ready yet,
      // skip logging – locals (e.g., item) are often undefined pre-init.
      try {
        const src = ownerSrc();
        if (!src || src.status === 'ready') {
          console.error('[JTX] eval locals error in', expr, e);
        }
      } catch { /* ignore logging issues */ }
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
          el.innerHTML = sanitizeHtml(v == null ? '' : toStr(v), el);
          el.removeAttribute(attrName);
        }
        else {
          bindHtml(el, expr, undefined);
        }
        break;

      case 'jtx-if':
        bindIf(el, expr, locals);
        break;

      case 'jtx-show':
        bindShow(el, expr, locals);
        break;

      case 'jtx-model':
        bindModel(el, expr);
        break;

      case 'jtx-on':
        bindOn(el, expr, locals);
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

  function snapshotStateNodes(node) {
    if (!node || typeof node.querySelectorAll !== 'function') return null;
    const states = Array.from(node.querySelectorAll('jtx-state'));
    if (!states.length) return null;
    const snapshots = [];
    for (const stEl of states) {
      const inst = stEl.__jtxState;
      if (inst && typeof inst.value !== 'undefined') snapshots.push(structuredCloneSafe(inst.value));
      else snapshots.push(undefined);
    }
    return snapshots;
  }

  function createNodeFor(idx, item, rootVal, derivedKey, restoreStates) {
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
      const stateNodes = Array.from(node.querySelectorAll('jtx-state'));
      const restoreArr = Array.isArray(restoreStates) ? restoreStates : null;
      for (let i = 0; i < stateNodes.length; i++) {
        const stEl = stateNodes[i];
        const opts = { register: false };
        if (restoreArr && i < restoreArr.length && typeof restoreArr[i] !== 'undefined') {
          opts.restore = restoreArr[i];
        }
        initState(stEl, locals, opts);
      }
    } catch { /* ignore */ }

    // One-shot compile for locals-referencing attributes; others bind normally without locals
    const localNames = [valVar, hasKeyVar ? keyVar : null, '$', '$index', '$key', '$root'].filter(Boolean);
    compileTemplateOnce(node, locals, localNames);
    return node;
  }


  function computeKey(idx, item, rootVal, strict = false) {
    if (keyExpr) {
      const itm = unwrapRef(item);
      const root = unwrapRef(rootVal);

      const baseLocals = Object.create(null);
      baseLocals[valVar] = itm;
      baseLocals.$ = itm;
      baseLocals.$index = idx;
      if (hasKeyVar) baseLocals[keyVar] = idx;
      baseLocals.$root = root;

      const order = [valVar, hasKeyVar ? keyVar : null, '$', '$index', '$root'].filter(Boolean);

      const v = evalWithLocalOrder(keyExpr, el, baseLocals, order, !!strict);
      return v == null ? idx : v;
    }
    return idx;
  }

  function materializeList(value) {
    const v = unwrapRef(value);
    if (Array.isArray(v)) return v.map((it, i) => ({ idx: i, item: unwrapRef(it) }));
    if (hasKeyVar && isObj(v)) return Object.keys(v).map((k) => ({ idx: k, item: unwrapRef(v[k]) }));
    if (v === undefined || v === null) return [{ idx: 0, item: v }];
    return [{ idx: 0, item: unwrapRef(v) }];
  }

  function update() {
    // If this insert is linked to a <jtx-src> that isn't ready yet, toggle slots.
    try {
      const src = ownerSrc();
      if (src && src.status !== 'ready') {
        const hasExisting = isMergeStrategy ? (mergeState.order.length > 0) : (currentItemNodes().length > 0);
        updateSlots(src.status, hasExisting);
      }
    } catch { /* ignore and proceed */ }

    let rootVal;
    try { rootVal = unwrapRef(safeEval(rhsExpr, el)); } catch (e) {
      try { console.error('[JTX] jtx-insert for error', e); } catch { /* ignore */ }
      fire(el, 'error', { error: e });
      return;
    }
    const entries = materializeList(rootVal);

    // General key validation for strategies that rely on provided keys in a batch
    if ((isReplaceStrategy || isAppendOnly || isPrependOnly) && keyExpr) {
      const seen = new Set();
      for (let i = 0; i < entries.length; i++) {
        const { idx, item } = entries[i];
        let rawKey;
        try { rawKey = computeKey(idx, item, rootVal, true); }
        catch (e) { fire(el, 'error', { error: e }); return; }
        const keyStr = toStr(rawKey);
        if (rawKey == null || keyStr === '') {
          fire(el, 'error', { error: new Error('jtx-insert: invalid key (null/undefined/empty)') });
          return; // abort without touching DOM
        }
        if (seen.has(keyStr)) {
          fire(el, 'error', { error: new Error('jtx-insert: duplicate keys in batch') });
          return; // abort without touching DOM
        }
        seen.add(keyStr);
      }
    }

    if (isReplaceStrategy) {
      // Remove all current nodes and track keys/state snapshots
      const current = currentItemNodes();
      const removedKeys = [];
      const preservedStates = new Map();
      for (const n of current) {
        const k = n.getAttribute('jtx-key');
        if (k != null) {
          removedKeys.push(k);
          const snap = snapshotStateNodes(n);
          if (snap) preservedStates.set(k, snap);
        }
        try { n.remove(); } catch { /* ignore */ }
      }

      // Add all new nodes
      const frag = document.createDocumentFragment();
      const addedItems = [];
      for (const { idx, item } of entries) {
        const key = toStr(computeKey(idx, item, rootVal));
        const restoreStates = preservedStates.get(key) || null;
        preservedStates.delete(key);
        const node = createNodeFor(idx, item, rootVal, key, restoreStates);
        addedItems.push(unwrapRef(item));
        frag.appendChild(node);
      }
      insertBeforeSpecial(frag);

      // Finalize lifecycle for replace (update slots, then init, remove, add, empty)
      const src = ownerSrc();
      const newCount = currentItemNodes().length;
      updateSlots(src?.status, newCount > 0);
      if (!initFired && newCount > 0) { fire(el, 'init', { count: newCount }); initFired = true; }
      if (removedKeys.length) fire(el, 'remove', { keys: removedKeys });
      if (addedItems.length) fire(el, 'add', { items: addedItems });
      if (newCount === 0 && prevCount !== 0) fire(el, 'empty', {});
      prevCount = newCount;
      return;
    }

    if (isAppendOnly || isPrependOnly) {
      const addedItems = [];
      if (isAppendOnly) {
        for (const { idx, item } of entries) {
          const key = toStr(computeKey(idx, item, rootVal));
          const node = createNodeFor(idx, item, rootVal, key, null);
          insertBeforeSpecial(node);
          addedItems.push(unwrapRef(item));
        }
      }
      else {
        for (let i = entries.length - 1; i >= 0; i--) {
          const { idx, item } = entries[i];
          const key = toStr(computeKey(idx, item, rootVal));
          const node = createNodeFor(idx, item, rootVal, key, null);
          insertAtStart(node);
          addedItems.push(unwrapRef(item));
        }
      }

      // window trimming and removal event BEFORE slot/update to preserve ordering
      const removedKeys = trimWindowNodes(windowSize, /*fromEnd*/ isPrependOnly);
      if (removedKeys.length) fire(el, 'remove', { keys: removedKeys });

      // Finalize lifecycle for append/prepend (update slots, then init, add, empty)
      const src = ownerSrc();
      const countNow = currentItemNodes().length;
      updateSlots(src?.status, countNow > 0);
      if (!initFired && countNow > 0) { fire(el, 'init', { count: countNow }); initFired = true; }
      if (addedItems.length) fire(el, 'add', { items: addedItems });
      if (countNow === 0 && prevCount !== 0) fire(el, 'empty', {});
      prevCount = countNow;
      return;
    }

    if (!keyExpr) {
      console.warn('[JTX] jtx-insert merge without a key may not behave as expected (uses index keys)');
    }

    // Seed internal state from existing DOM once (helps after hot reload or static SSR)
    seedMergeStateFromDOMOnce();

    if (entries.length === 0) {
      const hadItems = mergeState.order.length > 0;
      const removedKeys = hadItems ? Array.from(mergeState.order) : [];
      if (removedKeys.length) {
        for (const rk of removedKeys) {
          const node = mergeState.map.get(rk);
          try { node?.remove(); } catch { /* ignore */ }
          mergeState.map.delete(rk);
        }
      }
      mergeState.order.length = 0;

      const src = ownerSrc();
      updateSlots(src?.status, false);

      if (removedKeys.length) fire(el, 'remove', { keys: removedKeys });
      if (hadItems) fire(el, 'empty', {});
      prevCount = 0;
      return;
    }

    // Validate incoming keys: reject null/undefined/empty or duplicates in the same batch
    const seenKeys = new Set();
    for (let i = 0; i < entries.length; i++) {
      const { idx, item } = entries[i];
      let rawKey;
      try { rawKey = computeKey(idx, item, rootVal, true); }
      catch (e) { fire(el, 'error', { error: e }); return; }
      const keyStr = toStr(rawKey);
      if (rawKey == null || keyStr === '') {
        fire(el, 'error', { error: new Error('jtx-insert: invalid key (null/undefined/empty)') });
        return; // do not modify DOM
      }
      if (seenKeys.has(keyStr)) {
        fire(el, 'error', { error: new Error('jtx-insert: duplicate keys in batch') });
        return; // do not modify DOM
      }
      seenKeys.add(keyStr);
    }

    // Deduplicate incoming by key (last wins) after validation
    const incoming = new Map();
    for (let i = 0; i < entries.length; i++) {
      const { idx, item } = entries[i];
      const k = toStr(computeKey(idx, item, rootVal));
      incoming.set(k, { idx, item });
    }

    const addedItems = [];
    const updatedItems = [];
    const prependMode = strategyTokens.has('prepend') && !strategyTokens.has('append');
    const newPrependQueue = [];

    for (const [k, rec] of incoming.entries()) {
      const item = rec.item;
      if (mergeState.map.has(k)) {
        const oldNode = mergeState.map.get(k);
        const displayIdx = mergeState.order.indexOf(k);
        const restoreStates = snapshotStateNodes(oldNode);
        const newNode = createNodeFor(displayIdx, item, rootVal, k, restoreStates);
        try { oldNode.replaceWith(newNode); } catch { /* ignore */ }
        mergeState.map.set(k, newNode);
        updatedItems.push(unwrapRef(item));
      }
      else {
        const displayIdx = prependMode ? 0 : mergeState.order.length;
        const newNode = createNodeFor(displayIdx, item, rootVal, k, null);
        if (prependMode) newPrependQueue.push({ k, node: newNode, item });
        else { insertBeforeSpecial(newNode); mergeState.order.push(k); mergeState.map.set(k, newNode); }
        if (!prependMode) addedItems.push(unwrapRef(item));
      }
    }

    if (prependMode && newPrependQueue.length) {
      // Insert in reverse to preserve incoming order at the beginning
      for (let i = newPrependQueue.length - 1; i >= 0; i--) {
        const { k, node, item } = newPrependQueue[i];
        insertAtStart(node);
        mergeState.order.unshift(k);
        mergeState.map.set(k, node);
        addedItems.push(unwrapRef(item));
      }
    }

    // window trimming (fire remove BEFORE slot/update to preserve ordering)
    const removedKeys = trimWindowMerge(windowSize, prependMode);
    if (removedKeys.length) fire(el, 'remove', { keys: removedKeys });

    // Finalize lifecycle for merge (update slots, then init, add, update, empty)
    const src = ownerSrc();
    const countNow = mergeState.order.length;
    updateSlots(src?.status, countNow > 0);
    if (!initFired && countNow > 0) { fire(el, 'init', { count: countNow }); initFired = true; }
    if (addedItems.length) fire(el, 'add', { items: addedItems });
    if (updatedItems.length) fire(el, 'update', { items: updatedItems });
    if (countNow === 0 && prevCount !== 0) fire(el, 'empty', {});
    prevCount = countNow;
  }

  runBinding({ el, type: 'insert-list', update });

  // Fire clear when the insert is removed from DOM
  registerCleanup(el, () => { try { fire(el, 'clear', {}); } catch { /* ignore */ } });
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

    // skip definitions and template content root,
    // but still allow event handlers on <jtx-state> and <jtx-src>
    const tag = el.tagName.toLowerCase();
    if (tag === 'jtx-state' || tag === 'jtx-src') {
      const onExpr = el.getAttribute('jtx-on');
      if (onExpr != null) {
        try { bindOnSelf(el, onExpr, perItemCtx); } catch { /* ignore */ }
      }
      try { Object.defineProperty(el, '__jtxProcessed', { value: true, configurable: true }); } catch { /* ignore */ }
      node = walker.nextNode();
      continue;
    }
    if (tag === 'jtx-template') {
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
