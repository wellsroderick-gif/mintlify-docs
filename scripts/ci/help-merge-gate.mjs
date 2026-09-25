// @ts-check
/**
 * Help-PR merge gate (WR-9862): the release-proof gate, the merge, and closing the help ticket.
 *
 * Runs ONLY from .github/workflows/auto-merge-help-prs.yml. That workflow is trusted: it starts
 * from `workflow_run`, `schedule`, `workflow_dispatch` and `pull_request_target`, all of which run
 * the definition on `main`. It checks out `main`, never a PR's head, and it is the only place the
 * Linear key (Environment `linear-robot`, main only) can be read. The six content checks run in
 * help-pr-checks.yml, on the PR's code, with no secrets.
 *
 *   select  Count the open help PRs whose Help PR checks passed on their head. GitHub reads only,
 *           no Linear key. The sweep job, which holds the key, runs only when this is non-zero.
 *   sweep   Each open help PR: head `mintlify-mcp/` or `admin-mcp/`, from this repo, into main,
 *           not a draft. The Help PR checks must have passed on its head. It must touch nothing
 *           under `.github/` or `scripts/` (this gate's own code merges by hand). Every blocker of
 *           its ticket must be spent. GitHub must call it mergeable. Then it is squash-merged, pinned
 *           to that head (`--match-head-commit`), and its ticket is closed (below). A PR that cannot
 *           merge gets ONE sticky comment saying why, rewritten only when the reason changes.
 *   close   A merged PR (PR_NUMBER, PR_HEAD_REF, PR_TITLE, PR_MERGE_SHA, from the event through
 *           `env:`): close the ticket it names. This is for merges this robot did not make. A merge
 *           made with GITHUB_TOKEN starts no workflow, so the sweep closes its own merges itself.
 *
 * WHY. Linear takes no action on pull requests into `main` (a No-action branch rule since
 * 2026-09-24), so a help ticket no longer closes itself when its PR merges; this does. `main` is
 * the live help site, so a merge is a release: a help ticket goes straight to Done. A WR-Games
 * ticket that a PR here happens to name is NEVER moved -- that is how WR-9774 was knocked out of
 * Ready for Smoke Test -- and gets one comment saying so.
 *
 * WHICH TICKET. The key in the head branch (`<prefix>/wr-<n>-...`), else the one key in the title.
 * No key means no ticket: nothing to prove and nothing to close.
 *
 * RELEASE PROOF. A help ticket that is `blockedBy` WR-Games work must not publish before that work
 * is in production. `release-proof-core.mjs` beside this file is a BYTE-IDENTICAL vendored copy of
 * board-game-meetup-nexus `scripts/release/release-proof-core.mjs`, with `release-proof-cases.json`.
 * Never edit either here: they are re-vendored from that repo, whose custodian compares the blob
 * SHAs nightly.
 *
 * FAILS CLOSED. Anything the gate cannot read or parse is a HOLD, never a merge. There is no
 * package.json in this repo: node builtins and global fetch only.
 *
 * Env: GITHUB_REPOSITORY always; GH_TOKEN for select and sweep; LINEAR_API_KEY (the raw key, no
 * "Bearer") for sweep and close. HELP_MERGE_GATE_DRY_RUN=1 reads everything and writes nothing.
 *
 * Tests: node --test scripts/ci/help-merge-gate.test.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { manifestFrom, proofFromReleases } from "./release-proof-core.mjs";

export const HELP_BRANCH_PREFIXES = Object.freeze(["mintlify-mcp/", "admin-mcp/"]);
export const CHECKS_WORKFLOW = "help-pr-checks.yml";
export const HOLD_MARKER = "<!-- wr-help-merge-gate -->";
export const CLOSE_MARKER = "<!-- wr-help-merge-gate-close -->";
export const HELP_LABELS = Object.freeze(["repo:mintlify-docs", "help-content", "changelog"]);
export const HELP_PROJECT = "Helpdesk & Support Integration";
export const REPO_LABEL = "repo:mintlify-docs";
export const TERMINAL_STATE_TYPES = Object.freeze(["completed", "canceled", "duplicate"]);
/** What an auto-merged PR may never touch: the workflows, and the code this gate runs. */
export const VETO_PREFIXES = Object.freeze([".github/", "scripts/"]);

// ---- pure decisions -----------------------------------------------------------------------------

/**
 * The ticket a head branch names: `<prefix>/wr-<n>-...` for any one-segment prefix, or null.
 * @param {string | null | undefined} ref
 */
export function keyFromBranch(ref) {
  const m = /^[a-z0-9._-]+\/wr-(\d+)(?:-|$)/i.exec(String(ref ?? ""));
  return m ? `WR-${Number(m[1])}` : null;
}

/**
 * The ticket a PR names: its branch key, else the ONE key in its title. Two keys in a title is
 * ambiguous, and ambiguous is no ticket.
 * @param {{ headRef?: string | null, title?: string | null }} pr
 */
export function ticketKeyOf({ headRef, title }) {
  const fromBranch = keyFromBranch(headRef);
  if (fromBranch) return fromBranch;
  const inTitle = [...new Set([...String(title ?? "").matchAll(/\bWR-(\d+)\b/gi)].map((m) => `WR-${Number(m[1])}`))];
  return inTitle.length === 1 ? inTitle[0] : null;
}

/**
 * Open help PRs this gate may consider: into main, from this repo, not a draft, help-branch prefix.
 * @param {any[]} prs GitHub REST `pulls` objects
 * @param {string} repo `owner/name`
 */
export function helpCandidates(prs, repo) {
  return (prs ?? [])
    .filter(
      (p) =>
        p?.state === "open" &&
        p?.draft !== true &&
        p?.base?.ref === "main" &&
        p?.head?.repo?.full_name === repo &&
        HELP_BRANCH_PREFIXES.some((pre) => String(p?.head?.ref ?? "").startsWith(pre)),
    )
    .sort((a, b) => Number(a.number) - Number(b.number));
}

/**
 * The path veto. A PR that edits a workflow or this gate's own code is merged by a human, so no
 * auto-merged PR can change what runs with the Linear key.
 * @param {Array<{ filename?: string, previous_filename?: string }>} files GitHub REST `pulls/<n>/files`
 */
export function judgePaths(files) {
  const names = (files ?? []).flatMap((f) => [f?.filename, f?.previous_filename]).filter(Boolean).map(String);
  const hit = names.find((n) => VETO_PREFIXES.some((p) => n.startsWith(p)));
  return hit ? { ok: false, reason: `it touches \`${hit}\`, and workflow or script changes merge by hand` } : { ok: true, reason: "content only" };
}

/**
 * The head's Help PR checks. The NEWEST run on this SHA decides, and it must have COMPLETED with
 * `success`. No run, a run still going, or any other conclusion holds.
 * @param {any[]} runs GitHub REST `actions/workflows/<file>/runs` workflow_runs
 */
export function judgeChecks(runs) {
  const newest = [...(runs ?? [])].sort(
    (a, b) => Date.parse(b?.created_at ?? "") - Date.parse(a?.created_at ?? "") || Number(b?.id ?? 0) - Number(a?.id ?? 0),
  )[0];
  if (!newest) return { ok: false, reason: "no Help PR checks run on the head yet" };
  if (newest.status !== "completed") return { ok: false, reason: "Help PR checks still running" };
  return newest.conclusion === "success" ? { ok: true, reason: "checks green" } : { ok: false, reason: `Help PR checks ${newest.conclusion}` };
}

/**
 * GitHub's own verdict. `null` means it has not computed one yet, which holds too.
 * @param {any} pr GitHub REST single-PR object
 */
export function judgeMergeable(pr) {
  if (pr?.mergeable === true) return { ok: true, reason: "mergeable" };
  if (pr?.mergeable === false) return { ok: false, reason: "it does not merge cleanly into main" };
  return { ok: false, reason: "GitHub has not worked out whether it merges cleanly yet" };
}

/**
 * Is ONE blocker spent? By its own repo's release rule, never by state alone.
 *   - no `repo:*` label (WR-Games): only a verified WR-Games release proves it;
 *   - `repo:mintlify-docs`: Done AND a merged PR here that names it -- `main` is the live site, so
 *     that merge was its release;
 *   - any other `repo:*` label, or anything unreadable: NOT spent.
 * Canceled is never spent on either arm.
 * @param {{ identifier?: string, stateType?: string, labels?: string[] }} blocker
 * @param {{ releases: any[], mergedKeys: Set<string> }} ctx
 */
export function blockerSpent(blocker, ctx) {
  const key = blocker?.identifier;
  if (!key || typeof blocker?.stateType !== "string") return { spent: false, reason: `${key ?? "?"}: unreadable` };
  const repo = (blocker.labels ?? []).filter((n) => String(n).trim().toLowerCase().startsWith("repo:"));
  if (repo.length === 0) {
    const p = proofFromReleases(key, ctx.releases);
    return { spent: p.proven, reason: p.proven ? `${key}: shipped in ${p.release}` : `${key}: not in a verified WR-Games release yet (${p.reason})` };
  }
  if (repo.length === 1 && repo[0] === REPO_LABEL) {
    const ok = blocker.stateType === "completed" && ctx.mergedKeys.has(key);
    return { spent: ok, reason: ok ? `${key}: merged here` : `${key}: not merged here yet (state ${blocker.stateType})` };
  }
  return { spent: false, reason: `${key}: ${repo.join(", ")} has no release rule this gate can read` };
}

/**
 * @param {{ blockers: any[], truncated: boolean } | null} blockers
 * @param {{ releases: any[], mergedKeys: Set<string> }} ctx
 */
export function judgeBlockers(blockers, ctx) {
  if (!blockers) return { ok: false, reason: "its blockers could not be read" };
  if (blockers.truncated) return { ok: false, reason: "its blocker list was truncated" };
  const live = blockers.blockers.map((b) => blockerSpent(b, ctx)).filter((r) => !r.spent);
  return live.length ? { ok: false, reason: `live blocker(s): ${live.map((r) => r.reason).join("; ")}` } : { ok: true, reason: "no live blocker" };
}

/**
 * What a merged PR does to the ticket it names.
 *   "none"    no ticket (no key, or the key reads as nothing)
 *   "skip"    already completed, canceled or duplicate
 *   "close"   a help ticket (a help label, `repo:mintlify-docs`, or the Helpdesk project) -> Done
 *   "comment" anything else -- a WR-Games ticket is never moved from here, only told, once
 * @param {any} issue Linear issue with state{type}, labels{nodes{name}}, project{name}
 */
export function closeDecision(issue) {
  if (!issue) return "none";
  if (TERMINAL_STATE_TYPES.includes(issue?.state?.type)) return "skip";
  const names = (issue?.labels?.nodes ?? []).map((/** @type {any} */ l) => l?.name);
  if (HELP_LABELS.some((l) => names.includes(l)) || issue?.project?.name === HELP_PROJECT) return "close";
  return "comment";
}

/** @param {{ reason: string, headSha: string, at: string }} a */
export function holdCommentBody({ reason, headSha, at }) {
  return [
    HOLD_MARKER,
    `**Help merge gate: holding.** ${reason[0].toUpperCase()}${reason.slice(1)}.`,
    "",
    `Head \`${headSha}\`, checked ${at}. The gate looks again when the checks finish and every hour; this comment is rewritten in place when the reason changes.`,
  ].join("\n");
}

/** @param {{ prNumber: number, mergeSha: string, repo: string }} a */
export function closedCommentBody({ prNumber, mergeSha, repo }) {
  return [
    `${CLOSE_MARKER} #${prNumber}`,
    `**Published.** ${repo} PR #${prNumber} merged into \`main\` as \`${mergeSha}\`. \`main\` is the live help site, so this ticket is done.`,
  ].join("\n");
}

/** @param {{ prNumber: number, repo: string }} a */
export function notHelpTicketBody({ prNumber, repo }) {
  return [
    `${CLOSE_MARKER} #${prNumber}`,
    `**Not moved.** ${repo} PR #${prNumber} merged and names this ticket, but this is not a help ticket: no help-content, changelog or repo:mintlify-docs label, and not in ${HELP_PROJECT}.`,
    "",
    "A PR in the help repo names only its own help ticket. This ticket's state is unchanged.",
  ].join("\n");
}

// ---- I/O ------------------------------------------------------------------------------------------

const REPO = process.env.GITHUB_REPOSITORY ?? "";
const DRY = process.env.HELP_MERGE_GATE_DRY_RUN === "1";
const log = (/** @type {string} */ m) => console.log(m);
const errText = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

/** @param {string} path @param {{ method?: string, body?: any }} [opts] */
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`GitHub ${opts.method ?? "GET"} ${path} -> ${res.status}: ${json?.message ?? text.slice(0, 200)}`);
  return json;
}

/** @param {string} query @param {Record<string, any>} [variables] */
async function linear(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: process.env.LINEAR_API_KEY ?? "" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`Linear ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  return json.data;
}

/**
 * Every node of a Linear connection. Hitting the page cap returns `truncated`, never a short list.
 * @param {string} query @param {Record<string, any>} vars @param {(d: any) => any} pick
 */
async function linearAll(query, vars, pick, maxPages = 20) {
  /** @type {any[]} */
  const out = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const conn = pick(await linear(query, { ...vars, after }));
    if (!conn) throw new Error("Linear returned no connection");
    out.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage) return { nodes: out, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { nodes: out, truncated: true };
}

/** Blockers are `inverseRelations` of type `blocks`: the `issue` on that edge blocks this one. @param {string} key */
async function readBlockers(key) {
  const r = await linearAll(
    `query($id:String!, $after:String){ issue(id:$id){ inverseRelations(first:100, after:$after){ nodes{ type issue{ identifier state{ type } labels{ nodes{ name } } } } pageInfo{ hasNextPage endCursor } } } }`,
    { id: key },
    (x) => x?.issue?.inverseRelations,
  );
  return {
    truncated: r.truncated,
    blockers: r.nodes
      .filter((n) => n?.type === "blocks" && n.issue)
      .map((n) => ({
        identifier: n.issue.identifier,
        stateType: n.issue.state?.type,
        labels: (n.issue.labels?.nodes ?? []).map((/** @type {any} */ l) => l.name),
      })),
  };
}

/** Completed Releases whose manifest names one of `keys`, with their comments. @param {string[]} keys */
async function readReleases(keys) {
  if (keys.length === 0) return [];
  const all = await linearAll(
    `query($after:String){ issues(filter:{ project:{ name:{ eq:"Releases" } }, state:{ type:{ eq:"completed" } } }, first:100, after:$after){ nodes{ identifier description state{ type } project{ name } } pageInfo{ hasNextPage endCursor } } }`,
    {},
    (x) => x?.issues,
  );
  if (all.truncated) throw new Error("the Releases list was truncated");
  const out = [];
  for (const n of all.nodes.filter((r) => keys.some((k) => manifestFrom(r.description).includes(k)))) {
    const c = await linearAll(
      `query($id:String!, $after:String){ issue(id:$id){ comments(first:100, after:$after){ nodes{ body } pageInfo{ hasNextPage endCursor } } } }`,
      { id: n.identifier },
      (x) => x?.issue?.comments,
    );
    if (c.truncated) throw new Error(`comments truncated on ${n.identifier}`);
    out.push({
      identifier: n.identifier,
      project: n.project?.name ?? null,
      stateType: n.state?.type ?? null,
      description: n.description ?? "",
      comments: c.nodes.map((/** @type {any} */ x) => x.body ?? ""),
    });
  }
  return out;
}

/** The ticket named by every MERGED PR into main: this repo's release record. */
async function mergedKeys() {
  const keys = new Set();
  for (let page = 1; page <= 10; page++) {
    const prs = await gh(`repos/${REPO}/pulls?state=closed&base=main&per_page=100&page=${page}`);
    for (const p of prs) {
      const key = p.merged_at ? ticketKeyOf({ headRef: p.head?.ref, title: p.title }) : null;
      if (key) keys.add(key);
    }
    if (prs.length < 100) return keys;
  }
  throw new Error("the merged-PR list passed 1,000 and was not read to the end");
}

/** A PR's mergeability, polling briefly: GitHub works it out lazily. @param {number} n */
async function readMergeable(n) {
  for (let i = 0; i < 6; i++) {
    const pr = await gh(`repos/${REPO}/pulls/${n}`);
    if (pr.mergeable !== null) return pr;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return gh(`repos/${REPO}/pulls/${n}`);
}

/** Create or update the one sticky hold comment on a PR. @param {any} pr @param {string} reason */
async function hold(pr, reason) {
  log(`  #${pr.number} ${pr.head.ref}: HOLD, ${reason}`);
  if (DRY) return;
  const body = holdCommentBody({ reason, headSha: pr.head.sha, at: new Date().toISOString() });
  const comments = await gh(`repos/${REPO}/issues/${pr.number}/comments?per_page=100`);
  const mine = comments.find((/** @type {any} */ c) => String(c.body ?? "").includes(HOLD_MARKER));
  if (mine) {
    // Rewrite only when the reason or the head changed, so the hourly sweep does not churn the PR.
    if (String(mine.body).split("\n").slice(0, 2).join("\n") === body.split("\n").slice(0, 2).join("\n") && String(mine.body).includes(pr.head.sha)) return;
    await gh(`repos/${REPO}/issues/comments/${mine.id}`, { method: "PATCH", body: { body } });
  } else {
    await gh(`repos/${REPO}/issues/${pr.number}/comments`, { method: "POST", body: { body } });
  }
}

/** @param {string} issueId @param {string} body */
async function comment(issueId, body) {
  const r = await linear(`mutation($id:String!, $b:String!){ commentCreate(input:{ issueId:$id, body:$b }){ success } }`, { id: issueId, b: body });
  if (!r?.commentCreate?.success) throw new Error("commentCreate did not succeed");
}

/**
 * Close the ticket a merged PR names: Done for a help ticket, one comment for anything else.
 * @param {{ prNumber: number, headRef: string, title: string, mergeSha: string }} pr
 */
async function closeTicket({ prNumber, headRef, title, mergeSha }) {
  const key = ticketKeyOf({ headRef, title });
  if (!key) {
    log(`close: #${prNumber} ${headRef} names no ticket, so there is nothing to close`);
    return;
  }
  const d = await linear(
    `query($id:String!){ issue(id:$id){ id identifier team{ key } state{ name type } labels{ nodes{ name } } project{ name } } }`,
    { id: key },
  ).catch((e) => {
    // Linear answers an unknown identifier with an error, not a null issue.
    if (/not found|entity not found/i.test(errText(e))) return null;
    throw e;
  });
  const issue = d?.issue ?? null;
  const decision = closeDecision(issue);
  log(`close: #${prNumber} -> ${key}: ${decision}${issue ? ` (${issue.state?.name})` : ""}`);
  if (decision === "none" || decision === "skip" || DRY) return;

  const marker = `${CLOSE_MARKER} #${prNumber}`;
  const said = (
    await linearAll(
      `query($id:String!, $after:String){ issue(id:$id){ comments(first:100, after:$after){ nodes{ body } pageInfo{ hasNextPage endCursor } } } }`,
      { id: issue.id },
      (x) => x?.issue?.comments,
    )
  ).nodes.some((c) => String(c?.body ?? "").includes(marker));

  if (decision === "comment") {
    if (!said) await comment(issue.id, notHelpTicketBody({ prNumber, repo: REPO }));
    return;
  }
  const s = await linear(`query($k:String!){ workflowStates(filter:{ team:{ key:{ eq:$k } }, name:{ eq:"Done" } }){ nodes{ id name team{ key } } } }`, { k: issue.team.key });
  const done = (s?.workflowStates?.nodes ?? []).find((/** @type {any} */ n) => n?.name === "Done" && n?.team?.key === issue.team.key)?.id;
  if (!done) throw new Error(`team ${issue.team.key} has no "Done" state`);
  const u = await linear(`mutation($id:String!, $s:String!){ issueUpdate(id:$id, input:{ stateId:$s }){ success } }`, { id: issue.id, s: done });
  if (!u?.issueUpdate?.success) throw new Error(`the move to Done did not succeed on ${key}`);
  log(`close: ${key}: ${issue.state?.name} -> Done`);
  if (!said) await comment(issue.id, closedCommentBody({ prNumber, mergeSha, repo: REPO }));
}

/** Open help PRs, each with its checks verdict. @returns {Promise<{ pr: any, checks: { ok: boolean, reason: string } }[]>} */
async function judged() {
  const open = await gh(`repos/${REPO}/pulls?state=open&base=main&per_page=100`);
  const candidates = helpCandidates(open, REPO);
  log(`help-merge-gate: ${open.length} open PR(s), ${candidates.length} help PR(s)`);
  const out = [];
  for (const pr of candidates) {
    const runs = await gh(`repos/${REPO}/actions/workflows/${CHECKS_WORKFLOW}/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=20`);
    out.push({ pr, checks: judgeChecks(runs.workflow_runs) });
  }
  return out;
}

async function select() {
  const ready = (await judged()).filter(({ pr, checks }) => {
    log(`  #${pr.number} ${pr.head.ref}: ${checks.reason}`);
    return checks.ok;
  });
  const line = `ready=${ready.length}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  log(line.trim());
}

async function sweep() {
  /** @type {Set<string> | null} */
  let merged = null;
  for (const { pr, checks } of await judged()) {
    if (!checks.ok) {
      log(`  #${pr.number} ${pr.head.ref}: not yet, ${checks.reason}`);
      continue;
    }
    const paths = judgePaths(await gh(`repos/${REPO}/pulls/${pr.number}/files?per_page=100`));
    if (!paths.ok) {
      await hold(pr, paths.reason);
      continue;
    }
    const key = ticketKeyOf({ headRef: pr.head.ref, title: pr.title });
    if (key) {
      let verdict;
      try {
        const blockers = await readBlockers(key);
        const needsRelease = blockers.blockers.filter((b) => !b.labels.some((/** @type {string} */ n) => n.startsWith("repo:"))).map((b) => b.identifier);
        if (blockers.blockers.length && !merged) merged = await mergedKeys();
        verdict = judgeBlockers(blockers, { releases: await readReleases(needsRelease), mergedKeys: merged ?? new Set() });
      } catch (e) {
        verdict = { ok: false, reason: `its blockers or releases could not be read (${errText(e)})` };
      }
      if (!verdict.ok) {
        await hold(pr, `${key} has ${verdict.reason}`);
        continue;
      }
    }
    const m = judgeMergeable(await readMergeable(pr.number));
    if (!m.ok) {
      await hold(pr, m.reason);
      continue;
    }
    if (DRY) {
      log(`  [dry-run] would squash-merge #${pr.number} at ${pr.head.sha} and close ${key ?? "no ticket"}`);
      continue;
    }
    let ghSaid = "";
    try {
      execFileSync("gh", ["pr", "merge", String(pr.number), "-R", REPO, "--squash", "--delete-branch", "--match-head-commit", pr.head.sha], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (e) {
      ghSaid = String(/** @type {any} */ (e)?.stderr ?? errText(e)).trim();
    }
    // The PR's own state is the truth: gh can fail after the merge (the branch delete), and a
    // merged PR must still get its ticket closed.
    const after = await gh(`repos/${REPO}/pulls/${pr.number}`);
    if (!after.merged) {
      console.error(`help-merge-gate: #${pr.number} did NOT merge: ${ghSaid || "gh reported success but the PR is not merged"}`);
      process.exitCode = 1;
      continue;
    }
    log(`  #${pr.number}: MERGED as ${after.merge_commit_sha}${ghSaid ? ` (gh also said: ${ghSaid})` : ""}`);
    try {
      await closeTicket({ prNumber: pr.number, headRef: pr.head.ref, title: pr.title, mergeSha: after.merge_commit_sha });
    } catch (e) {
      console.error(`help-merge-gate: #${pr.number} MERGED as ${after.merge_commit_sha}, but closing its ticket FAILED: ${errText(e)}`);
      process.exitCode = 1;
    }
  }
}

/** @type {Record<string, { needs: string[], run: () => Promise<void> }>} */
const MODES = {
  select: { needs: ["GH_TOKEN"], run: select },
  sweep: { needs: ["GH_TOKEN", "LINEAR_API_KEY"], run: sweep },
  close: {
    needs: ["LINEAR_API_KEY"],
    run: () =>
      closeTicket({
        prNumber: Number(process.env.PR_NUMBER),
        headRef: String(process.env.PR_HEAD_REF ?? ""),
        title: String(process.env.PR_TITLE ?? ""),
        mergeSha: String(process.env.PR_MERGE_SHA ?? ""),
      }),
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = MODES[process.argv[2] ?? ""];
  if (!mode) {
    console.error("usage: help-merge-gate.mjs select | sweep | close");
    process.exitCode = 1;
  } else {
    // Names only, never values.
    const missing = ["GITHUB_REPOSITORY", ...mode.needs].filter((k) => !process.env[k]);
    if (missing.length) {
      console.error(`help-merge-gate ${process.argv[2]}: missing ${missing.join(", ")}; nothing merged or closed`);
      process.exitCode = 1;
    } else {
      mode.run().catch((e) => {
        console.error(`help-merge-gate ${process.argv[2]} FAILED: ${errText(e)}`);
        process.exitCode = 1;
      });
    }
  }
}
