/**
 * Absolute self-link check — flags `https://help.wr-games.com/...` inside the docs.
 *
 * Why this exists (WR-5606): `npx mintlify broken-links` resolves RELATIVE links against
 * the nav tree, but treats `https://help.wr-games.com/...` as an external URL it never
 * checks. An absolute self-link that points at a renamed or deleted page therefore ships
 * green — the corpus links to its own 404 and CI says nothing.
 *
 * Deliberately full-repo, not diff-scoped: siblings check-frontmatter and
 * check-nav-membership only scan changed files (BASE_SHA/HEAD_SHA), and
 * `lib/git-diff.mjs` additionally drops `index.mdx` from that list entirely. Both gaps
 * matter here — a self-link rots on a merged page that never re-enters a diff, and the
 * homepage is a relay target that must not be exempt. Same reasoning as check-icons.mjs.
 * Do not "fix" this into diff-scoping without an explicit product decision.
 *
 * Usage:
 *   node scripts/ci/check-self-links.mjs              # scan the repo
 *   node scripts/ci/check-self-links.mjs --self-test  # run the inline vectors
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Anchored on the scheme so a bare prose mention of the hostname is NOT a finding:
 * `## A new support center at help.wr-games.com` is legitimate copy, not a link.
 * The host is matched to a `/` or end boundary so a hypothetical `help.wr-games.com.evil`
 * or `myhelp.wr-games.com` is not swept up. Case-insensitive: scheme and host are
 * case-insensitive per RFC 3986, and `HTTPS://HELP.WR-GAMES.COM` is the same defect.
 */
const SELF_LINK = /https?:\/\/help\.wr-games\.com(?=[/)\s"'`>\]]|$)/gi;

const SKIP_DIRS = new Set(["node_modules", ".git", ".github", ".claude"]);

/**
 * True when `dir` is the root of a nested checkout (agent worktrees land under
 * `.claude/worktrees/<name>/`, each with its own `.git`). Their .mdx files are a stale
 * copy of this corpus, so walking into one reports phantom findings against content that
 * is not in the repo — measured locally as 27 findings where the repo has 17.
 * CI checks out clean and never sees these, which is exactly why the local run must skip
 * them: otherwise the guard is noisy where it is authored and silent where it runs.
 * @param {string} dir
 */
function isNestedCheckout(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]} repo-relative .mdx paths, POSIX-separated
 */
function collectMdx(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (isNestedCheckout(child)) continue;
      collectMdx(child, out);
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      out.push(path.relative(repoRoot, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * @param {string} content
 * @returns {Array<{ line: number, match: string, text: string }>}
 */
export function findSelfLinks(content) {
  /** @type {Array<{ line: number, match: string, text: string }>} */
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Fresh lastIndex per line: SELF_LINK is /g and would otherwise skip matches.
    SELF_LINK.lastIndex = 0;
    let m;
    while ((m = SELF_LINK.exec(lines[i])) !== null) {
      hits.push({ line: i + 1, match: m[0], text: lines[i].trim() });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Self-test vectors — the guard's own RED/GREEN proof.
 * ------------------------------------------------------------------ */

const VECTORS = [
  // Must flag.
  ["[Roll Call](https://help.wr-games.com/features/roll-call).", 1],
  ["[Browse the help center](https://help.wr-games.com).", 1],
  ['<Card title="Transit" href="https://help.wr-games.com/features/transit">', 1],
  ["Two on one line: https://help.wr-games.com/a and https://help.wr-games.com/b", 2],
  ["Uppercase is the same defect: HTTPS://HELP.WR-GAMES.COM/features/roll-call", 1],
  ["Plain http scheme: http://help.wr-games.com/help/notifications", 1],
  // Must NOT flag.
  ["## A new support center at help.wr-games.com", 0],
  ["[Roll Call](/features/roll-call) is relative and fine.", 0],
  ["External links are fine: https://boardgamegeek.com/browse/boardgame", 0],
  ["The marketing site is a different host: https://wr-games.com/pricing", 0],
  ["Not our host: https://myhelp.wr-games.com/features/roll-call", 0],
];

function runSelfTest() {
  let failed = 0;
  for (const [input, expected] of VECTORS) {
    const actual = findSelfLinks(input).length;
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

const files = collectMdx(repoRoot);
/** @type {Array<{ file: string, line: number, match: string, text: string }>} */
const findings = [];

for (const file of files) {
  const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
  for (const hit of findSelfLinks(content)) {
    findings.push({ file, ...hit });
  }
}

if (findings.length > 0) {
  console.error(
    `Self-link check failed — ${findings.length} absolute self-link(s) in ${new Set(findings.map((f) => f.file)).size} file(s):`,
  );
  for (const f of findings) {
    console.error(`  - ${f.file}:${f.line}  ${f.match}`);
    console.error(`      ${f.text}`);
  }
  console.error(
    "\nUse a relative path instead: [Roll Call](/features/roll-call), not" +
      " https://help.wr-games.com/features/roll-call. `mintlify broken-links` treats the" +
      " absolute form as an external URL and never checks it, so a broken self-link ships green." +
      "\nThe site root is `/`.",
  );
  process.exit(1);
}

console.log(`Self-link check passed (${files.length} .mdx files scanned).`);
