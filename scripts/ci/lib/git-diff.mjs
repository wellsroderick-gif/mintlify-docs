import { execFileSync } from "node:child_process";

/**
 * @param {string} baseSha
 * @param {string} headSha
 * @param {string} diffFilter - git diff --diff-filter value (e.g. ACMR, A)
 * @returns {string[]}
 */
export function listChangedMdxFiles(baseSha, headSha, diffFilter) {
  if (!baseSha || !headSha) {
    console.error("BASE_SHA and HEAD_SHA env vars are required");
    process.exit(1);
  }

  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      `--diff-filter=${diffFilter}`,
      baseSha,
      headSha,
      "--",
      "*.mdx",
    ],
    { encoding: "utf8" },
  );

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".mdx") && line !== "index.mdx");
}
