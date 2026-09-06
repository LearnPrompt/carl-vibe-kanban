// Pure derivation rules: given manual fields + git/gh facts, compute status
// and flags. No I/O here at all so this is fully unit-testable with fixtures.

export const STATUSES = ["backlog", "doing", "review", "blocked", "done", "dropped"];

// facts: {
//   hasBranch: bool,             // manual.branch != null
//   branchLocation: 'local'|'origin'|null,
//   prState: 'OPEN'|'DRAFT'|'CLOSED'|'MERGED'|null,   // already downgraded (see gh.mapPrToFields)
//   mergedIntoBase: bool,
//   hasWorktree: bool,
// }
// manual: { pinned: bool, pinnedStatus: string, priorStatus: string }
export function deriveStatus(manual, facts) {
  if (manual.pinned) {
    return manual.pinnedStatus;
  }
  if (facts.prState === "MERGED") return "done";
  if (facts.prState === "CLOSED") return "dropped";
  if (facts.prState === "OPEN") return "review";
  if (facts.prState === "DRAFT") return "doing";
  if (!facts.hasBranch) {
    // detached-worktree card, keyed by worktree path
    return "doing";
  }
  if (facts.branchLocation === null) {
    // branch missing locally and on origin: leave status untouched
    return manual.priorStatus;
  }
  if (facts.mergedIntoBase) return "done";
  if (facts.hasWorktree) return "doing";
  return "backlog";
}

// flagsInput: {
//   hasBranch, branchLocation, worktreePrunable (bool), prState, status,
//   lastCommitAt (ISO string|null), now (Date), staleDays (number),
//   nextStep (string),
// }
export function deriveFlags(input) {
  const flags = [];

  if (input.hasBranch && input.branchLocation === null) {
    flags.push("branch_missing");
  }

  if (input.worktreePrunable) {
    flags.push("prunable");
  }

  if (input.prState === "CLOSED") {
    flags.push("pr_closed_unmerged");
  }

  if (input.lastCommitAt) {
    const ageMs = input.now.getTime() - new Date(input.lastCommitAt).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays > input.staleDays && (input.status === "doing" || input.status === "review")) {
      flags.push("stale_7d");
    }
  }

  if ((!input.nextStep || input.nextStep.trim() === "") && input.status !== "done" && input.status !== "dropped") {
    flags.push("no_next_step");
  }

  // board-spec-v0.1: stage-based flags. `stage`/`hasConflicts` are optional so
  // existing callers (and existing fixtures) that don't pass them are unaffected.
  if (input.stage === "unpushed" || input.stage === "dirty") {
    flags.push("unpushed");
  }
  if (input.hasConflicts) {
    flags.push("conflict");
  }

  return Array.from(new Set(flags)).sort();
}

export function deriveWorktreeState(worktree) {
  if (!worktree) return null;
  if (worktree.prunable) return "prunable";
  if (worktree.detached) return "detached";
  return "ok";
}

// --- board-spec-v0.1: branch "stage" (dirty|unpushed|pushed|pr_open|merged|closed|missing) ---

export const STAGES = ["dirty", "unpushed", "pushed", "pr_open", "merged", "closed", "missing"];

// facts: {
//   prState: 'OPEN'|'DRAFT'|'CLOSED'|'MERGED'|null,  // already downgraded, see gh.mapPrToFields
//   hasLocalBranch: bool,
//   hasOriginBranch: bool,
//   dirtyFiles: number,       // worktree uncommitted file count; 0 when no worktree
//   unpushedCommits: number,  // commits in local not in origin (or ahead-of-base proxy when no origin)
// }
// Rules apply in order, first hit wins (board-spec-v0.1 §新增派生字段).
export function deriveStage(facts) {
  // 未提交改动优先于一切：PR 合了但 worktree 还有脏文件，对话照样不能关
  if ((facts.dirtyFiles || 0) > 0) return "dirty";
  if (facts.prState === "MERGED") return "merged";
  if (facts.prState === "CLOSED") return "closed";
  if (!facts.hasLocalBranch && !facts.hasOriginBranch) return "missing";
  if (facts.hasLocalBranch && (!facts.hasOriginBranch || (facts.unpushedCommits || 0) > 0)) return "unpushed";
  if (facts.prState === "OPEN" || facts.prState === "DRAFT") return "pr_open";
  return "pushed";
}

// --- board-spec-v0.1: pairwise conflict detection between active branches ---

// entries: array of { branch: string, files: string[] }. Caller pre-filters to
// branches whose stage is NOT in {merged, closed, missing} (spec rule).
// Returns { [branch]: string[] } — "other (N files)" entries, sorted + deduped
// so the result is stable/idempotent across repeated runs.
export function deriveConflicts(entries) {
  const result = {};
  for (const e of entries) result[e.branch] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const setA = new Set(a.files || []);
      const shared = (b.files || []).filter((f) => setA.has(f));
      if (shared.length > 0) {
        result[a.branch].push(`${b.branch} (${shared.length} files)`);
        result[b.branch].push(`${a.branch} (${shared.length} files)`);
      }
    }
  }
  for (const key of Object.keys(result)) {
    result[key] = Array.from(new Set(result[key])).sort();
  }
  return result;
}
