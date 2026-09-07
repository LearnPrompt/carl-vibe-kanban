import test from "node:test";
import assert from "node:assert/strict";
import {
  computeId,
  buildCardData,
  cardsEqualIgnoringUpdated,
  unionKeys,
  findCardByAnyKey,
  CARD_KEY_ORDER,
  isCleanupCandidate,
  cleanupBlockers,
  appendBodyLine,
} from "./store.mjs";

test("computeId is stable (deterministic) for the same natural key", () => {
  const a = computeId("feat/i2v-input-assets");
  const b = computeId("feat/i2v-input-assets");
  assert.equal(a, b);
  assert.match(a, /^T-[0-9a-f]{6}$/);
});

test("computeId differs for different natural keys", () => {
  const a = computeId("feat/a");
  const b = computeId("feat/b");
  assert.notEqual(a, b);
});

test("computeId works for absolute worktree paths (detached cards)", () => {
  const id = computeId("/Users/carl/agent-workbench/worktrees/goodcase-eval-run");
  assert.match(id, /^T-[0-9a-f]{6}$/);
});

test("buildCardData fills every fixed key in the correct order, defaulting missing arrays to []", () => {
  const built = buildCardData({ id: "T-000001", title: "x" });
  assert.deepEqual(Object.keys(built), CARD_KEY_ORDER);
  assert.equal(built.id, "T-000001");
  assert.equal(built.title, "x");
  assert.equal(built.branch, null);
  assert.deepEqual(built.evidence, []);
  assert.deepEqual(built.flags, []);
  assert.deepEqual(built.keys, []);
});

test("cardsEqualIgnoringUpdated ignores only the `updated` field", () => {
  const a = buildCardData({ id: "T-1", title: "x", updated: "2026-09-01T00:00:00Z" });
  const b = buildCardData({ id: "T-1", title: "x", updated: "2026-09-05T00:00:00Z" });
  assert.equal(cardsEqualIgnoringUpdated(a, b), true);
});

test("cardsEqualIgnoringUpdated detects a real difference", () => {
  const a = buildCardData({ id: "T-1", title: "x", status: "doing" });
  const b = buildCardData({ id: "T-1", title: "x", status: "review" });
  assert.equal(cardsEqualIgnoringUpdated(a, b), false);
});

test("unionKeys merges and dedupes, dropping falsy entries", () => {
  const result = unionKeys(["feat/a"], ["feat/a", "feat/b", null, undefined]);
  assert.deepEqual(result, ["feat/a", "feat/b"]);
});

test("findCardByAnyKey matches a card whose keys array contains any candidate", () => {
  const cards = [
    { data: { id: "T-1", keys: ["feat/a"] } },
    { data: { id: "T-2", keys: ["/path/to/detached-wt"] } },
  ];
  assert.equal(findCardByAnyKey(cards, ["/path/to/detached-wt"]).data.id, "T-2");
  assert.equal(findCardByAnyKey(cards, ["feat/nowhere"]), undefined);
});

// --- board-spec-v0.4 §A2: done 清理 -----------------------------------------

function baseCleanupCard(overrides = {}) {
  return {
    id: "T-1",
    branch: "feat/a",
    worktree: "/Users/carl/agent-workbench/worktrees/repo-feat-a",
    stage: "merged",
    status: "done",
    dirty_files: 0,
    unpushed_commits: 0,
    ...overrides,
  };
}

test("isCleanupCandidate: stage=merged with a worktree + branch is a candidate", () => {
  assert.equal(isCleanupCandidate(baseCleanupCard({ stage: "merged" })), true);
});

test("isCleanupCandidate: stage=closed with a worktree + branch is a candidate", () => {
  assert.equal(isCleanupCandidate(baseCleanupCard({ stage: "closed" })), true);
});

test("isCleanupCandidate: status=dropped (any stage) with a worktree + branch is a candidate", () => {
  assert.equal(isCleanupCandidate(baseCleanupCard({ stage: "pushed", status: "dropped" })), true);
});

test("isCleanupCandidate: an active stage (e.g. pushed, not dropped) is never a candidate", () => {
  assert.equal(isCleanupCandidate(baseCleanupCard({ stage: "pushed", status: "doing" })), false);
});

test("isCleanupCandidate: no worktree at all is never touched (nothing to clean, or the main worktree)", () => {
  assert.equal(isCleanupCandidate(baseCleanupCard({ worktree: null })), false);
});

test("isCleanupCandidate: a detached card (no branch) is never touched, even if merged/closed/dropped", () => {
  assert.equal(isCleanupCandidate(baseCleanupCard({ branch: null })), false);
});

test("isCleanupCandidate: null/undefined card never throws", () => {
  assert.equal(isCleanupCandidate(null), false);
  assert.equal(isCleanupCandidate(undefined), false);
});

test("cleanupBlockers: a clean, fully-pushed candidate has no blockers", () => {
  assert.deepEqual(cleanupBlockers(baseCleanupCard()), []);
});

test("cleanupBlockers: dirty files blocks", () => {
  const blockers = cleanupBlockers(baseCleanupCard({ dirty_files: 3 }));
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /3 个未提交文件/);
});

test("cleanupBlockers: unpushed commits blocks", () => {
  const blockers = cleanupBlockers(baseCleanupCard({ unpushed_commits: 2 }));
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /2 个 commit 未 push/);
});

test("cleanupBlockers: both dirty files and unpushed commits report both reasons", () => {
  const blockers = cleanupBlockers(baseCleanupCard({ dirty_files: 1, unpushed_commits: 1 }));
  assert.equal(blockers.length, 2);
});

test("cleanupBlockers: force:true bypasses every blocker", () => {
  const blockers = cleanupBlockers(baseCleanupCard({ dirty_files: 5, unpushed_commits: 5 }), { force: true });
  assert.deepEqual(blockers, []);
});

test("appendBodyLine: appends to an empty body without a leading blank line", () => {
  const result = appendBodyLine("", "- 2026-09-08 cleanup：已删 worktree /x");
  assert.equal(result, "- 2026-09-08 cleanup：已删 worktree /x\n");
});

test("appendBodyLine: preserves existing human-written content untouched, appends after it", () => {
  const original = "## 备注\n\n手写的验收记录，别动我。\n";
  const result = appendBodyLine(original, "- 2026-09-08 cleanup：已删 worktree /x 与本地分支 feat/a");
  assert.ok(result.startsWith("## 备注\n\n手写的验收记录，别动我。"));
  assert.match(result, /- 2026-09-08 cleanup：已删 worktree \/x 与本地分支 feat\/a\n$/);
});

test("appendBodyLine: repeated appends don't accumulate blank lines between entries", () => {
  const once = appendBodyLine("原文\n", "- line one");
  const twice = appendBodyLine(once, "- line two");
  assert.equal(twice, "原文\n- line one\n- line two\n");
});

test("appendBodyLine: null/undefined body treated as empty, never throws", () => {
  assert.equal(appendBodyLine(null, "- x"), "- x\n");
  assert.equal(appendBodyLine(undefined, "- x"), "- x\n");
});
