import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractMentions,
  resolveWorktreePath,
  resolvePrLink,
  filterBranchesToRepo,
  stripLocalPrefix,
  resolveSessionBranches,
  resolveCwdOwnership,
  isPathContainedIn,
  mergeSessionRow,
  judgeSession,
  classifyClaudeLine,
  classifyCodexLine,
  extractSessionFacts,
  WORKTREE_PATH_MIN_MENTIONS,
  loadHookEvents,
  groupHookEventsBySession,
  resolveHookBranchesForRepo,
  buildSessionRows,
} from "./sessions.mjs";
import { appendHookEvent } from "./hooks.mjs";

// --- transcript regex extraction ------------------------------------------------

test("extractMentions: git push -u origin <branch>", () => {
  const line = String.raw`{"command":"git push -u origin feat/heat-decay-0830 2>&1 | tail -1"}`;
  const mentions = extractMentions(line);
  assert.ok(mentions.some((m) => m.type === "branch" && m.branch === "feat/heat-decay-0830" && m.via === "push"));
});

test("extractMentions: plain git push origin <branch> (no -u)", () => {
  const mentions = extractMentions("git push origin fix/hero-restore-0830");
  assert.ok(mentions.some((m) => m.branch === "fix/hero-restore-0830" && m.via === "push"));
});

test("extractMentions: checkout -b <branch>", () => {
  const mentions = extractMentions("git checkout -b sync/main-20260901 origin/main");
  assert.ok(mentions.some((m) => m.branch === "sync/main-20260901" && m.via === "checkout-b"));
});

test("extractMentions: switch -c <branch>", () => {
  const mentions = extractMentions("git switch -c feat/new-thing");
  assert.ok(mentions.some((m) => m.branch === "feat/new-thing" && m.via === "switch-c"));
});

test("extractMentions: worktree add <path> -b <branch> (new branch)", () => {
  const mentions = extractMentions("git worktree add ../goodcase-board -b feat/board-v0");
  assert.ok(mentions.some((m) => m.branch === "feat/board-v0" && m.via === "worktree-add-b"));
});

test("extractMentions: worktree add <path> <branch> (existing branch, no -b)", () => {
  const mentions = extractMentions("git worktree add /Users/carl/wt/goodcase-i2v feat/i2v-input-assets");
  assert.ok(mentions.some((m) => m.branch === "feat/i2v-input-assets" && m.via === "worktree-add-plain"));
});

test("extractMentions: gh pr create --head <branch>", () => {
  const mentions = extractMentions("gh pr create --base main --head feat/prompt-cluster-merge --title x");
  assert.ok(mentions.some((m) => m.branch === "feat/prompt-cluster-merge" && m.via === "pr-head"));
});

test("extractMentions: worktree path fragment under agent-workbench/worktrees", () => {
  const line = String.raw`cd /Users/carl2077/agent-workbench/worktrees/goodcase-board && npm test`;
  const mentions = extractMentions(line);
  const wt = mentions.find((m) => m.type === "worktree-path");
  assert.ok(wt);
  assert.equal(wt.path, "agent-workbench/worktrees/goodcase-board");
});

test("extractMentions: github PR link", () => {
  const mentions = extractMentions("see https://github.com/LearnPrompt/goodcaseai/pull/150 for details");
  const link = mentions.find((m) => m.type === "pr-link");
  assert.deepEqual(link, { type: "pr-link", owner: "LearnPrompt", repo: "goodcaseai", number: 150 });
});

test("extractMentions: no false positives on a line with none of the patterns", () => {
  assert.deepEqual(extractMentions("just chatting about an article idea"), []);
});

// --- worktree path resolution ------------------------------------------------

test("resolveWorktreePath: suffix-matches a fragment against the real worktree list", () => {
  const entries = [
    { path: "/Users/carl2077/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0" },
    { path: "/Users/carl2077/agent-workbench/worktrees/goodcase-eval-run", branch: null },
  ];
  assert.equal(resolveWorktreePath("agent-workbench/worktrees/goodcase-board", entries), "feat/board-v0");
  assert.equal(resolveWorktreePath("agent-workbench/worktrees/nonexistent", entries), null);
});

// --- PR link resolution + cross-repo filtering --------------------------------

const prList = [
  { number: 150, headRefName: "feat/i2v-input-assets", state: "OPEN" },
  { number: 144, headRefName: "fix/ui-round4", state: "MERGED" },
];

test("resolvePrLink: same-repo PR link resolves to its headRefName", () => {
  const mention = { owner: "LearnPrompt", repo: "goodcaseai", number: 150 };
  assert.equal(resolvePrLink(mention, "LearnPrompt", "goodcaseai", prList), "feat/i2v-input-assets");
});

test("resolvePrLink: cross-repo PR link is filtered out (returns null)", () => {
  const mention = { owner: "someone-else", repo: "unrelated-repo", number: 150 };
  assert.equal(resolvePrLink(mention, "LearnPrompt", "goodcaseai", prList), null);
});

test("resolvePrLink: same owner but different repo name is also filtered", () => {
  const mention = { owner: "LearnPrompt", repo: "other-repo", number: 150 };
  assert.equal(resolvePrLink(mention, "LearnPrompt", "goodcaseai", prList), null);
});

test("resolvePrLink: unknown PR number in this repo resolves to null", () => {
  const mention = { owner: "LearnPrompt", repo: "goodcaseai", number: 9999 };
  assert.equal(resolvePrLink(mention, "LearnPrompt", "goodcaseai", prList), null);
});

// --- repo-scope branch filtering ------------------------------------------------

test("filterBranchesToRepo: keeps only branches present locally, on origin, or as a PR headRefName", () => {
  const result = filterBranchesToRepo(
    ["feat/board-v0", "feat/only-on-origin", "some-other-repos-branch", "feat/only-a-pr"],
    ["feat/board-v0"],
    ["feat/only-on-origin"],
    ["feat/only-a-pr"]
  );
  assert.deepEqual(result, ["feat/board-v0", "feat/only-a-pr", "feat/only-on-origin"]);
});

test("filterBranchesToRepo: dedupes and sorts", () => {
  const result = filterBranchesToRepo(["feat/b", "feat/a", "feat/a"], ["feat/a", "feat/b"], [], []);
  assert.deepEqual(result, ["feat/a", "feat/b"]);
});

// --- resolving a raw cache record's mentions against live git state ------------

test("resolveSessionBranches: combines direct branch mentions, worktree-path mentions (>= threshold), and PR links", () => {
  const rec = {
    branchMentions: ["feat/i2v-input-assets"],
    worktreePathCounts: { "agent-workbench/worktrees/goodcase-board": WORKTREE_PATH_MIN_MENTIONS },
    prLinkMentions: [{ owner: "LearnPrompt", repo: "goodcaseai", number: 144 }],
  };
  const ctx = {
    localBranches: ["feat/board-v0"],
    remoteBranches: ["feat/i2v-input-assets"],
    worktreeEntries: [{ path: "/Users/x/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0" }],
    prList,
    repoOwner: "LearnPrompt",
    repoName: "goodcaseai",
  };
  assert.deepEqual(resolveSessionBranches(rec, ctx), ["feat/board-v0", "feat/i2v-input-assets", "fix/ui-round4"]);
});

test("resolveSessionBranches: a null/undefined record resolves to no branches", () => {
  assert.deepEqual(resolveSessionBranches(null, baseGitCtx), []);
});

// --- worktree-path mention weight threshold (board-spec-v0.1) -----------------

test("resolveSessionBranches: a worktree-path mentioned below WORKTREE_PATH_MIN_MENTIONS times does not resolve", () => {
  const rec = {
    branchMentions: [],
    worktreePathCounts: { "agent-workbench/worktrees/goodcase-board": WORKTREE_PATH_MIN_MENTIONS - 1 },
    prLinkMentions: [],
  };
  const ctx = {
    localBranches: ["feat/board-v0"],
    remoteBranches: [],
    worktreeEntries: [{ path: "/Users/x/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0" }],
    prList: [],
    repoOwner: "LearnPrompt",
    repoName: "goodcaseai",
  };
  assert.deepEqual(resolveSessionBranches(rec, ctx), []);
});

test("resolveSessionBranches: a worktree-path mentioned exactly WORKTREE_PATH_MIN_MENTIONS times does resolve", () => {
  const rec = {
    branchMentions: [],
    worktreePathCounts: { "agent-workbench/worktrees/goodcase-board": WORKTREE_PATH_MIN_MENTIONS },
    prLinkMentions: [],
  };
  const ctx = {
    localBranches: ["feat/board-v0"],
    remoteBranches: [],
    worktreeEntries: [{ path: "/Users/x/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0" }],
    prList: [],
    repoOwner: "LearnPrompt",
    repoName: "goodcaseai",
  };
  assert.deepEqual(resolveSessionBranches(rec, ctx), ["feat/board-v0"]);
});

// --- per-line classification: only agent actions + real user text, never tool output ---

test("classifyClaudeLine: a tool_use block's input is extracted as tool-input", () => {
  const obj = {
    type: "assistant",
    message: { content: [{ type: "tool_use", input: { command: "git push -u origin feat/board-v0" } }] },
  };
  const items = classifyClaudeLine(obj);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tool-input");
  assert.match(items[0].text, /feat\/board-v0/);
});

test("classifyClaudeLine: a tool_result block is never extracted (bug this fix addresses)", () => {
  const obj = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", content: "cd /Users/carl2077/agent-workbench/worktrees/goodcase-board && ..." },
      ],
    },
  };
  assert.deepEqual(classifyClaudeLine(obj), []);
});

test("classifyClaudeLine: isMeta user turns (system-reminders, skill bodies) are excluded", () => {
  const obj = {
    type: "user",
    isMeta: true,
    message: { content: [{ type: "text", text: "Base directory for this skill: /Users/x/.claude/skills/browse\n..." }] },
  };
  assert.deepEqual(classifyClaudeLine(obj), []);
});

test("classifyClaudeLine: real user text starting with '<' (e.g. <recommended_plugins>) is excluded", () => {
  const obj = {
    type: "user",
    message: { content: [{ type: "text", text: "<recommended_plugins>\nHere is a list..." }] },
  };
  assert.deepEqual(classifyClaudeLine(obj), []);
});

test("classifyClaudeLine: real user text starting with '#' (e.g. AGENTS.md excerpt) is excluded", () => {
  const obj = {
    type: "user",
    message: { content: [{ type: "text", text: "# AGENTS.md instructions for /Users/x/repo\n..." }] },
  };
  assert.deepEqual(classifyClaudeLine(obj), []);
});

test("classifyClaudeLine: genuine real user text is returned as user-text", () => {
  const obj = { type: "user", message: { content: "帮我看下 PR https://github.com/LearnPrompt/goodcaseai/pull/150" } };
  const items = classifyClaudeLine(obj);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "user-text");
});

test("classifyCodexLine: function_call.arguments is extracted as tool-input", () => {
  const obj = {
    type: "response_item",
    payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"git checkout -b feat/x"}' },
  };
  const items = classifyCodexLine(obj);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tool-input");
  assert.match(items[0].text, /feat\/x/);
});

test("classifyCodexLine: custom_tool_call.input is extracted as tool-input", () => {
  const obj = {
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", input: 'text(await tools.exec_command({cmd:"git push -u origin feat/y"}))' },
  };
  const items = classifyCodexLine(obj);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tool-input");
  assert.match(items[0].text, /feat\/y/);
});

test("classifyCodexLine: function_call_output / custom_tool_call_output (tool results) are never extracted", () => {
  const outA = { type: "response_item", payload: { type: "function_call_output", output: "cd /repo/worktrees/goodcase-board" } };
  const outB = { type: "response_item", payload: { type: "custom_tool_call_output", output: [{ type: "input_text", text: "worktrees/goodcase-board" }] } };
  assert.deepEqual(classifyCodexLine(outA), []);
  assert.deepEqual(classifyCodexLine(outB), []);
});

test("classifyCodexLine: role=user text starting with '<' is excluded, real text is kept", () => {
  const injected = {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\n..." }] },
  };
  const real = {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "看下 goodcase 站点" }] },
  };
  assert.deepEqual(classifyCodexLine(injected), []);
  assert.equal(classifyCodexLine(real)[0].kind, "user-text");
});

// --- end-to-end: extractSessionFacts over a real (fixture) transcript file ------

test("extractSessionFacts: a system-reminder/isMeta line never becomes first_prompt, and tool_result worktree paths are never counted", async () => {
  const lines = [
    JSON.stringify({
      type: "user",
      isMeta: true,
      cwd: "/Users/carl2077/agent-workbench/worktrees/goodcase-board",
      message: { content: [{ type: "text", text: "Base directory for this skill: /Users/x/.claude/skills/browse\n..." }] },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "cd /Users/carl2077/agent-workbench/worktrees/goodcase-board && git status" },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text: "帮我看看这个案例能不能复现" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", input: { command: "git push -u origin feat/board-v0" } }] },
    }),
  ];
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "board-sessions-test-")), "fixture.jsonl");
  fs.writeFileSync(tmpFile, lines.join("\n") + "\n", "utf8");

  const facts = await extractSessionFacts(tmpFile, "claude");
  assert.equal(facts.firstPrompt, "帮我看看这个案例能不能复现");
  assert.deepEqual(facts.worktreePathCounts, {});
  assert.deepEqual(facts.branchMentions, ["feat/board-v0"]);
  assert.equal(facts.cwd, "/Users/carl2077/agent-workbench/worktrees/goodcase-board");

  fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
});

test("classifyCodexLine: role=developer / assistant text is never treated as user-text", () => {
  const dev = {
    type: "response_item",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex..." }] },
  };
  assert.deepEqual(classifyCodexLine(dev), []);
});

// --- app session id / prNumber matching -----------------------------------------

test("stripLocalPrefix: strips the local_ prefix used by the desktop app", () => {
  assert.equal(stripLocalPrefix("local_f603c749-d80c-4d0f-a5a2-6edf02e0de83"), "f603c749-d80c-4d0f-a5a2-6edf02e0de83");
});

test("stripLocalPrefix: passes through an id with no local_ prefix", () => {
  assert.equal(stripLocalPrefix("f603c749-d80c-4d0f-a5a2-6edf02e0de83"), "f603c749-d80c-4d0f-a5a2-6edf02e0de83");
});

const baseGitCtx = {
  repoRoot: "/Users/carl2077/projects/goodcaseai",
  repoLabel: "goodcaseai",
  worktreeEntries: [],
  localBranches: ["feat/i2v-input-assets"],
  remoteBranches: ["feat/i2v-input-assets"],
  prList,
  repoOwner: "LearnPrompt",
  repoName: "goodcaseai",
};

test("mergeSessionRow: id-matched transcript session resolves branches from its raw mentions", () => {
  const scanned = {
    branchMentions: ["feat/i2v-input-assets"],
    worktreePathCounts: {},
    prLinkMentions: [],
    firstPrompt: "图生视频案例",
    lastActive: "2026-09-04T00:00:00Z",
  };
  const row = mergeSessionRow("uuid-1", scanned, null, baseGitCtx);
  assert.deepEqual(row.branches, ["feat/i2v-input-assets"]);
  assert.equal(row.matchedViaTranscript, true);
  assert.equal(row.title, "图生视频案例");
});

test("mergeSessionRow: resolves a worktree-path mention via the live worktree list (>= threshold)", () => {
  const scanned = {
    branchMentions: [],
    worktreePathCounts: { "agent-workbench/worktrees/goodcase-board": WORKTREE_PATH_MIN_MENTIONS },
    prLinkMentions: [],
    firstPrompt: "board 相关工作",
    lastActive: "2026-09-05T00:00:00Z",
  };
  const ctx = {
    ...baseGitCtx,
    localBranches: [...baseGitCtx.localBranches, "feat/board-v0"],
    worktreeEntries: [{ path: "/Users/carl2077/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0" }],
  };
  const row = mergeSessionRow("uuid-2", scanned, null, ctx);
  assert.deepEqual(row.branches, ["feat/board-v0"]);
});

// --- prNumber fallback: repo guard (board-spec-v0.1 §prNumber 兜底加仓库守卫) ----

test("mergeSessionRow: prNumber guard (a) — transcript has a this-repo PR link, prNumber fallback trusted, not flagged inferred", () => {
  const scanned = {
    branchMentions: [],
    worktreePathCounts: {},
    prLinkMentions: [{ owner: "LearnPrompt", repo: "goodcaseai", number: 150 }],
    firstPrompt: "图生视频提示语案例",
    lastActive: "2026-09-04T00:00:00Z",
  };
  const app = { sessionId: "local_feac66d1-8917-4f14-aaee-a9aa68c2136e", title: "图生视频提示语案例", prNumber: 150, pinned: true };
  const row = mergeSessionRow(stripLocalPrefix(app.sessionId), scanned, app, baseGitCtx);
  assert.deepEqual(row.branches, ["feat/i2v-input-assets"]);
  assert.equal(row.pinned, true);
  assert.equal(row.prInferred, false);
});

test("mergeSessionRow: prNumber guard (a) — transcript has a weighty this-repo worktree-path clue, prNumber fallback trusted", () => {
  const scanned = {
    branchMentions: [],
    worktreePathCounts: { "agent-workbench/worktrees/goodcase-board": WORKTREE_PATH_MIN_MENTIONS },
    prLinkMentions: [],
    firstPrompt: "board 相关工作",
    lastActive: "2026-09-05T00:00:00Z",
  };
  const ctx = {
    ...baseGitCtx,
    worktreeEntries: [{ path: "/Users/carl2077/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0" }],
  };
  const app = { sessionId: "local_x2", title: "board 工作", prNumber: 150 };
  const row = mergeSessionRow("x2", scanned, app, ctx);
  assert.deepEqual(row.branches, ["feat/i2v-input-assets"]);
  assert.equal(row.prInferred, false);
});

// --- cwd-based repo ownership (replaces title/alias matching entirely) ---------
// 铁律: session titles are randomly generated by Claude and must NEVER be a
// matching signal — only project (cwd) and branch may be used. Every test
// below that includes a misleading/on-the-nose title is deliberately proving
// that title text never moves the outcome.

test("isPathContainedIn: a sibling directory with a shared string prefix is not a false match", () => {
  assert.equal(isPathContainedIn("/foo/bar2/x", "/foo/bar"), false);
  assert.equal(isPathContainedIn("/foo/bar2", "/foo/bar"), false);
  assert.equal(isPathContainedIn("/foo/bar/x", "/foo/bar"), true);
  assert.equal(isPathContainedIn("/foo/bar", "/foo/bar"), true);
});

test("resolveCwdOwnership: cwd under a registered worktree path resolves to that repo, worktree included", () => {
  const worktreeEntries = [
    { path: "/Users/carl2077/agent-workbench/worktrees/goodcase-i2v-input-assets", branch: "feat/i2v-input-assets", detached: false },
  ];
  const result = resolveCwdOwnership(
    "/Users/carl2077/agent-workbench/worktrees/goodcase-i2v-input-assets/lib/foo.mjs",
    "/Users/carl2077/projects/goodcaseai",
    worktreeEntries
  );
  assert.equal(result.matched, true);
  assert.equal(result.worktree.branch, "feat/i2v-input-assets");
});

test("resolveCwdOwnership: a general orchestration directory (~/agent-workbench) outside repoRoot/worktrees matches nothing", () => {
  const result = resolveCwdOwnership(
    "/Users/carl2077/agent-workbench",
    "/Users/carl2077/projects/goodcaseai",
    [{ path: "/Users/carl2077/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0" }]
  );
  assert.equal(result.matched, false);
  assert.equal(result.worktree, null);
});

// Regression: worktrees can be registered NESTED inside repoRoot itself (the
// desktop app's own `<repoRoot>/.claude/worktrees/<name>` convention — `git
// worktree list` always reports the main worktree first). A cwd inside the
// nested worktree is contained by BOTH repoRoot and the nested worktree path;
// the more specific (longest) match must win, not whichever candidate was
// checked/listed first.
test("resolveCwdOwnership: a cwd inside a worktree nested under repoRoot resolves to the NESTED worktree, not repoRoot or an earlier-listed shallower worktree", () => {
  const repoRoot = "/Users/carl2077/projects/goodcaseai";
  const worktreeEntries = [
    { path: "/Users/carl2077/projects/goodcaseai", branch: "main", detached: false },
    { path: "/Users/carl2077/projects/goodcaseai/.claude/worktrees/keen-moser-b79a64", branch: null, detached: true },
  ];
  const cwd = "/Users/carl2077/projects/goodcaseai/.claude/worktrees/keen-moser-b79a64";
  const result = resolveCwdOwnership(cwd, repoRoot, worktreeEntries);
  assert.equal(result.matched, true);
  assert.equal(result.worktree.path, "/Users/carl2077/projects/goodcaseai/.claude/worktrees/keen-moser-b79a64");
  assert.equal(result.worktree.detached, true);
});

// STEP4 acceptance (1): cwd under a worktree path → correctly attributed to that repo.
test("mergeSessionRow: cwd under a worktree path is attributed to that repo via the worktree's checked-out branch", () => {
  const app = { sessionId: "local_wt1", title: "随手记的标题", cwd: "/Users/carl2077/agent-workbench/worktrees/goodcase-board/lib/sessions.mjs" };
  const ctx = {
    ...baseGitCtx,
    localBranches: [...baseGitCtx.localBranches, "feat/board-v0"],
    worktreeEntries: [{ path: "/Users/carl2077/agent-workbench/worktrees/goodcase-board", branch: "feat/board-v0", detached: false }],
  };
  const row = mergeSessionRow("wt1", null, app, ctx);
  assert.deepEqual(row.branches, ["feat/board-v0"]);
});

test("mergeSessionRow: cwd under a detached-HEAD worktree records the worktree path itself as the branch clue", () => {
  const app = { sessionId: "local_wt2", title: "无关标题", cwd: "/Users/carl2077/agent-workbench/worktrees/goodcase-eval-run/sub/dir" };
  const ctx = {
    ...baseGitCtx,
    worktreeEntries: [{ path: "/Users/carl2077/agent-workbench/worktrees/goodcase-eval-run", branch: null, detached: true }],
  };
  const row = mergeSessionRow("wt2", null, app, ctx);
  assert.deepEqual(row.branches, ["/Users/carl2077/agent-workbench/worktrees/goodcase-eval-run"]);
});

// STEP4 acceptance (2): cwd = ~/agent-workbench (non-repo orchestration dir) → NOT attributed via cwd.
test("mergeSessionRow: cwd = agent-workbench alone attributes nothing (no transcript, no branch, no prNumber clue)", () => {
  const app = { sessionId: "local_wb1", title: "随便聊聊", cwd: "/Users/carl2077/agent-workbench" };
  const row = mergeSessionRow("wb1", null, app, baseGitCtx);
  assert.deepEqual(row.branches, []);
  assert.equal(row.prInferred, false);
});

// STEP4 acceptance (3): app.branch matching a repo's branch → recorded as a branch clue.
test("mergeSessionRow: app.branch matching a real branch of this repo is recorded as a branch clue", () => {
  const app = { sessionId: "local_br1", title: "无所谓的标题", branch: "feat/i2v-input-assets" };
  const row = mergeSessionRow("br1", null, app, baseGitCtx);
  assert.deepEqual(row.branches, ["feat/i2v-input-assets"]);
});

test("mergeSessionRow: app.branch that isn't a real branch of this repo is filtered out (not a genuine clue)", () => {
  const app = { sessionId: "local_br2", title: "无所谓的标题", branch: "feat/some-other-repos-branch" };
  const row = mergeSessionRow("br2", null, app, baseGitCtx);
  assert.deepEqual(row.branches, []);
});

// STEP4 acceptance (4): PR number unique to exactly one repo in the workspace index → accepted, prInferred: true.
test("mergeSessionRow: prNumber unique to exactly one repo in the workspace PR index is accepted and flagged prInferred", () => {
  const workspacePrIndex = new Map([[150, new Set(["goodcaseai"])]]);
  const ctx = { ...baseGitCtx, workspacePrIndex };
  const app = { sessionId: "local_uniq1", title: "无关标题", prNumber: 150 };
  const row = mergeSessionRow("uniq1", null, app, ctx);
  assert.deepEqual(row.branches, ["feat/i2v-input-assets"]);
  assert.equal(row.prInferred, true);
});

// STEP4 acceptance (5): PR number present in TWO repos' workspace index, no cwd/transcript clue → rejected for both.
test("mergeSessionRow: prNumber present in two repos' workspace index is ambiguous and rejected for both", () => {
  const workspacePrIndex = new Map([[2, new Set(["goodcaseai", "aimap"])]]);
  const goodcaseCtx = {
    ...baseGitCtx,
    prList: [...prList, { number: 2, headRefName: "fix/goodcase-stability-placeholder", state: "OPEN" }],
    workspacePrIndex,
  };
  const aimapCtx = {
    repoRoot: "/Users/carl2077/projects/aimap",
    repoLabel: "aimap",
    worktreeEntries: [],
    localBranches: ["heat-v2"],
    remoteBranches: ["heat-v2"],
    prList: [{ number: 2, headRefName: "heat-v2", state: "OPEN" }],
    repoOwner: "LearnPrompt",
    repoName: "aimap",
    workspacePrIndex,
  };
  const app = { sessionId: "local_amb1", title: "aimap", prNumber: 2 };
  const rowGoodcase = mergeSessionRow("amb1", null, app, goodcaseCtx);
  const rowAimap = mergeSessionRow("amb1", null, app, aimapCtx);
  assert.deepEqual(rowGoodcase.branches, []);
  assert.equal(rowGoodcase.prInferred, false);
  assert.deepEqual(rowAimap.branches, []);
  assert.equal(rowAimap.prInferred, false);
});

// Single-repo mode has no workspacePrIndex at all — path (iii) must simply be unavailable, not fabricated.
test("mergeSessionRow: no workspacePrIndex present (single-repo mode) means the PR-uniqueness path is unavailable", () => {
  const app = { sessionId: "local_solo1", title: "无关标题", prNumber: 150 };
  const row = mergeSessionRow("solo1", null, app, baseGitCtx);
  assert.deepEqual(row.branches, []);
  assert.equal(row.prInferred, false);
});

// STEP4 acceptance (6): title alone (even naming this repo) never attributes — no cwd/branch/transcript/unique-PR clue.
test("mergeSessionRow: title alone naming this repo's own name never attributes a session", () => {
  const app = { sessionId: "local_x3", title: "goodcaseai 相关工作", cwd: "/Users/carl2077/agent-workbench", prNumber: 999999 };
  const row = mergeSessionRow("x3", null, app, baseGitCtx);
  assert.deepEqual(row.branches, []);
  assert.equal(row.matchedViaTranscript, false);
  assert.equal(row.prInferred, false);
});

test("mergeSessionRow: prNumber fallback that doesn't resolve to any PR in this repo yields no branches", () => {
  const scanned = {
    branchMentions: [],
    worktreePathCounts: {},
    prLinkMentions: [{ owner: "LearnPrompt", repo: "goodcaseai", number: 424242 }],
  };
  const app = { sessionId: "local_x", title: "unrelated", prNumber: 424242 };
  const row = mergeSessionRow("x", scanned, app, baseGitCtx);
  assert.deepEqual(row.branches, []);
});

// --- conclusion judgement: 可关 / 别关 / 无线索 -----------------------------------

function card(overrides) {
  return {
    branch: "feat/x",
    stage: "pushed",
    status: "doing",
    dirty_files: 0,
    unpushed_commits: 0,
    pr: null,
    pr_state: null,
    conflicts_with: [],
    ...overrides,
  };
}

test("judgeSession: no branches at all -> no-clue", () => {
  assert.deepEqual(judgeSession([], new Map()), { verdict: "no-clue", reason: null });
  assert.deepEqual(judgeSession(null, new Map()), { verdict: "no-clue", reason: null });
});

test("judgeSession: branches don't match any known card -> no-clue", () => {
  const result = judgeSession(["feat/ghost"], new Map());
  assert.equal(result.verdict, "no-clue");
});

test("judgeSession: merged branch, clean -> can-close", () => {
  const cards = new Map([["feat/x", card({ stage: "merged", status: "done" })]]);
  assert.deepEqual(judgeSession(["feat/x"], cards), { verdict: "can-close", reason: null });
});

test("judgeSession: closed (dropped) branch, clean -> can-close", () => {
  const cards = new Map([["feat/x", card({ stage: "closed", status: "dropped" })]]);
  assert.deepEqual(judgeSession(["feat/x"], cards), { verdict: "can-close", reason: null });
});

test("judgeSession: merged branch but worktree still dirty -> keep (safety net)", () => {
  const cards = new Map([["feat/x", card({ stage: "merged", status: "done", dirty_files: 2 })]]);
  const result = judgeSession(["feat/x"], cards);
  assert.equal(result.verdict, "keep");
  assert.match(result.reason, /有 2 个未提交文件/);
});

test("judgeSession: keep reason - dirty files", () => {
  const cards = new Map([["feat/x", card({ stage: "dirty", dirty_files: 3 })]]);
  assert.deepEqual(judgeSession(["feat/x"], cards), { verdict: "keep", reason: "feat/x 有 3 个未提交文件" });
});

test("judgeSession: keep reason - unpushed commits", () => {
  const cards = new Map([["feat/x", card({ stage: "unpushed", unpushed_commits: 4 })]]);
  assert.deepEqual(judgeSession(["feat/x"], cards), { verdict: "keep", reason: "feat/x 有 4 个 commit 未 push" });
});

test("judgeSession: keep reason - PR still open", () => {
  const cards = new Map([["feat/x", card({ stage: "pr_open", pr: 150, pr_state: "OPEN" })]]);
  assert.deepEqual(judgeSession(["feat/x"], cards), { verdict: "keep", reason: "feat/x PR #150 还开着" });
});

test("judgeSession: keep reason - pushed but no PR", () => {
  const cards = new Map([["feat/x", card({ stage: "pushed" })]]);
  assert.deepEqual(judgeSession(["feat/x"], cards), { verdict: "keep", reason: "feat/x 只 push 了没开 PR" });
});

test("judgeSession: keep reason - conflicts with another branch (lowest-priority reason, per spec order)", () => {
  // Conflict is checked last: it only surfaces once dirty/unpushed/pr_open/pushed
  // all fail to explain why the branch isn't closeable — e.g. a freshly-created
  // local branch with no commits yet ahead of base and no origin ref.
  const cards = new Map([
    ["feat/x", card({ stage: "unpushed", dirty_files: 0, unpushed_commits: 0, pr: null, conflicts_with: ["feat/y (3 files)"] })],
  ]);
  const result = judgeSession(["feat/x"], cards);
  assert.equal(result.verdict, "keep");
  assert.match(result.reason, /与 feat\/y \(3 files\)/);
});

test("judgeSession: reason priority - 'pushed, no PR' is reported before a conflict on the same branch", () => {
  const cards = new Map([["feat/x", card({ stage: "pushed", conflicts_with: ["feat/y (3 files)"] })]]);
  const result = judgeSession(["feat/x"], cards);
  assert.equal(result.reason, "feat/x 只 push 了没开 PR");
});

test("judgeSession: reason priority - dirty files reported before unpushed commits", () => {
  const cards = new Map([["feat/x", card({ stage: "dirty", dirty_files: 1, unpushed_commits: 5 })]]);
  const result = judgeSession(["feat/x"], cards);
  assert.match(result.reason, /未提交文件/);
});

test("judgeSession: multiple branches, all done -> can-close", () => {
  const cards = new Map([
    ["feat/a", card({ stage: "merged", status: "done" })],
    ["feat/b", card({ stage: "closed", status: "dropped" })],
  ]);
  assert.deepEqual(judgeSession(["feat/a", "feat/b"], cards), { verdict: "can-close", reason: null });
});

test("judgeSession: multiple branches, one still active -> keep with that branch's reason", () => {
  const cards = new Map([
    ["feat/a", card({ stage: "merged", status: "done" })],
    ["feat/b", card({ stage: "pushed" })],
  ]);
  const result = judgeSession(["feat/a", "feat/b"], cards);
  assert.equal(result.verdict, "keep");
  assert.match(result.reason, /feat\/b 只 push 了没开 PR/);
});

test("filterBranchesToRepo drops trunk branches even when they exist in the repo", () => {
  const out = filterBranchesToRepo(["main", "master", "feat/x"], ["main", "master", "feat/x"], [], []);
  assert.deepEqual(out, ["feat/x"]);
});

// --- board-spec-v0.4 §A1: hook 直写线索（最高优先级） -------------------------

function mkTmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "board-hooks-agg-"));
}

test("loadHookEvents: empty cache dir (no events.jsonl yet) yields []", () => {
  const cacheDir = mkTmpCacheDir();
  assert.deepEqual(loadHookEvents(cacheDir), []);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("loadHookEvents: reads back everything appendHookEvent wrote (hooks.mjs round trip)", () => {
  const cacheDir = mkTmpCacheDir();
  appendHookEvent(cacheDir, { ts: "t1", source: "claude", sessionId: "s1", branch: "feat/a" });
  appendHookEvent(cacheDir, { ts: "t2", source: "codex", sessionId: "s2", branch: "feat/b" });
  const events = loadHookEvents(cacheDir);
  assert.equal(events.length, 2);
  assert.equal(events[0].sessionId, "s1");
  assert.equal(events[1].sessionId, "s2");
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("groupHookEventsBySession: 同一 sessionId 的多条事件聚合成一个数组，缺 sessionId 的事件被丢弃", () => {
  const events = [
    { sessionId: "s1", branch: "feat/a" },
    { sessionId: "s1", branch: "feat/b" },
    { sessionId: "s2", branch: "feat/c" },
    { branch: "feat/no-session" },
  ];
  const groups = groupHookEventsBySession(events);
  assert.equal(groups.size, 2);
  assert.equal(groups.get("s1").length, 2);
  assert.equal(groups.get("s2").length, 1);
});

const hookGitCtx = {
  repoRoot: "/Users/carl/projects/goodcaseai",
  worktreeEntries: [],
  localBranches: ["feat/board-v0"],
  remoteBranches: ["feat/board-v0"],
  prList: [],
};

test("resolveHookBranchesForRepo: an event whose repoRoot equals gitCtx.repoRoot resolves its branch", () => {
  const events = [{ repoRoot: "/Users/carl/projects/goodcaseai", branch: "feat/board-v0", worktree: null }];
  assert.deepEqual(resolveHookBranchesForRepo(events, hookGitCtx), ["feat/board-v0"]);
});

test("resolveHookBranchesForRepo: an event fired inside a LINKED worktree resolves via --git-common-dir reversed to the main repo root (board-spec-v0.4 事件聚合)", () => {
  const events = [
    {
      repoRoot: "/Users/carl/agent-workbench/worktrees/goodcase-board", // show-toplevel of the worktree itself
      branch: "feat/board-v0",
      worktree: "/Users/carl/projects/goodcaseai/.git", // --git-common-dir, shared with the main repo
    },
  ];
  assert.deepEqual(resolveHookBranchesForRepo(events, hookGitCtx), ["feat/board-v0"]);
});

test("resolveHookBranchesForRepo: an event for a DIFFERENT repo (neither repoRoot nor worktree matches) contributes nothing", () => {
  const events = [{ repoRoot: "/Users/carl/projects/some-other-repo", branch: "feat/x", worktree: "/Users/carl/projects/some-other-repo/.git" }];
  assert.deepEqual(resolveHookBranchesForRepo(events, hookGitCtx), []);
});

test("resolveHookBranchesForRepo: a branch that doesn't exist in this repo (local/remote/PR) is filtered out", () => {
  const events = [{ repoRoot: "/Users/carl/projects/goodcaseai", branch: "feat/nonexistent", worktree: null }];
  assert.deepEqual(resolveHookBranchesForRepo(events, hookGitCtx), []);
});

test("resolveHookBranchesForRepo: trunk branches (main/master) never count as a clue, even from a hook", () => {
  const ctx = { ...hookGitCtx, localBranches: ["main"], remoteBranches: ["main"] };
  const events = [{ repoRoot: "/Users/carl/projects/goodcaseai", branch: "main", worktree: null }];
  assert.deepEqual(resolveHookBranchesForRepo(events, ctx), []);
});

test("resolveHookBranchesForRepo: no events / no repoRoot on gitCtx yields []", () => {
  assert.deepEqual(resolveHookBranchesForRepo([], hookGitCtx), []);
  assert.deepEqual(resolveHookBranchesForRepo(null, hookGitCtx), []);
  assert.deepEqual(resolveHookBranchesForRepo([{ repoRoot: "/x", branch: "feat/board-v0" }], { ...hookGitCtx, repoRoot: null }), []);
});

// --- mergeSessionRow: hook 线索最高优先级 -------------------------------------

test("mergeSessionRow: a hook-only session (no scanned transcript, no app import) still produces a row, labeled via=hook", () => {
  const hookEvents = [{ repoRoot: "/Users/carl/projects/goodcaseai", branch: "feat/board-v0", worktree: null, ts: "2026-09-07T00:00:00Z" }];
  const row = mergeSessionRow("test-1234", null, null, hookGitCtx, hookEvents);
  assert.deepEqual(row.branches, ["feat/board-v0"]);
  assert.equal(row.via, "hook");
  assert.equal(row.title, "(无标题)");
});

test("mergeSessionRow: hook branches are unioned with transcript-derived branches, not replaced by them", () => {
  const scanned = { branchMentions: ["feat/board-v0"], worktreePathCounts: {}, prLinkMentions: [] };
  const ctx = { ...hookGitCtx, localBranches: ["feat/board-v0", "feat/other"], remoteBranches: ["feat/board-v0", "feat/other"] };
  const hookEvents = [{ repoRoot: "/Users/carl/projects/goodcaseai", branch: "feat/other", worktree: null }];
  const row = mergeSessionRow("uuid-x", scanned, null, ctx, hookEvents);
  assert.deepEqual(row.branches, ["feat/board-v0", "feat/other"]);
  assert.equal(row.via, "hook");
});

test("mergeSessionRow: a hook match outranks prNumber inference — via=hook, not prInferred's 按 PR 号推断 label", () => {
  const goodcaseCtx = {
    repoRoot: "/Users/carl/projects/goodcaseai",
    repoLabel: "goodcaseai",
    worktreeEntries: [],
    localBranches: ["feat/board-v0"],
    remoteBranches: ["feat/board-v0"],
    prList: [{ number: 999, headRefName: "feat/board-v0" }],
    workspacePrIndex: new Map([[999, new Set(["goodcaseai"])]]),
  };
  const app = { sessionId: "local_uniq-hook-1", prNumber: 999 };
  const hookEvents = [{ repoRoot: "/Users/carl/projects/goodcaseai", branch: "feat/board-v0", worktree: null }];
  const row = mergeSessionRow("uniq-hook-1", null, app, goodcaseCtx, hookEvents);
  assert.equal(row.via, "hook");
  // prInferred may independently be computed true by the pre-existing PR-uniqueness
  // path, but board.mjs's printSessionRows must prefer via="hook" over that label —
  // the important contract here is that via itself is set correctly.
  assert.ok(row.branches.includes("feat/board-v0"));
});

test("mergeSessionRow: no hook events at all leaves via=null and existing behavior unchanged", () => {
  const row = mergeSessionRow("uuid-y", null, { branch: "feat/board-v0" }, hookGitCtx);
  assert.equal(row.via, null);
  assert.deepEqual(row.branches, ["feat/board-v0"]);
});

// --- buildSessionRows: a hook-only session appears as a row (board-spec-v0.4 §A1) ---

test("buildSessionRows: a session known ONLY via hook events (never transcribed, never app-imported) still appears", () => {
  const cacheDir = mkTmpCacheDir();
  appendHookEvent(cacheDir, {
    ts: "2026-09-07T12:00:00Z",
    source: "claude",
    sessionId: "test-1234",
    repoRoot: "/Users/carl/projects/goodcaseai",
    branch: "feat/board-v0",
    worktree: null,
  });
  const rows = buildSessionRows(cacheDir, hookGitCtx);
  const row = rows.find((r) => r.uuid === "test-1234");
  assert.ok(row, "expected a row for the hook-only session");
  assert.deepEqual(row.branches, ["feat/board-v0"]);
  assert.equal(row.via, "hook");
  fs.rmSync(cacheDir, { recursive: true, force: true });
});
