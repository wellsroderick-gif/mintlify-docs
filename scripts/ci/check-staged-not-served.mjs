/**
 * Staged screenshot guard (WR-32543) — nothing under `drafts/` may be a navigable help URL.
 *
 * Publishing exclusion is primarily `.mintignore` (`drafts/`). This guard adds static proof:
 * no nav entry, redirect, or in-corpus MDX link targets `/drafts/` or `drafts/screenshots/`.
 *
 * Usage:
 *   node scripts/ci/check-staged-not-served.mjs
 *   node scripts/ci/check-staged-not-served.mjs --self-test
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectMdx } from "./lib/collect-mdx.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DRAFT_PATH = /(?:^|[\s"'`(])\/drafts\/|(?:^|[\s"'`(])drafts\/screenshots\//i;

/**
 * @param {string} content
 * @returns {number}
 */
export function countDraftServedReferences(content) {
  const lines = String(content).split(/\r?\n/);
  let hits = 0;
  for (const line of lines) {
    if (DRAFT_PATH.test(line)) hits++;
  }
  return hits;
}

const VECTORS = [
  ["![staged](/drafts/screenshots/foo.png)", 1],
  ["See [staged](drafts/screenshots/foo.png)", 1],
  ["Promoted only: /images/screenshots/foo.png", 0],
  [".mintignore lists drafts/", 0],
];

function runSelfTest() {
  let failed = 0;
  for (const [input, expected] of VECTORS) {
    const actual = countDraftServedReferences(input);
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  expected=${expected} actual=${actual}`);
  }
  if (failed > 0) {
    console.error(`\nSelf-test FAILED: ${failed} of ${VECTORS.length} vectors wrong.`);
    process.exit(1);
  }
  console.log(`\nSelf-test passed (${VECTORS.length} vectors). RED-before-GREEN: vectors include staged-path hits.`);
  process.exit(0);
}

function assertMintignore() {
  const mintignore = path.join(repoRoot, ".mintignore");
  const text = fs.readFileSync(mintignore, "utf8");
  if (!text.includes("drafts/")) {
    console.error("check-staged-not-served: .mintignore must exclude drafts/");
    process.exit(1);
  }
}

function walkNavForDrafts(node, hits) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkNavForDrafts(child, hits);
    return;
  }
  if (typeof node.pages === "object") {
    for (const page of node.pages) {
      if (typeof page === "string" && page.replace(/^\//, "").startsWith("drafts/")) {
        hits.push(`nav page: ${page}`);
      }
    }
  }
  for (const key of ["tabs", "groups", "anchors", "dropdowns", "versions", "languages"]) {
    if (Array.isArray(node[key])) walkNavForDrafts(node[key], hits);
  }
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  assertMintignore();

  /** @type {string[]} */
  const failures = [];

  const docsJsonPath = path.join(repoRoot, "docs.json");
  const docs = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
  /** @type {string[]} */
  const navHits = [];
  walkNavForDrafts(docs.navigation, navHits);
  for (const h of navHits) failures.push(h);

  for (const redirect of docs.redirects ?? []) {
    const dest = String(redirect.destination ?? "");
    const src = String(redirect.source ?? "");
    if (dest.includes("/drafts/") || src.includes("/drafts/")) {
      failures.push(`redirect: ${src} -> ${dest}`);
    }
  }

  for (const rel of collectMdx(repoRoot)) {
    const full = path.join(repoRoot, rel);
    const text = fs.readFileSync(full, "utf8");
    const n = countDraftServedReferences(text);
    if (n > 0) failures.push(`${rel}: ${n} staged-path reference(s)`);
  }

  const helpIgnore = path.join(repoRoot, "help-shots.manifest.json");
  if (fs.existsSync(helpIgnore)) {
    const manifest = JSON.parse(fs.readFileSync(helpIgnore, "utf8"));
    if (Array.isArray(manifest)) {
      for (const row of manifest) {
        const file = String(row?.file ?? "");
        if (file.startsWith("drafts/")) {
          failures.push(`manifest id=${row?.id}: file must be promoted under images/screenshots/, not ${file}`);
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error("check-staged-not-served: staged content must not be served or linked as help URLs:\n");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("check-staged-not-served: OK (.mintignore, nav, redirects, corpus)");
}

main();