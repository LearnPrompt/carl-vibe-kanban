// Thin wrappers around `git` plumbing commands used by the board. All
// functions that shell out take `cwd` explicitly. Pure parsing helpers
// (exported separately) take raw command output so they can be unit tested
// without a real git repo.
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function run(cwd, args) {
  try {
    // stderr 丢掉：origin 没有同名分支这类失败是预期内的探测，不该刷屏
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (err) {
    return null;
  }
}

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function getGitCommonDir(cwd) {
  const out = run(cwd, ["rev-parse", "--git-common-dir"]);
  if (!out) return null;
  return path.resolve(cwd, out);
}

// True when `cwd` exists and is inside a git working tree (any worktree, not
// just the main one). Used by workspace mode to SKIP a configured repo path
// that's missing or not a git repo, instead of throwing (board-spec-v0.2 §模式判定).
export function isGitRepo(cwd) {
  return run(cwd, ["rev-parse", "--git-dir"]) !== null;
}

// Pure: given a raw `--git-common-dir` value (already resolved to an absolute
// path, see getGitCommonDir), derives the main worktree root — the common
// case is "<mainRoot>/.git" (any worktree, linked or main, shares this),
// bare repos report the common dir itself. Split out from getMainWorktreeRoot
// so board-spec-v0.4's hook writer can store the raw common-dir string (cheap,
// no extra shelling) and reverse it into a comparable root later, at read
// time, against workspace.repos (board-spec-v0.4 §A1 事件聚合).
export function resolveMainWorktreeRootFromCommonDir(commonDir) {
  if (!commonDir) return null;
  if (path.basename(commonDir) === ".git") {
    return path.dirname(commonDir);
  }
  return commonDir;
}

export function getMainWorktreeRoot(cwd) {
  return resolveMainWorktreeRootFromCommonDir(getGitCommonDir(cwd));
}

// `git rev-parse --show-toplevel` — the root of whichever worktree `cwd` is
// actually inside (a linked worktree's own path, not the main worktree).
export function getShowToplevel(cwd) {
  return run(cwd, ["rev-parse", "--show-toplevel"]);
}

// Current branch name, or null for detached HEAD (or a non-repo cwd).
export function getCurrentBranch(cwd) {
  const out = run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!out || out === "HEAD") return null;
  return out;
}

// Best-effort fs.realpathSync: falls back to path.resolve on any error (e.g.
// path doesn't exist yet, permission denied) rather than throwing — used by
// callers that need a canonical path for comparison, never for I/O.
export function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// --- worktree porcelain parsing -------------------------------------------

// Parses the output of `git worktree list --porcelain`.
// Returns an array of { path, head, branch, detached, locked, prunable }.
// `branch` is null for detached worktrees. `locked`/`prunable` are booleans
// (reason strings, if present, are ignored for our purposes).
export function parseWorktreePorcelain(output) {
  if (!output || !output.trim()) return [];
  const blocks = output.trim().split(/\n\n+/);
  return blocks.map((block) => {
    const entry = {
      path: null,
      head: null,
      branch: null,
      detached: false,
      locked: false,
      prunable: false,
      bare: false,
    };
    for (const line of block.split("\n")) {
      if (line === "") continue;
      const spaceIdx = line.indexOf(" ");
      const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
      const value = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
      switch (key) {
        case "worktree":
          entry.path = value;
          break;
        case "HEAD":
          entry.head = value;
          break;
        case "branch":
          entry.branch = value.replace(/^refs\/heads\//, "");
          break;
        case "detached":
          entry.detached = true;
          break;
        case "locked":
          entry.locked = true;
          break;
        case "prunable":
          entry.prunable = true;
          break;
        case "bare":
          entry.bare = true;
          break;
        default:
          break;
      }
    }
    return entry;
  });
}

export function listWorktrees(cwd) {
  const out = run(cwd, ["worktree", "list", "--porcelain"]);
  if (out === null) return [];
  return parseWorktreePorcelain(out);
}

// --- branch ref resolution --------------------------------------------------

export function parseForEachRef(output) {
  if (!output || !output.trim()) return [];
  return output
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function listLocalBranches(cwd) {
  const out = run(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]);
  return parseForEachRef(out || "");
}

export function listRemoteBranches(cwd) {
  const out = run(cwd, ["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)"]);
  return parseForEachRef(out || "").map((name) => name.replace(/^origin\//, ""));
}

// Given branch name and pre-fetched local/remote branch name lists, resolve
// which ref (if any) exists and where. Pure function for testability.
export function resolveBranchLocation(branchName, localBranches, remoteBranches) {
  if (localBranches.includes(branchName)) return "local";
  if (remoteBranches.includes(branchName)) return "origin";
  return null;
}

export function branchRefFor(branchName, location) {
  if (location === "local") return `refs/heads/${branchName}`;
  if (location === "origin") return `refs/remotes/origin/${branchName}`;
  return null;
}

// --- commit facts ------------------------------------------------------------

export function parseLastCommitLine(line) {
  if (!line) return null;
  const parts = line.split("\x1f");
  if (parts.length < 3) return null;
  const [sha, date, ...msgParts] = parts;
  return { sha, date, msg: msgParts.join("\x1f") };
}

export function getLastCommit(cwd, ref) {
  const out = run(cwd, ["log", "-1", "--format=%H\x1f%cI\x1f%s", ref]);
  if (!out) return null;
  return parseLastCommitLine(out);
}

export function parseAheadBehind(output) {
  if (!output) return { behind: null, ahead: null };
  const [behind, ahead] = output.trim().split(/\s+/).map((n) => parseInt(n, 10));
  return {
    behind: Number.isFinite(behind) ? behind : null,
    ahead: Number.isFinite(ahead) ? ahead : null,
  };
}

// ahead/behind of `ref` relative to `baseRef` (baseRef...ref)
export function getAheadBehind(cwd, ref, baseRef) {
  const out = run(cwd, ["rev-list", "--left-right", "--count", `${baseRef}...${ref}`]);
  return parseAheadBehind(out);
}

export function parseMergedBranchList(output) {
  if (!output || !output.trim()) return [];
  return output
    .trim()
    .split("\n")
    .map((l) => l.trim().replace(/^\*\s*/, ""))
    .filter(Boolean);
}

// Is `branchName` merged into `baseRef`? Checks both local and remote-tracking
// merged lists since a board card's branch may only exist on origin.
export function isBranchMergedIntoBase(cwd, branchName, baseRef, location) {
  if (location === "local") {
    const out = run(cwd, ["branch", "--merged", baseRef, "--format=%(refname:short)"]);
    return parseMergedBranchList(out || "").includes(branchName);
  }
  if (location === "origin") {
    const out = run(cwd, ["branch", "-r", "--merged", baseRef, "--format=%(refname:short)"]);
    return parseMergedBranchList(out || "").includes(`origin/${branchName}`);
  }
  return false;
}

export function branchExistsLocally(cwd, branchName) {
  return listLocalBranches(cwd).includes(branchName);
}

export function createBranch(cwd, branchName, baseName) {
  execFileSync("git", ["branch", branchName, baseName], { cwd, encoding: "utf8" });
}

export function addWorktree(cwd, worktreePath, branchName) {
  execFileSync("git", ["worktree", "add", worktreePath, branchName], {
    cwd,
    encoding: "utf8",
  });
}

export function fetchOrigin(cwd) {
  try {
    execFileSync("git", ["fetch", "origin"], { cwd, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

// --- board-spec-v0.1: worktree dirtiness, unpushed commits, conflict file sets ---

// Pure: counts non-empty lines in `git status --porcelain` output.
export function parseStatusPorcelainCount(output) {
  if (!output) return 0;
  return output.split("\n").filter((l) => l.trim() !== "").length;
}

// Number of uncommitted files in a worktree. 0 when there's no worktree.
export function getWorktreeDirtyFileCount(worktreePath) {
  if (!worktreePath) return 0;
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf8" });
    return parseStatusPorcelainCount(out);
  } catch {
    return 0;
  }
}

// Commits on `branchName` not present on `origin/<branchName>`. Returns null
// when that comparison isn't possible (e.g. no origin ref) so callers can
// fall back to another proxy (see deriveStage / runSync).
export function getUnpushedCommitCount(cwd, branchName) {
  const out = run(cwd, ["rev-list", "--count", `origin/${branchName}..${branchName}`]);
  if (out === null) return null;
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// File paths changed on `targetRef` since it diverged from `baseRef`
// (`git diff --name-only $(git merge-base base target) target`). Used for
// pairwise conflict detection between active branches.
export function getChangedFiles(cwd, baseRef, targetRef) {
  const mergeBase = run(cwd, ["merge-base", baseRef, targetRef]);
  if (!mergeBase) return [];
  const out = run(cwd, ["diff", "--name-only", mergeBase, targetRef]);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// --- board-spec-v0.1: origin remote -> {owner, repo}, for session repo-scoping ---

export function getOriginUrl(cwd) {
  return run(cwd, ["remote", "get-url", "origin"]);
}

// Parses `https://github.com/OWNER/REPO(.git)` and `git@github.com:OWNER/REPO(.git)`.
export function parseGithubRemote(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// 主干分支自动识别：仓库不一定叫 main（aimap / ai-news-radar 是 master）。
// 顺序：配置里写的且真实存在 → origin/HEAD 指向的 → main → master。
export function refExists(cwd, ref) {
  return run(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== null;
}

// --- board-spec-v0.4 §A2: done 清理 -----------------------------------------
//
// Thin I/O wrappers, deliberately not covered by unit tests (same pattern as
// addWorktree/createBranch/fetchOrigin above — nothing pure to extract, and
// this repo's test suite never shells out to a real git repo). Callers
// (bin/board.mjs `cleanup`/`done`) treat git's own refusal (dirty worktree,
// unmerged branch) as the source of truth; the `{force}` option maps to
// `--force` / `-D` respectively.

export function removeWorktree(cwd, worktreePath, { force = false } = {}) {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  try {
    execFileSync("git", args, { cwd, encoding: "utf8" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function deleteBranch(cwd, branchName, { force = false } = {}) {
  const args = ["branch", force ? "-D" : "-d", branchName];
  try {
    execFileSync("git", args, { cwd, encoding: "utf8" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function pruneWorktrees(cwd) {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, encoding: "utf8" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

// --- board-commit: sync + commit-only-board-paths primitives ----------------
//
// Thin I/O wrappers in the same style as removeWorktree/deleteBranch above
// (never throw — return {ok, error} so `lib/commit.mjs` can print git's own
// reason and move on to the next repo instead of crashing the whole `board
// commit --all` run).

// `git rev-parse --git-dir` — the WORKTREE-specific git dir (as opposed to
// getGitCommonDir's --git-common-dir), needed because rebase-merge/rebase-apply/
// MERGE_HEAD state lives per-worktree, not in the shared common dir.
export function getGitDir(cwd) {
  const out = run(cwd, ["rev-parse", "--git-dir"]);
  if (!out) return null;
  return path.resolve(cwd, out);
}

// True when `cwd`'s worktree is mid-rebase or mid-merge — board commit must
// never touch a repo in this state (board-commit spec step 1).
export function isRebaseOrMergeInProgress(cwd) {
  const gitDir = getGitDir(cwd);
  if (!gitDir) return false;
  return (
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply")) ||
    fs.existsSync(path.join(gitDir, "MERGE_HEAD"))
  );
}

// `git ls-files -- <pathspec>` — used to decide whether board/ is tracked at
// all in this repo (an empty result means the repo owner never committed
// board/, and `board commit` must skip it rather than deciding for them).
export function lsFilesTracked(cwd, pathspec) {
  const out = run(cwd, ["ls-files", "--", pathspec]);
  if (!out) return [];
  return out.split("\n").filter(Boolean);
}

export function fetchBranch(cwd, branch) {
  try {
    execFileSync("git", ["fetch", "origin", branch], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function mergeFfOnly(cwd, ref) {
  try {
    execFileSync("git", ["merge", "--ff-only", ref], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function rebaseOnto(cwd, ref) {
  try {
    execFileSync("git", ["rebase", ref], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function abortRebase(cwd) {
  try {
    execFileSync("git", ["rebase", "--abort"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

// Stages ONLY the given pathspecs (`git add -A -- <paths>`) — callers must
// pre-filter to paths that exist on disk, since `git add` (unlike `git
// status`) hard-fails on a pathspec that never matched anything.
export function addPaths(cwd, paths) {
  if (!paths || paths.length === 0) return { ok: true };
  try {
    execFileSync("git", ["add", "-A", "--", ...paths], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function getStagedNameOnly(cwd, pathspec) {
  const out = run(cwd, ["diff", "--cached", "--name-only", "--", pathspec]);
  if (!out) return [];
  return out.split("\n").filter(Boolean);
}

// `git status --porcelain -- <pathspecs>` — pathspecs that don't currently
// match anything are silently ignored (unlike `git add`), so callers can
// pass the full BOARD_COMMIT_PATHS list unfiltered.
export function getStatusForPaths(cwd, paths) {
  const out = run(cwd, ["status", "--porcelain", "--", ...paths]);
  return out ? out.split("\n").filter((l) => l.trim() !== "") : [];
}

// `git status --porcelain --untracked-files=no` over the WHOLE repo — used
// to detect dirty files outside board/ before an automatic rebase.
export function getStatusPorcelainExcludeUntracked(cwd) {
  const out = run(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return out || "";
}

// Commits ONLY the given pathspecs' current content, staged or not — other
// staged files (e.g. from another session's in-progress work in the same
// main worktree) are left exactly as staged, untouched (verified against
// real git: `git commit -m msg -- board/` with README.md also staged leaves
// README.md staged after the commit).
export function commitPaths(cwd, message, pathspecs) {
  try {
    execFileSync("git", ["commit", "-m", message, "--", ...pathspecs], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function getShortSha(cwd) {
  return run(cwd, ["rev-parse", "--short", "HEAD"]);
}

export function pushBranch(cwd, localRef, remoteBranch) {
  try {
    execFileSync("git", ["push", "origin", `${localRef}:${remoteBranch}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || "").toString().trim() };
  }
}

export function detectDefaultBranch(cwd, preferred) {
  if (preferred && refExists(cwd, `refs/heads/${preferred}`)) return preferred;
  const head = run(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) {
    const name = head.trim().replace(/^origin\//, "");
    if (name && refExists(cwd, `refs/heads/${name}`)) return name;
  }
  for (const cand of ["main", "master"]) {
    if (refExists(cwd, `refs/heads/${cand}`)) return cand;
  }
  return preferred || "main";
}
