// Test-only asynchronous hooks compatible with Node 20 module.register.
// Stub source executes in the importing process, not in the loader worker.
let stubs = {};
let sourceRoot;
export function initialize(data) {
  stubs = data.stubs;
  sourceRoot = data.sourceRoot;
}
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(stubs, specifier)) {
    return { shortCircuit: true, url: `jimeng-test-stub:${encodeURIComponent(specifier)}` };
  }
  if (specifier.startsWith('@/api/services/')) {
    return nextResolve(new URL(specifier.slice(2), sourceRoot).href, context);
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('jimeng-test-stub:')) {
    return { shortCircuit: true, format: 'module', source: stubs[decodeURIComponent(url.slice('jimeng-test-stub:'.length))] };
  }
  return nextLoad(url, context);
}
