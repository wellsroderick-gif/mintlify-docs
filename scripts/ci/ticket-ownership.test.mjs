// WR-47608 S3 (WR-47684) — shared ownership fixture against vendored ticket-ownership-core.mjs.
// Run: node --test scripts/ci/ticket-ownership.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  keyFromBranch,
  titleMentionKeys,
  titleRefusalReason,
  titleStrongKeys,
} from "./ticket-ownership-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, "ticket-ownership-cases.json"), "utf8"),
);

describe("titleStrongKeys / titleMentionKeys (shared fixture)", () => {
  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      assert.deepEqual([...titleStrongKeys(c.input)].sort(), [...c.owns].sort());
      assert.deepEqual([...titleMentionKeys(c.input)].sort(), [...(c.mentions ?? [])].sort());
    });
  }

  it("RED: owning every token would wrongly count passing mentions", () => {
    const owned = titleStrongKeys("WR-1: x (prep for WR-2)");
    assert.ok(!owned.includes("WR-2"));
    assert.ok(
      !titleStrongKeys("WR-46361: step labels (drift gate prep for WR-45308)").includes("WR-45308"),
    );
  });
});

describe("keyFromBranch (shared fixture)", () => {
  for (const c of FIXTURE.branchCases) {
    it(c.name, () => {
      assert.equal(keyFromBranch(c.input), c.key);
    });
  }
});

describe("titleRefusalReason (shared fixture)", () => {
  for (const c of FIXTURE.refusalCases) {
    it(c.name, () => {
      assert.equal(titleRefusalReason(c.title, c.ownKey), c.reason);
    });
  }
});