import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDom, flush } from './helpers/dom.mjs';
import { loadJTX } from './helpers/jtx.mjs';

test('bindings react to state changes as described in spec §§3.1-3.3', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-state name="ui" counter="0" message="\'hello\'" visible="true">',
    '    <jtx-state name="prefs" theme="\'light\'" persist-url="theme">',
    '      <div id="app">',
    '        <span id="text" jtx-text="@ui.message"></span>',
    '        <div id="if" jtx-if="@ui.visible">Visible</div>',
    '        <div id="show" jtx-show="@ui.visible"></div>',
    '        <span id="attr" jtx-attr-title="\'Clicks: \'+ @ui.counter"></span>',
    '        <div id="flag" jtx-attr-data-on="@ui.visible"></div>',
    '        <div id="html" jtx-html="\'<b>\' + @ui.message + \'</b>\'"></div>',
    '        <span id="mirror" jtx-text="@ui.message"></span>',
    '        <input id="input" type="text" jtx-model="@ui.message">',
    '        <button id="inc" jtx-on="click: @ui.counter++; emit(\'count:changed\', { value: @ui.counter })"></button>',
    '        <button id="toggle" jtx-on="click: @ui.visible = !@ui.visible"></button>',
    '        <button id="theme" jtx-on="click: @prefs.theme = \'dark\'"></button>',
    '      </div>',
    '    </jtx-state>',
    '  </jtx-state>',
    '</body>'
  ].join('');

  const { document, window, cleanup } = createDom(html);
  t.after(cleanup);

  const JTX = await loadJTX();
  JTX.__testReset();
  const emitted = [];
  document.getElementById('app').addEventListener('count:changed', (ev) => emitted.push(ev.detail.value));

  JTX.init(document);
  await flush();

  const text = document.getElementById('text');
  const htmlNode = document.getElementById('html');
  const attrNode = document.getElementById('attr');
  const flagNode = document.getElementById('flag');
  const showNode = document.getElementById('show');

  assert.equal(text.textContent, 'hello');
  assert.equal(htmlNode.innerHTML.toLowerCase(), '<b>hello</b>');
  assert.equal(attrNode.getAttribute('title'), 'Clicks: 0');
  assert(flagNode.hasAttribute('data-on'));
  assert(!showNode.hasAttribute('hidden'));
  assert(document.getElementById('if'));

  const incBtn = document.getElementById('inc');
  incBtn.click();
  await flush();

  assert.equal(attrNode.getAttribute('title'), 'Clicks: 1');
  assert.deepEqual(emitted, [1]);

  const toggleBtn = document.getElementById('toggle');
  toggleBtn.click();
  await flush();

  assert(showNode.hasAttribute('hidden'));
  assert.equal(document.getElementById('if'), null);
  assert(!flagNode.hasAttribute('data-on'));

  toggleBtn.click();
  await flush();

  assert(!showNode.hasAttribute('hidden'));
  assert(document.getElementById('if'));
  assert(flagNode.hasAttribute('data-on'));

  const input = document.getElementById('input');
  input.value = 'world';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush();

  assert.equal(document.getElementById('mirror').textContent, 'world');
  assert.equal(htmlNode.innerHTML.toLowerCase(), '<b>world</b>');

  const themeBtn = document.getElementById('theme');
  themeBtn.click();
  await flush();

  assert.match(window.location.search, /theme=/);
  JTX.__testReset();
});


test('treats literal @ characters in expressions as plain text', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-state name="ui" literal="\'foo@bar.com\'">',
    '    <span id="stateLiteral" jtx-text="@ui.literal"></span>',
    '  </jtx-state>',
    '  <span id="directLiteral" jtx-text="\'foo@bar.com\'"></span>',
    '</body>',
  ].join('');

  const { document, cleanup } = createDom(html);
  t.after(cleanup);

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  assert.equal(document.getElementById('stateLiteral').textContent, 'foo@bar.com');
  assert.equal(document.getElementById('directLiteral').textContent, 'foo@bar.com');
  JTX.__testReset();
});


test('jtx-html uses configured sanitizer', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-state name="ui" raw="\'<script>boom</script>\'" optional="\'<u>start</u>\'">',
    '    <div id="target" jtx-html="@ui.raw"></div>',
    '    <div id="fallback" jtx-html="unknownVar"><span>safe</span></div>',
    '    <div id="withFallback" jtx-html="@ui.optional">Default <strong>value</strong></div>',
    '    <button id="updateRaw" jtx-on="click: @ui.raw = \'<i>changed</i>\'"></button>',
    '    <button id="clearOptional" jtx-on="click: @ui.optional = null"></button>',
    '  </jtx-state>',
    '</body>',
  ].join('');

  const { document, cleanup } = createDom(html);
  t.after(cleanup);

  const JTX = await loadJTX();
  JTX.__testReset();
  t.after(() => JTX.setHtmlSanitizer(null));

  JTX.setHtmlSanitizer((value) => value.replace(/</g, '&lt;'));
  JTX.init(document);
  await flush();

  const target = document.getElementById('target');
  const fallback = document.getElementById('fallback');
  const withFallback = document.getElementById('withFallback');

  assert.equal(target.innerHTML, '&lt;script&gt;boom&lt;/script&gt;');
  assert.equal(fallback.innerHTML, '&lt;span&gt;safe&lt;/span&gt;');
  assert.equal(withFallback.innerHTML, '&lt;u&gt;start&lt;/u&gt;');

  document.getElementById('updateRaw').click();
  await flush();
  assert.equal(target.innerHTML, '&lt;i&gt;changed&lt;/i&gt;');

  document.getElementById('clearOptional').click();
  await flush();
  assert.equal(withFallback.innerHTML, 'Default &lt;strong&gt;value&lt;/strong&gt;');
});


test('state references are scoped to their <jtx-state> descendants', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-state name="ui" counter="0">',
    '    <section>',
    '      <span id="insideValue" jtx-text="@ui.counter"></span>',
    '      <button id="insideInc" jtx-on="click: @ui.counter++"></button>',
    '    </section>',
    '  </jtx-state>',
    '  <section>',
    '    <span id="outsideValue" jtx-text="@ui.counter">fallback</span>',
    '    <button id="outsideInc" jtx-on="click: @ui.counter++"></button>',
    '  </section>',
    '</body>'
  ].join('');

  const { document, cleanup } = createDom(html);
  t.after(cleanup);

  const warnMock = t.mock.method(console, 'warn');

  const JTX = await loadJTX();
  JTX.__testReset();

  JTX.init(document);
  await flush();

  const inside = document.getElementById('insideValue');
  const outside = document.getElementById('outsideValue');

  assert.equal(inside.textContent, '0');
  assert.equal(outside.textContent, 'fallback');

  document.getElementById('outsideInc').click();
  await flush();

  const stateEl = document.querySelector('jtx-state');
  assert(stateEl);
  const state = stateEl.__jtxState;
  assert(state);
  assert.equal(state.value.counter, 0);
  assert.equal(inside.textContent, '0');

  document.getElementById('insideInc').click();
  await flush();

  assert.equal(state.value.counter, 1);
  assert.equal(inside.textContent, '1');
  assert.equal(outside.textContent, 'fallback');

  assert.ok(warnMock.mock.calls.some((call) => String(call.arguments[0]).includes('Unknown reference @ui')));

  JTX.__testReset();
});

test('source references are scoped to their <jtx-src> descendants', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-src name="orders" url="/api/orders" fetch="manual">',
    '    <span id="insideStatus" jtx-text="@orders.$status"></span>',
    '  </jtx-src>',
    '  <span id="outsideStatus" jtx-text="@orders.$status">status</span>',
    '</body>'
  ].join('');

  const { document, cleanup } = createDom(html);
  t.after(cleanup);

  const warnMock = t.mock.method(console, 'warn');

  const JTX = await loadJTX();
  JTX.__testReset();

  JTX.init(document);
  await flush();

  const inside = document.getElementById('insideStatus');
  const outside = document.getElementById('outsideStatus');

  assert.equal(inside.textContent, 'idle');
  assert.equal(outside.textContent, 'status');

  assert.ok(warnMock.mock.calls.some((call) => String(call.arguments[0]).includes('Unknown reference @orders')));

  JTX.__testReset();
});


test('state references traverse shadow roots', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-state name="ui" counter="1">',
    '    <button id="shadowInc" jtx-on="click: @ui.counter++"></button>',
    '    <div id="shadowHost"></div>',
    '  </jtx-state>',
    '</body>'
  ].join('');

  const { document, cleanup } = createDom(html);
  t.after(cleanup);

  const warnMock = t.mock.method(console, 'warn');

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  const host = document.getElementById('shadowHost');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<span id="shadowValue" jtx-text="@ui.counter"></span>';
  JTX.init(shadow);
  await flush();

  assert.equal(shadow.querySelector('#shadowValue').textContent, '1');

  document.getElementById('shadowInc').click();
  await flush();

  assert.equal(shadow.querySelector('#shadowValue').textContent, '2');
  assert.ok(!warnMock.mock.calls.some((call) => String(call.arguments[0]).includes('Unknown reference @ui')));

  JTX.__testReset();
});

test('source references traverse shadow roots', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-src name="orders" url="/api/orders" fetch="manual">',
    '    <div id="srcShadowHost"></div>',
    '  </jtx-src>',
    '</body>'
  ].join('');

  const { document, cleanup } = createDom(html);
  t.after(cleanup);

  const warnMock = t.mock.method(console, 'warn');

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  const host = document.getElementById('srcShadowHost');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<span id="srcShadowValue" jtx-text="@orders.$status"></span>';
  JTX.init(shadow);
  await flush();

  assert.equal(shadow.querySelector('#srcShadowValue').textContent, 'idle');
  assert.ok(!warnMock.mock.calls.some((call) => String(call.arguments[0]).includes('Unknown reference @orders')));

  JTX.__testReset();
});
