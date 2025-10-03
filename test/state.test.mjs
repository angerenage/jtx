import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDom, flush } from './helpers/dom.mjs';
import { loadJTX } from './helpers/jtx.mjs';

test('initialises state keys from attributes and emits init per spec §2.1', { concurrency: false }, async (t) => {
  const { document, cleanup } = createDom('<body><jtx-state name="ui" counter="1 + 2" theme="\'light\'"></jtx-state></body>');
  t.after(cleanup);

  const el = document.querySelector('jtx-state');
  const initEvents = [];
  el.addEventListener('init', (ev) => initEvents.push(ev));

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  const state = el.__jtxState;
  assert(state);
  assert.deepEqual(state.value, { counter: 3, theme: 'light' });
  assert.equal(initEvents.length, 1);
  assert.equal(initEvents[0].detail.name, 'ui');
  assert.deepEqual(initEvents[0].detail.value, { counter: 3, theme: 'light' });
  assert.notStrictEqual(initEvents[0].detail.value, state.value);
  JTX.__testReset();
});

test('dispatches error event when an attribute expression throws (spec §2.1)', { concurrency: false }, async (t) => {
  const { document, cleanup } = createDom('<body><jtx-state name="bad" broken="(()"></jtx-state></body>');
  t.after(cleanup);

  const el = document.querySelector('jtx-state');
  const errors = [];
  el.addEventListener('error', (ev) => errors.push(ev));

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].detail.name, 'bad');
  assert(errors[0].detail.error instanceof Error);
  const state = el.__jtxState;
  assert.ok(state);
  assert.deepEqual(state.value, { broken: undefined });
  JTX.__testReset();
});

test('restores persisted keys from localStorage and tracks them (spec §2.1 persist)', { concurrency: false }, async (t) => {
  const { window, document, cleanup } = createDom('<body></body>');
  t.after(cleanup);

  window.localStorage.setItem('jtx:ui:counter', JSON.stringify(10));
  document.body.innerHTML = '<jtx-state name="ui" counter="0" label="\'default\'" persist="counter, label"></jtx-state>';
  const el = document.querySelector('jtx-state');

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  const state = el.__jtxState;
  assert.equal(state.value.counter, 10);
  assert.equal(state.value.label, 'default');
  assert(state.persistedKeys.has('counter'));
  assert(state.persistedKeys.has('label'));
  JTX.__testReset();
});

test('emits error when persisted value cannot be parsed (spec §2.1 error)', { concurrency: false }, async (t) => {
  const { window, document, cleanup } = createDom('<body></body>');
  t.after(cleanup);

  window.localStorage.setItem('jtx:oops:counter', 'not-json');
  document.body.innerHTML = '<jtx-state name="oops" counter="0" persist="counter"></jtx-state>';
  const el = document.querySelector('jtx-state');
  const errors = [];
  el.addEventListener('error', (ev) => errors.push(ev));

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].detail.name, 'oops');
  const state = el.__jtxState;
  assert.equal(state.value.counter, 0);
  JTX.__testReset();
});

test('initialises keys from URL when persist-url is provided (spec §4)', { concurrency: false }, async (t) => {
  const { document, cleanup } = createDom('<body><jtx-state name="ui" counter="0" filters="({ foo: \\"bar\\" })" persist-url="counter, filters"></jtx-state></body>', { url: 'https://example.test/?counter=5&filters=%7B%22q%22%3A42%7D' });
  t.after(cleanup);

  const el = document.querySelector('jtx-state');

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  const state = el.__jtxState;
  assert.equal(state.value.counter, 5);
  assert.deepEqual(state.value.filters, { q: 42 });
  assert(state.urlKeys.has('counter'));
  assert(state.urlKeys.has('filters'));
  JTX.__testReset();
});

test('ignores duplicate state names and warns (spec §2.1 unique name)', { concurrency: false }, async (t) => {
  const { document, cleanup } = createDom('<body><jtx-state id="first" name="dup" value="1"></jtx-state><jtx-state id="second" name="dup" value="2"></jtx-state></body>');
  t.after(cleanup);

  const [first, second] = document.querySelectorAll('jtx-state');

  const warnMock = t.mock.method(console, 'warn');
  const initEvents = [];
  second.addEventListener('init', (ev) => initEvents.push(ev));

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  assert.equal(warnMock.mock.calls.length, 1);
  assert.match(String(warnMock.mock.calls[0].arguments[0]), /Duplicate state name/);
  const state = first.__jtxState;
  assert.equal(initEvents.length, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(second, '__jtxState'), false);
  assert.equal(state.value.value, 1);
  JTX.__testReset();
});
