import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorktreePorcelain,
  parseForEachRef,
  resolveBranchLocation,
  branchRefFor,
  parseLastCommitLine,
  parseAheadBehind,
  parseMergedBranchList,
  expandHome,
  parseStatusPorcelainCount,
  parseGithubRemote,
} from "./git.mjs";

test("parses a normal worktree list with a branch", () => {
  const out = [
    "worktree /Users/carl/projects/goodcaseai",
    "HEAD d2d327bxxxx",
    "branch refs/heads/main",
    "",
    "worktree /Users/carl/agent-workbench/worktrees/goodcase-board",
    "HEAD deadbeef",
    "branch refs/heads/feat/board-v0",
  ].join("\n");
  const entries = parseWorktreePorcelain(out);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, "/Users/carl/projects/goodcaseai");
  assert.equal(entries[0].branch, "main");
  assert.equal(entries[0].detached, false);
  assert.equal(entries[1].branch, "feat/board-v0");
});

test("parses a detached worktree entry", () => {
  const out = ["worktree /path/to/goodcase-eval-run", "HEAD e96e879abc", "detached"].join("\n");
  const entries = parseWorktreePorcelain(out);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].branch, null);
  assert.equal(entries[0].detached, true);
  assert.equal(entries[0].head, "e96e879abc");
});

test("parses a prunable worktree entry", () => {
  const out = [
    "worktree /path/to/stale-wt",
    "HEAD abc123",
    "branch refs/heads/fix/gone",
    "prunable gitdir file points to non-existent location",
  ].join("\n");
  const entries = parseWorktreePorcelain(out);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].prunable, true);
  assert.equal(entries[0].branch, "fix/gone");
});

test("parses a locked worktree entry and a bare repo entry", () => {
  const out = [
    "worktree /path/to/locked-wt",
    "HEAD abc123",
    "branch refs/heads/wip/locked",
    "locked",
    "",
    "worktree /path/to/bare.git",
    "bare",
  ].join("\n");
  const entries = parseWorktreePorcelain(out);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].locked, true);
  assert.equal(entries[1].bare, true);
});

test("empty porcelain output parses to empty array", () => {
  assert.deepEqual(parseWorktreePorcelain(""), []);
  assert.deepEqual(parseWorktreePorcelain(null), []);
});

test("parseForEachRef splits and trims lines", () => {
  assert.deepEqual(parseForEachRef("main\nfeat/a\nfeat/b\n"), ["main", "feat/a", "feat/b"]);
  assert.deepEqual(parseForEachRef(""), []);
});

test("resolveBranchLocation prefers local over origin, else origin, else null", () => {
  const local = ["main", "feat/local-only"];
  const remote = ["main", "feat/origin-only"];
  assert.equal(resolveBranchLocation("feat/local-only", local, remote), "local");
  assert.equal(resolveBranchLocation("feat/origin-only", local, remote), "origin");
  assert.equal(resolveBranchLocation("feat/nowhere", local, remote), null);
});

test("branchRefFor builds the correct ref string per location", () => {
  assert.equal(branchRefFor("feat/x", "local"), "refs/heads/feat/x");
  assert.equal(branchRefFor("feat/x", "origin"), "refs/remotes/origin/feat/x");
  assert.equal(branchRefFor("feat/x", null), null);
});

test("parseLastCommitLine extracts sha, date, and message with unit separators", () => {
  const line = "03ba00aabc\x1f2026-09-04T18:58:21+08:00\x1ffeat(cases): add input assets column";
  const parsed = parseLastCommitLine(line);
  assert.deepEqual(parsed, {
    sha: "03ba00aabc",
    date: "2026-09-04T18:58:21+08:00",
    msg: "feat(cases): add input assets column",
  });
  assert.equal(parseLastCommitLine(""), null);
  assert.equal(parseLastCommitLine(null), null);
});

test("parseAheadBehind reads left-right count output", () => {
  assert.deepEqual(parseAheadBehind("12\t3"), { behind: 12, ahead: 3 });
  assert.deepEqual(parseAheadBehind(""), { behind: null, ahead: null });
});

test("parseMergedBranchList strips the current-branch asterisk marker", () => {
  assert.deepEqual(parseMergedBranchList("  main\n* feat/done\n  feat/also-done\n"), [
    "main",
    "feat/done",
    "feat/also-done",
  ]);
  assert.deepEqual(parseMergedBranchList(""), []);
});

test("parseStatusPorcelainCount counts non-empty lines, ignores trailing blank", () => {
  assert.equal(parseStatusPorcelainCount(" M a.ts\n?? b.ts\n"), 2);
  assert.equal(parseStatusPorcelainCount(""), 0);
  assert.equal(parseStatusPorcelainCount(null), 0);
});

test("parseGithubRemote parses an https origin URL", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/LearnPrompt/goodcaseai"), {
    owner: "LearnPrompt",
    repo: "goodcaseai",
  });
  assert.deepEqual(parseGithubRemote("https://github.com/LearnPrompt/goodcaseai.git"), {
    owner: "LearnPrompt",
    repo: "goodcaseai",
  });
});

test("parseGithubRemote parses an ssh origin URL", () => {
  assert.deepEqual(parseGithubRemote("git@github.com:LearnPrompt/goodcaseai.git"), {
    owner: "LearnPrompt",
    repo: "goodcaseai",
  });
});

test("parseGithubRemote returns null for a non-github remote or empty input", () => {
  assert.equal(parseGithubRemote("https://gitlab.com/foo/bar"), null);
  assert.equal(parseGithubRemote(null), null);
});

test("expandHome expands a leading ~ using the home directory", () => {
  const expanded = expandHome("~/agent-workbench/worktrees");
  assert.ok(expanded.startsWith("/"));
  assert.ok(expanded.endsWith("/agent-workbench/worktrees"));
  assert.equal(expandHome("/already/absolute"), "/already/absolute");
});
