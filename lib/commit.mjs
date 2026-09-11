// `board commit` — commits already-`board sync`-refreshed cards into the
// repo's own default branch, touching ONLY board/ paths in the shared main
// worktree (which routinely has other sessions' unrelated staged/unstaged
// changes sitting in it — this must never stash, never touch anything
// outside board/tasks, board/archive, board/board.config.json).
import fs from "node:fs";
import path from "node:path";
import * as git from "./git.mjs";

export const BOARD_COMMIT_PATHS = ["board/tasks", "board/archive", "board/board.config.json"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Pure: local-time "YYYY-MM-DD HH:mm" (matches goodcaseai's Vercel Ignored
// Build Step convention: commit message prefix `chore(board):` skips builds,
// the timestamp itself isn't machine-read by anything).
export function formatCommitTimestamp(date = new Date()) {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

export function buildCommitMessage(date = new Date()) {
  return `chore(board): 卡片刷新 ${formatCommitTimestamp(date)}`;
}

// Pure: true when every path in `files` lies under board/ (used to decide
// whether a diverged local branch is safe to auto-rebase — board-commit
// spec step 2's "领先的提交全部只改 board/ 路径").
export function filesAllUnderBoard(files) {
  return files.length > 0 && files.every((f) => f === "board" || f.startsWith("board/"));
}

// Pure: parses `git status --porcelain` lines into working-tree paths.
// Handles the plain "XY path" form and the rename "XY old -> new" form
// (status codes are always exactly 2 chars + 1 space per git's porcelain
// format, so path always starts at column 3).
export function parseStatusPaths(output) {
  if (!output) return [];
  return output
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const rest = l.slice(3);
      const arrowIdx = rest.indexOf(" -> ");
      return arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4);
    });
}

// Pure: true when at least one dirty path lies OUTSIDE board/ — the signal
// that blocks an automatic rebase during a diverged `board commit` (board
// must never silently rebase over another session's unrelated WIP).
export function hasNonBoardDirty(paths) {
  return paths.some((p) => p !== "board" && !p.startsWith("board/"));
}

// Attempts to catch a diverged local branch up with `remoteRef`, but ONLY
// when it's provably safe: every locally-ahead commit touches board/ paths
// only, AND nothing outside board/ is currently dirty. Returns {ok, reason}
// — on failure the caller SKIPs the repo rather than guessing further; on a
// rebase that itself fails (conflict), the rebase is aborted so the shared
// main worktree is never left mid-rebase for other sessions to trip over.
export function trySyncDiverged(boardRoot, remoteRef) {
  const changed = git.getChangedFiles(boardRoot, remoteRef, "HEAD");
  if (!filesAllUnderBoard(changed)) {
    return { ok: false, reason: "分叉且领先提交改了 board/ 之外的路径，需人工处理" };
  }
  const dirtyPaths = parseStatusPaths(git.getStatusPorcelainExcludeUntracked(boardRoot));
  if (hasNonBoardDirty(dirtyPaths)) {
    return { ok: false, reason: "分叉且工作区有 board/ 之外的未提交改动，需人工处理" };
  }
  const rebaseRes = git.rebaseOnto(boardRoot, remoteRef);
  if (!rebaseRes.ok) {
    git.abortRebase(boardRoot);
    return { ok: false, reason: `git rebase 失败已自动回滚: ${rebaseRes.error}` };
  }
  return { ok: true };
}

// Runs the full board-commit flow for ONE repo's main worktree. Never
// throws — every failure path returns a printable line instead (this is a
// scheduled/unattended command; a single repo's git hiccup must not stop the
// rest of `--all`, and per spec a push rejection after a successful local
// commit must still exit 0).
export function runCommitForRepo(boardRoot, repoLabel, { push = false, dryRun = false } = {}) {
  const tracked = git.lsFilesTracked(boardRoot, "board/");
  if (tracked.length === 0) {
    return `SKIP ${repoLabel}  卡片未入库`;
  }

  if (git.isRebaseOrMergeInProgress(boardRoot)) {
    return `SKIP ${repoLabel}  处于 rebase/merge 中`;
  }

  const base = git.detectDefaultBranch(boardRoot, "main");
  const currentBranch = git.getCurrentBranch(boardRoot);
  if (currentBranch !== base) {
    return `SKIP ${repoLabel}  主工作树当前分支不是主干（${currentBranch || "(detached)"} != ${base}）`;
  }

  const fetchRes = git.fetchBranch(boardRoot, base);
  if (!fetchRes.ok) {
    return `SKIP ${repoLabel}  git fetch origin ${base} 失败: ${fetchRes.error}`;
  }

  const remoteRef = `refs/remotes/origin/${base}`;
  const syncOutcome = syncWithRemote(boardRoot, remoteRef);
  if (!syncOutcome.ok) {
    return `SKIP ${repoLabel}  ${syncOutcome.reason}`;
  }

  if (dryRun) {
    const n = git.getStatusForPaths(boardRoot, BOARD_COMMIT_PATHS).length;
    return `${repoLabel}: 将提交 ${n} 个文件 -> ${base}`;
  }

  const existingPaths = BOARD_COMMIT_PATHS.filter((p) => fs.existsSync(path.join(boardRoot, p)));
  if (existingPaths.length === 0) {
    return `${repoLabel}: no changes`;
  }
  const addRes = git.addPaths(boardRoot, existingPaths);
  if (!addRes.ok) {
    return `SKIP ${repoLabel}  git add 失败: ${addRes.error}`;
  }
  const staged = git.getStagedNameOnly(boardRoot, "board/");
  if (staged.length === 0) {
    return `${repoLabel}: no changes`;
  }

  const commitRes = git.commitPaths(boardRoot, buildCommitMessage(), ["board/"]);
  if (!commitRes.ok) {
    return `SKIP ${repoLabel}  git commit 失败: ${commitRes.error}`;
  }
  const sha = git.getShortSha(boardRoot) || "?";

  let line = `${repoLabel}: committed ${staged.length} files ${sha}`;
  if (push) {
    const pushOutcome = pushWithOneRetry(boardRoot, base, remoteRef);
    line += pushOutcome.ok ? " pushed" : ` (push 未成功，本地提交已保留: ${pushOutcome.reason})`;
  }
  return line;
}

// behind>0 && ahead===0 -> fast-forward; behind>0 && ahead>0 -> diverged,
// only rebase when provably board-only; behind===0 -> nothing to do (may
// already be ahead, which is fine — that's what gets pushed later).
function syncWithRemote(boardRoot, remoteRef) {
  const { ahead, behind } = git.getAheadBehind(boardRoot, "HEAD", remoteRef);
  if (behind > 0 && ahead === 0) {
    const merge = git.mergeFfOnly(boardRoot, remoteRef);
    if (!merge.ok) return { ok: false, reason: `git merge --ff-only 失败: ${merge.error}` };
    return { ok: true };
  }
  if (behind > 0 && ahead > 0) {
    return trySyncDiverged(boardRoot, remoteRef);
  }
  return { ok: true };
}

// Push retry per board-commit spec step 5: one rejection -> fetch -> if
// still behind, apply the SAME divergence rule as syncWithRemote -> push
// again. Any further failure just reports why; never a second retry loop.
// Exported (not just used internally by runCommitForRepo) so this sequencing
// can be tested directly against a real race between two clones, without
// needing to win a timing race inside a single runCommitForRepo() call.
export function pushWithOneRetry(boardRoot, base, remoteRef) {
  const first = git.pushBranch(boardRoot, "HEAD", base);
  if (first.ok) return { ok: true };

  const fetchRes = git.fetchBranch(boardRoot, base);
  if (!fetchRes.ok) return { ok: false, reason: `push 被拒后 fetch 失败: ${fetchRes.error}` };

  const { ahead, behind } = git.getAheadBehind(boardRoot, "HEAD", remoteRef);
  if (behind > 0) {
    const sync = trySyncDiverged(boardRoot, remoteRef);
    if (!sync.ok) return { ok: false, reason: `push 被拒且无法自动同步: ${sync.reason}` };
  } else if (ahead === 0) {
    // Nothing local to push anymore (someone else already pushed the exact
    // same content) — treat as success, nothing left to do.
    return { ok: true };
  }

  const second = git.pushBranch(boardRoot, "HEAD", base);
  if (!second.ok) return { ok: false, reason: `重试后仍失败: ${second.error}` };
  return { ok: true };
}
