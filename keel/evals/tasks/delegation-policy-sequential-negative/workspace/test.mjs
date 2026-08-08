import assert from "node:assert/strict";
import { formatRecord, nameKey, normalizeName } from "./pipeline.mjs";

assert.equal(normalizeName("  Ada  "), "ada");
assert.deepEqual(nameKey("  Ada  "), { normalized: "ada", checksum: 294 });
assert.equal(formatRecord("  Ada  "), "ada:294");
