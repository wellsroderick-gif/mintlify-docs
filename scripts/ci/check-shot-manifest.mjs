/**
 * Manifest integrity for help screenshots (WR-32543 SMK-3).
 *
 * - Every manifest `file` is under `images/screenshots/`.
 * - Every `<Shot id="…" />` in the corpus references a manifest id.
 * - Manifest ids are unique.
 *
 * Usage:
 *   node scripts/ci/check-shot-manifest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectMdx } from "./lib/collect-mdx.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SHOT_TAG = /<Shot\s+[^>]*\bid\s*=\s*["'{]([^"'}\s]+)["'}]/g;

/**
 * @param {string} content
 * @returns {string[]}
 */
export function findShotIdsInMdx(content) {
  /** @type {string[]} */
  const ids = [];
  for (const m of String(content).matchAll(SHOT_TAG)) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

function main() {
  const manifestPath = path.join(repoRoot, "help-shots.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest)) {
    console.error("check-shot-manifest: help-shots.manifest.json must be a JSON array");
    process.exit(1);
  }

  /** @type {Set<string>} */
  const manifestIds = new Set();
  /** @type {string[]} */
  const errors = [];

  for (const row of manifest) {
    const id = String(row?.id ?? "");
    if (!id) {
      errors.push("manifest row missing id");
      continue;
    }
    if (manifestIds.has(id)) errors.push(`duplicate manifest id: ${id}`);
    manifestIds.add(id);
    const file = String(row?.file ?? "");
    if (file && !file.startsWith("images/screenshots/")) {
      errors.push(`manifest id=${id}: file must be under images/screenshots/ (got ${file})`);
    }
  }

  for (const rel of collectMdx(repoRoot)) {
    const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    for (const id of findShotIdsInMdx(text)) {
      if (!manifestIds.has(id)) {
        errors.push(`${rel}: <Shot id="${id}"> has no manifest entry`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("check-shot-manifest:\n");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(`check-shot-manifest: OK (${manifest.length} manifest entries, corpus Shot tags resolved)`);
}

main();