/**
 * Icon name check — validates MDX and docs.json icon literals against a
 * Mintlify CDN probe snapshot (see --regen).
 *
 * Deliberately full-repo, not diff-scoped: siblings check-frontmatter and
 * check-nav-membership only scan changed files (BASE_SHA/HEAD_SHA). WR-3375
 * showed stale icon names survive on merged pages that never re-enter a diff.
 * Do not "fix" this into diff-scoping without an explicit product decision.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Mintlify Lucide bundle served at render time. Bump requires `node scripts/ci/check-icons.mjs --regen`. */
const MINTLIFY_LUCIDE_BUNDLE = "v1.16.0";
// Oracle: membership is whatever this CDN bundle HEADs as 200 (not Lucide's published set).
const MINTLIFY_CDN_ORACLE = `https://d3gk2c5xim1je2.cloudfront.net/lucide/${MINTLIFY_LUCIDE_BUNDLE}`;
const CANDIDATE_SOURCE = "https://lucide.dev/api/figma/data";
const REGEN_COMMAND = "node scripts/ci/check-icons.mjs --regen";

const PROBE_CONCURRENCY = 10;
const PROBE_MAX_RETRIES = 3;
const PROBE_SANITY_FLOOR = 1000;
const PROBE_TIMEOUT_MS = 15_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsJsonPath = path.join(repoRoot, "docs.json");
const dataDir = path.join(repoRoot, "scripts/ci/data");

const isRegen = process.argv.includes("--regen");

/**
 * docs.json nav icon extractor — line scan, deliberately NOT the recursive walk used by
 * check-nav-membership.mjs's collectPageSlugs.
 *
 * Reason: JSON.parse discards line numbers, and this check must report path:line.
 * Cost: an "icon" key whose value sits on a different line than the key is not matched.
 * Acceptable because docs.json is machine-formatted single-line-per-key.
 * Do not "fix" this into a recursive walk without solving line attribution first.
 *
 * @returns {Array<{ path: string, line: number, value: string }>}
 */
function extractNavIconsFromDocsJson() {
  const logicalPath = "docs.json";
  const content = fs.readFileSync(docsJsonPath, "utf8");
  const lines = content.split(/\r?\n/);
  /** @type {Array<{ path: string, line: number, value: string }>} */
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const dbl = line.match(/"icon"\s*:\s*"([^"]*)"/);
    if (dbl) {
      hits.push({ path: logicalPath, line: i + 1, value: dbl[1] });
      continue;
    }
    const sgl = line.match(/"icon"\s*:\s*'([^']*)'/);
    if (sgl) {
      hits.push({ path: logicalPath, line: i + 1, value: sgl[1] });
    }
  }

  return hits;
}

/**
 * @param {string} dir
 * @param {string[]} acc
 */
function listMdxFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      listMdxFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      acc.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
    }
  }
  return acc;
}

/** @param {string} line */
function unquoteYamlValue(line) {
  let value = line.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * @param {string} filePath
 * @returns {{
 *   jsx: Array<{ path: string, line: number, value: string, component: string }>,
 *   frontmatter: Array<{ path: string, line: number, value: string }>,
 *   skipped: Array<{ path: string, line: number, reason: string }>,
 * }}
 */
function extractFromMdx(filePath) {
  const content = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
  const lines = content.split(/\r?\n/);
  /** @type {Array<{ path: string, line: number, value: string, component: string }>} */
  const jsx = [];
  /** @type {Array<{ path: string, line: number, value: string }>} */
  const frontmatter = [];
  /** @type {Array<{ path: string, line: number, reason: string }>} */
  const skipped = [];

  let inFrontmatter = false;
  let frontmatterEnded = false;

  /** @type {string | null} */
  let pendingComponent = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Open frontmatter only on line 1 — body `---` thematic breaks must not start a phantom block.
    if (!frontmatterEnded && line.trim() === "---" && (inFrontmatter || i === 0)) {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      }
      inFrontmatter = false;
      frontmatterEnded = true;
      continue;
    }

    if (inFrontmatter) {
      const fmMatch = line.match(/^icon:\s*(.*)$/);
      if (fmMatch) {
        const raw = fmMatch[1].trim();
        if (!raw || raw.startsWith("{") || raw.includes("${")) {
          skipped.push({ path: filePath, line: lineNo, reason: "non-literal frontmatter icon" });
        } else {
          frontmatter.push({ path: filePath, line: lineNo, value: unquoteYamlValue(raw) });
        }
      }
      continue;
    }

    const tagMatch = line.match(/<([A-Za-z][A-Za-z0-9.-]*)\b/);
    if (tagMatch) {
      pendingComponent = tagMatch[1];
    }

    const dblMatch = line.match(/\bicon="([^"]*)"/);
    if (dblMatch) {
      jsx.push({
        path: filePath,
        line: lineNo,
        value: dblMatch[1],
        component: pendingComponent ?? "unknown",
      });
      continue;
    }

    const sglMatch = line.match(/\bicon='([^']*)'/);
    if (sglMatch) {
      jsx.push({
        path: filePath,
        line: lineNo,
        value: sglMatch[1],
        component: pendingComponent ?? "unknown",
      });
      continue;
    }

    if (/\bicon=\{/.test(line) || /\bicon=\{`/.test(line)) {
      skipped.push({ path: filePath, line: lineNo, reason: "non-literal JSX icon" });
    }
  }

  return { jsx, frontmatter, skipped };
}

/**
 * @param {number} status
 */
function isTransientProbeStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * @param {string} name
 * @returns {Promise<{ name: string, status: number, transient: boolean, absent: boolean, kept: boolean }>}
 */
async function probeIconName(name) {
  const url = `${MINTLIFY_CDN_ORACLE}/${encodeURIComponent(name)}.svg`;

  for (let attempt = 1; attempt <= PROBE_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(url, { method: "HEAD", signal: controller.signal });
      clearTimeout(timer);

      if (response.status === 200) {
        return { name, status: 200, transient: false, absent: false, kept: true };
      }
      if (response.status === 403 || response.status === 404) {
        return { name, status: response.status, transient: false, absent: true, kept: false };
      }
      if (isTransientProbeStatus(response.status)) {
        if (attempt === PROBE_MAX_RETRIES) {
          return { name, status: response.status, transient: true, absent: false, kept: false };
        }
        await new Promise((r) => setTimeout(r, attempt * 500));
        continue;
      }

      return {
        name,
        status: response.status,
        transient: true,
        absent: false,
        kept: false,
      };
    } catch {
      clearTimeout(timer);
      if (attempt === PROBE_MAX_RETRIES) {
        return { name, status: 0, transient: true, absent: false, kept: false };
      }
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }

  return { name, status: 0, transient: true, absent: false, kept: false };
}

/**
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
async function probeCandidates(names) {
  /** @type {string[]} */
  const kept = [];
  let index = 0;

  /** @type {Promise<void>[]} */
  const workers = Array.from({ length: PROBE_CONCURRENCY }, async () => {
    while (index < names.length) {
      const current = names[index++];
      const result = await probeIconName(current);
      if (result.transient) {
        throw new Error(
          `Transient CDN probe failure for "${current}" (HTTP ${result.status || "network error"}). Regen aborted; snapshot not written.`,
        );
      }
      if (result.kept) {
        kept.push(current);
      }
    }
  });

  await Promise.all(workers);
  return kept.sort();
}

async function regenSnapshot(library) {
  let payload;
  try {
    const response = await fetch(CANDIDATE_SOURCE);
    if (!response.ok) {
      console.error(`Failed to fetch candidate source (${response.status}): ${CANDIDATE_SOURCE}`);
      process.exit(1);
    }
    payload = await response.json();
  } catch (err) {
    console.error(`Failed to fetch candidate source: ${CANDIDATE_SOURCE}`);
    console.error(String(err));
    process.exit(1);
  }

  const iconKeys = Object.keys(payload.icons ?? {});
  const aliasKeys = Object.keys(payload.aliases ?? {});
  const candidates = [...new Set([...iconKeys, ...aliasKeys])].sort();

  console.log(
    `Regenerating icon snapshot: ${candidates.length} candidate name(s) from ${CANDIDATE_SOURCE}`,
  );
  console.log(`Probing Mintlify CDN oracle (${MINTLIFY_CDN_ORACLE}) with concurrency ${PROBE_CONCURRENCY}…`);

  let kept;
  try {
    kept = await probeCandidates(candidates);
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }

  if (kept.length < PROBE_SANITY_FLOOR) {
    console.error(
      `Regen sanity floor failed: only ${kept.length} name(s) returned HTTP 200 (minimum ${PROBE_SANITY_FLOOR}). Snapshot not written.`,
    );
    process.exit(1);
  }

  const snapshot = {
    library,
    oracle: MINTLIFY_CDN_ORACLE,
    bundleVersion: MINTLIFY_LUCIDE_BUNDLE,
    candidateSource: CANDIDATE_SOURCE,
    sourceNote:
      "Membership determined by HEAD probe against Mintlify CloudFront Lucide bundle (oracle). Candidate set from unofficial unversioned Lucide Figma-plugin API (icons∪aliases). Both endpoints may move without notice. Aliases are candidates only — never trusted without a 200.",
    fetchedAt: new Date().toISOString(),
    count: kept.length,
    names: kept,
  };

  fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, `icon-names.${library}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Wrote ${kept.length} probed icon name(s) to ${path.relative(repoRoot, outPath)}`);
}

function loadSnapshot(library) {
  const snapshotPath = path.join(dataDir, `icon-names.${library}.json`);
  if (!fs.existsSync(snapshotPath)) {
    console.error(`Icon snapshot missing for library "${library}": ${path.relative(repoRoot, snapshotPath)}`);
    console.error(`Run: ${REGEN_COMMAND}`);
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  if (snapshot.bundleVersion !== MINTLIFY_LUCIDE_BUNDLE) {
    console.error(
      `Icon snapshot bundleVersion "${snapshot.bundleVersion}" does not match script constant "${MINTLIFY_LUCIDE_BUNDLE}".`,
    );
    console.error(`Run: ${REGEN_COMMAND}`);
    process.exit(1);
  }

  return {
    snapshot,
    allowed: new Set(snapshot.names ?? []),
  };
}

function runCheck() {
  const docsJson = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
  const library = docsJson.icons?.library;
  if (!library || typeof library !== "string") {
    console.error('docs.json is missing icons.library (e.g. "lucide").');
    process.exit(1);
  }

  const { allowed } = loadSnapshot(library);

  /** @type {Array<{ path: string, line: number, value: string }>} */
  const navIcons = extractNavIconsFromDocsJson();

  /** @type {Array<{ path: string, line: number, value: string, component: string }>} */
  const jsxIcons = [];
  /** @type {Array<{ path: string, line: number, value: string }>} */
  const frontmatterIcons = [];
  /** @type {Array<{ path: string, line: number, reason: string }>} */
  const skipped = [];

  for (const filePath of listMdxFiles(repoRoot)) {
    const extracted = extractFromMdx(filePath);
    jsxIcons.push(...extracted.jsx);
    frontmatterIcons.push(...extracted.frontmatter);
    skipped.push(...extracted.skipped);
  }

  /** @type {Record<string, number>} */
  const jsxByComponent = {};
  for (const hit of jsxIcons) {
    jsxByComponent[hit.component] = (jsxByComponent[hit.component] ?? 0) + 1;
  }

  console.log(`Icon extraction counts:`);
  console.log(`  JSX icon attributes: ${jsxIcons.length}`);
  for (const [component, count] of Object.entries(jsxByComponent).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`    ${component}: ${count}`);
  }
  console.log(`  Frontmatter icon: ${frontmatterIcons.length}`);
  console.log(`  docs.json nav icon: ${navIcons.length}`);
  if (skipped.length > 0) {
    console.log(`  Skipped non-literal icon values: ${skipped.length}`);
    for (const item of skipped) {
      console.log(`    - ${item.path}:${item.line} (${item.reason})`);
    }
  }

  /** @type {Array<{ path: string, line: number, value: string }>} */
  const allLiterals = [
    ...jsxIcons.map(({ path, line, value }) => ({ path, line, value })),
    ...frontmatterIcons,
    ...navIcons,
  ];

  const failures = allLiterals.filter(({ value }) => !allowed.has(value));

  if (failures.length > 0) {
    console.error("Icon check failed:");
    for (const { path: filePath, line, value } of failures) {
      console.error(`  - ${filePath}:${line} (icon: "${value}")`);
    }
    console.error(`Run: ${REGEN_COMMAND}`);
    process.exit(1);
  }

  console.log(
    `Icon check passed (${allLiterals.length} literal icon value(s) across ${jsxIcons.length} JSX, ${frontmatterIcons.length} frontmatter, ${navIcons.length} docs.json).`,
  );
}

async function main() {
  const docsJson = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));
  const library = docsJson.icons?.library;
  if (!library || typeof library !== "string") {
    console.error('docs.json is missing icons.library (e.g. "lucide").');
    process.exit(1);
  }

  if (isRegen) {
    await regenSnapshot(library);
    return;
  }

  runCheck();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
