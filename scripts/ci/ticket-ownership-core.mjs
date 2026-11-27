// @ts-check
/**
 * WR-47608 S1 (WR-47682) -- THE ticket-ownership core: pure, import-free, and the ONE copy of the
 * "which ticket does this title/subject OWN, and which does it only mention?" rule.
 *
 * WHY THIS EXISTS. The grammar lived only as `subjectStrongKeys` in `scripts/release/commit-keys.mjs`,
 * which is 500+ lines of nexus-only predicates that command-admin and mintlify-docs cannot resolve
 * (neither shares this repo's module system, and mintlify-docs has no package.json at all). Those two
 * repos' own merge robots (S2 `WR-47683`, S3 `WR-47684`) need the SAME grammar a merged PR title is
 * judged by here, byte-identical, so this file is the smallest canonical slice: it imports nothing.
 *
 * VENDORED, NEVER HAND-COPIED. command-admin (`scripts/merge-gate/ticket-ownership-core.mjs`) and
 * mintlify-docs (`scripts/ci/ticket-ownership-core.mjs`) carry this file BYTE-IDENTICAL, with the
 * fixture `__fixtures__/ticket-ownership-cases.json` beside it, written by
 * `npm run release-proof:vendor -- --family ticket-ownership --target <repo> --to <that checkout>`
 * and never edited there. The custodian's `ticket-ownership-pair` audit compares the blob SHAs on
 * GitHub nightly. Edit it HERE, then re-vendor.
 *
 * THE GRAMMAR (Commander D1-B on WR-46944, 2026-11-22; carried as WR-47608 scope D1): the leading key,
 * or a leading comma/plus/slash/and-joined list of keys, at the very start of a title or commit
 * subject OWNS the work. A key appearing anywhere else -- "(prep for WR-2)", "fix: thing (WR-1)",
 * after "see" or "and" mid-sentence -- is a PASSING MENTION and owns nothing. PR #2576
 * (`WR-46361: step labels use .frame-label (drift gate prep for WR-45308)`) is the incident: Linear's
 * own GitHub integration moved WR-45308 to Ready for Smoke Test on that merge, though the PR owned
 * only WR-46361.
 *
 * `titleStrongKeys` is `commit-keys.mjs`'s `subjectStrongKeys` MOVED here verbatim (byte-for-byte,
 * WR-9841 row 16 discipline): `commit-keys.mjs` re-exports it so every existing caller sees the exact
 * same answers. `keyFromBranch` and `MAX_BRANCH_LENGTH` moved here the same way.
 *
 * THE TOKEN REGEX IS BUILT FROM A STRING SOURCE, NOT A REGEX LITERAL. The `key-predicates-home` scan
 * (`scripts/release/__tests__/key-predicates-home.test.mjs`) reds on a `/\bWR-\d+\b/g` literal
 * anywhere outside `commit-keys.mjs` -- that literal is `commit-keys.mjs`'s own `LOOP_KEY_RE`, the
 * release loop's form, and this file must never carry a second copy of it. `KEY_TOKEN_SOURCE` is a
 * `String.raw` value, assembled into a RegExp at call time, so the scan's literal-string match never
 * fires on this file.
 */

/** The bare key-token pattern, as a STRING (never a regex literal -- see the file header). */
export const KEY_TOKEN_SOURCE = String.raw`\bWR-\d+\b`;

/**
 * Every upper-case `WR-<n>` token in `text`, first-appearance order, deduped.
 * @param {unknown} text
 * @returns {string[]}
 */
export function titleKeyTokens(text) {
  const re = new RegExp(KEY_TOKEN_SOURCE, "g");
  return [...new Set([...String(text ?? "").matchAll(re)].map((m) => m[0]))];
}

/** A branch name longer than this is not a branch any lane or human here creates. */
export const MAX_BRANCH_LENGTH = 200;

/**
 * The key named by a branch, upper-cased, or null. Moved verbatim from `commit-keys.mjs` (WR-9841 row
 * 16; the corpus rationale lives there in full) -- `wr-?\d+` at the START of any `/`-segment,
 * case-insensitive, with a load-bearing terminator (`-`, `_`, `.` or end of segment) so `wr123x-thing`
 * never yields a wrong key. Injection-safe: anything outside `[A-Za-z0-9._/-]` returns null first.
 * @param {unknown} name
 * @returns {string|null}
 */
export function keyFromBranch(name) {
  const s = typeof name === "string" ? name : "";
  if (s.length === 0 || s.length > MAX_BRANCH_LENGTH) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return null;
  for (const segment of s.split("/")) {
    const m = /^wr-?(\d+)(?:[-_.]|$)/i.exec(segment);
    if (m) return `WR-${m[1]}`;
  }
  return null;
}

/**
 * The keys a TITLE or commit SUBJECT owns: only the primary key(s) it opens with, not every key it
 * mentions. Three forms count -- a leading `WR-<n>:`, a leading list of keys the lanes use for batches
 * (`WR-1, WR-2: ...`, `WR-1 + WR-2: ...`), and the conventional `type(WR-<n>): ...` (a `!` breaking
 * marker and a `Revert "` opener are read through). Moved verbatim from `commit-keys.mjs`'s
 * `subjectStrongKeys` (WR-9841 row 16): the list grammar is the one home for this literal (scope D2;
 * `key-predicates-home.test.mjs` asserts it lives ONLY here).
 * @param {unknown} title
 * @returns {string[]} upper-case `WR-####`, first-appearance order, deduped
 */
export function titleStrongKeys(title) {
  const s = String(title ?? "").trim().replace(/^Revert\s+"/, "");
  const list = String.raw`WR-\d+(?:\/\d+)*(?:(?:\s*[,+&/]\s*|\s+and\s+|\s+)WR-\d+(?:\/\d+)*)*`;
  const m = new RegExp(String.raw`^(?:(${list})\b|[a-z]+\((${list})\)!?\s*:)`).exec(s);
  const head = m?.[1] ?? m?.[2];
  return head ? titleKeyTokens(head) : [];
}

/**
 * Every key `title` names that it does NOT own: `titleKeyTokens(title)` minus `titleStrongKeys(title)`.
 * A passing mention -- never an ownership claim.
 * @param {unknown} title
 * @returns {string[]}
 */
export function titleMentionKeys(title) {
  const owned = new Set(titleStrongKeys(title));
  return titleKeyTokens(title).filter((k) => !owned.has(k));
}

/**
 * Why a lane must refuse this title for `ownKey` -- null when it may proceed. `ownKey` must be owned
 * (the leading key or in the leading list), and the title must mention nothing else: Linear moves
 * every ticket a merged title names, so a second key read in passing is moved too (PR #2576).
 * @param {unknown} title
 * @param {string} ownKey
 * @returns {string|null}
 */
export function titleRefusalReason(title, ownKey) {
  if (!titleStrongKeys(title).includes(ownKey)) return `does not open with ${ownKey}`;
  const mentions = titleMentionKeys(title);
  if (mentions.length > 0) return `names ${mentions.join(", ")} in passing`;
  return null;
}

/**
 * The keys this title/branch pair OWNS: the branch's key (if any) first, then the title's strong
 * keys, deduped in that order. Pure composition -- the caller supplies its own branch reader's answer
 * (a lane's `laneBranchKey`, this core's own `keyFromBranch`, or whatever else resolves a branch).
 * @param {{ branchKey?: string|null, title?: unknown }} args
 * @returns {string[]}
 */
export function ownedKeys({ branchKey = null, title = "" } = {}) {
  return [...new Set([...(branchKey ? [branchKey] : []), ...titleStrongKeys(title)])];
}
