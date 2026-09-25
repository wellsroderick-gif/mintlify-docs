// WR-9862 — help merge gate decisions. Run with: node --test scripts/ci/help-merge-gate.test.mjs
// Every "holds" case sits beside a green one, so a fixture that silently arrives clean cannot pass
// for the wrong reason.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import {
  CLOSE_MARKER,
  HOLD_MARKER,
  blockerSpent,
  closeDecision,
  closedCommentBody,
  helpCandidates,
  holdCommentBody,
  judgeBlockers,
  judgeChecks,
  judgeMergeable,
  judgePaths,
  keyFromBranch,
  notHelpTicketBody,
  ticketKeyOf,
} from "./help-merge-gate.mjs";
import { manifestFrom, proofFromReleases } from "./release-proof-core.mjs";

const REPO = "wellsroderick-gif/mintlify-docs";
const read = (/** @type {string} */ rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

describe("which ticket a PR names", () => {
  it("the branch key, whatever the one-segment prefix", () => {
    assert.equal(keyFromBranch("mintlify-mcp/wr-8357-changelog-event-invitations"), "WR-8357");
    assert.equal(keyFromBranch("admin-mcp/wr-5483-help-content-accuracy-8436808"), "WR-5483");
    assert.equal(keyFromBranch("claude/WR-5808-help-center-corpus-integrity"), "WR-5808");
    assert.equal(keyFromBranch("claude/wr-9862"), "WR-9862");
  });
  it("no key in the branch is null, and a key that is not the leading slug token is not one", () => {
    assert.equal(keyFromBranch("mintlify-mcp/whatsnew-body-fix-a0393cc"), null);
    assert.equal(keyFromBranch("mintlify-mcp/fix-wr-5438-flag"), null);
    assert.equal(keyFromBranch("mintlify-mcp/wr-12x"), null);
    assert.equal(keyFromBranch(undefined), null);
  });
  it("the branch wins over the title", () => {
    assert.equal(ticketKeyOf({ headRef: "mintlify-mcp/wr-5608-heading-casing-fix", title: "Heading casing (WR-3093)" }), "WR-5608");
  });
  it("a keyless branch falls back to the ONE key in the title", () => {
    assert.equal(ticketKeyOf({ headRef: "mintlify-mcp/fix-life-buoy-icon", title: "Fix Contact Us card icon (WR-5438)" }), "WR-5438");
  });
  it("two keys in the title is ambiguous, so no ticket", () => {
    assert.equal(ticketKeyOf({ headRef: "mintlify-mcp/settings", title: "Billing sweep (WR-3628, WR-3665)" }), null);
    assert.equal(ticketKeyOf({ headRef: "mintlify-mcp/settings", title: "Billing sweep" }), null);
  });
});

describe("which PRs the gate considers", () => {
  const pr = (/** @type {any} */ over) => ({
    number: 10,
    state: "open",
    draft: false,
    base: { ref: "main" },
    head: { ref: "mintlify-mcp/wr-1-x", repo: { full_name: REPO }, sha: "abc" },
    ...over,
  });
  it("an open, ready help PR from this repo into main is a candidate", () => {
    assert.deepEqual(helpCandidates([pr({})], REPO).map((p) => p.number), [10]);
    assert.deepEqual(helpCandidates([pr({ head: { ref: "admin-mcp/wr-2-y", repo: { full_name: REPO } } })], REPO).length, 1);
  });
  it("a draft, a fork, another base, a closed PR and a non-help branch are not", () => {
    assert.equal(helpCandidates([pr({ draft: true })], REPO).length, 0);
    assert.equal(helpCandidates([pr({ head: { ref: "mintlify-mcp/wr-1-x", repo: { full_name: "someone/fork" } } })], REPO).length, 0);
    assert.equal(helpCandidates([pr({ head: { ref: "mintlify-mcp/wr-1-x", repo: null } })], REPO).length, 0);
    assert.equal(helpCandidates([pr({ base: { ref: "develop" } })], REPO).length, 0);
    assert.equal(helpCandidates([pr({ state: "closed" })], REPO).length, 0);
    assert.equal(helpCandidates([pr({ head: { ref: "claude/wr-9862-help-merge-gate", repo: { full_name: REPO } } })], REPO).length, 0);
  });
  it("candidates come oldest first", () => {
    assert.deepEqual(helpCandidates([pr({ number: 12 }), pr({ number: 11 })], REPO).map((p) => p.number), [11, 12]);
  });
});

describe("path veto", () => {
  it("content-only PRs pass", () => {
    assert.equal(judgePaths([{ filename: "guides/events.mdx" }, { filename: "docs.json" }]).ok, true);
  });
  it("a workflow edit, a script edit, or a rename out of either holds", () => {
    assert.equal(judgePaths([{ filename: "guides/events.mdx" }, { filename: ".github/workflows/auto-merge-help-prs.yml" }]).ok, false);
    assert.equal(judgePaths([{ filename: "scripts/ci/help-merge-gate.mjs" }]).ok, false);
    assert.equal(judgePaths([{ filename: "guides/x.mjs", previous_filename: "scripts/ci/help-merge-gate.mjs" }]).ok, false);
  });
});

describe("Help PR checks on the head", () => {
  const run = (/** @type {any} */ over) => ({ id: 1, created_at: "2026-09-24T10:00:00Z", status: "completed", conclusion: "success", ...over });
  it("the newest run green passes", () => {
    assert.equal(judgeChecks([run({})]).ok, true);
    assert.equal(judgeChecks([run({ conclusion: "failure" }), run({ id: 2, created_at: "2026-09-24T11:00:00Z" })]).ok, true);
  });
  it("no run, a newest run still going, or a newest run red holds", () => {
    assert.equal(judgeChecks([]).ok, false);
    assert.equal(judgeChecks([run({}), run({ id: 2, created_at: "2026-09-24T11:00:00Z", status: "in_progress", conclusion: null })]).ok, false);
    assert.equal(judgeChecks([run({}), run({ id: 2, created_at: "2026-09-24T11:00:00Z", conclusion: "failure" })]).ok, false);
    assert.equal(judgeChecks([run({ conclusion: "cancelled" })]).ok, false);
  });
});

describe("mergeability", () => {
  it("only GitHub's true passes", () => {
    assert.equal(judgeMergeable({ mergeable: true }).ok, true);
    assert.equal(judgeMergeable({ mergeable: false }).ok, false);
    assert.equal(judgeMergeable({ mergeable: null }).ok, false);
    assert.equal(judgeMergeable(null).ok, false);
  });
});

describe("blockers — spent by release proof, never by state", () => {
  const fx = JSON.parse(read("./release-proof-cases.json"));
  const ctx = { releases: [fx.release], mergedKeys: new Set(["WR-900"]) };

  for (const c of fx.cases) {
    it(`shared fixture: ${c.name}`, () => {
      assert.equal(proofFromReleases(c.key, [{ ...fx.release, ...c.mutate }]).proven, c.proven);
    });
  }
  it("a WR-Games blocker shipped in a verified release is spent", () => {
    assert.equal(blockerSpent({ identifier: "WR-7165", stateType: "completed", labels: ["Improvement"] }, ctx).spent, true);
  });
  it("a WR-Games blocker that is Done but in no verified release is NOT spent", () => {
    assert.equal(blockerSpent({ identifier: "WR-5000", stateType: "completed", labels: [] }, ctx).spent, false);
  });
  it("a CANCELED WR-Games blocker is NOT spent", () => {
    assert.equal(blockerSpent({ identifier: "WR-5000", stateType: "canceled", labels: [] }, ctx).spent, false);
  });
  it("a repo:mintlify-docs blocker is spent only when Done AND merged here", () => {
    assert.equal(blockerSpent({ identifier: "WR-900", stateType: "completed", labels: ["repo:mintlify-docs"] }, ctx).spent, true);
    assert.equal(blockerSpent({ identifier: "WR-900", stateType: "started", labels: ["repo:mintlify-docs"] }, ctx).spent, false);
    assert.equal(blockerSpent({ identifier: "WR-901", stateType: "completed", labels: ["repo:mintlify-docs"] }, ctx).spent, false);
    assert.equal(blockerSpent({ identifier: "WR-900", stateType: "canceled", labels: ["repo:mintlify-docs"] }, ctx).spent, false);
  });
  it("another repo's label, or an unreadable blocker, is NOT spent", () => {
    assert.equal(blockerSpent({ identifier: "WR-900", stateType: "completed", labels: ["repo:command-admin"] }, ctx).spent, false);
    assert.equal(blockerSpent({ identifier: "WR-900", stateType: "completed", labels: ["repo:mintlify-docs", "repo:command-admin"] }, ctx).spent, false);
    assert.equal(blockerSpent({ identifier: "WR-7165" }, ctx).spent, false);
    assert.equal(blockerSpent({}, ctx).spent, false);
  });
  it("the list: no blocker passes; unreadable, truncated or one live blocker holds", () => {
    assert.equal(judgeBlockers({ blockers: [], truncated: false }, ctx).ok, true);
    assert.equal(judgeBlockers({ blockers: [{ identifier: "WR-7165", stateType: "completed", labels: [] }], truncated: false }, ctx).ok, true);
    assert.equal(judgeBlockers(null, ctx).ok, false);
    assert.equal(judgeBlockers({ blockers: [], truncated: true }, ctx).ok, false);
    const mixed = judgeBlockers(
      { blockers: [{ identifier: "WR-7165", stateType: "completed", labels: [] }, { identifier: "WR-5000", stateType: "started", labels: [] }], truncated: false },
      ctx,
    );
    assert.equal(mixed.ok, false);
    assert.match(mixed.reason, /WR-5000/);
    assert.doesNotMatch(mixed.reason, /WR-7165/);
  });
});

describe("closing the ticket a merged PR names", () => {
  const issue = (/** @type {any} */ over) => ({ state: { type: "unstarted" }, labels: { nodes: [] }, project: null, ...over });
  it("a help ticket closes: a help label, repo:mintlify-docs, or the Helpdesk project", () => {
    assert.equal(closeDecision(issue({ labels: { nodes: [{ name: "help-content" }] } })), "close");
    assert.equal(closeDecision(issue({ labels: { nodes: [{ name: "changelog" }] } })), "close");
    assert.equal(closeDecision(issue({ labels: { nodes: [{ name: "repo:mintlify-docs" }] } })), "close");
    assert.equal(closeDecision(issue({ project: { name: "Helpdesk & Support Integration" } })), "close");
  });
  it("a WR-Games ticket is only commented on, whatever its state", () => {
    assert.equal(closeDecision(issue({ labels: { nodes: [{ name: "Bug" }] } })), "comment");
    assert.equal(closeDecision(issue({ state: { type: "started" }, project: { name: "Automation Platform" } })), "comment");
  });
  it("a terminal ticket is left alone, duplicate included", () => {
    for (const type of ["completed", "canceled", "duplicate"]) {
      assert.equal(closeDecision(issue({ state: { type }, labels: { nodes: [{ name: "help-content" }] } })), "skip");
    }
  });
  it("no ticket is nothing", () => assert.equal(closeDecision(null), "none"));
});

describe("comment bodies", () => {
  it("the hold comment leads with its marker and names the reason and head", () => {
    const b = holdCommentBody({ reason: "live blocker(s): WR-1", headSha: "abc123", at: "2026-09-24T00:00:00Z" });
    assert.equal(b.split("\n")[0], HOLD_MARKER);
    assert.match(b, /Live blocker\(s\): WR-1\./);
    assert.match(b, /abc123/);
  });
  it("the close comments carry the marker plus the PR number, which is what makes them once-only", () => {
    assert.equal(closedCommentBody({ prNumber: 7, mergeSha: "def", repo: REPO }).split("\n")[0], `${CLOSE_MARKER} #7`);
    assert.equal(notHelpTicketBody({ prNumber: 7, repo: REPO }).split("\n")[0], `${CLOSE_MARKER} #7`);
    assert.match(notHelpTicketBody({ prNumber: 7, repo: REPO }), /state is unchanged/);
  });
});

describe("the vendored release-proof core", () => {
  it("imports nothing, so it can be carried byte-identical", () => {
    assert.doesNotMatch(read("./release-proof-core.mjs"), /^\s*import\s/m);
  });
  it("reads a mention-link manifest", () => {
    assert.deepEqual(manifestFrom("## Manifest\n\n* [WR-7590](https://linear.app/x) title\n"), ["WR-7590"]);
  });
});

describe("the workflows keep PR code and PR text away from the Linear key", () => {
  const trusted = read("../../.github/workflows/auto-merge-help-prs.yml");
  const checks = read("../../.github/workflows/help-pr-checks.yml");

  /** Every line of every `run:` value, block scalars included. @param {string} yml */
  function runLines(yml) {
    const lines = yml.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      out.push(m[2]);
      if (/^[|>]/.test(m[2])) {
        for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > m[1].length); j++) out.push(lines[j]);
      }
    }
    return out;
  }

  it("no run: line in either workflow interpolates an expression", () => {
    for (const yml of [trusted, checks]) {
      assert.ok(runLines(yml).length > 0, "found no run: lines, so the scan proves nothing");
      assert.deepEqual(runLines(yml).filter((l) => l.includes("${{")), []);
    }
  });
  it("the scan catches an interpolated run: line (positive control)", () => {
    assert.equal(runLines("    steps:\n      - run: echo ${{ github.event.pull_request.title }}\n").filter((l) => l.includes("${{")).length, 1);
    assert.equal(runLines("      - name: x\n        run: |\n          echo ok\n          echo ${{ github.head_ref }}\n").filter((l) => l.includes("${{")).length, 1);
  });
  it("the trusted workflow starts only from events that run main's definition", () => {
    assert.doesNotMatch(trusted, /^\s{2}pull_request:/m);
    assert.doesNotMatch(trusted, /^\s{2}push:/m);
    assert.match(trusted, /^\s{2}pull_request_target:/m);
    assert.match(trusted, /^\s{2}workflow_run:/m);
  });
  it("every checkout in the trusted workflow is main, without persisted credentials", () => {
    const checkouts = trusted.split("uses: actions/checkout@").slice(1);
    assert.ok(checkouts.length >= 2);
    for (const c of checkouts) {
      assert.match(c.slice(0, 200), /ref: main\b/);
      assert.match(c.slice(0, 200), /persist-credentials: false/);
    }
    assert.doesNotMatch(trusted, /^\s*ref:.*(head|workflow_run|github\.sha)/m);
  });
  it("the close job runs only for a merged PR, and the checks workflow holds no secret", () => {
    assert.match(trusted, /github\.event\.pull_request\.merged == true/);
    assert.doesNotMatch(checks, /secrets\./);
    assert.doesNotMatch(checks, /environment:/);
  });
});
