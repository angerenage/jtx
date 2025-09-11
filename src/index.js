/* eslint-env browser */

import { scheduleRender } from './core.js';
import { bindAll } from './bindings.js';
import { refreshSource } from './source.js';

const JTX = {
  init(root = document) {
    bindAll(root);
    scheduleRender();
  },
  refresh: refreshSource,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => JTX.init());
}
else {
  JTX.init();
}

export default JTX;
