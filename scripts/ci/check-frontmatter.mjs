import fs from "node:fs";
import { listChangedMdxFiles } from "./lib/git-diff.mjs";

const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA;

/** @param {string} filePath */
function parseFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  if (!content.startsWith("---")) {
    return null;
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return null;
  }

  const block = content.slice(4, end);
  /** @type {Record<string, string>} */
  const fields = {};

  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  return fields;
}

const changedFiles = listChangedMdxFiles(baseSha, headSha, "ACMR");
const failures = [];

for (const filePath of changedFiles) {
  const fields = parseFrontmatter(filePath);
  const missing = [];

  if (!fields?.title?.trim()) missing.push("title");
  if (!fields?.description?.trim()) missing.push("description");

  if (missing.length > 0) {
    failures.push(`${filePath} (missing: ${missing.join(", ")})`);
  }
}

if (failures.length > 0) {
  console.error("Frontmatter check failed for changed .mdx files:");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  changedFiles.length === 0
    ? "Frontmatter check passed (no changed .mdx files)."
    : `Frontmatter check passed (${changedFiles.length} changed .mdx file(s)).`,
);
