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
