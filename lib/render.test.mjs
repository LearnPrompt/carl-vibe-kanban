import test from "node:test";
import assert from "node:assert/strict";
import { cardColor, groupByStatus, relativeTime, formatLocal, renderBoardHtml } from "./render.mjs";

test("cardColor: done + evidence -> green", () => {
  assert.equal(cardColor({ status: "done", evidence: ["https://x"], flags: [] }), "green");
});

test("cardColor: done + no evidence -> grey", () => {
  assert.equal(cardColor({ status: "done", evidence: [], flags: [] }), "grey");
});

test("cardColor: blocked/dropped -> red", () => {
  assert.equal(cardColor({ status: "blocked", evidence: [], flags: [] }), "red");
  assert.equal(cardColor({ status: "dropped", evidence: [], flags: [] }), "red");
});

test("cardColor: alarming flags -> red even for other statuses", () => {
  assert.equal(cardColor({ status: "doing", evidence: [], flags: ["stale_7d"] }), "red");
  assert.equal(cardColor({ status: "doing", evidence: [], flags: ["branch_missing"] }), "red");
  assert.equal(cardColor({ status: "doing", evidence: [], flags: ["prunable"] }), "red");
});

test("cardColor: review -> yellow, no_next_step -> yellow", () => {
  assert.equal(cardColor({ status: "review", evidence: [], flags: [] }), "yellow");
  assert.equal(cardColor({ status: "doing", evidence: [], flags: ["no_next_step"] }), "yellow");
});

test("cardColor: backlog/doing with nothing notable -> grey", () => {
  assert.equal(cardColor({ status: "backlog", evidence: [], flags: [] }), "grey");
  assert.equal(cardColor({ status: "doing", evidence: [], flags: [] }), "grey");
});

test("groupByStatus buckets cards under their status, including empty buckets", () => {
  const groups = groupByStatus([{ status: "doing" }, { status: "doing" }, { status: "done" }]);
  assert.equal(groups.doing.length, 2);
  assert.equal(groups.done.length, 1);
  assert.deepEqual(groups.blocked, []);
  assert.deepEqual(groups.dropped, []);
});

test("relativeTime buckets minutes/hours/days", () => {
  const now = "2026-09-06T12:00:00Z";
  assert.match(relativeTime("2026-09-06T11:59:00Z", now), /分钟前/);
  assert.match(relativeTime("2026-09-06T09:00:00Z", now), /小时前/);
  assert.match(relativeTime("2026-09-03T12:00:00Z", now), /天前/);
});

test("formatLocal renders yyyy-mm-dd hh:mm", () => {
  assert.match(formatLocal("2026-09-05T00:00:00Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// ---------------------------------------------------------------------------
// Fixture: two projects covering the full v0.2 contract surface —
// conflicts_with, a pinned+can-close session, a no-clue session, a
// detached card (no branch), and all seven stage values.
// ---------------------------------------------------------------------------

function makeCard(overrides) {
  return {
    id: overrides.id,
    title: overrides.title,
    branch: overrides.branch ?? null,
    status: overrides.status ?? "doing",
    stage: overrides.stage ?? "unpushed",
    pr: overrides.pr ?? null,
    pr_state: overrides.pr_state ?? null,
    pr_url: overrides.pr_url ?? null,
    ahead: overrides.ahead ?? 0,
    behind: overrides.behind ?? 0,
    last_commit: overrides.last_commit ?? "abc1234",
    last_commit_at: overrides.last_commit_at ?? "2026-09-04T00:00:00Z",
    agent: overrides.agent ?? "claude",
    next_step: overrides.next_step ?? "",
    flags: overrides.flags ?? [],
    evidence: overrides.evidence ?? [],
    conflicts_with: overrides.conflicts_with ?? [],
  };
}

const goodcaseCards = [
  makeCard({ id: "T-000001", title: "dirty 卡", branch: "feat/dirty", stage: "dirty", status: "doing" }),
  makeCard({ id: "T-000002", title: "unpushed 卡", branch: "feat/unpushed", stage: "unpushed", status: "doing" }),
  makeCard({
    id: "T-000003",
    title: "pushed 卡",
    branch: "feat/pushed",
    stage: "pushed",
    status: "doing",
    ahead: 3,
    behind: 0,
  }),
  makeCard({
    id: "T-000004",
    title: "pr_open 卡",
    branch: "feat/pr-open",
    stage: "pr_open",
    status: "review",
    pr: 155,
    pr_state: "OPEN",
    pr_url: "https://github.com/x/y/pull/155",
    conflicts_with: ["feat/pushed (3 files)"],
  }),
  makeCard({
    id: "T-000005",
    title: "merged 卡",
    branch: "feat/merged",
    stage: "merged",
    status: "done",
    evidence: ["https://x"],
    conflicts_with: ["feat/pr-open (3 files)"],
  }),
  makeCard({ id: "T-000006", title: "closed 卡", branch: "feat/closed", stage: "closed", status: "dropped" }),
  makeCard({ id: "T-000007", title: "missing 卡", branch: "feat/missing", stage: "missing", status: "blocked", flags: ["branch_missing"] }),
  makeCard({ id: "T-000008", title: "detached 卡", branch: null, stage: "dirty", status: "doing" }),
];

const aimapCards = [
  makeCard({ id: "T-000101", title: "aimap 分支", branch: "feat/aimap-x", stage: "pushed", status: "doing" }),
];

const goodcaseSessions = [
  {
    uuid: "s1",
    title: "聊 feat/pr-open 的 PR",
    branches: ["feat/pr-open"],
    lastActive: "2026-09-06T10:00:00Z",
    pinned: true,
    prInferred: false,
    inApp: true,
    judge: { verdict: "keep", reason: "PR 还在审" },
  },
  {
    uuid: "s2",
    title: "已落地可以关掉",
    branches: ["feat/landed-and-gone"],
    lastActive: "2026-09-01T10:00:00Z",
    pinned: true,
    prInferred: true,
    inApp: true,
    judge: { verdict: "can-close", reason: "分支已合并" },
  },
];

const noClueSessions = [
  {
    uuid: "s3",
    title: "不知道属于哪个分支",
    branches: [],
    lastActive: "2026-09-02T10:00:00Z",
    pinned: false,
    prInferred: false,
    inApp: true,
    judge: { verdict: "no-clue", reason: null },
  },
];

const fixture = {
  generatedAt: "2026-09-06T22:03:00Z",
  projects: [
    {
      repoName: "goodcaseai",
      remote: "LearnPrompt/goodcaseai",
      repoRoot: "/Users/carl/projects/goodcaseai",
      cards: goodcaseCards,
      sessions: goodcaseSessions,
    },
    {
      repoName: "aimap",
      remote: "LearnPrompt/aimap",
      repoRoot: "/Users/carl/projects/aimap",
      cards: aimapCards,
      sessions: [],
    },
  ],
  noClueSessions,
  summary: { pinned: 2, pinnedCanClose: 1, repos: 2, cards: 9, sessions: 2 },
};

test("renderBoardHtml (v0.2 contract): renders all three tabs with §01/§02 sections", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /id="tab-tree"/);
  assert.match(html, /id="tab-kanban"/);
  assert.match(html, /id="tab-conflicts"/);
  assert.match(html, /§ 01 · LearnPrompt\/goodcaseai/);
  assert.match(html, /§ 02 · LearnPrompt\/aimap/);
});

test("renderBoardHtml (v0.2 contract): self-contained, zero external requests, zero radius", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<script type="application\/json" id="board-data">/);
  assert.doesNotMatch(html, /cdn\.|googleapis|<link /);
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/);
});

test("renderBoardHtml (v0.2 contract): forbidden visuals absent (no orange hex, shadow, gradient, emoji)", () => {
  const html = renderBoardHtml(fixture);
  assert.doesNotMatch(html, /#f97316/i);
  assert.doesNotMatch(html, /box-shadow/);
  assert.doesNotMatch(html, /linear-gradient/);
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/);
});

test("renderBoardHtml (v0.2 contract): conflicts render as matrix + pair list", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /table class="matrix"/);
  assert.match(html, /feat\/pr-open/);
  assert.match(html, /feat\/pushed/);
  assert.match(html, /feat\/merged/);
});

test("renderBoardHtml (v0.2 contract): pinned + can-close + no-clue sessions all rendered", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /置顶/);
  assert.match(html, /可关/);
  assert.match(html, /无分支线索（1）/);
  assert.match(html, /不知道属于哪个分支/);
});

test("renderBoardHtml (v0.2 contract): detached card falls back to a synthetic branch label", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /detached: detached 卡/);
});

test("renderBoardHtml (v0.2 contract): all seven stage values present in fixture render", () => {
  const html = renderBoardHtml(fixture);
  for (const stage of ["dirty", "unpushed", "pushed", "pr_open", "merged", "closed", "missing"]) {
    assert.match(html, new RegExp(`title="${stage}"|>${stage}<`), `expected stage ${stage} to appear`);
  }
});

test("renderBoardHtml (v0.2 contract): header shows pinned/can-close summary stats", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<strong>2<\/strong>&nbsp;置顶/);
  assert.match(html, /<strong>1<\/strong>&nbsp;可关/);
});
