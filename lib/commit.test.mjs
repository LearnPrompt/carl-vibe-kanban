// Real-git fixture tests for `board commit` (lib/commit.mjs). Unlike the rest
// of this repo's test suite (which sticks to pure parsing functions), the
// whole point of `board commit` is git plumbing sequencing — fetch, ff-only
// merge, rebase-if-board-only, commit with a pathspec, push-retry — so these
// tests build a real bare remote + real clones per test and assert on real
// `git log`/`git status` output. Never calls launchctl (that's schedule.mjs's
// job, tested separately with pure plist generation only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  runCommitForRepo,
  pushWithOneRetry,
  buildCommitMessage,
  filesAllUnderBoard,
  parseStatusPaths,
  hasNonBoardDirty,
} from "./commit.mjs";
import { isRebaseOrMergeInProgress, lsFilesTracked } from "./git.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitOk(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function makeRemote() {
  const remoteDir = tmpDir("board-commit-remote-");
  git(remoteDir, ["init", "--bare", "-q", "--initial-branch=main", "."]);
  return remoteDir;
}

function cloneRepo(remoteDir) {
  const parent = tmpDir("board-commit-clone-parent-");
  const dir = path.join(parent, "work");
  git(parent, ["clone", "-q", remoteDir, dir]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

// Seeds a remote with an initial commit that already tracks board/tasks/a.md
// (i.e. `board/` is "入库"), pushed to main. Returns the remote dir.
function makeSeededRemote() {
  const remoteDir = makeRemote();
  const seed = cloneRepo(remoteDir);
  writeFile(seed, "README.md", "hello\n");
  writeFile(seed, "board/tasks/a.md", "---\nid: T-a\n---\n");
  commitAll(seed, "init");
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  return remoteDir;
}

// --- 1. board/ 未入库 -> SKIP --------------------------------------------------

test("SKIPs a repo where board/ was never committed", () => {
  const remoteDir = makeRemote();
  const seed = cloneRepo(remoteDir);
  writeFile(seed, "README.md", "hello\n");
  commitAll(seed, "init");
  git(seed, ["push", "-q", "-u", "origin", "main"]);

  assert.deepEqual(lsFilesTracked(seed, "board/"), []);
  const line = runCommitForRepo(seed, "no-board-repo", {});
  assert.equal(line, "SKIP no-board-repo  卡片未入库");
});

// --- 2. 非主干分支 -> SKIP ------------------------------------------------------

test("SKIPs when the main worktree isn't checked out to the default branch", () => {
  const remoteDir = makeSeededRemote();
  const work = cloneRepo(remoteDir);
  git(work, ["checkout", "-q", "-b", "feature"]);

  const line = runCommitForRepo(work, "wrong-branch-repo", {});
  assert.match(line, /^SKIP wrong-branch-repo {2}主工作树当前分支不是主干/);
});

// --- 3. 只提交 board 路径，别的已暂存文件原样保留 --------------------------------

test("commits only board/ paths, leaving an already-staged non-board file staged", () => {
  const remoteDir = makeSeededRemote();
  const work = cloneRepo(remoteDir);

  // Simulate another session's unrelated staged edit sitting in the shared
  // main worktree.
  writeFile(work, "README.md", "hello\nedited by another session\n");
  git(work, ["add", "README.md"]);

  // Our own board refresh, left unstaged (board sync just wrote it).
  writeFile(work, "board/tasks/a.md", "---\nid: T-a\nstatus: doing\n---\n");

  const line = runCommitForRepo(work, "myrepo", {});
  assert.match(line, /^myrepo: committed 1 files [0-9a-f]{7}$/);

  const log = git(work, ["log", "-1", "--format=%s"]).trim();
  assert.match(log, /^chore\(board\): /);

  const committedFiles = git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
    .trim()
    .split("\n");
  assert.deepEqual(committedFiles, ["board/tasks/a.md"]);

  // README.md must still be staged (index) and NOT committed.
  const status = git(work, ["status", "--porcelain"]);
  assert.equal(status, "M  README.md\n");
});

// --- 4. 无变化 ------------------------------------------------------------------

test("prints no changes when board/ has nothing to commit", () => {
  const remoteDir = makeSeededRemote();
  const work = cloneRepo(remoteDir);

  const line = runCommitForRepo(work, "myrepo", {});
  assert.equal(line, "myrepo: no changes");
});

// --- 5. ff 更新后提交 -------------------------------------------------------------

test("fast-forwards a behind-but-not-ahead repo before committing its own board change", () => {
  const remoteDir = makeSeededRemote();
  const workA = cloneRepo(remoteDir);
  const workB = cloneRepo(remoteDir);

  // Someone/something else already refreshed and pushed board/ from workB.
  writeFile(workB, "board/tasks/remote-added.md", "---\nid: T-remote\n---\n");
  commitAll(workB, "chore(board): 卡片刷新 remote");
  git(workB, ["push", "-q", "origin", "main"]);

  // workA is behind (hasn't fetched) and has its OWN unrelated new board
  // file sitting unstaged — no path overlap with workB's change, so the
  // ff-only merge won't conflict.
  writeFile(workA, "board/tasks/local-new.md", "---\nid: T-local\n---\n");

  const line = runCommitForRepo(workA, "myrepo", {});
  assert.match(line, /^myrepo: committed 1 files [0-9a-f]{7}$/);

  // The ff-merge must have landed workB's commit too.
  assert.ok(fs.existsSync(path.join(workA, "board", "tasks", "remote-added.md")));
  const log = git(workA, ["log", "--oneline"]).trim().split("\n");
  assert.equal(log.length, 3); // init, remote-added, our chore(board) commit
});

// --- 6. push 被拒后 fetch + rebase + 重推 -----------------------------------------

test("pushWithOneRetry rebases a board-only divergence and pushes again", () => {
  const remoteDir = makeSeededRemote();
  const workA = cloneRepo(remoteDir);
  const workB = cloneRepo(remoteDir);

  // workA commits a board-only change locally but does NOT push yet.
  writeFile(workA, "board/tasks/from-a.md", "---\nid: T-a2\n---\n");
  commitAll(workA, "chore(board): 卡片刷新 from-a");

  // Meanwhile workB pushes its own board-only change to origin/main first.
  writeFile(workB, "board/tasks/from-b.md", "---\nid: T-b\n---\n");
  commitAll(workB, "chore(board): 卡片刷新 from-b");
  git(workB, ["push", "-q", "origin", "main"]);

  // workA hasn't fetched — its plain push is rejected (non-fast-forward).
  assert.equal(gitOk(workA, ["push", "origin", "HEAD:main"]), false);

  const result = pushWithOneRetry(workA, "main", "refs/remotes/origin/main");
  assert.deepEqual(result, { ok: true });

  git(workA, ["fetch", "origin", "main", "-q"]);
  const remoteLog = git(workA, ["log", "--oneline", "refs/remotes/origin/main"]).trim().split("\n");
  assert.equal(remoteLog.length, 3); // init, from-b, from-a (rebased on top)
  assert.ok(fs.existsSync(path.join(workA, "board", "tasks", "from-b.md")));
});

// --- 7. 分叉且领先提交改了 board/ 之外的路径 -> SKIP -------------------------------

test("SKIPs a diverged repo whose local-ahead commit touches a non-board path", () => {
  const remoteDir = makeSeededRemote();
  const workA = cloneRepo(remoteDir);
  const workB = cloneRepo(remoteDir);

  // Remote advances with a board-only commit from workB.
  writeFile(workB, "board/tasks/from-b.md", "---\nid: T-b\n---\n");
  commitAll(workB, "chore(board): 卡片刷新 from-b");
  git(workB, ["push", "-q", "origin", "main"]);

  // workA, without fetching, commits a change that touches README.md (NOT
  // under board/) — this is the disallowed kind of "领先" commit.
  writeFile(workA, "README.md", "hello\nlocal edit\n");
  commitAll(workA, "docs: tweak readme");

  const line = runCommitForRepo(workA, "myrepo", {});
  assert.equal(line, "SKIP myrepo  分叉且领先提交改了 board/ 之外的路径，需人工处理");
});

// --- 8. 提交信息前缀 --------------------------------------------------------------

test("buildCommitMessage always starts with the chore(board): prefix Vercel's Ignored Build Step matches on", () => {
  const msg = buildCommitMessage(new Date(2026, 8, 12, 9, 30));
  assert.equal(msg, "chore(board): 卡片刷新 2026-09-12 09:30");
  assert.match(msg, /^chore\(board\): /);
});

// --- bonus: new git.mjs primitives this feature added --------------------------

test("isRebaseOrMergeInProgress is false for a clean repo and true once MERGE_HEAD exists", () => {
  const remoteDir = makeSeededRemote();
  const work = cloneRepo(remoteDir);
  assert.equal(isRebaseOrMergeInProgress(work), false);

  const gitDir = git(work, ["rev-parse", "--git-dir"]).trim();
  fs.writeFileSync(path.join(work, gitDir, "MERGE_HEAD"), "deadbeef\n", "utf8");
  assert.equal(isRebaseOrMergeInProgress(work), true);
});

test("SKIPs a repo mid-merge instead of touching it", () => {
  const remoteDir = makeSeededRemote();
  const work = cloneRepo(remoteDir);
  const gitDir = git(work, ["rev-parse", "--git-dir"]).trim();
  fs.writeFileSync(path.join(work, gitDir, "MERGE_HEAD"), "deadbeef\n", "utf8");

  const line = runCommitForRepo(work, "midmerge-repo", {});
  assert.equal(line, "SKIP midmerge-repo  处于 rebase/merge 中");
});

// --- pure helpers ----------------------------------------------------------------

test("filesAllUnderBoard", () => {
  assert.equal(filesAllUnderBoard(["board/tasks/a.md", "board/archive/b.md"]), true);
  assert.equal(filesAllUnderBoard(["board/tasks/a.md", "README.md"]), false);
  assert.equal(filesAllUnderBoard([]), false);
});

test("parseStatusPaths and hasNonBoardDirty", () => {
  const out = " M board/tasks/a.md\n?? README.md\n";
  const paths = parseStatusPaths(out);
  assert.deepEqual(paths, ["board/tasks/a.md", "README.md"]);
  assert.equal(hasNonBoardDirty(paths), true);
  assert.equal(hasNonBoardDirty(["board/tasks/a.md"]), false);
});
