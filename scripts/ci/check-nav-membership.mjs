import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listChangedMdxFiles } from "./lib/git-diff.mjs";

const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsJsonPath = path.join(repoRoot, "docs.json");

/**
 * Recursively walk navigation (or any node) and collect string page slugs
 * from every `pages` array at any depth.
 * @param {unknown} node
 * @param {Set<string>} slugs
 * @returns {Set<string>}
 */
function collectPageSlugs(node, slugs = new Set()) {
  if (node == null || typeof node !== "object") {
    return slugs;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectPageSlugs(item, slugs);
    }
    return slugs;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "pages" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          slugs.add(entry);
        } else {
          collectPageSlugs(entry, slugs);
        }
      }
    } else {
      collectPageSlugs(value, slugs);
    }
  }

  return slugs;
}

/** @param {string} filePath */
function mdxPathToSlug(filePath) {
  return filePath.replace(/\\/g, "/").replace(/\.mdx$/, "");
}

const newFiles = listChangedMdxFiles(baseSha, headSha, "A");

if (newFiles.length === 0) {
  console.log("Nav membership check passed (no new .mdx files).");
  process.exit(0);
}

const docsJson = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
const navSlugs = collectPageSlugs(docsJson.navigation ?? {});

const orphans = newFiles
  .map((filePath) => ({ filePath, slug: mdxPathToSlug(filePath) }))
  .filter(({ slug }) => !navSlugs.has(slug));

if (orphans.length > 0) {
  console.error("Nav membership check failed — new .mdx files not in docs.json navigation:");
  for (const { filePath, slug } of orphans) {
    console.error(`  - ${filePath} (slug: ${slug})`);
  }
  process.exit(1);
}

console.log(`Nav membership check passed (${newFiles.length} new .mdx file(s)).`);
