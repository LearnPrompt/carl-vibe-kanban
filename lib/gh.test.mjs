import test from "node:test";
import assert from "node:assert/strict";
import { pickPrForBranch, mapPrToFields } from "./gh.mjs";

const prList = [
  { number: 150, title: "i2v input assets", state: "OPEN", isDraft: false, headRefName: "feat/i2v-input-assets", url: "https://x/150" },
  { number: 149, title: "cluster merge", state: "MERGED", isDraft: false, headRefName: "feat/prompt-cluster-merge", url: "https://x/149" },
  { number: 140, title: "closed one", state: "CLOSED", isDraft: false, headRefName: "feat/dead-end", url: "https://x/140" },
  { number: 90, title: "draft pr", state: "OPEN", isDraft: true, headRefName: "feat/draft-thing", url: "https://x/90" },
];

test("pickPrForBranch returns the single match for a normal branch", () => {
  assert.deepEqual(pickPrForBranch(prList, "feat/i2v-input-assets"), prList[0]);
});

test("pickPrForBranch returns null when no PR matches", () => {
  assert.equal(pickPrForBranch(prList, "feat/no-pr-here"), null);
});

test("pickPrForBranch returns null for a null/undefined list", () => {
  assert.equal(pickPrForBranch(null, "feat/x"), null);
});

test("pickPrForBranch prefers OPEN when multiple PRs share a branch", () => {
  const multi = [
    { number: 10, state: "CLOSED", headRefName: "feat/reused", isDraft: false, title: "old attempt" },
    { number: 20, state: "OPEN", headRefName: "feat/reused", isDraft: false, title: "reopened" },
  ];
  assert.equal(pickPrForBranch(multi, "feat/reused").number, 20);
});

test("pickPrForBranch falls back to highest PR number when none are OPEN", () => {
  const multi = [
    { number: 5, state: "CLOSED", headRefName: "feat/reused", isDraft: false, title: "a" },
    { number: 30, state: "MERGED", headRefName: "feat/reused", isDraft: false, title: "b" },
    { number: 12, state: "CLOSED", headRefName: "feat/reused", isDraft: false, title: "c" },
  ];
  assert.equal(pickPrForBranch(multi, "feat/reused").number, 30);
});

test("mapPrToFields passes through OPEN non-draft as OPEN", () => {
  assert.deepEqual(mapPrToFields(prList[0]), { pr: 150, pr_state: "OPEN", pr_url: "https://x/150" });
});

test("mapPrToFields downgrades OPEN+isDraft to DRAFT (rule A)", () => {
  assert.deepEqual(mapPrToFields(prList[3]), { pr: 90, pr_state: "DRAFT", pr_url: "https://x/90" });
});

test("mapPrToFields keeps CLOSED as CLOSED even if isDraft were true", () => {
  const closedDraft = { number: 200, state: "CLOSED", isDraft: true, url: "https://x/200" };
  assert.deepEqual(mapPrToFields(closedDraft), { pr: 200, pr_state: "CLOSED", pr_url: "https://x/200" });
});

test("mapPrToFields passes through MERGED", () => {
  assert.deepEqual(mapPrToFields(prList[1]), { pr: 149, pr_state: "MERGED", pr_url: "https://x/149" });
});

test("mapPrToFields returns all-null fields for no PR", () => {
  assert.deepEqual(mapPrToFields(null), { pr: null, pr_state: null, pr_url: null });
});
