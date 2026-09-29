/**
 * Shared MDX walk for the full-repo content guards (WR-5852 / WR-5853).
 *
 * Extracted verbatim in behaviour from check-self-links.mjs, which grew it first. Both
 * new guards need the same two things that file needed: every `.mdx` in the corpus, and
 * a skip for nested checkouts.
 *
 * This is NOT lib/git-diff.mjs. That helper answers "which .mdx did this PR change?" and
 * is used by the diff-scoped guards (check-frontmatter, check-nav-membership). It returns
 * FILE PATHS ONLY with no line granularity, and it drops `index.mdx` outright. A guard
 * built on it can only ever say "this file is dirty", never "this hunk is dirty" — so a
 * file-scoped gate over a corpus with pre-existing debt would red on debt the PR did not
 * introduce. The guards that import THIS module are full-repo and assert ZERO, which is
 * only safe because their defective baselines are zero. Do not repoint them at git-diff
 * without re-measuring the baseline first.
 *
 * No package.json exists in this repo: node builtins only.
 */
import fs from "node:fs";
import path from "node:path";

/** Directories that never hold corpus content. */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".github", ".claude"]);

/**
 * True when `dir` is the root of a nested checkout (agent worktrees land under
 * `.claude/worktrees/<name>/`, each with its own `.git`). Their .mdx files are a stale
 * copy of this corpus, so walking into one reports phantom findings against content that
 * is not in the repo. CI checks out clean and never sees these, which is exactly why the
 * local run must skip them: otherwise the guard is noisy where it is authored and silent
 * where it runs.
 * @param {string} dir
 */
export function isNestedCheckout(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * Every `.mdx` in the corpus, repo-relative and POSIX-separated.
 * @param {string} repoRoot
 * @param {string} [dir]
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function collectMdx(repoRoot, dir = repoRoot, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (isNestedCheckout(child)) continue;
      collectMdx(repoRoot, child, out);
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      out.push(path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * The full scan set for a corpus-wide content guard: every `.mdx`, plus `docs.json`
 * when it exists (it carries user-facing nav labels and card titles).
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function collectScanTargets(repoRoot) {
  const targets = collectMdx(repoRoot);
  if (fs.existsSync(path.join(repoRoot, "docs.json"))) targets.push("docs.json");
  return targets.sort();
}
