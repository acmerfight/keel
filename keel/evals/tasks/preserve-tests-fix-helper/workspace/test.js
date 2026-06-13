const assert = require("node:assert");
const { clamp } = require("./helpers");

assert.strictEqual(clamp(5, 0, 10), 5);
assert.strictEqual(clamp(-2, 0, 10), 0);
assert.strictEqual(clamp(12, 0, 10), 10);
console.log("ok");
