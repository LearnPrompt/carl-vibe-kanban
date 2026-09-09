import test from "node:test";
import assert from "node:assert/strict";
import {
  cardColor,
  groupByStatus,
  relativeTime,
  formatLocal,
  renderBoardHtml,
  normalizeConvTitle,
  sortSessions,
  clusterSessions,
  openAppLink,
  suggestedArchiveSessions,
  transcriptOnlyArchiveSessions,
  hasAppSession,
  countArchivableCanClose,
} from "./render.mjs";

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
// Fixture: two projects covering the full v0.6 contract surface —
// conflicts_with, a pinned+can-close session, a no-clue session, a
// detached card (no branch), a hook-sourced session, and all seven stage
// values. Kept from v0.2 (per board-spec-v0.6-render.md: "现有 fixture
// 保留，断言更新") with one addition: a `via: "hook"` session so the new
// hook chip label has fixture coverage.
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

// v0.7: five sessions on feat/pushed — two share a normalized title (one has a
// " (fork)" suffix) so clustering has coverage, and four distinct clusters means
// the 3-chip inline cutoff also has coverage. Mixed appSessionId/source values
// exercise all three 打开 link branches.
const pushedSessions = [
  {
    uuid: "11111111-1111-4111-8111-111111111111",
    appSessionId: "local_11111111-1111-4111-8111-111111111111",
    source: "claude",
    title: "改热度算法",
    branches: ["feat/pushed"],
    lastActive: "2026-09-06T09:00:00Z",
    pinned: false,
    prInferred: false,
    via: null,
    judge: { verdict: "keep", reason: "还在改" },
  },
  {
    uuid: "22222222-2222-4222-8222-222222222222",
    appSessionId: null,
    source: "claude",
    title: "改热度算法 (fork)",
    branches: ["feat/pushed"],
    lastActive: "2026-09-05T09:00:00Z",
    pinned: false,
    prInferred: false,
    via: null,
    judge: { verdict: "keep", reason: "fork 出来的" },
  },
  {
    uuid: "33333333-3333-4333-8333-333333333333",
    appSessionId: "local_33333333-3333-4333-8333-333333333333",
    source: "claude",
    title: "补测试",
    branches: ["feat/pushed"],
    lastActive: "2026-09-04T09:00:00Z",
    pinned: false,
    prInferred: false,
    via: null,
    judge: { verdict: "keep", reason: "测试没写完" },
  },
  {
    uuid: "44444444-4444-4444-8444-444444444444",
    appSessionId: null,
    source: "codex",
    title: "codex 跑批",
    branches: ["feat/pushed"],
    lastActive: "2026-09-03T09:00:00Z",
    pinned: false,
    prInferred: false,
    via: null,
    judge: { verdict: "keep", reason: "codex 在跑" },
  },
  {
    uuid: "55555555-5555-4555-8555-555555555555",
    appSessionId: null,
    source: "claude",
    title: "看看 CI",
    branches: ["feat/pushed"],
    lastActive: "2026-09-02T09:00:00Z",
    pinned: false,
    prInferred: false,
    via: null,
    suggest: { kind: "stale-chat", reason: "7 天没说过话了", by: "rule" },
    judge: { verdict: "no-clue", reason: null },
  },
];

const goodcaseSessions = [
  {
    uuid: "s1",
    title: "聊 feat/pr-open 的 PR",
    branches: ["feat/pr-open"],
    lastActive: "2026-09-06T10:00:00Z",
    pinned: true,
    prInferred: false,
    via: "hook",
    inApp: true,
    judge: { verdict: "keep", reason: "PR 还在审" },
  },
  {
    uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    appSessionId: "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    source: "claude",
    title: "已落地可以关掉",
    branches: ["feat/landed-and-gone"],
    lastActive: "2026-09-01T10:00:00Z",
    pinned: true,
    prInferred: true,
    via: null,
    inApp: true,
    judge: { verdict: "can-close", reason: "分支已合并" },
  },
  ...pushedSessions,
];

const noClueSessions = [
  {
    uuid: "s3",
    title: "不知道属于哪个分支",
    branches: [],
    lastActive: "2026-09-02T10:00:00Z",
    pinned: false,
    prInferred: false,
    via: null,
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

// ---------------------------------------------------------------------------
// board-spec-v0.6-render.md §验收 1: node --test 全绿 — assertions below.
// ---------------------------------------------------------------------------

// v0.7 replaces the v0.6 "no tabs at all" rule with "repo tabs only": the old
// 树/看板/冲突 view tabs must still never come back (no 看板 text, no id="tab-"),
// but a .repo-tab bar switching between projects is now expected.
test("renderBoardHtml (v0.7): repo tabs exist, old view tabs still gone", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<nav class="repo-tabs">/);
  assert.match(html, /class="repo-tab active" data-repo="goodcaseai"/);
  assert.match(html, /data-repo="__all__"/);
  assert.doesNotMatch(html, /看板/);
  assert.doesNotMatch(html, /id="tab-/);
});

test("renderBoardHtml (v0.6): renders §01/§02 project sections as one horizontal tree each", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /§ 01 · LearnPrompt\/goodcaseai/);
  assert.match(html, /§ 02 · LearnPrompt\/aimap/);
  assert.match(html, /class="tree-grid"/);
  assert.match(html, /class="conn-svg"/);
});

test("renderBoardHtml (v0.6): self-contained, zero external requests, zero radius", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<script type="application\/json" id="board-data">/);
  assert.doesNotMatch(html, /cdn\.|googleapis|<link /);
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/);
});

test("renderBoardHtml (v0.6): forbidden visuals absent (no orange hex, shadow, gradient, emoji)", () => {
  const html = renderBoardHtml(fixture);
  assert.doesNotMatch(html, /#f97316/i);
  assert.doesNotMatch(html, /box-shadow/);
  assert.doesNotMatch(html, /linear-gradient/);
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/);
});

test("renderBoardHtml (v0.6): body copy is 14px, mono is 12px", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /font-size: 14px/);
  assert.match(html, /\.mono \{[^}]*font-size: 12px/);
});

test("renderBoardHtml (v0.6): every branch node carries a five-cell stage bar", () => {
  const html = renderBoardHtml(fixture);
  const branchNodeBlocks = html.match(/<div class="node branch-node[^]*?<\/div>\s*<\/div>/g) || [];
  assert.ok(branchNodeBlocks.length >= 7, "expected at least 7 branch nodes in fixture render");
  for (const block of branchNodeBlocks) {
    const cellCount = (block.match(/class="stage-cell/g) || []).length;
    assert.equal(cellCount, 5, `expected exactly 5 stage cells per branch node, got ${cellCount}`);
  }
});

test("renderBoardHtml (v0.6): conflicting branches show a 冲突 N badge", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /冲突 1/);
  assert.match(html, /class="conflict-badge mono"/);
});

test("renderBoardHtml (v0.6): conflict pairs are embedded as connector data for the client script", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /data-conflicts="/);
  assert.match(html, /feat\/pr-open/);
  assert.match(html, /feat\/pushed/);
  assert.match(html, /feat\/merged/);
  assert.match(html, /boardDrawConnectors/);
  assert.match(html, /boardToggleConflicts/);
});

test("renderBoardHtml (v0.6): pinned + can-close + no-clue + hook sessions all rendered", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /置顶/);
  assert.match(html, /class="hook-mark mono">hook</);
  assert.match(html, /无分支线索（1）/);
  assert.match(html, /不知道属于哪个分支/);
});

test("renderBoardHtml (v0.6): detached card falls back to a synthetic branch label", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /detached: detached 卡/);
});

test("renderBoardHtml (v0.6): all seven stage values present in fixture render", () => {
  const html = renderBoardHtml(fixture);
  for (const stage of ["dirty", "unpushed", "pushed", "pr_open", "merged", "closed", "missing"]) {
    assert.match(html, new RegExp(`title="${stage}"|>${stage}<`), `expected stage ${stage} to appear`);
  }
});

test("renderBoardHtml (v0.6): header shows pinned/can-close summary stats and conflict toggle", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<strong>2<\/strong>&nbsp;置顶/);
  assert.match(html, /<strong>1<\/strong>&nbsp;可关/);
  assert.match(html, /id="conflict-toggle"/);
  assert.match(html, /冲突线 开/);
});

test("renderBoardHtml (v0.6): legend row lists five stage cells with Chinese labels", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /class="legend"/);
  for (const label of ["未提交", "未推送", "已推送", "审阅中", "已合并"]) {
    assert.match(html, new RegExp(label));
  }
});

test("renderBoardHtml (v0.6): branches with no linked conversation show placeholder text, not a chip", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /class="conv-empty">暂无关联对话/);
});

// ---------------------------------------------------------------------------
// v0.7: tabs / clustering / open-in-app / line legend / 建议归档
// ---------------------------------------------------------------------------

test("renderBoardHtml (v0.7): tab labels carry per-project counts and only the first project shows", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /全部<span class="repo-tab-counts mono">9 卡 · 1 审 · 1 可关<\/span>/);
  assert.match(html, /goodcaseai<span class="repo-tab-counts mono">8 卡 · 1 审 · 1 可关<\/span>/);
  // 第一个项目默认展开，其余带 hidden
  assert.match(html, /<section class="project-section" data-repo="goodcaseai">/);
  assert.match(html, /<section class="project-section" data-repo="aimap" hidden>/);
});

test("renderBoardHtml (v0.7): tab state persists via #repo= hash with a localStorage fallback", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /function boardSelectRepo\(/);
  assert.match(html, /function boardRestoreRepo\(/);
  assert.match(html, /location\.hash = "repo=" \+ encodeURIComponent\(repo\)/);
  assert.match(html, /localStorage\.setItem\("board-repo", repo\)/);
  assert.match(html, /localStorage\.getItem\("board-repo"\)/);
  // 隐藏的 section 没有几何，切完必须重画连线
  assert.match(html, /boardSelectRepo[^]*?boardDrawConnectors\(\);/);
  assert.match(html, /hashchange/);
});

test("renderBoardHtml (v0.7): same-title sessions cluster into one ×N chip", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<span class="cluster-mark mono">×2<\/span>/);
  // 簇成员逐条列出，fork 那条也在
  assert.match(html, /class="conv-members"/);
  assert.match(html, /改热度算法 \(fork\)/);
});

test("renderBoardHtml (v0.7): a branch row shows at most 3 chips, the rest fold into 还有 N 个对话", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<details class="conv-more">/);
  assert.match(html, /还有 1 个对话/);
});

test("renderBoardHtml (v0.7): chips link into the desktop app, CLI sessions fall back to resume", () => {
  const html = renderBoardHtml(fixture);
  assert.match(
    html,
    /href="claude:\/\/code\/continue\?session=local_11111111-1111-4111-8111-111111111111&amp;source=board"/
  );
  assert.match(html, /href="claude:\/\/resume\?session=22222222-2222-4222-8222-222222222222"/);
  assert.match(html, /导入 CLI 会话到桌面 app/);
  assert.match(html, /<span class="open-link mono disabled" title="Codex 跳转待做">codex<\/span>/);
  // 点「打开」不能顺手把 details 展开
  assert.match(html, /onclick="event\.stopPropagation\(\)"/);
  assert.match(html, /data-session="local_11111111-1111-4111-8111-111111111111"/);
});

test("renderBoardHtml (v0.7): legend explains solid ownership lines vs dashed conflict lines", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<span class="legend-line"><\/span>归属线：项目 → 分支 → 对话/);
  assert.match(html, /<span class="legend-line dashed"><\/span>冲突线：两条分支改了同一批文件（可用右上角开关）/);
  assert.match(html, /\.legend-line\.dashed \{ border-top-style: dashed/);
});

test("renderBoardHtml (v0.7): 建议归档 panel lists can-close + suggest sessions with a Claude deep link", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /<details class="archive-panel" open data-archive="ap-01" data-folder="\/Users\/carl\/projects\/goodcaseai">/);
  assert.match(html, /建议归档（1）/);
  // suggest.reason 优先，没有才退回判定文案
  assert.match(html, /7 天没说过话了/);
  assert.match(html, /判定：分支已合并/);
  assert.match(html, /置顶的会话桌面 app 拒绝归档，先在侧栏取消置顶/);
  assert.match(html, /让 Claude 归档选中的 1 个/);
});

test("renderBoardHtml (v0.7): archive button builds the archive_session prompt client-side", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /function boardArchivePrompt\(sectionId\)/);
  assert.match(
    html,
    /请用 archive_session 逐个归档以下桌面会话，reason 写「分支已合并」；置顶的先告诉我需要取消置顶，一个都别猜：/
  );
  assert.match(html, /claude:\/\/code\/new\?prompt=" \+ encodeURIComponent\(text\)/);
  assert.match(html, /"&folder=" \+ encodeURIComponent\(folder\)/);
  // 计数跟着勾选变
  assert.match(html, /function boardArchiveCount\(el\)/);
  assert.match(html, /btn\.textContent = "让 Claude 归档选中的 " \+ n \+ " 个"/);
});

// ---------------------------------------------------------------------------
// v0.7b: 1440 走查的三处修正 —— tab 换行、归档面板去噪、可关口径统一
// ---------------------------------------------------------------------------

test("renderBoardHtml (v0.7b): repo tab bar wraps instead of clipping projects off the line", () => {
  const html = renderBoardHtml(fixture);
  const bar = /\.repo-tabs \{([^}]*)\}/.exec(html);
  assert.ok(bar, "expected a .repo-tabs rule");
  assert.match(bar[1], /flex-wrap: wrap;/);
  assert.doesNotMatch(bar[1], /flex-wrap: nowrap;/);
  assert.doesNotMatch(bar[1], /overflow-x: auto;/);
  // 分隔线靠 border-left/top + -1px 外边距叠成一根，行首那根被裁在盒子外
  const tab = /\.repo-tab \{([^}]*)\}/.exec(html);
  assert.ok(tab, "expected a .repo-tab rule");
  assert.match(tab[1], /border-left: 1px solid var\(--line-faint\);/);
  assert.match(tab[1], /margin-left: -1px;/);
  assert.match(tab[1], /margin-top: -1px;/);
  assert.doesNotMatch(tab[1], /border-right:/);
  // 选中态仍是重音下划线 + ink 底色，且抬一层免得被下一行的顶边压掉
  const active = /\.repo-tab\.active \{([^}]*)\}/.exec(html);
  assert.ok(active, "expected a .repo-tab.active rule");
  assert.match(active[1], /border-bottom-color: var\(--accent\);/);
  assert.match(active[1], /z-index: 1;/);
});

test("renderBoardHtml (v0.7b): archive checkbox list is app-sessions only, transcript rows nest in archive-rest", () => {
  const html = renderBoardHtml(fixture);
  assert.match(html, /建议归档（1）<span class="archive-rest-count mono">\+1 转录<\/span>/);
  // 勾选框只出现在有 app id 的行上
  const boxes = html.match(/<input type="checkbox" class="archive-cb" checked data-app-id="[^"]*"/g) || [];
  assert.equal(boxes.length, 1);
  for (const box of boxes) assert.match(box, /data-app-id="local_/);
  // 无 app id 的那批收进默认折叠、没有勾选框的 details
  const rest = /<details class="archive-rest">([\s\S]*?)<\/details>/.exec(html);
  assert.ok(rest, "expected a nested .archive-rest details");
  assert.match(rest[0], /<details class="archive-rest">\s*<summary class="mono">转录里的另外 1 个（无 app id，桌面 app 归档不了）<\/summary>/);
  assert.doesNotMatch(rest[0], /<details class="archive-rest" open/);
  assert.doesNotMatch(rest[1], /<input/);
  assert.match(rest[1], /看看 CI/);
  // 旧的「无 app id」徽标没必要了，折叠盒标题已经说清楚
  assert.doesNotMatch(html, /class="no-appid mono"/);
});

test("renderBoardHtml (v0.7b): 可关 counts only sessions the archive panel can actually act on", () => {
  const sessions = [
    {
      uuid: "y1",
      appSessionId: "local_yyyyyyyy-yyyy-4yyy-8yyy-yyyyyyyyyyyy",
      source: "claude",
      title: "能关的",
      branches: ["feat/one"],
      lastActive: "2026-09-06T09:00:00Z",
      judge: { verdict: "can-close", reason: "分支已合并" },
    },
    {
      uuid: "y2",
      appSessionId: null,
      source: "claude",
      title: "转录里的一号",
      branches: ["feat/one"],
      lastActive: "2026-09-05T09:00:00Z",
      judge: { verdict: "can-close", reason: "分支已合并" },
    },
    {
      uuid: "y3",
      appSessionId: null,
      source: "claude",
      title: "转录里的二号",
      branches: ["feat/one"],
      lastActive: "2026-09-04T09:00:00Z",
      judge: { verdict: "can-close", reason: "分支已合并" },
    },
  ];
  const html = renderBoardHtml({
    generatedAt: "2026-09-06T22:03:00Z",
    projects: [
      {
        repoName: "onerepo",
        remote: "o/onerepo",
        repoRoot: "/tmp/onerepo",
        cards: [makeCard({ id: "T-100001", title: "一张卡", branch: "feat/one", stage: "pushed" })],
        sessions,
      },
    ],
    noClueSessions: [],
    summary: {},
  });
  // 三个 can-close，只有一个带 app id —— section / tab / 面板三处必须一致读 1
  assert.match(html, /可关 1 · 别关对话 0/);
  assert.match(html, /onerepo<span class="repo-tab-counts mono">1 卡 · 0 审 · 1 可关<\/span>/);
  assert.match(html, /全部<span class="repo-tab-counts mono">1 卡 · 0 审 · 1 可关<\/span>/);
  assert.match(html, /建议归档（1）<span class="archive-rest-count mono">\+2 转录<\/span>/);
  assert.match(html, /让 Claude 归档选中的 1 个/);
});

test("normalizeConvTitle strips fork suffixes and collapses whitespace", () => {
  assert.equal(normalizeConvTitle("  改  热度算法 "), "改 热度算法");
  assert.equal(normalizeConvTitle("改热度算法 (fork)"), "改热度算法");
  assert.equal(normalizeConvTitle("改热度算法（fork）"), "改热度算法");
  assert.equal(normalizeConvTitle(null), "");
});

test("sortSessions: pinned first, then hook, then most recent", () => {
  const out = sortSessions([
    { uuid: "c", lastActive: "2026-09-01T00:00:00Z" },
    { uuid: "b", lastActive: "2026-09-03T00:00:00Z", via: "hook" },
    { uuid: "a", lastActive: "2026-08-01T00:00:00Z", pinned: true },
    { uuid: "d", lastActive: "2026-09-05T00:00:00Z" },
  ]);
  assert.deepEqual(out.map((s) => s.uuid), ["a", "b", "d", "c"]);
});

test("clusterSessions groups by normalized title, keeping the newest as lead", () => {
  const clusters = clusterSessions(pushedSessions);
  assert.equal(clusters.length, 4);
  assert.equal(clusters[0].members.length, 2);
  assert.equal(clusters[0].lead.title, "改热度算法");
});

test("openAppLink: app id wins, then claude uuid, then codex placeholder, else nothing", () => {
  assert.match(openAppLink({ appSessionId: "local_abc-123", source: "claude" }), /claude:\/\/code\/continue\?session=local_abc-123/);
  assert.match(
    openAppLink({ uuid: "22222222-2222-4222-8222-222222222222", source: "claude" }),
    /claude:\/\/resume\?session=22222222/
  );
  assert.match(openAppLink({ uuid: "nope", source: "codex" }), /Codex 跳转待做/);
  assert.equal(openAppLink({ uuid: "nope", source: "claude" }), "");
});

test("suggestedArchiveSessions keeps only candidates the desktop app can archive", () => {
  const picked = suggestedArchiveSessions(goodcaseSessions);
  assert.deepEqual(picked.map((s) => s.title), ["已落地可以关掉"]);
});

test("transcriptOnlyArchiveSessions takes the same candidates that have no app id", () => {
  const rest = transcriptOnlyArchiveSessions(goodcaseSessions);
  // 「看看 CI」有 suggest 但没有 app id，归档不了，只能进折叠盒
  assert.deepEqual(rest.map((s) => s.title), ["看看 CI"]);
  // 两个清单不重叠，并起来就是全部候选
  assert.equal(suggestedArchiveSessions(goodcaseSessions).length + rest.length, 2);
});

test("hasAppSession only accepts a well-formed local_ id", () => {
  assert.equal(hasAppSession({ appSessionId: "local_abc-123" }), true);
  assert.equal(hasAppSession({ appSessionId: null }), false);
  assert.equal(hasAppSession({ appSessionId: "22222222-2222-4222-8222-222222222222" }), false);
  assert.equal(hasAppSession({}), false);
  assert.equal(hasAppSession(null), false);
});

test("countArchivableCanClose ignores can-close sessions without an app id", () => {
  const sessions = [
    { appSessionId: "local_a", judge: { verdict: "can-close" } },
    { appSessionId: null, judge: { verdict: "can-close" } },
    { appSessionId: "local_b", judge: { verdict: "keep" } },
    { appSessionId: "local_c", judge: { verdict: "can-close" } },
  ];
  assert.equal(countArchivableCanClose(sessions), 2);
  assert.equal(countArchivableCanClose([]), 0);
  assert.equal(countArchivableCanClose(null), 0);
});
