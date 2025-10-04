/* eslint-env browser */

import { scheduleRender, registry, setHtmlSanitizer } from './core.js';
import { bindAll } from './bindings.js';
import { refreshSource } from './source.js';

const JTX = {
  init(root = document) {
    bindAll(root);
    scheduleRender();
  },
  refresh: refreshSource,
  setHtmlSanitizer,
};

if (typeof window !== 'undefined') {
  Object.defineProperty(JTX, '__testReset', {
    value() {
      registry.states.clear();
      registry.srcs.clear();
      registry.bindingDeps.clear();
      registry.depBindings.clear();
      registry.changed.clear();
      setHtmlSanitizer(null);
    },
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

const shouldAutoInit = typeof document !== 'undefined' && !globalThis.__JTX_AUTORUN_DISABLED__;

if (shouldAutoInit) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => JTX.init());
  }
  else {
    JTX.init();
  }
}

export default JTX;
