/**
 * Em-dash ratchet (WR-5853) — no U+2014 anywhere in the help corpus.
 *
 * Why this exists: help voice does not use em dashes. WR-3697 took the corpus to zero,
 * and it did not stay there — two U+2014 landed back on billing/manage-subscription.mdx
 * in an unrelated content commit and survived twenty-one commits without anything
 * noticing. This ratchet is what keeps zero at zero.
 *
 * COUNTS OCCURRENCES, NOT LINES. The live regression was 2 occurrences on 1 line. A
 * line-counting ratchet reports that as 1 and would pass a corpus whose defect count had
 * doubled. Every number this guard prints is an occurrence count.
 *
 * U+2013 EN DASH IS NEVER FLAGGED. It is correct punctuation and the corpus uses it
 * legitimately (7 occurrences in concepts/trust-and-reputation.mdx at the commit this
 * guard lands on). A guard that flags an en dash is wrong, and the vectors below pin
 * that in both directions. The two code points are NEVER conflated: this reads UTF-8 in
 * Node and matches by code point. Do not reimplement this with Git Bash `grep`, which is
 * unreliable for non-ASCII patterns on the authoring host.
 *
 * NEVER "FIX" AN EM DASH BY WRITING `--`. That produces clean ASCII which every checker
 * passes while the intended glyph is destroyed. Rewrite the sentence instead: a colon, a
 * comma, parentheses, or two sentences.
 *
 * Deliberately full-repo, not diff-scoped — same reasoning as check-self-links.mjs. Safe
 * here because the defective baseline is ZERO corpus-wide at the commit this guard lands
 * on (the two survivors are fixed in the same PR). A full-repo gate over a corpus with
 * standing debt would red on debt the PR did not introduce; this one cannot, because
 * there is none.
 *
 * Usage:
 *   node scripts/ci/check-em-dashes.mjs              # scan the repo
 *   node scripts/ci/check-em-dashes.mjs --self-test  # run the inline vectors
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectScanTargets } from "./lib/collect-mdx.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** U+2014 EM DASH. Matched by code point, never by a shell-quoted literal. */
const EM_DASH = /—/g;

/**
 * Every em dash in one blob of text, as OCCURRENCES.
 * Pure: no filesystem, no process state. This is the predicate the vectors exercise.
 * @param {string} content
 * @returns {number[]} character offsets, one per occurrence
 */
export function findEmDashes(content) {
  /** @type {number[]} */
  const at = [];
  for (const m of String(content).matchAll(EM_DASH)) at.push(m.index ?? -1);
  return at;
}

/* ------------------------------------------------------------------ *
 * Self-test vectors — the guard's own RED/GREEN proof.
 * ------------------------------------------------------------------ */

const VECTORS = [
  // --- must flag ---
  ["Switch to Annual — $96/year", 1],
  // The live regression: TWO occurrences on ONE line. A line-counter reports 1.
  ["**Switch to Annual — $96/year** on Standard, **Switch to Annual — $192/year** on Pro.", 2],
  ["Three — in — one — line", 3],
  ["A heading — with an em dash", 1],

  // --- must NOT flag: U+2013 EN DASH is correct and must survive ---
  ["Days 0–7 are the petition window.", 0],
  ["The 2024–2025 season.", 0],
  ["Seven en dashes: – – – – – – –", 0],
  // --- must NOT flag: ASCII punctuation ---
  ["A hyphen - is fine.", 0],
  ["A double hyphen -- is not an em dash.", 0],
  ["Plain prose with no dashes at all.", 0],
  // --- mixed: the en dash must not mask the em dash, nor be counted with it ---
  ["Days 0–7 — the petition window", 1],
];

function runSelfTest() {
  let failed = 0;
  for (const [input, expected] of VECTORS) {
    const actual = findEmDashes(String(input)).length;
    const ok = actual === expected;
    if (!ok) failed++;
    const shown = String(input).replace(/—/g, "<EM>").replace(/–/g, "<EN>");
    console.log(`  ${ok ? "PASS" : "FAIL"}  expected=${expected} actual=${actual}  ${shown}`);
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
/** @type {Array<{ file: string, line: number, count: number, text: string }>} */
const findings = [];
let total = 0;

for (const file of files) {
  const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
  content.split(/\r?\n/).forEach((text, i) => {
    const n = findEmDashes(text).length;
    if (n > 0) {
      total += n;
      findings.push({ file, line: i + 1, count: n, text: text.trim() });
    }
  });
}

if (total > 0) {
  console.error(
    `Em-dash check failed — ${total} em dash(es) (U+2014) on ${findings.length} line(s) in ${new Set(findings.map((f) => f.file)).size} file(s):`,
  );
  for (const f of findings) {
    console.error(`  - ${f.file}:${f.line}  (${f.count} occurrence${f.count === 1 ? "" : "s"})`);
    console.error(`      ${f.text}`);
  }
  console.error(
    "\nHelp voice does not use em dashes. Rewrite the sentence: a colon, a comma," +
      " parentheses, or two sentences." +
      "\nDo NOT replace it with `--` — that is clean ASCII this check passes while the" +
      " intended glyph is gone." +
      "\nThe en dash (U+2013) is correct punctuation and is never flagged.",
  );
  process.exit(1);
}

console.log(`Em-dash check passed (${files.length} files scanned, 0 occurrences of U+2014).`);
