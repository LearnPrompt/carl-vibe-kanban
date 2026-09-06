import test from "node:test";
import assert from "node:assert/strict";
import {
  computeId,
  buildCardData,
  cardsEqualIgnoringUpdated,
  unionKeys,
  findCardByAnyKey,
  CARD_KEY_ORDER,
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
