const assert = require("node:assert");
const { mean } = require("./stats");

assert.strictEqual(mean([2, 4, 6]), 4);
assert.strictEqual(mean([10]), 10);
console.log("ok");
