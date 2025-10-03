import { JSDOM } from 'jsdom';

const GLOBAL_KEYS = [
  'window',
  'document',
  'Node',
  'NodeFilter',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'CustomEvent',
  'Event',
  'EventTarget',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'performance',
  'DOMParser',
  'DocumentFragment',
  'Text',
  'Comment',
];

function installGlobal(domWindow, key, records) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, key);
  const prevDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(globalThis, key) : undefined;
  records.set(key, {
    hadOwn,
    descriptor: prevDescriptor ? { ...prevDescriptor } : null,
  });
  Object.defineProperty(globalThis, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: domWindow[key],
  });
}

export function createDom(html = '<body></body>', options = {}) {
  const markup = '<!DOCTYPE html><html>' + html + '</html>';
  const dom = new JSDOM(markup, {
    url: options.url || 'https://example.test/',
    pretendToBeVisual: true,
  });

  const previous = new Map();
  for (const key of GLOBAL_KEYS) {
    if (key in dom.window) {
      installGlobal(dom.window, key, previous);
    }
  }

  const cleanup = () => {
    for (const key of GLOBAL_KEYS) {
      if (!previous.has(key)) continue;
      const record = previous.get(key);
      if (record.hadOwn) {
        if (record.descriptor) {
          Object.defineProperty(globalThis, key, record.descriptor);
        }
        else {
          delete globalThis[key];
        }
      }
      else {
        delete globalThis[key];
      }
    }
    dom.window.close();
  };

  return { dom, cleanup, window: dom.window, document: dom.window.document };
}

export async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
