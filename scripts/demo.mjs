#!/usr/bin/env node
// Renders a neutral demo board (docs/demo.html) for the README, using the
// same renderBoardHtml() contract as bin/board.mjs. Data below is entirely
// fictional (repo names, branches, session titles) — no real repos/branches
// from this machine are used.
//
// Usage:
//   node scripts/demo.mjs            # writes docs/demo.html only
//   node scripts/demo.mjs --shots    # also writes docs/board-light.png / board-dark.png

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBoardHtml } from "../lib/render.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const docsDir = path.join(repoRoot, "docs");
const demoHtmlPath = path.join(docsDir, "demo.html");
const lightPngPath = path.join(docsDir, "board-light.png");
const darkPngPath = path.join(docsDir, "board-dark.png");

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
    last_commit_at: overrides.last_commit_at ?? "2026-09-10T00:00:00Z",
    agent: overrides.agent ?? "claude",
    next_step: overrides.next_step ?? "",
    flags: overrides.flags ?? [],
    evidence: overrides.evidence ?? [],
    conflicts_with: overrides.conflicts_with ?? [],
  };
}

function makeSession(overrides) {
  return {
    uuid: overrides.uuid,
    appSessionId: overrides.appSessionId ?? null,
    source: overrides.source ?? "claude",
    title: overrides.title,
    branches: overrides.branches ?? [],
    lastActive: overrides.lastActive,
    pinned: overrides.pinned ?? false,
    prInferred: overrides.prInferred ?? false,
    via: overrides.via ?? null,
    inApp: overrides.inApp ?? true,
    judge: overrides.judge ?? { verdict: "no-clue", reason: null },
    ...(overrides.suggest ? { suggest: overrides.suggest } : {}),
  };
}

// ---------------------------------------------------------------------------
// webapp: 7 branches, one per stage (dirty / unpushed / pushed / pr_open /
// merged / closed / missing). PR numbers 12–19. Two branches conflict with
// each other (2 files, then 1 files) to exercise the conflict badge + line.
// ---------------------------------------------------------------------------

const webappCards = [
  makeCard({
    id: "T-100001",
    title: "Fix login form validation edge case",
    branch: "feat/login-form-validation",
    stage: "dirty",
    status: "doing",
  }),
  makeCard({
    id: "T-100002",
    title: "Add retry backoff for rate limits",
    branch: "feat/rate-limit-retry",
    stage: "unpushed",
    status: "doing",
    ahead: 3,
  }),
  makeCard({
    id: "T-100003",
    title: "Add OG image stats",
    branch: "feat/og-image-stats",
    stage: "pushed",
    status: "doing",
    ahead: 3,
    behind: 0,
  }),
  makeCard({
    id: "T-100004",
    title: "Fix checkout race on retry",
    branch: "feat/checkout-race-fix",
    stage: "pr_open",
    status: "review",
    pr: 14,
    pr_state: "OPEN",
    pr_url: "https://github.com/acme/webapp/pull/14",
    conflicts_with: ["feat/og-image-stats (2 files)"],
  }),
  makeCard({
    id: "T-100005",
    title: "Rewrite API error messages",
    branch: "feat/api-error-messages",
    stage: "merged",
    status: "done",
    pr: 12,
    pr_state: "MERGED",
    pr_url: "https://github.com/acme/webapp/pull/12",
    evidence: ["https://github.com/acme/webapp/pull/12"],
    conflicts_with: ["feat/checkout-race-fix (1 files)"],
  }),
  makeCard({
    id: "T-100006",
    title: "Clean up legacy auth flow",
    branch: "feat/legacy-auth-cleanup",
    stage: "closed",
    status: "dropped",
    pr: 13,
    pr_state: "CLOSED",
    pr_url: "https://github.com/acme/webapp/pull/13",
  }),
  makeCard({
    id: "T-100007",
    title: "Debug webhook retry queue",
    branch: "feat/webhook-retry-queue",
    stage: "missing",
    status: "blocked",
    flags: ["branch_missing"],
  }),
];

const webappSessions = [
  makeSession({
    uuid: "a1000000-0000-4000-8000-000000000001",
    appSessionId: "local_a1000000-0000-4000-8000-000000000001",
    title: "Fix login form validation edge case",
    branches: ["feat/login-form-validation"],
    lastActive: "2026-09-10T15:00:00Z",
    judge: { verdict: "keep", reason: "还在改，本地有未提交改动" },
  }),
  makeSession({
    uuid: "a2000000-0000-4000-8000-000000000002",
    appSessionId: "local_a2000000-0000-4000-8000-000000000002",
    title: "Add retry backoff for rate limits",
    branches: ["feat/rate-limit-retry"],
    lastActive: "2026-09-10T11:00:00Z",
    judge: { verdict: "keep", reason: "feat/rate-limit-retry has 3 unpushed commits" },
  }),
  makeSession({
    uuid: "a3000000-0000-4000-8000-000000000003",
    appSessionId: "local_a3000000-0000-4000-8000-000000000003",
    title: "Add OG image stats",
    branches: ["feat/og-image-stats"],
    lastActive: "2026-09-09T18:00:00Z",
    judge: { verdict: "keep", reason: "等设计确认埋点字段" },
  }),
  makeSession({
    uuid: "a3000000-0000-4000-8000-000000000004",
    title: "Add OG image stats (fork)",
    branches: ["feat/og-image-stats"],
    source: "codex",
    lastActive: "2026-09-09T09:00:00Z",
    judge: { verdict: "keep", reason: "codex 在跑一版对比" },
  }),
  makeSession({
    uuid: "a4000000-0000-4000-8000-000000000005",
    appSessionId: "local_a4000000-0000-4000-8000-000000000005",
    title: "Fix checkout race on retry",
    branches: ["feat/checkout-race-fix"],
    lastActive: "2026-09-10T20:00:00Z",
    pinned: true,
    prInferred: true,
    via: "hook",
    judge: { verdict: "keep", reason: "PR 还在等 review" },
  }),
  makeSession({
    uuid: "a5000000-0000-4000-8000-000000000006",
    appSessionId: "local_a5000000-0000-4000-8000-000000000006",
    title: "Rewrite API error messages",
    branches: ["feat/api-error-messages"],
    lastActive: "2026-09-08T10:00:00Z",
    pinned: true,
    prInferred: true,
    judge: { verdict: "can-close", reason: "PR #12 已合并" },
  }),
  makeSession({
    uuid: "a5000000-0000-4000-8000-000000000007",
    appSessionId: "local_a5000000-0000-4000-8000-000000000007",
    title: "Add error code docs",
    branches: ["feat/api-error-messages"],
    lastActive: "2026-09-07T10:00:00Z",
    pinned: true,
    judge: { verdict: "can-close", reason: "分支已合并，收尾对话可以关了" },
  }),
  makeSession({
    uuid: "a6000000-0000-4000-8000-000000000008",
    appSessionId: "local_a6000000-0000-4000-8000-000000000008",
    title: "Clean up legacy auth flow",
    branches: ["feat/legacy-auth-cleanup"],
    lastActive: "2026-09-05T10:00:00Z",
    pinned: true,
    judge: { verdict: "can-close", reason: "PR 已关闭，改动放弃" },
  }),
  makeSession({
    uuid: "a7000000-0000-4000-8000-000000000009",
    title: "Debug webhook retry queue",
    branches: ["feat/webhook-retry-queue"],
    lastActive: "2026-09-03T10:00:00Z",
    judge: { verdict: "no-clue", reason: null },
  }),
];

// ---------------------------------------------------------------------------
// docs: 2 branches, kept small on purpose.
// ---------------------------------------------------------------------------

const docsCards = [
  makeCard({
    id: "T-200001",
    title: "Rewrite README install steps",
    branch: "docs/update-readme-install",
    stage: "unpushed",
    status: "doing",
    ahead: 2,
  }),
  makeCard({
    id: "T-200002",
    title: "Fix broken API reference links",
    branch: "docs/fix-api-reference-links",
    stage: "merged",
    status: "done",
    evidence: ["https://github.com/acme/docs/pull/9"],
  }),
];

const docsSessions = [
  makeSession({
    uuid: "b1000000-0000-4000-8000-000000000001",
    appSessionId: "local_b1000000-0000-4000-8000-000000000001",
    title: "Rewrite README install steps",
    branches: ["docs/update-readme-install"],
    lastActive: "2026-09-10T08:00:00Z",
    judge: { verdict: "keep", reason: "还差一节故障排查" },
  }),
  makeSession({
    uuid: "b2000000-0000-4000-8000-000000000002",
    appSessionId: "local_b2000000-0000-4000-8000-000000000002",
    title: "Fix broken API reference links",
    branches: ["docs/fix-api-reference-links"],
    lastActive: "2026-09-06T08:00:00Z",
    judge: { verdict: "can-close", reason: "分支已合并" },
  }),
];

const noClueSessions = [
  makeSession({
    uuid: "c1000000-0000-4000-8000-000000000001",
    title: "Random exploratory question about the build",
    branches: [],
    lastActive: "2026-09-08T12:00:00Z",
    judge: { verdict: "no-clue", reason: null },
  }),
];

const projects = [
  {
    repoName: "webapp",
    remote: "acme/webapp",
    repoRoot: "/Users/demo/projects/webapp",
    cards: webappCards,
    sessions: webappSessions,
  },
  {
    repoName: "docs",
    remote: "acme/docs",
    repoRoot: "/Users/demo/projects/docs",
    cards: docsCards,
    sessions: docsSessions,
  },
];

const allCards = [...webappCards, ...docsCards];
const allSessions = [...webappSessions, ...docsSessions];
const pinnedCount = allSessions.filter((s) => s.pinned).length;
const pinnedCanCloseCount = allSessions.filter(
  (s) => s.pinned && s.judge && s.judge.verdict === "can-close"
).length;

const summary = {
  repos: projects.length,
  cards: allCards.length,
  sessions: allSessions.length,
  pinned: pinnedCount,
  pinnedCanClose: pinnedCanCloseCount,
};

const board = {
  generatedAt: "2026-09-11T09:30:00Z",
  projects,
  noClueSessions,
  summary,
};

// ---------------------------------------------------------------------------
// Render + write
// ---------------------------------------------------------------------------

if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

const html = renderBoardHtml(board);
writeFileSync(demoHtmlPath, html, "utf8");
console.log(`wrote ${path.relative(repoRoot, demoHtmlPath)} (${html.length} bytes)`);

if (process.argv.includes("--shots")) {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const fileUrl = `file://${demoHtmlPath}`;
  const windowSize = "1600,1210";

  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${windowSize}`,
      `--screenshot=${lightPngPath}`,
      fileUrl,
    ],
    { stdio: "inherit" }
  );
  console.log(`wrote ${path.relative(repoRoot, lightPngPath)}`);

  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-dark-mode",
      `--window-size=${windowSize}`,
      `--screenshot=${darkPngPath}`,
      fileUrl,
    ],
    { stdio: "inherit" }
  );
  console.log(`wrote ${path.relative(repoRoot, darkPngPath)}`);
}
