const assert = require("node:assert");
const { isEmail, isUuid } = require("./validators");

assert.strictEqual(isEmail("team@example.com"), true);
assert.strictEqual(isEmail("not-an-email"), false);
assert.strictEqual(isUuid("123e4567-e89b-12d3-a456-426614174000"), true);
assert.strictEqual(isUuid("not-a-uuid"), false);
console.log("ok");
