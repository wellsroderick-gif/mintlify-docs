/**
 * Brand-term casing check (WR-5852) — flags wrong-cased `Co-Host` and `On the Table`.
 *
 * Why this exists: the brand brief (§6, board-game-meetup-nexus
 * docs/marketing/wr-games-brand-brief.md) locks two branded names to a fixed casing in
 * every user-facing surface. Nothing enforced that here, and the corpus proved it: while
 * the canonical `On the Table` page was being fixed, six OTHER pages drifted to the
 * wrong-cased `On The Table` and CI said nothing. This is the guard that would have
 * caught it.
 *
 * WHAT IS FLAGGED
 *   Co-Host — any variant that is not exactly `Co-Host` or `Co-Hosts`.
 *             `co-host`, `Co-host`, `CO-HOST`, `cohost`, `CoHost` all fail.
 *             The PLURAL `Co-Hosts` is allowed: the corpus already uses it in prose.
 *   On the Table — the wrong-cased `On The Table` and the hyphenated `On-the-Table` /
 *             `On-The-Table`. Canonical is `On the Table`, lowercase `the`
 *             (Commander, 2026-09-23).
 *
 * WHAT IS NOT FLAGGED, DELIBERATELY
 *   - Gerunds. `co-hosting`, `co-hosted by` stay in grammatical casing (WR-1022
 *     decision 2). The word-boundary anchor handles this for free: in `co-hosted` there
 *     is no boundary after `host`, so the candidate never matches.
 *   - The ordinary English idiom `on the table` ("what's on the table"). Only the
 *     capital-`The` form is a brand-name defect.
 *   - The URL slug `/features/on-the-table`. Lowercase-hyphenated is a path, not a name.
 *
 * A NOTE ON COUNTING, because it nearly became a false finding upstream: a word-boundary
 * regex written as `\bCo-Host\b` silently DROPS the plural and under-reports the
 * canonical baseline by 4 (16/7 files instead of 20/8), which reads exactly like a
 * regression that has not happened. The vectors below pin the plural in both directions.
 *
 * Deliberately full-repo, not diff-scoped — same reasoning as check-self-links.mjs and
 * check-icons.mjs. Safe here because the defective baseline is ZERO corpus-wide: 0
 * wrong-cased Co-Host against 19 canonical, and 0 wrong-cased On the Table against 41
 * canonical, both measured at the commit this guard lands on. A full-repo gate over a
 * corpus with standing debt would red on debt the PR did not introduce; this one cannot,
 * because there is none. Re-measure before repointing this at lib/git-diff.mjs.
 *
 * Usage:
 *   node scripts/ci/check-brand-casing.mjs              # scan the repo
 *   node scripts/ci/check-brand-casing.mjs --self-test  # run the inline vectors
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectScanTargets } from "./lib/collect-mdx.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every spelling of the co-host role noun, singular or plural, gerunds excluded by \b. */
const CO_HOST_CANDIDATE = /\bco-?hosts?\b/gi;
/** The only two spellings that are correct. */
const CO_HOST_ALLOWED = new Set(["Co-Host", "Co-Hosts"]);

/**
 * Wrong-cased brand term. `On The Table` (capital The) and the hyphenated forms.
 * Canonical `On the Table` and the lowercase idiom/slug are both excluded by construction.
 */
const ON_THE_TABLE_DEFECT = /On[-\s]The[-\s]Table|On-the-Table/g;

/**
 * Every casing defect in one blob of text.
 * Pure: no filesystem, no process state. This is the predicate the vectors exercise.
 * @param {string} content
 * @returns {Array<{ match: string, term: string }>}
 */
export function findCasingDefects(content) {
  /** @type {Array<{ match: string, term: string }>} */
  const hits = [];

  for (const m of content.matchAll(CO_HOST_CANDIDATE)) {
    if (!CO_HOST_ALLOWED.has(m[0])) hits.push({ match: m[0], term: "Co-Host" });
  }
  for (const m of content.matchAll(ON_THE_TABLE_DEFECT)) {
    hits.push({ match: m[0], term: "On the Table" });
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Self-test vectors — the guard's own RED/GREEN proof.
 * ------------------------------------------------------------------ */

const VECTORS = [
  // --- Co-Host: must flag ---
  ["Ask your co-host to approve it.", 1],
  ["Ask your Co-host to approve it.", 1],
  ["SHOUTING: CO-HOST", 1],
  ["Unhyphenated: cohost", 1],
  ["Camel: CoHost", 1],
  ["Plural wrong case: co-hosts can edit", 1],
  ["Plural wrong case: Co-hosts can edit", 1],
  ["Two on one line: co-host and cohost", 2],
  // --- Co-Host: must NOT flag ---
  ["The Co-Host can edit the event.", 0],
  ["Both Co-Hosts can edit the event.", 0],
  ["Events you are co-hosting stay visible.", 0],
  ["An event co-hosted by two people.", 0],
  ["A Co-Host and two Co-Hosts walk in.", 0],

  // --- On the Table: must flag ---
  ["Open the On The Table tab.", 1],
  ['<Card title="On The Table" icon="dices">', 1],
  ["Hyphenated: On-the-Table", 1],
  ["Hyphenated caps: On-The-Table", 1],
  ["Two: On The Table and On The Table", 2],
  // --- On the Table: must NOT flag ---
  ["Open the On the Table tab.", 0],
  ["See what's on the table at every event.", 0],
  ["[On the Table](/features/on-the-table) is the tab.", 0],
  ['href="/features/on-the-table"', 0],

  // --- mixed ---
  ["A co-host opens On The Table.", 2],
  ["A Co-Host opens On the Table.", 0],
];

function runSelfTest() {
  let failed = 0;
  for (const [input, expected] of VECTORS) {
    const actual = findCasingDefects(String(input)).length;
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  expected=${expected} actual=${actual}  ${input}`);
  }
  if (failed > 0) {
    console.error(`\nSelf-test FAILED: ${failed} of ${VECTORS.length} vectors wrong.`);
    process.exit(1);
  }
  console.log(`\nSelf-test passed (${VECTORS.length} vectors).`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */

if (process.argv.includes("--self-test")) {
  runSelfTest();
}

const files = collectScanTargets(repoRoot);
/** @type {Array<{ file: string, line: number, match: string, term: string, text: string }>} */
const findings = [];

for (const file of files) {
  const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
  content.split(/\r?\n/).forEach((text, i) => {
    for (const hit of findCasingDefects(text)) {
      findings.push({ file, line: i + 1, text: text.trim(), ...hit });
    }
  });
}

if (findings.length > 0) {
  console.error(
    `Brand casing check failed — ${findings.length} wrong-cased term(s) in ${new Set(findings.map((f) => f.file)).size} file(s):`,
  );
  for (const f of findings) {
    console.error(`  - ${f.file}:${f.line}  "${f.match}"  ->  write "${f.term}"`);
    console.error(`      ${f.text}`);
  }
  console.error(
    "\nBranded names take a fixed casing in every user-facing surface:" +
      "\n  Co-Host / Co-Hosts   (never co-host, cohost, CoHost; the gerund co-hosting is fine)" +
      "\n  On the Table         (lowercase `the`; the slug /features/on-the-table is fine)",
  );
  process.exit(1);
}

console.log(`Brand casing check passed (${files.length} files scanned).`);
