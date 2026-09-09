#!/usr/bin/env node
// board — agent-agnostic markdown task board CLI. Zero npm dependencies.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";

import * as git from "../lib/git.mjs";
import * as gh from "../lib/gh.mjs";
import { deriveStatus, deriveFlags, deriveWorktreeState, deriveStage, deriveConflicts } from "../lib/derive.mjs";
import * as store from "../lib/store.mjs";
import { renderBoardHtml } from "../lib/render.mjs";
import * as sessionsLib from "../lib/sessions.mjs";
import * as hooksLib from "../lib/hooks.mjs";
import * as mcpLib from "../lib/mcp.mjs";
import * as importVkLib from "../lib/import-vibe-kanban.mjs";

const DEFAULT_CONFIG = {
  base: "main",
  worktreeRoot: "~/agent-workbench/worktrees",
  copy: [".env.local"],
  link: [],
  discover: ["worktrees", "prs"],
  staleDays: 7,
  archiveDays: 14,
  agents: { claude: "claude", codex: "codex" },
};

function nowIso() {
  return new Date().toISOString();
}

function resolveBoardRoot() {
  if (process.env.BOARD_HOME) {
    return path.resolve(git.expandHome(process.env.BOARD_HOME));
  }
  const root = git.getMainWorktreeRoot(process.cwd());
  if (!root) {
    throw new Error("无法定位 git 主工作树，且未设置 BOARD_HOME");
  }
  return root;
}

// The "real" main worktree, used only to exclude it from auto-discovery.
// Always resolved via git-common-dir, ignoring BOARD_HOME, per spec B/I.
function resolveRealMainWorktreeRoot(boardRoot) {
  return git.getMainWorktreeRoot(boardRoot) || boardRoot;
}

function loadRepoConfig(boardRoot) {
  const configPath = path.join(boardRoot, "board", "board.config.json");
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(configPath)) {
    try {
      cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
    } catch (err) {
      console.error(`WARN 读取 board.config.json 失败，使用默认配置: ${err.message}`);
    }
  }
  // base 写死 main 会在 master 仓里报 malformed object name；按实际主干修正
  cfg.base = git.detectDefaultBranch(boardRoot, cfg.base);
  return cfg;
}

// board-spec-v0.2 §模式判定: a repo with no board/board.config.json yet gets one
// auto-created on its first `sync`, seeded with DEFAULT_CONFIG. Read-only
// commands (ls, sessions ls, render) use plain loadRepoConfig() above and
// never write this file.
function loadOrInitRepoConfig(boardRoot) {
  const configPath = path.join(boardRoot, "board", "board.config.json");
  if (fs.existsSync(configPath)) return loadRepoConfig(boardRoot);
  const cfg = { ...DEFAULT_CONFIG, base: git.detectDefaultBranch(boardRoot, DEFAULT_CONFIG.base) };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return cfg;
}

// ~/.config/board/config.json is a pre-existing user-level file (previously
// only `on_done`); board-spec-v0.2 adds a `workspace` section alongside it.
// Reading/writing here always preserves whichever of the two the caller isn't
// touching (see the `repos` acceptance step: on_done must survive).
function userConfigPath() {
  return path.join(os.homedir(), ".config", "board", "config.json");
}

function loadUserConfig() {
  const p = userConfigPath();
  if (!fs.existsSync(p)) return { on_done: "", workspace: null };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return { on_done: raw.on_done || "", workspace: raw.workspace || null };
  } catch {
    return { on_done: "", workspace: null };
  }
}

function loadUserOnDone() {
  return loadUserConfig().on_done;
}

function requireWorkspaceRepos() {
  const { workspace } = loadUserConfig();
  if (!workspace || !Array.isArray(workspace.repos) || workspace.repos.length === 0) {
    throw new Error(
      `工作区模式需要在 ${userConfigPath()} 配置 workspace.repos（见 board-spec-v0.2 §多仓工作区）`
    );
  }
  return workspace.repos;
}

// Machine-local, shared across every repo in the workspace (sessions.mjs
// caches live here now, not under any single repo's board/.cache/). Falls
// back to ~/.cache/board when workspace.cache isn't configured (or there's no
// workspace config at all yet) so single-repo mode still works standalone.
function resolveCacheDir() {
  const { workspace } = loadUserConfig();
  const dir =
    workspace && workspace.cache
      ? path.resolve(git.expandHome(workspace.cache))
      : path.join(os.homedir(), ".cache", "board");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// board-spec-v0.2 §模式判定: --all forces workspace mode; otherwise workspace
// mode is also entered automatically when not inside any git repo (and
// BOARD_HOME isn't set to one) — e.g. running from ~/agent-workbench itself.
function isWorkspaceMode(flags) {
  if (flags && flags.all) return true;
  if (process.env.BOARD_HOME) return false;
  return git.getMainWorktreeRoot(process.cwd()) === null;
}

// board-spec-v0.2 §主工作树写入说明 / repoRootOverride: a workspace.repos entry
// is used VERBATIM as repoRoot — never reduced to its main worktree via
// git-common-dir. This is what lets goodcaseai temporarily point at the
// feat/board-v0 worktree (`~/agent-workbench/worktrees/goodcase-board`)
// instead of `~/projects/goodcaseai` (which is checked out to main) without
// any repo-specific special-casing in the code.
function probeConfiguredRepo(rawPath) {
  const repoRoot = path.resolve(git.expandHome(rawPath));
  if (!fs.existsSync(repoRoot)) return { ok: false, reason: "路径不存在" };
  if (!git.isGitRepo(repoRoot)) return { ok: false, reason: "不是 git 仓库" };
  return { ok: true, repoRoot, repoLabel: resolveRepoLabel(repoRoot) };
}

// Prefers the GitHub remote's repo name (stable even when repoRoot is a
// worktree with a different directory name, e.g. the goodcaseai override
// above) and falls back to the directory basename when there's no remote.
function resolveRepoLabel(repoRoot) {
  const parsed = git.parseGithubRemote(git.getOriginUrl(repoRoot));
  return (parsed && parsed.repo) || path.basename(repoRoot);
}

// board-spec-v0.2 §CLI: iterates workspace.repos, printing `SKIP <path> 原因`
// for missing/non-git entries and calling `fn(probe)` for the rest.
function forEachWorkspaceRepo(fn) {
  const repos = requireWorkspaceRepos();
  for (const p of repos) {
    const probe = probeConfiguredRepo(p);
    if (!probe.ok) {
      console.log(`SKIP ${p}  ${probe.reason}`);
      continue;
    }
    fn(probe);
  }
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Shared git/gh facts used by both card sync and session scanning/matching
// (board-spec-v0.1). `prList` here always resolves to an array (never null)
// so session matching degrades gracefully when `gh` is unavailable.
// `repoRoot` + `repoLabel` ride along here because sessions.mjs's cwd-based
// ownership resolution (resolveCwdOwnership) needs repoRoot/worktreeEntries
// to decide whether a session's cwd belongs to this repo, and the prNumber
// fallback's PR-uniqueness path needs repoLabel to match itself up against
// gitCtx.workspacePrIndex (set separately, workspace-mode only — see
// buildRepoContexts below). `config` is accepted for parity with call sites
// that pass it, but no longer contributes anything here (aliases removed —
// title/alias matching is gone, cwd/branch are now the only signals).
function buildGitCtx(boardRoot, config) {
  const localBranches = git.listLocalBranches(boardRoot);
  const remoteBranches = git.listRemoteBranches(boardRoot);
  const worktreeEntries = git.listWorktrees(boardRoot);
  const prList = gh.listPRs(boardRoot);
  const originUrl = git.getOriginUrl(boardRoot);
  const parsedRemote = git.parseGithubRemote(originUrl) || {};
  return {
    repoRoot: path.resolve(boardRoot),
    repoLabel: parsedRemote.repo || path.basename(boardRoot),
    localBranches,
    remoteBranches,
    worktreeEntries,
    prList: prList || [],
    prListOk: prList !== null,
    repoOwner: parsedRemote.owner || null,
    repoName: parsedRemote.repo || null,
  };
}

// --- core sync ---------------------------------------------------------------

function runSync(boardRoot, config, opts = {}) {
  const { dryRun = false, discover = true, fetch = false, repoLabel } = opts;
  const effectiveRepoLabel = repoLabel || resolveRepoLabel(boardRoot);
  const { tasksDir } = store.ensureBoardDirs(boardRoot);

  if (fetch) git.fetchOrigin(boardRoot);

  const mainRootResolved = safeRealpath(resolveRealMainWorktreeRoot(boardRoot));
  const rawWorktrees = git.listWorktrees(boardRoot);
  const discoverableWorktrees = rawWorktrees.filter((w) => {
    if (!w.path || w.bare) return false;
    return safeRealpath(w.path) !== mainRootResolved;
  });

  const worktreesByBranch = new Map();
  const detachedWorktrees = [];
  for (const w of discoverableWorktrees) {
    if (w.branch) worktreesByBranch.set(w.branch, w);
    else detachedWorktrees.push(w);
  }

  const localBranches = git.listLocalBranches(boardRoot);
  const remoteBranches = git.listRemoteBranches(boardRoot);

  const prListResult = gh.listPRs(boardRoot);
  const output = [];
  if (prListResult === null) {
    output.push("WARN gh pr list 失败，PR 信息保留旧值");
  }

  const existingCardFiles = store.readAllCards(tasksDir);
  const archivedIds = new Set(store.listArchivedIds(boardRoot));

  const registry = new Map();
  for (const c of existingCardFiles) {
    registry.set(c.data.id, { data: { ...c.data }, body: c.body, isNew: false, filePath: c.filePath });
  }

  function considerNewCard(naturalKey, seedFields) {
    const id = store.computeId(naturalKey);
    if (registry.has(id)) return;
    if (archivedIds.has(id)) return;
    registry.set(id, {
      data: {
        id,
        title: seedFields.title,
        branch: seedFields.branch ?? null,
        next_step: "",
        evidence: [],
        agent: null,
        status_pinned: false,
        status: "backlog",
        created: nowIso(),
        keys: [naturalKey],
      },
      body: "",
      isNew: true,
    });
  }

  const discoverList = discover ? config.discover || [] : [];

  if (discoverList.includes("worktrees")) {
    for (const wt of discoverableWorktrees) {
      if (wt.branch) {
        const pr = prListResult ? gh.pickPrForBranch(prListResult, wt.branch) : null;
        considerNewCard(wt.branch, { title: pr ? pr.title : wt.branch, branch: wt.branch });
      } else {
        considerNewCard(wt.path, { title: `detached: ${path.basename(wt.path)}`, branch: null });
      }
    }
  }

  if (discoverList.includes("prs") && prListResult) {
    // 只给还开着的 PR 自动建卡；已合并/已关的历史 PR 不进板，免得把几十条旧账灌成噪音
    for (const pr of prListResult) {
      if (pr.state !== "OPEN") continue;
      considerNewCard(pr.headRefName, { title: pr.title, branch: pr.headRefName });
    }
  }

  const now = new Date();
  const nowIsoStr = now.toISOString();
  const doneTransitions = [];

  // --- pass 1: everything except conflicts_with (needs every branch's diff first) ---

  const computed = [];
  for (const [id, entry] of registry) {
    const data = entry.data;
    const hasBranch = data.branch !== null && data.branch !== undefined;

    let branchLocation = null;
    let worktreeEntry = null;
    if (hasBranch) {
      branchLocation = git.resolveBranchLocation(data.branch, localBranches, remoteBranches);
      worktreeEntry = worktreesByBranch.get(data.branch) || null;
    } else {
      const candidatePaths = [data.worktree, ...(data.keys || [])].filter(Boolean);
      worktreeEntry = detachedWorktrees.find((w) => candidatePaths.includes(w.path)) || null;
    }

    let prFields;
    if (hasBranch && prListResult) {
      prFields = gh.mapPrToFields(gh.pickPrForBranch(prListResult, data.branch));
    } else if (hasBranch) {
      prFields = { pr: data.pr ?? null, pr_state: data.pr_state ?? null, pr_url: data.pr_url ?? null };
    } else {
      prFields = { pr: null, pr_state: null, pr_url: null };
    }

    let mergedIntoBase = false;
    if (hasBranch && branchLocation) {
      mergedIntoBase = git.isBranchMergedIntoBase(boardRoot, data.branch, config.base, branchLocation);
    }

    let lastCommit = null;
    let ahead = null;
    let behind = null;
    if (hasBranch && branchLocation) {
      const ref = git.branchRefFor(data.branch, branchLocation);
      lastCommit = git.getLastCommit(boardRoot, ref);
      const ab = git.getAheadBehind(boardRoot, ref, config.base);
      ahead = ab.ahead;
      behind = ab.behind;
    } else if (!hasBranch && worktreeEntry && worktreeEntry.head) {
      lastCommit = git.getLastCommit(boardRoot, worktreeEntry.head);
    }

    const worktreeState = deriveWorktreeState(worktreeEntry);
    const pinned = data.status_pinned === true;
    const priorStatus = data.status || "backlog";

    const statusFacts = {
      hasBranch,
      branchLocation,
      prState: prFields.pr_state,
      mergedIntoBase,
      hasWorktree: !!worktreeEntry,
    };
    const status = deriveStatus({ pinned, pinnedStatus: data.status, priorStatus }, statusFacts);

    // board-spec-v0.1: stage + dirty_files + unpushed_commits.
    const hasLocalBranch = hasBranch && branchLocation === "local";
    const hasOriginBranch = hasBranch && (branchLocation === "origin" || remoteBranches.includes(data.branch));
    const dirtyFiles = worktreeEntry ? git.getWorktreeDirtyFileCount(worktreeEntry.path) : 0;
    let unpushedCommits = 0;
    if (hasLocalBranch && hasOriginBranch) {
      unpushedCommits = git.getUnpushedCommitCount(boardRoot, data.branch) ?? 0;
    } else if (hasLocalBranch) {
      unpushedCommits = ahead ?? 0;
    }
    const stage = hasBranch
      ? deriveStage({
          prState: prFields.pr_state,
          hasLocalBranch,
          hasOriginBranch,
          dirtyFiles,
          unpushedCommits,
        })
      : null;

    // Changed-file set vs base, for pairwise conflict detection (pass 2).
    // Only computed for branches that are still "active" per spec.
    let changedFiles = [];
    if (hasBranch && branchLocation && !["merged", "closed", "missing"].includes(stage)) {
      const ref = git.branchRefFor(data.branch, branchLocation);
      changedFiles = git.getChangedFiles(boardRoot, config.base, ref);
    }

    computed.push({
      id,
      entry,
      data,
      hasBranch,
      branchLocation,
      worktreeEntry,
      prFields,
      lastCommit,
      ahead,
      behind,
      worktreeState,
      pinned,
      status,
      stage,
      dirtyFiles,
      unpushedCommits,
      changedFiles,
    });
  }

  // --- conflicts_with: pairwise file-set intersection across active branches ---

  const conflictInputs = computed
    .filter((c) => c.hasBranch && !["merged", "closed", "missing"].includes(c.stage))
    .map((c) => ({ branch: c.data.branch, files: c.changedFiles }));
  const conflictsMap = deriveConflicts(conflictInputs);

  // --- pass 2: finalize fields (flags now know about stage + conflicts), diff, write ---

  for (const c of computed) {
    const { id, entry, data, hasBranch, branchLocation, worktreeEntry, prFields, lastCommit, ahead, behind, worktreeState, pinned, status, stage, dirtyFiles, unpushedCommits } = c;

    const conflictsWith = hasBranch ? conflictsMap[data.branch] || [] : [];

    const flags = deriveFlags({
      hasBranch,
      branchLocation,
      worktreePrunable: worktreeEntry ? !!worktreeEntry.prunable : false,
      prState: prFields.pr_state,
      status,
      lastCommitAt: lastCommit ? lastCommit.date : null,
      now,
      staleDays: config.staleDays ?? 7,
      nextStep: data.next_step,
      stage,
      hasConflicts: conflictsWith.length > 0,
    });

    const keys = store.unionKeys(
      data.keys,
      hasBranch ? [data.branch] : [data.worktree || (worktreeEntry ? worktreeEntry.path : null)].filter(Boolean)
    );

    const finalFields = {
      id,
      repo: effectiveRepoLabel,
      title: data.title,
      branch: hasBranch ? data.branch : null,
      worktree: worktreeEntry ? worktreeEntry.path : null,
      worktree_state: worktreeState,
      pr: prFields.pr,
      pr_state: prFields.pr_state,
      pr_url: prFields.pr_url,
      last_commit: lastCommit ? lastCommit.sha : null,
      last_commit_at: lastCommit ? lastCommit.date : null,
      last_commit_msg: lastCommit ? lastCommit.msg : null,
      ahead,
      behind,
      stage,
      dirty_files: dirtyFiles,
      unpushed_commits: unpushedCommits,
      base: config.base,
      status,
      status_pinned: pinned,
      agent: data.agent ?? null,
      evidence: data.evidence || [],
      next_step: data.next_step || "",
      created: data.created || nowIsoStr,
      updated: nowIsoStr,
      flags,
      conflicts_with: conflictsWith,
      keys,
    };

    const builtData = store.buildCardData(finalFields);

    let changed;
    if (entry.isNew) {
      changed = true;
    } else {
      const originalBuilt = store.buildCardData(entry.data);
      changed = !store.cardsEqualIgnoringUpdated(builtData, originalBuilt);
    }

    let effectiveUpdated = entry.data.updated || nowIsoStr;

    if (changed) {
      effectiveUpdated = nowIsoStr;
      if (entry.isNew) {
        output.push(`NEW ${id}  status: ${status}  (${finalFields.title})`);
      } else {
        const statusChangeStr = entry.data.status !== status ? `status: ${entry.data.status} → ${status}  ` : "";
        const oldFlags = entry.data.flags || [];
        const addedFlags = flags.filter((f) => !oldFlags.includes(f));
        const flagStr = addedFlags.length ? `+flags: ${addedFlags.join(",")}  ` : "";
        const descriptor = statusChangeStr || flagStr ? `${statusChangeStr}${flagStr}` : "updated  ";
        output.push(`${id}  ${descriptor}(${finalFields.title})`);
      }
      if (!dryRun) {
        store.writeCardFile(tasksDir, id, builtData, entry.body || "");
      }
      if (entry.data.status !== "done" && status === "done") {
        doneTransitions.push(id);
      }
    }

    // Archive check (rule N): done/dropped cards untouched for archiveDays.
    if (status === "done" || status === "dropped") {
      const ageDays = (now.getTime() - new Date(effectiveUpdated).getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays > (config.archiveDays ?? 14)) {
        output.push(`ARCHIVE ${id}  (${finalFields.title})`);
        if (!dryRun) {
          store.moveCardToArchive(boardRoot, id);
        }
      }
    }
  }

  if (!dryRun && doneTransitions.length > 0) {
    const onDone = loadUserOnDone();
    if (onDone) {
      try {
        execSync(onDone, { cwd: boardRoot, stdio: "inherit" });
      } catch (err) {
        output.push(`WARN on_done 命令执行失败: ${err.message}`);
      }
    }
  }

  const hasRealOutput = output.some((line) => !line.startsWith("WARN"));
  if (!hasRealOutput) {
    output.push("no changes");
  }

  return output;
}

// --- ls ------------------------------------------------------------------

function printCardsTable(cards, args, { withRepo }) {
  let filtered = cards;
  if (args.status) filtered = filtered.filter((c) => c.status === args.status);
  if (args.flag) filtered = filtered.filter((c) => (c.flags || []).includes(args.flag));

  if (args.json) {
    console.log(JSON.stringify(filtered));
    return;
  }

  if (filtered.length === 0) {
    console.log("(no cards)");
    return;
  }

  const rows = filtered.map((c) => ({
    ...(withRepo ? { repo: c.repo || "-" } : {}),
    id: c.id,
    status: c.status,
    stage: c.stage || "-",
    branch: c.branch || "(detached)",
    pr: c.pr ? `#${c.pr}(${c.pr_state})` : "-",
    agent: c.agent || "-",
    flags: (c.flags || []).join(",") || "-",
    conflicts: (c.conflicts_with || []).join(",") || "-",
    title: c.title,
  }));

  const cols = [
    ...(withRepo ? ["repo"] : []),
    "id",
    "status",
    "stage",
    "branch",
    "pr",
    "agent",
    "flags",
    "conflicts",
    "title",
  ];
  const widths = {};
  for (const col of cols) {
    widths[col] = Math.max(col.length, ...rows.map((r) => String(r[col]).length));
  }
  const header = cols.map((c) => c.padEnd(widths[c])).join("  ");
  console.log(header);
  console.log(cols.map((c) => "-".repeat(widths[c])).join("  "));
  for (const r of rows) {
    console.log(cols.map((c) => String(r[c]).padEnd(widths[c])).join("  "));
  }
}

function cmdLs(args) {
  if (isWorkspaceMode(args)) {
    let allCards = [];
    forEachWorkspaceRepo((probe) => {
      const tasksDir = store.tasksDirFor(probe.repoRoot);
      const cards = store.readAllCards(tasksDir).map((c) => ({ ...c.data, repo: c.data.repo || probe.repoLabel }));
      allCards = allCards.concat(cards);
    });
    printCardsTable(allCards, args, { withRepo: true });
    return;
  }
  const boardRoot = resolveBoardRoot();
  const tasksDir = store.tasksDirFor(boardRoot);
  const cards = store.readAllCards(tasksDir).map((c) => c.data);
  printCardsTable(cards, args, { withRepo: false });
}

// --- repos -----------------------------------------------------------------

function cmdRepos() {
  forEachWorkspaceRepo((probe) => {
    const configPath = path.join(probe.repoRoot, "board", "board.config.json");
    const hasConfig = fs.existsSync(configPath);
    const tasksDir = store.tasksDirFor(probe.repoRoot);
    const cardCount = fs.existsSync(tasksDir) ? store.readAllCards(tasksDir).length : 0;
    console.log(
      `${probe.repoLabel}  ${probe.repoRoot}  ${hasConfig ? "已配置" : "缺 board 配置"}  卡片 ${cardCount}`
    );
  });
}

// --- add -------------------------------------------------------------------

function cmdAdd(args) {
  if (!args.branch) {
    console.error("用法: board add --branch <b> [--title t] [--agent a]");
    process.exit(1);
  }
  const boardRoot = resolveBoardRoot();
  const config = loadOrInitRepoConfig(boardRoot);
  const { tasksDir } = store.ensureBoardDirs(boardRoot);

  const id = store.computeId(args.branch);
  const existingPath = path.join(tasksDir, `${id}.md`);
  if (fs.existsSync(existingPath)) {
    console.error(`已存在卡片 ${id}（branch=${args.branch}）`);
    process.exit(1);
  }

  const now = nowIso();
  const fields = {
    id,
    title: args.title || args.branch,
    branch: args.branch,
    next_step: "",
    evidence: [],
    agent: args.agent || null,
    status_pinned: false,
    status: "backlog",
    created: now,
    updated: now,
    flags: [],
    keys: [args.branch],
  };
  store.writeCardFile(tasksDir, id, store.buildCardData(fields), "");
  console.log(`created ${id}`);

  const lines = runSync(boardRoot, config, { discover: false, repoLabel: resolveRepoLabel(boardRoot) });
  for (const l of lines) console.log(l);
}

// --- next / evidence / pin / unpin -----------------------------------------

function loadCardOrExit(boardRoot, id) {
  const tasksDir = store.tasksDirFor(boardRoot);
  const filePath = path.join(tasksDir, `${id}.md`);
  if (!fs.existsSync(filePath)) {
    console.error(`未找到卡片 ${id}`);
    process.exit(1);
  }
  return store.readCardFile(filePath);
}

function cmdNext(id, text) {
  const boardRoot = resolveBoardRoot();
  const tasksDir = store.tasksDirFor(boardRoot);
  const card = loadCardOrExit(boardRoot, id);
  const data = { ...card.data, next_step: text, updated: nowIso() };
  store.writeCardFile(tasksDir, id, store.buildCardData(data), card.body);
  console.log(`${id} next_step 已更新`);
}

function cmdEvidence(id, text) {
  const boardRoot = resolveBoardRoot();
  const tasksDir = store.tasksDirFor(boardRoot);
  const card = loadCardOrExit(boardRoot, id);
  const evidence = [...(card.data.evidence || []), text];
  const data = { ...card.data, evidence, updated: nowIso() };
  store.writeCardFile(tasksDir, id, store.buildCardData(data), card.body);
  console.log(`${id} evidence 已追加`);
}

function cmdPin(id, status) {
  const validStatuses = ["backlog", "doing", "review", "blocked", "done", "dropped"];
  if (!validStatuses.includes(status)) {
    console.error(`非法 status: ${status}，可选: ${validStatuses.join(", ")}`);
    process.exit(1);
  }
  const boardRoot = resolveBoardRoot();
  const tasksDir = store.tasksDirFor(boardRoot);
  const card = loadCardOrExit(boardRoot, id);
  const data = { ...card.data, status, status_pinned: true, updated: nowIso() };
  store.writeCardFile(tasksDir, id, store.buildCardData(data), card.body);
  console.log(`${id} pinned -> ${status}`);
}

function cmdUnpin(id) {
  const boardRoot = resolveBoardRoot();
  const tasksDir = store.tasksDirFor(boardRoot);
  const card = loadCardOrExit(boardRoot, id);
  const data = { ...card.data, status_pinned: false, updated: nowIso() };
  store.writeCardFile(tasksDir, id, store.buildCardData(data), card.body);
  console.log(`${id} unpinned`);
}

// --- archive -----------------------------------------------------------------

function cmdArchive(id) {
  const boardRoot = resolveBoardRoot();
  const ok = store.moveCardToArchive(boardRoot, id);
  if (!ok) {
    console.error(`未找到卡片 ${id}`);
    process.exit(1);
  }
  console.log(`${id} archived`);
}

// --- hook / hooks (board-spec-v0.4 §A1) ---------------------------------------
//
// `board hook claude` / `board hook codex` are on the hot path of every
// Claude Code turn (SessionStart/Stop/UserPromptSubmit) — they must NEVER
// throw, NEVER exit non-zero, and NEVER shell out to `gh`. Every branch below
// is wrapped so a failure degrades to "recorded nothing" instead of an
// exception; nothing here calls resolveBoardRoot() (which throws outside a
// git repo) or gh.mjs.

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function cmdHookClaude() {
  try {
    const cacheDir = resolveCacheDir();
    const raw = readStdinSync();
    hooksLib.recordClaudeHookEvent(cacheDir, raw);
  } catch {
    // never let a hook invocation fail the user's Claude Code turn
  }
}

function cmdHookCodex(rawArg) {
  try {
    const cacheDir = resolveCacheDir();
    hooksLib.recordCodexHookEvent(cacheDir, rawArg);
  } catch {
    // never let a hook invocation fail
  }
}

function cmdHooksInstall(flags) {
  const dryRun = !!flags["dry-run"];
  const cacheDir = resolveCacheDir();

  console.log("== Claude Code (~/.claude/settings.json) ==");
  const claudeResult = hooksLib.installClaudeHooks(cacheDir, { dryRun });
  if (claudeResult.added.length === 0) {
    console.log(`已装好，无需改动（${claudeResult.path}）`);
  } else if (dryRun) {
    console.log(`将在以下事件追加 "${hooksLib.CLAUDE_HOOK_COMMAND}"：${claudeResult.added.join(", ")}`);
    console.log(`（${claudeResult.path}，写入前会先备份到 ${hooksLib.backupsDir(cacheDir)}）`);
  } else {
    console.log(`已在以下事件追加 "${hooksLib.CLAUDE_HOOK_COMMAND}"：${claudeResult.added.join(", ")}`);
    if (claudeResult.backupPath) console.log(`原文件已备份到 ${claudeResult.backupPath}`);
  }

  console.log("== Codex (~/.codex/config.toml) ==");
  const codexResult = hooksLib.installCodexNotify(cacheDir, { dryRun });
  switch (codexResult.action) {
    case "skip-already-installed":
      console.log(`已装好，无需改动：${codexResult.existingLine}`);
      break;
    case "manual":
      console.log(`notify 已被占用，不自动修改：`);
      console.log(`  现有: ${codexResult.existingLine}`);
      console.log(`  建议手动改成: ${codexResult.suggestedLine}`);
      break;
    case "create":
      console.log(dryRun ? `将新建 ${codexResult.path} 并写入 notify 行` : `已新建 ${codexResult.path} 并写入 notify 行`);
      break;
    case "append":
      console.log(
        dryRun
          ? `将在 ${codexResult.path} 末尾追加 notify 行（写入前会先备份到 ${hooksLib.backupsDir(cacheDir)}）`
          : `已在 ${codexResult.path} 末尾追加 notify 行${codexResult.backupPath ? `（原文件已备份到 ${codexResult.backupPath}）` : ""}`
      );
      break;
  }
}

function cmdHooksStatus() {
  const cacheDir = resolveCacheDir();
  const status = hooksLib.hooksStatus(cacheDir);
  console.log("== Claude Code ==");
  for (const evt of hooksLib.CLAUDE_HOOK_EVENTS) {
    console.log(`  ${evt}: ${status.claude[evt] ? "已装" : "未装"}`);
  }
  console.log("== Codex ==");
  console.log(`  notify: ${status.codexNotifyInstalled ? "已装" : "未装"}${status.codexNotifyLine ? `（${status.codexNotifyLine}）` : ""}`);
  console.log("== 事件日志 ==");
  console.log(`  ${eventsPathLabel(cacheDir)}`);
  console.log(`  共 ${status.eventCount} 条，最近一条: ${status.lastEventTs || "(无)"}`);
}

function eventsPathLabel(cacheDir) {
  return hooksLib.eventsPath(cacheDir);
}

// --- cleanup / done (board-spec-v0.4 §A2) -------------------------------------

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}

// Runs the full cleanup sequence for ONE already-vetted candidate card:
// worktree remove -> branch -d/-D -> worktree prune -> clear worktree fields
// + append a body line (the only tool-writable line in the human-owned body).
// Returns a printable summary line; never throws (git.mjs's I/O wrappers
// already return {ok, error} instead of throwing).
function cleanupOneCard(boardRoot, repoLabel, card, { apply, force }) {
  const dirty = card.worktree ? git.getWorktreeDirtyFileCount(card.worktree) : 0;
  let unpushed = card.branch ? git.getUnpushedCommitCount(boardRoot, card.branch) : null;
  if (unpushed === null) unpushed = card.unpushed_commits || 0;

  const label = `${card.id}  ${repoLabel}  ${card.branch || "(detached)"}  ${card.worktree}  dirty:${dirty}  unpushed:${unpushed}`;

  const blockers = [];
  if (!force) {
    if (dirty > 0) blockers.push(`${dirty} 个未提交文件`);
    if (unpushed > 0) blockers.push(`${unpushed} 个 commit 未 push`);
  }
  if (blockers.length > 0) {
    console.log(`${label}  ${red("BLOCKED: " + blockers.join("; "))}`);
    return { ok: false };
  }

  if (!apply) {
    console.log(`${label}  (dry-run)`);
    return { ok: true, dryRun: true };
  }

  const rm = git.removeWorktree(boardRoot, card.worktree, { force });
  if (!rm.ok) {
    console.log(`${label}  ${red("FAILED worktree remove: " + rm.error)}`);
    return { ok: false };
  }

  let branchNote = "";
  if (card.branch) {
    const br = git.deleteBranch(boardRoot, card.branch, { force });
    if (!br.ok) {
      console.log(`${label}  ${red("worktree 已删，但分支删除失败: " + br.error + "（--force 可强删 -D）")}`);
      return { ok: false };
    }
    branchNote = ` 与本地分支 ${card.branch}`;
  }
  git.pruneWorktrees(boardRoot);

  const tasksDir = store.tasksDirFor(boardRoot);
  const dateStr = nowIso().slice(0, 10);
  const line = `- ${dateStr} cleanup：已删 worktree ${card.worktree}${branchNote}`;
  const cardFile = store.readCardFile(path.join(tasksDir, `${card.id}.md`));
  const newBody = store.appendBodyLine(cardFile.body, line);
  const newData = { ...cardFile.data, worktree: null, worktree_state: null, updated: nowIso() };
  store.writeCardFile(tasksDir, card.id, store.buildCardData(newData), newBody);

  console.log(`${label}  已清理`);
  return { ok: true };
}

function cleanupRepo(boardRoot, repoLabel, { apply, force }) {
  const tasksDir = store.tasksDirFor(boardRoot);
  const cards = store.readAllCards(tasksDir).map((c) => c.data);
  const candidates = cards.filter(store.isCleanupCandidate);
  for (const card of candidates) {
    cleanupOneCard(boardRoot, repoLabel, card, { apply, force });
  }
  return candidates.length;
}

function cmdCleanup(flags) {
  const apply = !!flags.apply;
  const force = !!flags.force;
  let total = 0;
  if (isWorkspaceMode(flags)) {
    forEachWorkspaceRepo((probe) => {
      total += cleanupRepo(probe.repoRoot, probe.repoLabel, { apply, force });
    });
  } else {
    const boardRoot = resolveBoardRoot();
    total = cleanupRepo(boardRoot, resolveRepoLabel(boardRoot), { apply, force });
  }
  if (total === 0) console.log("(no cleanup candidates)");
}

function cmdDone(id, flags) {
  const force = !!flags.force;

  function tryRepo(boardRoot, repoLabel) {
    const tasksDir = store.tasksDirFor(boardRoot);
    const filePath = path.join(tasksDir, `${id}.md`);
    if (!fs.existsSync(filePath)) return false;
    const card = store.readCardFile(filePath).data;
    if (!store.isCleanupCandidate(card)) {
      console.error(`卡片 ${id} 不满足清理条件（stage 需 merged/closed 或 status=dropped，且要有 branch + worktree）`);
      process.exit(1);
    }
    cleanupOneCard(boardRoot, repoLabel, card, { apply: true, force });
    return true;
  }

  if (isWorkspaceMode(flags)) {
    let found = false;
    forEachWorkspaceRepo((probe) => {
      if (!found) found = tryRepo(probe.repoRoot, probe.repoLabel);
    });
    if (!found) {
      console.error(`未找到卡片 ${id}`);
      process.exit(1);
    }
    return;
  }

  const boardRoot = resolveBoardRoot();
  if (!tryRepo(boardRoot, resolveRepoLabel(boardRoot))) {
    console.error(`未找到卡片 ${id}`);
    process.exit(1);
  }
}

// --- init ---------------------------------------------------------------------

// Scans ~/projects/* for directories that look like git repos (a `.git` file
// or dir present), for the --repos-less confirmation flow below. Never
// touches disk beyond reading directory entries.
function scanCandidateRepos() {
  const projectsDir = path.join(os.homedir(), "projects");
  if (!fs.existsSync(projectsDir)) return [];
  return fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(projectsDir, d.name))
    .filter((p) => fs.existsSync(path.join(p, ".git")))
    .sort();
}

function cmdInit(flags) {
  const p = userConfigPath();
  if (fs.existsSync(p)) {
    console.log(`已存在 ${p}，不覆盖。当前配置：`);
    console.log(fs.readFileSync(p, "utf8"));
    return;
  }

  if (!flags.repos) {
    const candidates = scanCandidateRepos();
    console.log(`未指定 --repos，尚未写入 ${p}。`);
    console.log(`~/projects 下候选仓库（${candidates.length} 个）：`);
    for (const c of candidates) console.log(`  ${c}`);
    console.log(`确认后重跑: board init --repos ${candidates.length ? candidates.map((c) => path.basename(c)).join(",") : "a,b,c"}`);
    return;
  }

  const repos = String(flags.repos)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const output = typeof flags.output === "string" ? flags.output : "~/.cache/board/index.html";
  const cache = typeof flags.cache === "string" ? flags.cache : "~/.cache/board";
  const config = { on_done: "", workspace: { repos, output, cache } };

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`已写入 ${p}`);
  console.log(JSON.stringify(config, null, 2));
}

// --- dispatch ----------------------------------------------------------------

function slugifyBranch(branch) {
  return branch
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9-]/g, "-");
}

function detectInstallCommand(boardRoot) {
  if (fs.existsSync(path.join(boardRoot, "bun.lockb")) || fs.existsSync(path.join(boardRoot, "bun.lock"))) {
    return "bun install";
  }
  return "npm install";
}

function cmdDispatch(identifier, args) {
  const boardRoot = resolveBoardRoot();
  const config = loadOrInitRepoConfig(boardRoot);
  const tasksDir = store.tasksDirFor(boardRoot);

  let branch = identifier;
  if (/^T-[0-9a-f]{6}$/.test(identifier)) {
    const filePath = path.join(tasksDir, `${identifier}.md`);
    if (!fs.existsSync(filePath)) {
      console.error(`未找到卡片 ${identifier}`);
      process.exit(1);
    }
    const card = store.readCardFile(filePath);
    if (!card.data.branch) {
      console.error(`卡片 ${identifier} 没有 branch（detached），无法 dispatch`);
      process.exit(1);
    }
    branch = card.data.branch;
  }

  const base = args.base || config.base;
  const agentName = args.agent || "claude";
  const agentCmd = (config.agents || {})[agentName] || agentName;

  const localBranches = git.listLocalBranches(boardRoot);
  const remoteBranches = git.listRemoteBranches(boardRoot);
  const location = git.resolveBranchLocation(branch, localBranches, remoteBranches);
  if (!location) {
    console.log(`分支 ${branch} 不存在，从 ${base} 创建`);
    git.createBranch(boardRoot, branch, base);
  }

  const worktreeRoot = git.expandHome(config.worktreeRoot);
  const repoName = path.basename(boardRoot);
  const slug = slugifyBranch(branch);
  const worktreePath = path.join(worktreeRoot, `${repoName}-${slug}`);

  const existingWorktrees = git.listWorktrees(boardRoot);
  const alreadyExists = existingWorktrees.some((w) => safeRealpath(w.path || "") === safeRealpath(worktreePath));

  if (alreadyExists) {
    console.log(`复用已有 worktree: ${worktreePath}`);
  } else {
    fs.mkdirSync(worktreeRoot, { recursive: true });
    git.addWorktree(boardRoot, worktreePath, branch);
    console.log(`已创建 worktree: ${worktreePath}`);
  }

  for (const file of config.copy || []) {
    const src = path.join(boardRoot, file);
    const dest = path.join(worktreePath, file);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`已拷贝 ${file}`);
    }
  }

  const installCmd = detectInstallCommand(boardRoot);
  console.log(`提示: cd ${worktreePath} && ${installCmd}`);
  console.log(`cd ${worktreePath}`);
  console.log(`${agentCmd}`);

  // Ensure a manual card stub exists / agent field set before sync fills derived fields.
  const id = store.computeId(branch);
  const filePath = path.join(tasksDir, `${id}.md`);
  if (fs.existsSync(filePath)) {
    const card = store.readCardFile(filePath);
    const data = { ...card.data, agent: args.agent || card.data.agent, updated: nowIso() };
    store.writeCardFile(tasksDir, id, store.buildCardData(data), card.body);
  } else {
    const now = nowIso();
    const fields = {
      id,
      title: branch,
      branch,
      next_step: "",
      evidence: [],
      agent: args.agent || null,
      status_pinned: false,
      status: "backlog",
      created: now,
      updated: now,
      flags: [],
      keys: [branch],
    };
    store.writeCardFile(tasksDir, id, store.buildCardData(fields), "");
  }

  if (args.run) {
    spawnSync(agentCmd, { cwd: worktreePath, stdio: "inherit" });
  }

  const lines = runSync(boardRoot, config, { discover: true, repoLabel: resolveRepoLabel(boardRoot) });
  for (const l of lines) console.log(l);
}

// --- sessions ------------------------------------------------------------------

async function cmdSessionsScan() {
  const boardRoot = resolveBoardRoot();
  const config = loadRepoConfig(boardRoot);
  const gitCtx = buildGitCtx(boardRoot, config);
  if (!gitCtx.prListOk) console.error("WARN gh pr list 失败，PR 链接匹配本轮跳过");
  const cacheDir = resolveCacheDir();
  const { totalCount, matchedCount, scannedCount } = await sessionsLib.scanSessions(cacheDir, gitCtx);
  console.log(`${totalCount} sessions, ${matchedCount} matched to branches（本轮新扫 ${scannedCount} 个文件）`);
}

// board-spec-v0.2: app session import is repo-agnostic — it always writes to
// the shared workspace cache, not any single repo's board/.
function cmdSessionsImport(filePath) {
  if (!filePath) {
    console.error("用法: board sessions import <file.json>");
    process.exit(1);
  }
  const cacheDir = resolveCacheDir();
  const count = sessionsLib.importAppSessions(cacheDir, path.resolve(filePath));
  console.log(`imported ${count} app sessions`);
}

// A repo branch a session touched may not have a board card at all — card
// discovery only carries currently-open worktrees/PRs, not every branch that
// ever existed (see board-spec-v0 §自动发现). Rather than mislabel those as
// "无线索" (which per spec means no branch was found at all), derive a
// lightweight virtual card from the same git/gh facts real cards use, so
// judgeSession can still answer "敢不敢关" for them. Bounded cost: only
// computed for the (usually small) set of touched-but-uncarded branches.
function buildVirtualCard(boardRoot, branch, gitCtx) {
  const hasLocalBranch = gitCtx.localBranches.includes(branch);
  const hasOriginBranch = gitCtx.remoteBranches.includes(branch);
  const prFields = gh.mapPrToFields(gh.pickPrForBranch(gitCtx.prList, branch));
  let unpushedCommits = 0;
  if (hasLocalBranch && hasOriginBranch) {
    unpushedCommits = git.getUnpushedCommitCount(boardRoot, branch) ?? 0;
  }
  const stage = deriveStage({ prState: prFields.pr_state, hasLocalBranch, hasOriginBranch, dirtyFiles: 0, unpushedCommits });
  return {
    branch,
    stage,
    status: stage === "merged" ? "done" : stage === "closed" ? "dropped" : "doing",
    dirty_files: 0,
    unpushed_commits: unpushedCommits,
    pr: prFields.pr,
    pr_state: prFields.pr_state,
    conflicts_with: [],
  };
}

// `cacheDir`: the shared workspace session cache (see sessions.mjs). Card data
// (cardsByBranch) is still read from this specific repo's boardRoot.
function buildSessionListing(boardRoot, cacheDir, gitCtx, { pinnedOnly = false, staleDays = 14 } = {}) {
  const tasksDir = store.tasksDirFor(boardRoot);
  const cards = store.readAllCards(tasksDir).map((c) => c.data);
  const cardsByBranch = new Map();
  for (const c of cards) {
    if (c.branch) cardsByBranch.set(c.branch, c);
  }

  let rows = sessionsLib.buildSessionRows(cacheDir, gitCtx);
  if (pinnedOnly) rows = rows.filter((r) => r.pinned);

  // Fill in virtual cards for touched branches with no real card, once each.
  const virtualCache = new Map();
  for (const r of rows) {
    for (const b of r.branches) {
      if (cardsByBranch.has(b) || virtualCache.has(b)) continue;
      virtualCache.set(b, buildVirtualCard(boardRoot, b, gitCtx));
    }
  }
  const judgeCardsByBranch = new Map([...cardsByBranch, ...virtualCache]);

  rows = rows.map((r) => ({ ...r, judge: sessionsLib.judgeSession(r.branches, judgeCardsByBranch) }));
  rows.sort((a, b) => new Date(b.lastActive || 0).getTime() - new Date(a.lastActive || 0).getTime());
  attachSuggestions(rows, cacheDir, staleDays);
  return rows;
}

// Mutates `rows` in place, adding `.suggest` (rule layer always, plus any
// still-valid cached AI verdict from a previous `judge --ai` run) — shared by
// `sessions ls`, `render`, and the combined workspace view below, so a
// suggestion computed once shows up everywhere a session row does.
function attachSuggestions(rows, cacheDir, staleDays = 14) {
  const suggestMap = sessionsLib.suggestArchive(rows, { now: Date.now(), staleDays });
  const judgeCache = sessionsLib.loadJudgeCache(cacheDir);
  sessionsLib.applyJudgeCache(rows, suggestMap, judgeCache);
  for (const r of rows) r.suggest = suggestMap.get(r.uuid) || null;
  return rows;
}

const VERDICT_LABEL = { "can-close": "可关", keep: "别关", "no-clue": "无线索" };

// A session's title (first_prompt) is raw human chat text and may contain
// literal newlines even after the 60-char slice in sessions.mjs — collapse to
// one line so each row of `sessions ls` output stays one physical line.
function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// board-spec-v0.2 §CLI: `sessions ls --json` output contract — one flat object
// per session, safe for an agent to JSON.parse().
function sessionRowToJson(r) {
  return {
    uuid: r.uuid,
    appSessionId: r.appSessionId ?? null,
    title: r.title,
    pinned: !!r.pinned,
    branches: r.branches,
    verdict: r.judge.verdict,
    reason: r.judge.reason,
    prInferred: !!r.prInferred,
    via: r.via || null,
    lastActive: r.lastActive,
    suggest: r.suggest || null,
  };
}

function printSessionRows(rows, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(rows.map(sessionRowToJson)));
    return;
  }
  if (rows.length === 0) {
    console.log("(no sessions)");
    return;
  }
  for (const r of rows) {
    const id8 = r.uuid.slice(0, 8);
    const pinnedMark = r.pinned ? "置顶" : "-";
    const branchesStr = r.branches.length ? r.branches.join(",") : "(无分支线索)";
    const verdictLabel = VERDICT_LABEL[r.judge.verdict] || r.judge.verdict;
    const reason = r.judge.reason ? ` — ${oneLine(r.judge.reason)}` : "";
    // board-spec-v0.4 §A1: a hook-recorded clue (fact, not inference) outranks
    // the "按 PR 号推断" label — never show both.
    const inferredMark = r.via === "hook" ? "  [hook]" : r.prInferred ? "  [按 PR 号推断]" : "";
    const suggestMark = r.suggest ? `  [建议:${r.suggest.kind}]` : "";
    console.log(
      `${id8}  ${pinnedMark}  ${verdictLabel}${reason}  [${branchesStr}]${inferredMark}${suggestMark}  ${oneLine(r.title)}`
    );
  }
}

// Combines the per-repo judgements for the SAME session (a conversation can
// touch branches in more than one project — board-spec-v0.2 §会话映射多仓化):
// "keep" wins if any matched repo says keep, otherwise "can-close" once every
// matched repo agrees; a session matched nowhere stays "no-clue".
function combineJudges(judges) {
  if (judges.length === 0) return { verdict: "no-clue", reason: null };
  const keep = judges.find((j) => j.verdict === "keep");
  if (keep) return keep;
  return judges[0];
}

// Merges buildSessionListing() output across every workspace repo into one
// row per session uuid, prefixing branches with their repo so the same branch
// name in two repos doesn't collide.
function buildWorkspaceSessionRows(repoContexts, cacheDir, { pinnedOnly = false, staleDays = 14 } = {}) {
  const combined = new Map();
  for (const rc of repoContexts) {
    const rows = buildSessionListing(rc.repoRoot, cacheDir, rc.gitCtx, { pinnedOnly, staleDays });
    for (const r of rows) {
      const entry = combined.get(r.uuid) || {
        uuid: r.uuid,
        appSessionId: r.appSessionId ?? null,
        title: r.title,
        pinned: false,
        lastActive: null,
        branches: [],
        judges: [],
        prInferred: false,
        via: null,
      };
      entry.pinned = entry.pinned || r.pinned;
      entry.prInferred = entry.prInferred || r.prInferred;
      entry.via = entry.via || r.via || null;
      if (r.lastActive && (!entry.lastActive || r.lastActive > entry.lastActive)) entry.lastActive = r.lastActive;
      if (r.branches.length > 0) {
        for (const b of r.branches) entry.branches.push(`${rc.repoLabel}:${b}`);
        entry.judges.push(r.judge);
      }
      combined.set(r.uuid, entry);
    }
  }
  const out = Array.from(combined.values()).map((e) => ({
    uuid: e.uuid,
    appSessionId: e.appSessionId,
    title: e.title,
    pinned: e.pinned,
    lastActive: e.lastActive,
    branches: e.branches,
    prInferred: e.prInferred,
    via: e.via,
    judge: combineJudges(e.judges),
  }));
  out.sort((a, b) => new Date(b.lastActive || 0).getTime() - new Date(a.lastActive || 0).getTime());
  // Recomputed against the COMBINED judge (not any single repo's), since the
  // same session can be "can-close" in one repo and "no-clue"/"keep" in
  // another — per-repo suggest would be wrong here. Cheap: attachSuggestions
  // was already called per repo above, but that per-repo work is superseded
  // by this pass, not reused.
  attachSuggestions(out, cacheDir, staleDays);
  return out;
}

// board-spec §prNumber 兜底路径 (iii), workspace mode only: a session's PR
// number that's unique to exactly one repo's OPEN PRs across the whole
// workspace can be trusted as an attribution signal even with no cwd or
// transcript clue (flagged `prInferred` — see mergeSessionRow). Built here,
// after every repo's gitCtx.prList is known, then shared onto every repo's
// gitCtx so mergeSessionRow can consult it per repo. Single-repo mode never
// calls this, so gitCtx.workspacePrIndex stays undefined there and path
// (iii) is simply unavailable (no fabricated single-entry index).
// 全部状态的 PR 都进索引：已合并 PR 正是判「可关」最常用的线索；
// 唯一性靠「这个号只在一个仓出现」保证，不靠 state。
function buildWorkspacePrIndex(contexts) {
  const index = new Map();
  for (const ctx of contexts) {
    for (const pr of ctx.gitCtx.prList || []) {
      if (!index.has(pr.number)) index.set(pr.number, new Set());
      index.get(pr.number).add(ctx.gitCtx.repoLabel);
    }
  }
  return index;
}

function buildRepoContexts() {
  const contexts = [];
  forEachWorkspaceRepo((probe) => {
    const config = loadRepoConfig(probe.repoRoot);
    const gitCtx = buildGitCtx(probe.repoRoot, config);
    contexts.push({ ...probe, config, gitCtx });
  });
  const workspacePrIndex = buildWorkspacePrIndex(contexts);
  for (const ctx of contexts) ctx.gitCtx.workspacePrIndex = workspacePrIndex;
  return contexts;
}

function cmdSessionsLs(flags) {
  const cacheDir = resolveCacheDir();
  const opts = { json: !!flags.json };
  if (isWorkspaceMode(flags)) {
    const repoContexts = buildRepoContexts();
    const rows = buildWorkspaceSessionRows(repoContexts, cacheDir, { pinnedOnly: !!flags.pinned });
    printSessionRows(rows, opts);
    return;
  }
  const boardRoot = resolveBoardRoot();
  const config = loadRepoConfig(boardRoot);
  const gitCtx = buildGitCtx(boardRoot, config);
  const rows = buildSessionListing(boardRoot, cacheDir, gitCtx, { pinnedOnly: !!flags.pinned });
  printSessionRows(rows, opts);
}

// --- sessions judge --------------------------------------------------------------
//
// Rule layer is always on (attachSuggestions() already ran inside
// buildSessionListing/buildWorkspaceSessionRows above — this command's own
// job is just to print it as a table, and, with --ai, ALSO ask `claude -p`
// about the rows the rule layer couldn't confidently place).

// Builds the full (unfiltered-by-pinned) row set this command judges over —
// always the whole session universe, since "which conversations can I
// archive" isn't a --pinned-scoped question the way `sessions ls` sometimes is.
function buildJudgeRows(flags, cacheDir, staleDays) {
  if (isWorkspaceMode(flags)) {
    const repoContexts = buildRepoContexts();
    return buildWorkspaceSessionRows(repoContexts, cacheDir, { pinnedOnly: false, staleDays });
  }
  const boardRoot = resolveBoardRoot();
  const config = loadRepoConfig(boardRoot);
  const gitCtx = buildGitCtx(boardRoot, config);
  return buildSessionListing(boardRoot, cacheDir, gitCtx, { pinnedOnly: false, staleDays });
}

function printSuggestTable(rows) {
  const withSuggest = rows.filter((r) => r.suggest);
  if (withSuggest.length === 0) {
    console.log("(no suggestions — 规则和 AI 都没找到可归档的对话)");
    return;
  }
  console.log(["title", "kind", "reason", "appSessionId"].join("\t"));
  for (const r of withSuggest) {
    console.log(
      [oneLine(r.title), r.suggest.kind, oneLine(r.suggest.reason), r.appSessionId || "-"].join("\t")
    );
  }
}

// claude CLI 缺失/非零退出永不抛出——降级为规则结果 + 一行 WARN，见 board-spec
// judge --ai。isError 只用于内部区分“跳过了 AI”和“正常跑完”，不对外抛异常。
function callClaudeJudge(prompt) {
  const check = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (check.error) {
    console.error("WARN 未找到 claude 命令，跳过 AI 判定，仅保留规则结果");
    return { isError: true };
  }
  const res = spawnSync("claude", ["-p", prompt, "--output-format", "json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : `exit ${res.status}: ${(res.stderr || "").trim()}`;
    console.error(`WARN claude -p 调用失败（${detail}），跳过 AI 判定，仅保留规则结果`);
    return { isError: true };
  }
  return { isError: false, stdout: res.stdout || "" };
}

async function cmdSessionsJudge(flags) {
  const cacheDir = resolveCacheDir();
  const staleDaysRaw = flags["stale-days"] ? parseInt(flags["stale-days"], 10) : NaN;
  const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : 14;

  const rows = buildJudgeRows(flags, cacheDir, staleDays);

  if (!flags.ai) {
    printSuggestTable(rows);
    return;
  }

  const judgeCache = sessionsLib.loadJudgeCache(cacheDir);
  // 规则+已有缓存已经在 buildJudgeRows -> attachSuggestions 里跑过一轮，这里
  // 重新算一遍纯规则 Map 只是为了拿到 suggestByUuid 传给 selectAiJudgeCandidates
  // 判断哪些行是 dup-title（不重复计算 judge，rows 上已经有）。
  const ruleSuggestOnly = sessionsLib.suggestArchive(rows, { now: Date.now(), staleDays });
  const candidates = sessionsLib.selectAiJudgeCandidates(rows, ruleSuggestOnly, { cap: 120 });
  const needing = sessionsLib.filterRowsNeedingAiJudge(candidates, judgeCache);

  if (flags["dry-run"]) {
    const prompt = sessionsLib.buildAiJudgePrompt(needing);
    console.log(prompt);
    console.log(`\n[dry-run] 候选 ${candidates.length} 条，其中 ${needing.length} 条命中缓存失效需要新判（未调用 claude）`);
    return;
  }

  if (needing.length === 0) {
    console.error(`AI 候选 ${candidates.length} 条全部命中缓存，无需调用 claude`);
  } else {
    const prompt = sessionsLib.buildAiJudgePrompt(needing);
    const result = callClaudeJudge(prompt);
    if (!result.isError) {
      const decisions = sessionsLib.parseAiJudgeResponse(result.stdout);
      if (decisions.length === 0) {
        console.error("WARN claude -p 输出解析不出有效判定（可能被别的文字包住了），仅保留规则结果");
      } else {
        const nextCache = sessionsLib.mergeJudgeDecisions(judgeCache, needing, decisions);
        sessionsLib.saveJudgeCache(cacheDir, nextCache);
        console.error(`AI 判完 ${decisions.length}/${needing.length} 条，已写入缓存`);
      }
    }
  }

  // Re-attach suggestions from disk so the printed table reflects whatever
  // just got persisted (freshly judged this run, or already-cached from a
  // previous run) — same code path `sessions ls`/`render` use, so the table
  // here is never out of sync with what those show next time.
  attachSuggestions(rows, cacheDir, staleDays);
  printSuggestTable(rows);
}

// --- import vibe-kanban ---------------------------------------------------------

// Candidate repos a VK project's repo path(s) can resolve against: every
// configured workspace.repos entry, plus (when board is run from inside a
// specific repo) that repo itself — so `board import vibe-kanban` works both
// in a bare single-repo checkout with no ~/.config/board/config.json at all,
// and across a whole workspace in one shot.
function buildImportCandidateRepos() {
  const candidates = [];
  const { workspace } = loadUserConfig();
  if (workspace && Array.isArray(workspace.repos)) {
    for (const p of workspace.repos) {
      const probe = probeConfiguredRepo(p);
      if (probe.ok) candidates.push({ repoRoot: probe.repoRoot, repoLabel: probe.repoLabel });
    }
  }
  try {
    const boardRoot = resolveBoardRoot();
    candidates.push({ repoRoot: boardRoot, repoLabel: resolveRepoLabel(boardRoot) });
  } catch {
    // not inside a git repo (or BOARD_HOME unset) — workspace.repos is all we have
  }
  return candidates;
}

async function cmdImportVibeKanban(sourceArg, flags) {
  const sourcePath = sourceArg ? path.resolve(git.expandHome(sourceArg)) : importVkLib.defaultDbPath();

  let repoOverride = null;
  if (flags.repo) {
    const probe = probeConfiguredRepo(flags.repo);
    if (!probe.ok) {
      console.error(`--repo ${flags.repo} 无效: ${probe.reason}`);
      process.exit(1);
    }
    repoOverride = { repoRoot: probe.repoRoot, repoLabel: probe.repoLabel };
  }

  const candidateRepos = buildImportCandidateRepos();
  const resolveRepo = (project) => importVkLib.resolveProjectRepo(project, { candidateRepos, repoOverride });

  const data = await importVkLib.loadVibeKanbanData(sourcePath);

  // Pre-resolve every distinct repo so we can read its existing cards once
  // (planImport needs that to decide new vs. updated vs. unchanged).
  const existingCardsByRepo = new Map();
  for (const project of data.projects) {
    const repo = resolveRepo(project);
    if (repo && !existingCardsByRepo.has(repo.repoRoot)) {
      existingCardsByRepo.set(repo.repoRoot, store.readAllCards(store.tasksDirFor(repo.repoRoot)));
    }
  }

  const perRepo = importVkLib.planImport(data, {
    resolveRepo,
    branchless: !!flags.branchless,
    existingCardsByRepo,
  });

  console.log(`source: ${sourcePath}`);
  for (const line of importVkLib.summarizePlan(perRepo)) console.log(line);

  const unresolved = perRepo.find((b) => b.repoRoot === null);
  if (unresolved && unresolved.entries.length > 0) {
    console.error("");
    console.error("以下 vibe-kanban project 匹配不到本地仓库（未配置 workspace.repos，也没传 --repo）：");
    for (const name of unresolved.projectNames) console.error(`  - ${name}`);
    console.error("用 --repo <path> 指定，或把对应仓库加进 ~/.config/board/config.json 的 workspace.repos");
  }

  if (!flags.apply) {
    console.log("");
    console.log("(dry-run，加 --apply 才写入；无分支的 task 默认跳过，加 --branchless 一并导入)");
    return;
  }

  if (unresolved && unresolved.entries.length > 0) {
    console.error("有未匹配到仓库的 project，先解决后再 --apply");
    process.exit(1);
  }

  for (const bucket of perRepo) {
    if (!bucket.repoRoot) continue;
    const { created, updated, unchanged } = importVkLib.applyRepoPlan(bucket.repoRoot, bucket.entries);
    const skippedBranchless = bucket.entries.filter((e) => e.outcome === "skip-no-branch").length;
    console.log(
      `${bucket.repoLabel}  created ${created}  updated ${updated}  unchanged ${unchanged}  跳过无分支 ${skippedBranchless}`
    );
  }
  console.log("建议接着跑 board sync 补全派生字段（repo/pr/stage 等）");
}

// --- render ------------------------------------------------------------------

// Builds one `projects[]` entry per the A/B interface contract (board-spec-v0.2
// §接口契约), plus `allRows` (every session row, matched or not) which is
// stripped back out before the object reaches renderBoardHtml — it's only
// needed here to compute the global noClueSessions list.
function buildProjectData(repoRoot, repoLabel, cacheDir, presetGitCtx = null) {
  const config = loadRepoConfig(repoRoot);
  const tasksDir = store.tasksDirFor(repoRoot);
  const cards = store.readAllCards(tasksDir).map((c) => c.data);
  // 工作区模式下复用带 workspacePrIndex 的 gitCtx，否则 PR 号唯一性规则在 render 里失效，
  // 顶栏置顶计数会和 sessions ls 对不上
  const gitCtx = presetGitCtx || buildGitCtx(repoRoot, config);
  const allRows = buildSessionListing(repoRoot, cacheDir, gitCtx);
  const remote = gitCtx.repoOwner && gitCtx.repoName ? `${gitCtx.repoOwner}/${gitCtx.repoName}` : null;
  return {
    repoName: repoLabel,
    remote,
    repoRoot,
    cards,
    sessions: allRows.filter((r) => r.branches.length > 0),
    allRows,
  };
}

// board-spec-v0.2 接口契约: noClueSessions is GLOBAL — an inApp session that
// matched zero branches in EVERY project, not just this one.
function computeNoClueSessions(projectsFull) {
  const matchedUuids = new Set();
  const latestByUuid = new Map();
  for (const proj of projectsFull) {
    for (const r of proj.allRows) {
      if (r.branches.length > 0) matchedUuids.add(r.uuid);
      const prev = latestByUuid.get(r.uuid);
      if (!prev || (r.lastActive && (!prev.lastActive || r.lastActive > prev.lastActive))) {
        latestByUuid.set(r.uuid, r);
      }
    }
  }
  return Array.from(latestByUuid.values()).filter((r) => r.inApp && !matchedUuids.has(r.uuid));
}

function buildSummary(projects) {
  const pinnedJudgesByUuid = new Map();
  const allUuids = new Set();
  for (const proj of projects) {
    for (const r of proj.sessions) {
      allUuids.add(r.uuid);
      if (r.pinned) {
        const arr = pinnedJudgesByUuid.get(r.uuid) || [];
        arr.push(r.judge);
        pinnedJudgesByUuid.set(r.uuid, arr);
      }
    }
  }
  let pinnedCanClose = 0;
  for (const judges of pinnedJudgesByUuid.values()) {
    if (combineJudges(judges).verdict === "can-close") pinnedCanClose++;
  }
  const cards = projects.reduce((sum, p) => sum + p.cards.length, 0);
  return {
    pinned: pinnedJudgesByUuid.size,
    pinnedCanClose,
    repos: projects.length,
    cards,
    sessions: allUuids.size,
  };
}

function cmdRender(flags) {
  const cacheDir = resolveCacheDir();
  const workspaceMode = isWorkspaceMode(flags);

  let repoEntries;
  if (workspaceMode) {
    repoEntries = buildRepoContexts();
  } else {
    const boardRoot = resolveBoardRoot();
    repoEntries = [{ repoRoot: boardRoot, repoLabel: resolveRepoLabel(boardRoot), gitCtx: null }];
  }

  const projectsFull = repoEntries.map((e) => buildProjectData(e.repoRoot, e.repoLabel, cacheDir, e.gitCtx || null));
  const noClueSessions = computeNoClueSessions(projectsFull);
  const projects = projectsFull.map(({ allRows, ...rest }) => rest);
  const summary = buildSummary(projects);
  // 顶栏「置顶」口径与 sessions ls --pinned 一致：无线索的置顶对话也算进去
  summary.pinned += noClueSessions.filter((s) => s.pinned).length;
  const generatedAt = nowIso();

  let html;
  try {
    html = renderBoardHtml({ generatedAt, projects, noClueSessions, summary });
  } catch (err) {
    // board-spec-v0.2: render.mjs is being rewritten to this contract in
    // parallel (implementer B) — fall back to the OLD single-repo signature
    // so `render`/`sync` don't hard-crash while that lands. B owns render.mjs
    // and render.test.mjs; this fallback is temporary scaffolding in board.mjs
    // only, never a change to the contract itself.
    console.error(`WARN renderBoardHtml 新契约调用失败（render.mjs 可能还没升级到 board-spec-v0.2）：${err.message}`);
    const p = projects[0] || { cards: [], sessions: [], repoName: "board" };
    html = renderBoardHtml({
      cards: p.cards,
      generatedAt,
      config: { base: "main" },
      sessions: p.sessions,
      repoName: p.repoName,
    });
  }

  const { workspace } = loadUserConfig();
  const outPath = workspaceMode
    ? path.resolve(git.expandHome((workspace && workspace.output) || "~/agent-workbench/board/index.html"))
    : path.join(repoEntries[0].repoRoot, "board", "index.html");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`rendered ${outPath}`);
}

// --- CLI plumbing --------------------------------------------------------------

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printHelp() {
  console.log(`board — agent-agnostic markdown task board

用法: board <command> [options]

命令（大部分子命令支持 --all 进入工作区模式，遍历 ~/.config/board/config.json 里的 workspace.repos；
不在任何 git 仓库里跑时自动进入工作区模式）:
  init [--repos a,b,c] [--output p] [--cache p]   初始化 ~/.config/board/config.json（已存在则只打印不覆盖）
  sync [--all] [--dry-run] [--no-discover] [--fetch] [--no-sessions]   刷新卡片派生字段（默认顺带增量扫对话）
  ls [--all] [--status x] [--flag y] [--json]  列出卡片（含 stage、conflicts_with；--all 加仓库列）
  repos                                        列出 workspace.repos 及各自状态（存在/缺配置/卡片数）
  add --branch <b> [--title t] [--agent a]     手动建卡（单仓）
  next <id> "<text>"                           写 next_step
  evidence <id> "<url|path>"                   追加 evidence
  pin <id> <status>                            锁定 status
  unpin <id>                                   解锁 status
  dispatch <id|branch> [--agent a] [--base b] [--run]   派发 worktree + agent（单仓）
  sessions scan                                增量扫描 Claude/Codex 转录，匹配到本仓库分支
  sessions import <file.json>                  导入桌面 app 的 list_sessions 元数据（与仓库无关，写 workspace.cache）
  sessions ls [--all] [--pinned] [--json]      列出对话：分支、可关/别关/无线索 + 理由
  sessions judge [--all] [--ai] [--dry-run] [--stale-days N]
                                                打印归档建议表（landed/dup-title/stale-chat 规则always-on；
                                                --ai 额外把 no-clue/dup-title 行发给 claude -p 判 archive/keep/ask；
                                                --dry-run 只打印会发送的 prompt 和条数，不调用 claude；
                                                建议仅供参考，归档仍需用户点头）
  import vibe-kanban [path] [--repo p] [--branchless] [--apply]
                                                导入 vibe-kanban 本地任务为卡片（默认 dry-run，--apply 才写；
                                                path 缺省时用 vibe-kanban 默认数据库路径，见 README）
  render [--all]                               生成 index.html（单仓写 board/index.html；--all 写 workspace.output）
  archive <id>                                 手动归档卡片
  hook claude                                  内部命令：Claude Code hook 用（stdin 读 JSON），供 settings.json 调用
  hook codex <json>                            内部命令：Codex notify 用，供 config.toml 调用
  hooks install [--dry-run]                    把 hook 直写接进 Claude Code / Codex（写前自动备份）
  hooks status                                 查看两边是否装好、事件日志条数与最近一条时间
  cleanup [--all] [--apply] [--force]          清理 merged/closed/dropped 且带 worktree 的卡（默认 dry-run）
  done <id> [--force]                          等价于对单张卡跑 cleanup --apply
  mcp                                          启动 stdio 上的 MCP server
  mcp install [--dry-run]                      注册到 Claude Code / Codex 的 MCP 配置
  --help                                       显示本帮助
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }

  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "sync": {
        const { flags } = parseFlags(rest);
        const cacheDir = resolveCacheDir();
        const syncOpts = {
          dryRun: !!flags["dry-run"],
          discover: !flags["no-discover"],
          fetch: !!flags.fetch,
        };

        if (isWorkspaceMode(flags)) {
          // The transcript scan/cache is shared machine-wide (sessions.mjs
          // caches raw, repo-agnostic mentions under workspace.cache), so
          // scanning once per repo below only re-reads unscanned files once
          // total — each subsequent repo's scanSessions() call is a cheap
          // cache hit. Doing it per repo (rather than once, separately) keeps
          // each repo's `sessions: N matched` count meaningful for that repo.
          forEachWorkspaceRepo((probe) => {
            console.log(`== ${probe.repoLabel} ==`);
            const config = loadOrInitRepoConfig(probe.repoRoot);
            const lines = runSync(probe.repoRoot, config, { ...syncOpts, repoLabel: probe.repoLabel });
            for (const l of lines) console.log(l);
          });
          if (!flags["no-sessions"]) {
            for (const p of requireWorkspaceRepos()) {
              const probe = probeConfiguredRepo(p);
              if (!probe.ok) continue;
              const config = loadRepoConfig(probe.repoRoot);
              const gitCtx = buildGitCtx(probe.repoRoot, config);
              const { totalCount, matchedCount, scannedCount } = await sessionsLib.scanSessions(cacheDir, gitCtx);
              console.log(
                `sessions(${probe.repoLabel}): ${totalCount} sessions, ${matchedCount} matched to branches（本轮新扫 ${scannedCount} 个文件）`
              );
            }
          }
          break;
        }

        const boardRoot = resolveBoardRoot();
        const configPathExisted = fs.existsSync(path.join(boardRoot, "board", "board.config.json"));
        const config = loadOrInitRepoConfig(boardRoot);
        const lines = runSync(boardRoot, config, { ...syncOpts, repoLabel: resolveRepoLabel(boardRoot) });
        for (const l of lines) console.log(l);
        if (!flags["no-sessions"]) {
          const gitCtx = buildGitCtx(boardRoot, config);
          if (!gitCtx.prListOk) console.error("WARN gh pr list 失败，PR 链接匹配本轮跳过");
          const { totalCount, matchedCount, scannedCount } = await sessionsLib.scanSessions(cacheDir, gitCtx);
          console.log(`sessions: ${totalCount} sessions, ${matchedCount} matched to branches（本轮新扫 ${scannedCount} 个文件）`);
        }
        if (!configPathExisted) {
          console.log("记得把 /board/index.html 加进 .gitignore");
        }
        break;
      }
      case "ls": {
        const { flags } = parseFlags(rest);
        cmdLs(flags);
        break;
      }
      case "repos": {
        cmdRepos();
        break;
      }
      case "add": {
        const { flags } = parseFlags(rest);
        cmdAdd(flags);
        break;
      }
      case "next": {
        const { positional } = parseFlags(rest);
        const [id, text] = positional;
        if (!id || text === undefined) {
          console.error('用法: board next <id> "<text>"');
          process.exit(1);
        }
        cmdNext(id, text);
        break;
      }
      case "evidence": {
        const { positional } = parseFlags(rest);
        const [id, text] = positional;
        if (!id || text === undefined) {
          console.error('用法: board evidence <id> "<url|path>"');
          process.exit(1);
        }
        cmdEvidence(id, text);
        break;
      }
      case "pin": {
        const { positional } = parseFlags(rest);
        const [id, status] = positional;
        if (!id || !status) {
          console.error("用法: board pin <id> <status>");
          process.exit(1);
        }
        cmdPin(id, status);
        break;
      }
      case "unpin": {
        const { positional } = parseFlags(rest);
        const [id] = positional;
        if (!id) {
          console.error("用法: board unpin <id>");
          process.exit(1);
        }
        cmdUnpin(id);
        break;
      }
      case "dispatch": {
        const { positional, flags } = parseFlags(rest);
        const [identifier] = positional;
        if (!identifier) {
          console.error("用法: board dispatch <id|branch> [--agent a] [--base b] [--run]");
          process.exit(1);
        }
        cmdDispatch(identifier, flags);
        break;
      }
      case "sessions": {
        const [subcommand, ...subRest] = rest;
        const { positional, flags } = parseFlags(subRest);
        switch (subcommand) {
          case "scan":
            await cmdSessionsScan();
            break;
          case "import":
            cmdSessionsImport(positional[0]);
            break;
          case "ls":
            cmdSessionsLs(flags);
            break;
          case "judge":
            await cmdSessionsJudge(flags);
            break;
          default:
            console.error("用法: board sessions <scan|import <file.json>|ls [--pinned]|judge [--ai] [--dry-run] [--stale-days N]>");
            process.exit(1);
        }
        break;
      }
      case "import": {
        const [subcommand, ...subRest] = rest;
        const { positional, flags } = parseFlags(subRest);
        if (subcommand === "vibe-kanban") {
          await cmdImportVibeKanban(positional[0], flags);
        } else {
          console.error("用法: board import vibe-kanban [path] [--repo p] [--branchless] [--apply]");
          process.exit(1);
        }
        break;
      }
      case "render": {
        const { flags } = parseFlags(rest);
        cmdRender(flags);
        break;
      }
      case "archive": {
        const { positional } = parseFlags(rest);
        const [id] = positional;
        if (!id) {
          console.error("用法: board archive <id>");
          process.exit(1);
        }
        cmdArchive(id);
        break;
      }
      case "init": {
        const { flags } = parseFlags(rest);
        cmdInit(flags);
        break;
      }
      case "hook": {
        // board-spec-v0.4 §A1: this command must never throw or exit
        // non-zero — a bad/missing subcommand is a silent no-op, not an
        // error, so a misconfigured hook never fails the caller's turn.
        const [sub, ...subRest] = rest;
        if (sub === "claude") {
          cmdHookClaude();
        } else if (sub === "codex") {
          const rawArg = subRest.length > 0 ? subRest[subRest.length - 1] : "";
          cmdHookCodex(rawArg);
        }
        break;
      }
      case "hooks": {
        const [sub, ...subRest] = rest;
        const { flags } = parseFlags(subRest);
        if (sub === "install") {
          cmdHooksInstall(flags);
        } else if (sub === "status") {
          cmdHooksStatus();
        } else {
          console.error("用法: board hooks <install [--dry-run]|status>");
          process.exit(1);
        }
        break;
      }
      case "cleanup": {
        const { flags } = parseFlags(rest);
        cmdCleanup(flags);
        break;
      }
      case "done": {
        const { positional, flags } = parseFlags(rest);
        const [id] = positional;
        if (!id) {
          console.error("用法: board done <id> [--force]");
          process.exit(1);
        }
        cmdDone(id, flags);
        break;
      }
      case "mcp": {
        const [sub, ...subRest] = rest;
        if (!sub) {
          await mcpLib.runServer();
        } else if (sub === "install") {
          const { flags } = parseFlags(subRest);
          mcpLib.installMcp({ dryRun: !!flags["dry-run"] });
        } else {
          console.error(`未知子命令: mcp ${sub}`);
          process.exit(1);
        }
        break;
      }
      default:
        console.error(`未知命令: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`board 出错: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`board 出错: ${err.message}`);
  process.exit(1);
});
