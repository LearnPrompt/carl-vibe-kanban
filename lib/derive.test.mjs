import test from "node:test";
import assert from "node:assert/strict";
import { deriveStatus, deriveFlags, deriveWorktreeState, deriveStage, deriveConflicts } from "./derive.mjs";

const baseFacts = {
  hasBranch: true,
  branchLocation: "local",
  prState: null,
  mergedIntoBase: false,
  hasWorktree: false,
};

function status(overridesManual, overridesFacts) {
  return deriveStatus({ pinned: false, pinnedStatus: null, priorStatus: "backlog", ...overridesManual }, {
    ...baseFacts,
    ...overridesFacts,
  });
}

// Rule 1: pinned status always wins, regardless of facts.
test("rule 1: status_pinned keeps the pinned status no matter what", () => {
  assert.equal(
    status({ pinned: true, pinnedStatus: "blocked" }, { prState: "MERGED", mergedIntoBase: true, hasWorktree: true }),
    "blocked"
  );
});

// Rule 2: PR merged -> done
test("rule 2: MERGED pr_state -> done", () => {
  assert.equal(status({}, { prState: "MERGED" }), "done");
});

// Rule 3: PR closed unmerged -> dropped
test("rule 3: CLOSED pr_state -> dropped", () => {
  assert.equal(status({}, { prState: "CLOSED" }), "dropped");
});

// Rule 4: PR open non-draft -> review
test("rule 4: OPEN pr_state -> review", () => {
  assert.equal(status({}, { prState: "OPEN" }), "review");
});

// Rule 5: PR open draft -> doing
test("rule 5: DRAFT pr_state -> doing", () => {
  assert.equal(status({}, { prState: "DRAFT" }), "doing");
});

// Rule 6: no PR, branch merged into base -> done
test("rule 6: no PR + merged into base -> done", () => {
  assert.equal(status({}, { prState: null, mergedIntoBase: true, hasWorktree: false }), "done");
});

// Rule 7: no PR, not merged, has worktree -> doing
test("rule 7: no PR + has worktree -> doing", () => {
  assert.equal(status({}, { prState: null, mergedIntoBase: false, hasWorktree: true }), "doing");
});

// Rule 8: no PR, not merged, no worktree -> backlog
test("rule 8: no PR + no worktree -> backlog", () => {
  assert.equal(status({}, { prState: null, mergedIntoBase: false, hasWorktree: false }), "backlog");
});

// Rule 9: branch missing entirely -> status unchanged (flag added separately)
test("rule 9: branch missing (local+origin both absent) keeps prior status", () => {
  assert.equal(
    status({ priorStatus: "doing" }, { branchLocation: null, prState: null }),
    "doing"
  );
  assert.equal(
    status({ priorStatus: "review" }, { branchLocation: null, prState: null }),
    "review"
  );
});

// Rule 10: detached worktree (no branch field at all) -> doing
test("rule 10: detached worktree card (hasBranch=false) -> doing", () => {
  assert.equal(status({}, { hasBranch: false, branchLocation: null }), "doing");
});

test("PR rules take priority even over branch-missing (branch deleted after merge)", () => {
  assert.equal(status({}, { prState: "MERGED", branchLocation: null }), "done");
});

// --- flags -------------------------------------------------------------

const nowRef = new Date("2026-09-05T00:00:00Z");

function flags(overrides) {
  return deriveFlags({
    hasBranch: true,
    branchLocation: "local",
    worktreePrunable: false,
    prState: null,
    status: "doing",
    lastCommitAt: null,
    now: nowRef,
    staleDays: 7,
    nextStep: "do the thing",
    ...overrides,
  });
}

test("flag: branch_missing when card has a branch but git can't resolve it", () => {
  assert.deepEqual(flags({ branchLocation: null }), ["branch_missing"]);
});

test("flag: branch_missing still applies even when the card has an associated PR (rule G)", () => {
  const result = flags({ branchLocation: null, prState: "OPEN", status: "review" });
  assert.ok(result.includes("branch_missing"));
});

test("flag: prunable when the worktree is marked prunable", () => {
  assert.deepEqual(flags({ worktreePrunable: true }), ["prunable"]);
});

test("flag: pr_closed_unmerged when pr_state is CLOSED", () => {
  assert.deepEqual(flags({ prState: "CLOSED", status: "dropped" }), ["pr_closed_unmerged"]);
});

test("flag: stale_7d only fires when status is doing/review and commit older than staleDays", () => {
  const eightDaysAgo = new Date(nowRef.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(flags({ lastCommitAt: eightDaysAgo, status: "doing" }), ["stale_7d"]);
  assert.deepEqual(flags({ lastCommitAt: eightDaysAgo, status: "review" }), ["stale_7d"]);
});

test("flag: stale_7d does not fire for backlog/done/dropped/blocked even if old", () => {
  const eightDaysAgo = new Date(nowRef.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(flags({ lastCommitAt: eightDaysAgo, status: "backlog" }), []);
  assert.deepEqual(flags({ lastCommitAt: eightDaysAgo, status: "done", nextStep: "x" }), []);
});

test("flag: stale_7d does not fire when commit is within staleDays", () => {
  const twoDaysAgo = new Date(nowRef.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(flags({ lastCommitAt: twoDaysAgo, status: "doing" }), []);
});

test("flag: no_next_step fires when next_step is empty/whitespace and status is not done/dropped", () => {
  assert.deepEqual(flags({ nextStep: "" }), ["no_next_step"]);
  assert.deepEqual(flags({ nextStep: "   " }), ["no_next_step"]);
});

test("flag: no_next_step does not fire for done or dropped statuses", () => {
  assert.deepEqual(flags({ nextStep: "", status: "done" }), []);
  assert.deepEqual(flags({ nextStep: "", status: "dropped" }), []);
});

test("flags: multiple flags combine, dedupe, and sort alphabetically", () => {
  const eightDaysAgo = new Date(nowRef.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const result = flags({
    branchLocation: null,
    worktreePrunable: true,
    lastCommitAt: eightDaysAgo,
    status: "doing",
    nextStep: "",
  });
  assert.deepEqual(result, [...result].sort());
  assert.deepEqual(new Set(result), new Set(["branch_missing", "prunable", "stale_7d", "no_next_step"]));
});

// --- worktree_state ------------------------------------------------------

test("deriveWorktreeState: null worktree -> null", () => {
  assert.equal(deriveWorktreeState(null), null);
});

test("deriveWorktreeState: prunable takes priority over detached", () => {
  assert.equal(deriveWorktreeState({ prunable: true, detached: true }), "prunable");
});

test("deriveWorktreeState: detached -> 'detached'", () => {
  assert.equal(deriveWorktreeState({ prunable: false, detached: true }), "detached");
});

test("deriveWorktreeState: normal worktree -> 'ok'", () => {
  assert.equal(deriveWorktreeState({ prunable: false, detached: false }), "ok");
});

// --- board-spec-v0.1: deriveStage (7-way, first hit wins) -----------------------

const baseStageFacts = {
  prState: null,
  hasLocalBranch: true,
  hasOriginBranch: true,
  dirtyFiles: 0,
  unpushedCommits: 0,
};

function stage(overrides) {
  return deriveStage({ ...baseStageFacts, ...overrides });
}

test("stage 0: dirty worktree wins even over PR MERGED", () => {
  assert.equal(stage({ prState: "MERGED", dirtyFiles: 3 }), "dirty");
});

test("stage 1: PR MERGED with clean worktree -> merged", () => {
  assert.equal(stage({ prState: "MERGED" }), "merged");
});

test("stage 2: PR CLOSED (unmerged) -> closed", () => {
  assert.equal(stage({ prState: "CLOSED" }), "closed");
});

test("stage 3: branch missing both locally and on origin -> missing", () => {
  assert.equal(stage({ hasLocalBranch: false, hasOriginBranch: false }), "missing");
});

test("stage 4: worktree dirty (uncommitted files) -> dirty", () => {
  assert.equal(stage({ dirtyFiles: 2 }), "dirty");
});

test("stage 5a: local branch exists, no origin branch -> unpushed", () => {
  assert.equal(stage({ hasLocalBranch: true, hasOriginBranch: false }), "unpushed");
});

test("stage 5b: local + origin both exist but local is ahead -> unpushed", () => {
  assert.equal(stage({ hasLocalBranch: true, hasOriginBranch: true, unpushedCommits: 2 }), "unpushed");
});

test("stage 6: PR OPEN/DRAFT, clean and pushed -> pr_open", () => {
  assert.equal(stage({ prState: "OPEN" }), "pr_open");
  assert.equal(stage({ prState: "DRAFT" }), "pr_open");
});

test("stage 7: no PR, clean, pushed and in sync with origin -> pushed", () => {
  assert.equal(stage({ prState: null, unpushedCommits: 0 }), "pushed");
});

test("stage: PR rules take priority even over branch-missing (branch deleted after merge)", () => {
  assert.equal(stage({ prState: "MERGED", hasLocalBranch: false, hasOriginBranch: false }), "merged");
});

// --- board-spec-v0.1: deriveConflicts -------------------------------------------

test("deriveConflicts: no overlap between two branches -> both empty", () => {
  const result = deriveConflicts([
    { branch: "feat/a", files: ["a.ts"] },
    { branch: "feat/b", files: ["b.ts"] },
  ]);
  assert.deepEqual(result, { "feat/a": [], "feat/b": [] });
});

test("deriveConflicts: overlapping files produce a symmetric conflict entry with a count", () => {
  const result = deriveConflicts([
    { branch: "feat/a", files: ["shared.ts", "a-only.ts"] },
    { branch: "feat/b", files: ["shared.ts", "b-only.ts"] },
  ]);
  assert.deepEqual(result["feat/a"], ["feat/b (1 files)"]);
  assert.deepEqual(result["feat/b"], ["feat/a (1 files)"]);
});

test("deriveConflicts: three-way overlap reports each pair independently", () => {
  const result = deriveConflicts([
    { branch: "feat/a", files: ["x.ts"] },
    { branch: "feat/b", files: ["x.ts"] },
    { branch: "feat/c", files: ["x.ts"] },
  ]);
  assert.deepEqual(result["feat/a"].sort(), ["feat/b (1 files)", "feat/c (1 files)"]);
  assert.deepEqual(result["feat/b"].sort(), ["feat/a (1 files)", "feat/c (1 files)"]);
  assert.deepEqual(result["feat/c"].sort(), ["feat/a (1 files)", "feat/b (1 files)"]);
});

test("deriveConflicts: result is deduped and sorted, so it's idempotent across repeated runs", () => {
  const entries = [
    { branch: "feat/a", files: ["one.ts", "two.ts"] },
    { branch: "feat/c", files: ["one.ts"] },
    { branch: "feat/b", files: ["one.ts", "two.ts"] },
  ];
  const result = deriveConflicts(entries);
  assert.deepEqual(result["feat/a"], [...result["feat/a"]].sort());
  // running it again on the same input yields byte-identical output
  const again = deriveConflicts(entries);
  assert.deepEqual(result, again);
});

test("deriveFlags: 'unpushed' flag fires for dirty/unpushed stages, not for others", () => {
  const input = { hasBranch: true, branchLocation: "local", worktreePrunable: false, prState: null, status: "doing", lastCommitAt: null, now: new Date(), staleDays: 7, nextStep: "x" };
  assert.ok(deriveFlags({ ...input, stage: "dirty" }).includes("unpushed"));
  assert.ok(deriveFlags({ ...input, stage: "unpushed" }).includes("unpushed"));
  assert.ok(!deriveFlags({ ...input, stage: "pushed" }).includes("unpushed"));
  assert.ok(!deriveFlags({ ...input }).includes("unpushed")); // no stage passed at all (back-compat)
});

test("deriveFlags: 'conflict' flag fires only when hasConflicts is true", () => {
  const input = { hasBranch: true, branchLocation: "local", worktreePrunable: false, prState: null, status: "doing", lastCommitAt: null, now: new Date(), staleDays: 7, nextStep: "x" };
  assert.ok(deriveFlags({ ...input, hasConflicts: true }).includes("conflict"));
  assert.ok(!deriveFlags({ ...input, hasConflicts: false }).includes("conflict"));
  assert.ok(!deriveFlags({ ...input }).includes("conflict"));
});
