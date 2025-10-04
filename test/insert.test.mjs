import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDom, flush } from './helpers/dom.mjs';
import { loadJTX } from './helpers/jtx.mjs';

function directItemTexts(container) {
  return Array.from(container.children)
    .filter((child) => child.tagName && child.tagName.toLowerCase() === 'li')
    .map((li) => li.textContent.trim());
}

test('jtx-insert list strategies follow spec expectations', { concurrency: false }, async (t) => {
  const html = [
    '<body>',
    '  <jtx-state name="ui" items="[{id:1,title:\'One\'},{id:2,title:\'Two\'}]">',
    '    <ul id="replace-host">',
    '      <jtx-insert id="replace" for="item in @ui.items" key="item.id">',
    '        <jtx-template>',
    '          <li jtx-text="item.title"></li>',
    '        </jtx-template>',
    '        <jtx-empty id="replace-empty">Empty</jtx-empty>',
    '      </jtx-insert>',
    '    </ul>',
    '    <ul id="merge-host">',
    '      <jtx-insert id="merge" for="item in @ui.items" key="item.id" strategy="append merge" window="3">',
    '        <jtx-template>',
    '          <li jtx-text="item.title"></li>',
    '        </jtx-template>',
    '      </jtx-insert>',
    '    </ul>',
    '    <button id="replaceButton" jtx-on="click: @ui.items = [{id:2,title:\'Deux\'},{id:3,title:\'Trois\'}]"></button>',
    '    <button id="appendButton" jtx-on="click: @ui.items = [...@ui.items, {id:4,title:\'Four\'}]"></button>',
    '    <button id="emptyButton" jtx-on="click: @ui.items = []"></button>',
    '  </jtx-state>',
    '</body>'
  ].join('');

  const { document, window, cleanup } = createDom(html);
  window;
  t.after(cleanup);

  const replaceInsert = document.getElementById('replace');
  const mergeInsert = document.getElementById('merge');

  const replaceEvents = { init: 0, add: [], remove: [], empty: 0 };
  replaceInsert.addEventListener('init', (ev) => { replaceEvents.init = ev.detail.count; });
  replaceInsert.addEventListener('add', (ev) => replaceEvents.add.push(ev.detail.items.map((item) => item.title)));
  replaceInsert.addEventListener('remove', (ev) => replaceEvents.remove.push(ev.detail.keys));
  replaceInsert.addEventListener('empty', () => { replaceEvents.empty += 1; });

  const mergeEvents = { add: [], update: [], remove: [], empty: 0 };
  mergeInsert.addEventListener('add', (ev) => mergeEvents.add.push(ev.detail.items.map((item) => item.title)));
  mergeInsert.addEventListener('update', (ev) => mergeEvents.update.push(ev.detail.items.map((item) => item.title)));
  mergeInsert.addEventListener('remove', (ev) => mergeEvents.remove.push(ev.detail.keys));
  mergeInsert.addEventListener('empty', () => { mergeEvents.empty += 1; });

  const JTX = await loadJTX();
  JTX.__testReset();
  JTX.init(document);
  await flush();

  assert.deepEqual(directItemTexts(replaceInsert), ['One', 'Two']);
  assert.deepEqual(directItemTexts(mergeInsert), ['One', 'Two']);
  assert.equal(document.getElementById('replace-empty').hasAttribute('hidden'), true);
  assert.equal(replaceEvents.init, 2);

  document.getElementById('replaceButton').click();
  await flush();

  assert.deepEqual(directItemTexts(replaceInsert), ['Deux', 'Trois']);
  assert.deepEqual(replaceEvents.add.at(-1), ['Deux', 'Trois']);

  assert.deepEqual(directItemTexts(mergeInsert), ['One', 'Deux', 'Trois']);
  assert(mergeEvents.add.at(-1).includes('Trois'));
  assert(mergeEvents.update.some((items) => items.includes('Deux')));
  assert.equal(mergeEvents.remove.length, 0);

  document.getElementById('appendButton').click();
  await flush();

  assert.deepEqual(directItemTexts(replaceInsert), ['Deux', 'Trois', 'Four']);
  const mergeTextsAfterAppend = directItemTexts(mergeInsert);
  assert.deepEqual(mergeTextsAfterAppend, ['Deux', 'Trois', 'Four']);
  assert(mergeEvents.remove.some((keys) => keys.includes('1')));

  document.getElementById('emptyButton').click();
  await flush();

  assert.deepEqual(directItemTexts(replaceInsert), []);
  assert.equal(document.getElementById('replace-empty').hasAttribute('hidden'), false);
  assert.equal(replaceEvents.empty, 1);
  assert(mergeEvents.empty >= 1);
  JTX.__testReset();
});
