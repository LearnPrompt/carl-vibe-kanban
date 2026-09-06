// Wraps `gh pr list` for board sync. All I/O is isolated in `listPRs`; the
// selection/merge rules are pure functions for unit testing.
import { execFileSync } from "node:child_process";

const PR_FIELDS = "number,title,state,isDraft,headRefName,mergedAt,updatedAt,url";

// Returns array of PR objects on success, or null on any failure (gh not
// installed, not authenticated, network error, etc). Callers must keep the
// previous stored PR fields and print a warning when this returns null.
export function listPRs(cwd) {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "200", "--json", PR_FIELDS],
      { cwd, encoding: "utf8" }
    );
    return JSON.parse(out);
  } catch (err) {
    return null;
  }
}

// Given the full PR list and a branch name, pick the PR to associate with
// that branch's card. Multiple PRs sharing a headRefName (re-opened PRs,
// stacked branches) resolve to: OPEN first, else highest PR number.
export function pickPrForBranch(prList, branchName) {
  if (!Array.isArray(prList)) return null;
  const matches = prList.filter((pr) => pr.headRefName === branchName);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const open = matches.filter((pr) => pr.state === "OPEN");
  if (open.length > 0) {
    return open.reduce((a, b) => (b.number > a.number ? b : a));
  }
  return matches.reduce((a, b) => (b.number > a.number ? b : a));
}

// Maps a raw gh PR object to board pr fields, applying rule A:
// pr_state starts as gh `state`; only OPEN + isDraft downgrades to DRAFT.
export function mapPrToFields(pr) {
  if (!pr) return { pr: null, pr_state: null, pr_url: null };
  let prState = pr.state;
  if (pr.state === "OPEN" && pr.isDraft) {
    prState = "DRAFT";
  }
  return { pr: pr.number, pr_state: prState, pr_url: pr.url };
}
