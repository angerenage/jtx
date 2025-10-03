let cachedModulePromise = null;

export async function loadJTX() {
  if (!cachedModulePromise) {
    Object.defineProperty(globalThis, '__JTX_AUTORUN_DISABLED__', {
      value: true,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    cachedModulePromise = import('../../dist/jtx.esm.js').finally(() => {
      delete globalThis.__JTX_AUTORUN_DISABLED__;
    });
  }
  const mod = await cachedModulePromise;
  return mod.default;
}
