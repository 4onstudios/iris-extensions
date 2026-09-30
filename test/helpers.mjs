export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const collect = async (iterable) => {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
};
export function manifest(overrides = {}) {
  return {
    id: "acme.test",
    name: "Test",
    version: "1.0.0",
    apiVersion: 1,
    ...overrides,
  };
}
