import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDom, flush } from './helpers/dom.mjs';
import { loadJTX } from './helpers/jtx.mjs';

class ResponseStub {
  constructor({ ok = true, status = 200, body = '' }) {
    this.ok = ok;
    this.status = status;
    this._body = body;
  }
  async text() {
    return this._body;
  }
}

function setupFetchStub(plans) {
  const pending = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (!plans.length) throw new Error('Unexpected fetch');
    const plan = plans.shift();
    if (plan.type === 'deferred') {
      return new Promise((resolve) => {
        pending.push({ resolve, response: plan.response });
      });
    }
    if (plan.type === 'value') {
      return Promise.resolve(new ResponseStub(plan.response));
    }
    if (typeof plan === 'function') {
      return plan(url, options);
    }
    throw new Error('Unknown fetch plan');
  };
  return {
    pending,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function directItemTexts(container) {
  return Array.from(container.children)
    .filter((child) => child.tagName && child.tagName.toLowerCase() === 'li')
    .map((li) => li.textContent.trim());
}

test('http sources follow spec lifecycle: status, slots, update and error handling', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-src name="orders" url="/api/orders" fetch="manual">',
    '    <span id="status" jtx-text="@orders.$status"></span>',
    '    <jtx-insert id="orders" for="order in @orders" key="order.id">',
    '      <jtx-template>',
    '        <li jtx-text="order.title"></li>',
    '      </jtx-template>',
    '      <jtx-loading id="loading">Loading</jtx-loading>',
    '      <jtx-error id="error">Error</jtx-error>',
    '      <jtx-empty id="empty">Empty</jtx-empty>',
    '    </jtx-insert>',
    '  </jtx-src>',
    '</body>'
  ].join('');

  const { document, cleanup } = createDom(html);
  const srcEl = document.querySelector('jtx-src');
  const updates = [];
  srcEl.addEventListener('update', (ev) => updates.push(ev.detail.value));
  const errors = [];
  srcEl.addEventListener('error', (ev) => errors.push(ev.detail));

  const JTX = await loadJTX();
  JTX.__testReset();

  const plans = [
    { type: 'deferred', response: { ok: true, status: 200, body: '[{"id":1,"title":"Order #1"}]' } },
    { type: 'value', response: { ok: false, status: 500, body: '' } },
  ];
  const fetchControl = setupFetchStub(plans);

  t.after(() => {
    fetchControl.restore();
    cleanup();
  });

  JTX.init(document);
  await flush();

  assert.equal(document.getElementById('status').textContent, 'idle');

  const refreshPromise = JTX.refresh('orders');
  await flush();

  assert.equal(document.getElementById('status').textContent, 'loading');
  assert.equal(document.getElementById('loading').hasAttribute('hidden'), false);

  const pending = fetchControl.pending.shift();
  pending.resolve(new ResponseStub(pending.response));
  await refreshPromise;
  await flush();

  assert.equal(document.getElementById('status').textContent, 'ready');
  assert.deepEqual(directItemTexts(document.getElementById('orders')), ['Order #1']);
  assert.equal(document.getElementById('loading').hasAttribute('hidden'), true);
  assert.equal(document.getElementById('error').hasAttribute('hidden'), true);
  assert.equal(document.getElementById('empty').hasAttribute('hidden'), true);
  assert.equal(updates.length, 1);

  await JTX.refresh('orders');
  await flush();

  assert.equal(document.getElementById('status').textContent, 'error');
  assert.equal(document.getElementById('error').hasAttribute('hidden'), false);
  assert.deepEqual(directItemTexts(document.getElementById('orders')), ['Order #1']);
  assert.equal(errors.at(-1).status, 500);
  JTX.__testReset();
});

test('sse sources append stream data and honour merge strategy', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-src name="events" url="sse:/stream">',
    '    <jtx-insert id="events" for="evt in @events" key="evt.id" strategy="append merge" window="2">',
    '      <jtx-template>',
    '        <li jtx-text="evt.title"></li>',
    '      </jtx-template>',
    '    </jtx-insert>',
    '  </jtx-src>',
    '</body>'
  ].join('');

  const { document, window, cleanup } = createDom(html);

  class FakeEventSource extends window.EventTarget {
    constructor(url) {
      super();
      this.url = url;
      FakeEventSource.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  FakeEventSource.instances = [];

  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;

  const JTX = await loadJTX();
  JTX.__testReset();

  t.after(() => {
    globalThis.EventSource = originalEventSource;
    cleanup();
  });

  JTX.init(document);
  await flush();

  const es = FakeEventSource.instances[0];
  assert.ok(es);

  es.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify({ id: 1, title: 'Alpha' }) }));
  await flush();
  assert.deepEqual(directItemTexts(document.getElementById('events')), ['Alpha']);

  es.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify({ id: 2, title: 'Beta' }) }));
  await flush();
  assert.deepEqual(directItemTexts(document.getElementById('events')), ['Alpha', 'Beta']);

  es.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify({ id: 1, title: 'Alpha v2' }) }));
  await flush();
  assert.deepEqual(directItemTexts(document.getElementById('events')), ['Alpha v2', 'Beta']);

  es.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify({ id: 3, title: 'Gamma' }) }));
  await flush();
  assert.deepEqual(directItemTexts(document.getElementById('events')), ['Beta', 'Gamma']);
  JTX.__testReset();
});
