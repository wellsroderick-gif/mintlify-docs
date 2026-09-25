// @ts-check
/**
 * WR-9841 -- THE release-proof core: pure, import-free, and the ONE copy of these rules.
 *
 * WHAT IT DECIDES. Which WR keys a Release issue's `## Manifest` lists (`manifestFrom`), and whether
 * a Release record proves a key shipped to production (`releaseProves` / `proofFromReleases`).
 * Three actors read it: this repo's verifier write-back (which items to move to Done), this repo's
 * release tick (which items an in-flight release owns), and the merge robots in command-admin and
 * mintlify-docs (whether a WR-Games blocker has shipped).
 *
 * VENDORED, NEVER HAND-COPIED. command-admin (`scripts/merge-gate/release-proof-core.mjs`) and
 * mintlify-docs (`scripts/ci/release-proof-core.mjs`) carry this file BYTE-IDENTICAL, with the
 * fixture `__fixtures__/release-proof-cases.json` beside it, written by
 * `npm run release-proof:vendor -- --target <repo> --to <that checkout>` and never edited there.
 * It imports nothing so that it can be: neither repo shares a module system with this one, and
 * mintlify-docs has no package.json at all. The custodian's `release-proof-pair` audit compares
 * the blob SHAs on GitHub nightly (nexus `develop` against each repo's `main`), so a copy that
 * drifts is reported rather than trusted. Edit it HERE, then re-vendor.
 *
 * THE PROOF, ALL FOUR REQUIRED:
 *   1. an issue in the `Releases` project,
 *   2. whose state type is `completed` (the verifier's success path is the only writer of Done on
 *      a Release; a pre-production failure goes back to Backlog, a post-production failure stays
 *      In Progress -- scripts/release/linear-writeback.mjs),
 *   3. whose `## Manifest` carries the key as the LEADING key of a list item -- a key named only in
 *      a manifest line's TITLE (release WR-7170's manifest names `WR-7149` that way) is NOT proven,
 *   4. and which carries the verifier's `**Release verified**` comment -- the guard against a
 *      Release issue a human closed by hand.
 */

export const RELEASES_PROJECT = "Releases";
export const VERIFIED_PREFIX = "**Release verified**";

/**
 * The LEADING key of a manifest list item, in any of the three spellings the live corpus holds.
 *
 *   `* WR-1234 title`                          what `cut.mjs` writes (`-`), re-serialised by Linear to `*`
 *   `* [WR-1234](https://linear.app/…) title`   a mention, which is how Linear stores a key a human
 *                                               typed or edited in -- release WR-7954 lists all of its
 *                                               items this way
 *   `* <issue id="…" href="…">WR-1234</issue>`  the same mention as the Linear MCP serialises it
 *
 * WR-9841 guard 14, measured 2026-09-24 across all 56 Release issues: the bare-key pattern read
 * WR-7954's manifest as EMPTY. So the verifier moved nothing for it, the tick could not see it as
 * in flight, and a merge gate could never prove its keys. Only the LEADING token of a list item
 * counts (WR-7268), so a key inside a title or in prose is still never a manifest entry.
 */
const MANIFEST_ITEM_RE =
  /^\s*[-*]\s+(?:\[(WR-\d+)\]\([^)\s]*\)|<issue\b[^>]*>(WR-\d+)<\/issue>|(WR-\d+)\b)/gm;

/**
 * `WR-1234` identifiers listed under `## Manifest` in a Release issue description.
 *
 * Sliced rather than matched with a single lookahead: the obvious `(?=^##\s|\Z)` is wrong in
 * JavaScript, where `\Z` is not an end-of-input anchor at all -- it is an escaped literal `Z`. That
 * regex would have ended the section at the first capital Z in the text, or run to the end of the
 * description and swallowed every later section's keys. This decides what gets moved to Done, so it
 * reads the section boundary explicitly.
 *
 * BOTH `-` AND `*` BULLETS: `cut.mjs` writes `-`, and Linear re-serialises the stored description
 * with `*`. A dash-only pattern would read every real manifest as empty and fail silently.
 *
 * @param {string | null | undefined} description
 * @returns {string[]}
 */
export function manifestFrom(description) {
  const text = description ?? "";
  const start = /^##\s*Manifest\s*$/im.exec(text);
  if (!start) return [];
  const rest = text.slice(start.index + start[0].length);
  const next = /^##\s/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  return [...new Set([...section.matchAll(MANIFEST_ITEM_RE)].map((m) => m[1] ?? m[2] ?? m[3]))];
}

/**
 * Does this Release record satisfy all four conditions for `key`? Pure.
 * @param {string} key
 * @param {{ identifier: string, project: string | null, stateType: string | null, description: string | null, comments: string[] }} release
 */
export function releaseProves(key, release) {
  if (release?.project !== RELEASES_PROJECT) return false;
  if (release?.stateType !== "completed") return false;
  if (!manifestFrom(release?.description ?? "").includes(key)) return false;
  return (release?.comments ?? []).some((b) => String(b ?? "").trimStart().startsWith(VERIFIED_PREFIX));
}

/**
 * The proof over a set of Release records. Pure -- the shape every consumer tests.
 * @param {string} key
 * @param {Array<Parameters<typeof releaseProves>[1]>} releases
 * @returns {{ proven: boolean, release: string | null, reason: string }}
 */
export function proofFromReleases(key, releases) {
  if (!/^WR-\d+$/.test(String(key ?? ""))) return { proven: false, release: null, reason: "malformed-key" };
  const hit = (releases ?? []).find((r) => releaseProves(key, r));
  if (hit) return { proven: true, release: hit.identifier, reason: "verified-release-manifest" };
  const inAnyManifest = (releases ?? []).some((r) => manifestFrom(r?.description ?? "").includes(key));
  return {
    proven: false,
    release: null,
    reason: inAnyManifest ? "manifest-without-verified-completed-release" : "not-in-any-manifest",
  };
}
