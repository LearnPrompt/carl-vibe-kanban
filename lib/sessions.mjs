// Session (对话) scanning and matching for board-spec-v0.1.
//
// Two read-only sources, never mutated:
//   - Claude Code transcripts: ~/.claude/projects/*/*.jsonl
//   - Codex transcripts:       ~/.codex/sessions/**/*.jsonl
// Both can be tens of MB; every read here is streamed line-by-line (readline),
// never fs.readFileSync'd whole. Scan results are cached under
// board/.cache/sessions.json, keyed by absolute file path with mtime+size so
// unchanged files are skipped on the next scan.
//
// Desktop-app metadata (title/pinned/prNumber) has no on-disk source of
// truth, so it's imported once via `board sessions import <file.json>` into
// board/.cache/app-sessions.json.
//
// Everything that doesn't need to touch the filesystem is exported as a pure
// function so it's unit-testable with fixtures (see sessions.test.mjs).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
export const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- pure regex extraction over one raw transcript line -----------------------

const RE_PUSH = /git push(?:\s+-u)?\s+origin\s+([A-Za-z0-9._/-]+)/g;
const RE_CHECKOUT_B = /checkout\s+-b\s+([A-Za-z0-9._/-]+)/g;
const RE_SWITCH_C = /switch\s+-c\s+([A-Za-z0-9._/-]+)/g;
const RE_WORKTREE_ADD_B = /worktree add[^\n]*?-b\s+([A-Za-z0-9._/-]+)/g;
const RE_WORKTREE_ADD_PLAIN = /worktree add\s+(\S+)\s+([A-Za-z0-9._/-]+)(?=[\s"'\\]|$)/g;
const RE_PR_HEAD = /gh pr create[^\n]*?--head\s+([A-Za-z0-9._/-]+)/g;
const RE_WORKTREE_PATH = /(agent-workbench\/worktrees|\.claude\/worktrees|projects\/[^/\s"']+-wt-[^/\s"']+)\/[^/\s"'\\]+/g;
const RE_PR_LINK = /github\.com\/([^/\s"']+)\/([^/\s"']+)\/pull\/(\d+)/g;

function matchAll(re, str) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(str))) {
    out.push(m);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// Scans one raw transcript line (no JSON parsing needed) for branch/worktree/PR
// mentions. Returns a list of raw, unfiltered mentions:
//   { type: "branch", branch, via }
//   { type: "worktree-path", path }
//   { type: "pr-link", owner, repo, number }
export function extractMentions(line) {
  if (!line) return [];
  const mentions = [];
  for (const m of matchAll(RE_PUSH, line)) mentions.push({ type: "branch", branch: m[1], via: "push" });
  for (const m of matchAll(RE_CHECKOUT_B, line)) mentions.push({ type: "branch", branch: m[1], via: "checkout-b" });
  for (const m of matchAll(RE_SWITCH_C, line)) mentions.push({ type: "branch", branch: m[1], via: "switch-c" });
  for (const m of matchAll(RE_WORKTREE_ADD_B, line)) mentions.push({ type: "branch", branch: m[1], via: "worktree-add-b" });
  for (const m of matchAll(RE_WORKTREE_ADD_PLAIN, line)) {
    if (!m[2].startsWith("-")) mentions.push({ type: "branch", branch: m[2], via: "worktree-add-plain" });
  }
  for (const m of matchAll(RE_PR_HEAD, line)) mentions.push({ type: "branch", branch: m[1], via: "pr-head" });
  for (const m of matchAll(RE_WORKTREE_PATH, line)) mentions.push({ type: "worktree-path", path: m[0] });
  for (const m of matchAll(RE_PR_LINK, line)) {
    mentions.push({ type: "pr-link", owner: m[1], repo: m[2].replace(/\.git$/, ""), number: parseInt(m[3], 10) });
  }
  return mentions;
}

// Resolves a worktree-path fragment (e.g. "agent-workbench/worktrees/goodcase-board")
// against the real `git worktree list` entries ({path, branch}[]), by suffix match.
export function resolveWorktreePath(fragment, worktreeEntries) {
  if (!fragment || !Array.isArray(worktreeEntries)) return null;
  for (const w of worktreeEntries) {
    if (!w.path) continue;
    if (w.path === fragment || w.path.endsWith(`/${fragment}`) || w.path.endsWith(fragment)) {
      return w.branch || null;
    }
  }
  return null;
}

// Resolves a { owner, repo, number } PR-link mention to a branch name, but
// ONLY when owner/repo match this repo (cross-repo PR links are filtered —
// board-spec-v0.1 §仓库范围过滤). Returns null otherwise.
export function resolvePrLink(mention, repoOwner, repoName, prList) {
  if (!mention || !repoOwner || !repoName) return null;
  if (mention.owner !== repoOwner || mention.repo !== repoName) return null;
  if (!Array.isArray(prList)) return null;
  const pr = prList.find((p) => p.number === mention.number);
  return pr ? pr.headRefName : null;
}

// A worktree-path fragment only counts as "this session touched this
// worktree" once it's been seen this many times inside tool_use / tool-call
// inputs. This is what keeps ambient noise (a path mentioned once in passing,
// or echoed back from a tool result before that source was excluded) from
// wrongly pinning a session to a branch. Explicit branch commands (push -u,
// checkout -b, switch -c, worktree add -b, gh pr create --head) need no such
// threshold — one occurrence in a tool call is already a deliberate action.
export const WORKTREE_PATH_MIN_MENTIONS = 3;

// Keeps only branch names that actually exist in this repo (local ref, origin
// ref, or a PR headRefName). Sorted + deduped for stable output.
// 主干分支不算对话线索：谁都会 checkout main、push main，不代表这个对话在做什么
const TRUNK_BRANCHES = new Set(["main", "master"]);

export function filterBranchesToRepo(candidateBranches, localBranches, remoteBranches, prHeadRefNames) {
  const allowed = new Set([...(localBranches || []), ...(remoteBranches || []), ...(prHeadRefNames || [])]);
  return Array.from(new Set((candidateBranches || []).filter(Boolean))).filter((b) => allowed.has(b) && !TRUNK_BRANCHES.has(b)).sort();
}

// --- transcript file discovery ------------------------------------------------

function isUuidLike(str) {
  return UUID_RE.test(str);
}

function walkCodexDir(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkCodexDir(full, out);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      const m = e.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const uuid = m ? m[1] : e.name.replace(/\.jsonl$/, "");
      out.push({ filePath: full, source: "codex", uuid });
    }
  }
}

// Lists every transcript file across both sources. Read-only directory walk,
// no file contents touched here.
export function listTranscriptFiles() {
  const files = [];
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    } catch {
      projectDirs = [];
    }
    for (const projDir of projectDirs) {
      if (!projDir.isDirectory()) continue;
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, projDir.name);
      let entries;
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const uuid = e.name.slice(0, -".jsonl".length);
        if (!isUuidLike(uuid)) continue;
        files.push({ filePath: path.join(dirPath, e.name), source: "claude", uuid });
      }
    }
  }
  if (fs.existsSync(CODEX_SESSIONS_DIR)) {
    walkCodexDir(CODEX_SESSIONS_DIR, files);
  }
  return files;
}

// --- per-line JSON extraction (agent actions + real user text only) -----------
//
// board-spec-v0.1: the old implementation ran extractMentions() over the RAW
// transcript line, which meant tool *output* (e.g. `git worktree list`
// printing every worktree on the machine) and injected system text (skill
// bodies, <recommended_plugins>, AGENTS.md instructions echoed as a "user"
// turn) were scanned for branch/worktree/PR clues right alongside the agent's
// own actions and the human's real messages. That's how one worktree `cd`
// printed by a tool ended up "matching" nearly every session in the machine.
//
// Fix: parse each line's JSON once, classify it, and only ever regex over:
//   - an agent's tool-call INPUT (Claude tool_use.input; Codex
//     function_call.arguments / custom_tool_call.input) — never a tool
//     RESULT/OUTPUT block. This is where explicit branch/worktree actions and
//     genuine PR links live.
//   - the human's own chat text (Claude type:"user" with isMeta !== true;
//     Codex role:"user"), and only when it doesn't look like injected
//     boilerplate (doesn't start with "<" or "#"). Real user text is used
//     ONLY for first_prompt and PR-link extraction — never for worktree-path
//     mentions, since a human typing a path in chat is not the same signal as
//     an agent actually cd'ing into / operating on that worktree.
// A line that fails JSON.parse is skipped outright.

// Returns a list of { kind: "tool-input" | "user-text", text } items found on
// one already-parsed Claude transcript line. Never returns tool_result text.
export function classifyClaudeLine(obj) {
  if (!obj || typeof obj !== "object") return [];

  if (obj.type === "assistant") {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const block of content) {
      if (block && block.type === "tool_use" && block.input !== undefined) {
        out.push({ kind: "tool-input", text: JSON.stringify(block.input) });
      }
    }
    return out;
  }

  if (obj.type === "user") {
    if (obj.isMeta === true) return [];
    const content = obj.message?.content;
    let text = null;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const textBlock = content.find((b) => b && b.type === "text" && typeof b.text === "string");
      text = textBlock ? textBlock.text : null;
    }
    if (typeof text !== "string") return [];
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("#")) return [];
    return [{ kind: "user-text", text: trimmed }];
  }

  return [];
}

// Same contract as classifyClaudeLine, for one already-parsed Codex
// response_item line. Tool calls appear as either the older `function_call`
// (payload.arguments, a JSON string) or `custom_tool_call` (payload.input, a
// freeform string); both are agent actions, never output. `function_call_output`
// / `custom_tool_call_output` are tool results and are intentionally not handled.
export function classifyCodexLine(obj) {
  if (!obj || typeof obj !== "object" || obj.type !== "response_item") return [];
  const payload = obj.payload;
  if (!payload || typeof payload !== "object") return [];

  if (payload.type === "function_call" && typeof payload.arguments === "string") {
    return [{ kind: "tool-input", text: payload.arguments }];
  }
  if (payload.type === "custom_tool_call" && typeof payload.input === "string") {
    return [{ kind: "tool-input", text: payload.input }];
  }

  if (payload.type === "message" && payload.role === "user") {
    const content = payload.content;
    let text = null;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const textBlock = content.find(
        (b) => b && (b.type === "input_text" || b.type === "text") && typeof b.text === "string"
      );
      text = textBlock ? textBlock.text : null;
    }
    if (typeof text !== "string") return [];
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("#")) return [];
    return [{ kind: "user-text", text: trimmed }];
  }

  return [];
}

function extractCwdFromParsed(obj, source, alreadyHaveCwd) {
  if (alreadyHaveCwd) return null;
  if (!obj || typeof obj !== "object") return null;
  if (source === "claude") return obj.cwd || null;
  if (obj.type === "session_meta") return obj.payload?.cwd || null;
  return null;
}

// Streams one transcript file line-by-line (readline; never readFileSync) and
// extracts everything the board needs from it. Each line is JSON.parse'd at
// most once; a line that fails to parse is skipped.
export async function extractSessionFacts(filePath, source) {
  const branchMentions = new Set();
  const worktreePathCounts = new Map();
  const prLinkMentions = [];
  let firstPrompt = null;
  let cwd = null;

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const c = extractCwdFromParsed(obj, source, cwd !== null);
      if (c) cwd = c;

      const items = source === "claude" ? classifyClaudeLine(obj) : classifyCodexLine(obj);
      for (const item of items) {
        if (item.kind === "tool-input") {
          for (const m of extractMentions(item.text)) {
            if (m.type === "branch") branchMentions.add(m.branch);
            else if (m.type === "worktree-path") {
              worktreePathCounts.set(m.path, (worktreePathCounts.get(m.path) || 0) + 1);
            } else if (m.type === "pr-link") {
              prLinkMentions.push({ owner: m.owner, repo: m.repo, number: m.number });
            }
          }
        } else if (item.kind === "user-text") {
          // Real user text: only PR links feed branch matching; never
          // worktree paths. Also doubles as the first_prompt source.
          for (const m of extractMentions(item.text)) {
            if (m.type === "pr-link") prLinkMentions.push({ owner: m.owner, repo: m.repo, number: m.number });
          }
          if (firstPrompt === null) firstPrompt = item.text.slice(0, 60);
        }
      }
    }
  } finally {
    rl.close();
  }

  return {
    branchMentions: Array.from(branchMentions),
    worktreePathCounts: Object.fromEntries(worktreePathCounts),
    prLinkMentions,
    firstPrompt,
    cwd,
  };
}

// --- caches --------------------------------------------------------------------
//
// board-spec-v0.2: these caches are machine-local and shared across every repo
// in the workspace (one transcript scan, reused by every repo's `sync`), so
// they now live under `workspace.cache` (default `~/.cache/board`) rather than
// under any single repo's `board/.cache/`. Callers pass that directory in as
// `cacheDir` — sessions.mjs itself has no opinion on where it resolves to.

export function sessionsCachePath(cacheDir) {
  return path.join(cacheDir, "sessions.json");
}

export function appSessionsCachePath(cacheDir) {
  return path.join(cacheDir, "app-sessions.json");
}

export function loadSessionsCache(cacheDir) {
  const p = sessionsCachePath(cacheDir);
  if (!fs.existsSync(p)) return { files: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return raw && typeof raw === "object" && raw.files ? raw : { files: {} };
  } catch {
    return { files: {} };
  }
}

export function saveSessionsCache(cacheDir, cache) {
  const p = sessionsCachePath(cacheDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), "utf8");
}

export function loadAppSessions(cacheDir) {
  const p = appSessionsCachePath(cacheDir);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

// Imports a `list_sessions`-shaped JSON array (small file — a single
// readFileSync is fine here, this is app metadata, not a transcript).
export function importAppSessions(cacheDir, filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("app sessions 文件必须是 JSON 数组");
  const p = appSessionsCachePath(cacheDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), "utf8");
  return arr.length;
}

// Strips the desktop app's `local_` id prefix so it lines up with the
// transcript file's own uuid. Passes through unprefixed ids unchanged.
export function stripLocalPrefix(sessionId) {
  if (typeof sessionId !== "string") return sessionId;
  return sessionId.startsWith("local_") ? sessionId.slice("local_".length) : sessionId;
}

// --- resolving a cached/scanned record's raw mentions against live git state ---

// The sessions cache stores raw mentions only (branchMentions/worktreePathCounts/
// prLinkMentions) — never a resolved `branches` list — so that resolution always
// reflects the CURRENT repo state (branches created/deleted/merged since the
// transcript was last scanned) without needing to invalidate the file-scan cache.
// worktreePathCounts is a { fragment: count } map; a fragment only resolves to
// a branch once it's been seen WORKTREE_PATH_MIN_MENTIONS+ times (board-spec-v0.1
// §worktree 路径线索要有分量) — the raw counts stay in the cache and the
// threshold is applied here, at read time, so tuning it needs no rescan.
// gitCtx: { localBranches, remoteBranches, worktreeEntries, prList, repoOwner, repoName }
export function resolveSessionBranches(rec, gitCtx) {
  if (!rec) return [];
  const prHeadRefNames = (gitCtx.prList || []).map((p) => p.headRefName);
  const worktreePathCounts = rec.worktreePathCounts || {};
  const resolvedFromPaths = Object.entries(worktreePathCounts)
    .filter(([, count]) => count >= WORKTREE_PATH_MIN_MENTIONS)
    .map(([frag]) => resolveWorktreePath(frag, gitCtx.worktreeEntries))
    .filter(Boolean);
  const resolvedFromPrLinks = (rec.prLinkMentions || [])
    .map((m) => resolvePrLink(m, gitCtx.repoOwner, gitCtx.repoName, gitCtx.prList))
    .filter(Boolean);
  return filterBranchesToRepo(
    [...(rec.branchMentions || []), ...resolvedFromPaths, ...resolvedFromPrLinks],
    gitCtx.localBranches,
    gitCtx.remoteBranches,
    prHeadRefNames
  );
}

// Whether a scanned transcript record itself carries evidence this session
// touched THIS repo (a PR link to this owner/repo, or a worktree-path mention
// with enough weight to resolve to one of this repo's real worktrees). Used
// to gate the prNumber fallback below (board-spec-v0.1 §prNumber 兜底加仓库守卫
// guard (a)) so a cross-repo session's stray prNumber can't borrow a branch
// name that happens to collide with this repo's PR numbering.
function scannedHasThisRepoClue(rec, gitCtx) {
  if (!rec) return false;
  const hasRepoPrLink = (rec.prLinkMentions || []).some(
    (m) => m.owner === gitCtx.repoOwner && m.repo === gitCtx.repoName
  );
  if (hasRepoPrLink) return true;
  const worktreePathCounts = rec.worktreePathCounts || {};
  for (const [frag, count] of Object.entries(worktreePathCounts)) {
    if (count >= WORKTREE_PATH_MIN_MENTIONS && resolveWorktreePath(frag, gitCtx.worktreeEntries)) return true;
  }
  return false;
}

// --- cwd-based repo ownership ---------------------------------------------------
//
// 铁律: session titles are randomly generated by Claude and must NEVER be used
// as a matching signal — only project (cwd) and branch may be used. This
// replaces the old title/alias-matching guard entirely (no title/alias
// fallback of any kind survives below).

// Path containment via normalized absolute paths (path.resolve), so that e.g.
// "/foo/bar2" is never mistaken for a descendant of "/foo/bar" the way a
// naive string-prefix check would get wrong.
export function isPathContainedIn(childPath, parentPath) {
  if (typeof childPath !== "string" || !childPath) return false;
  if (typeof parentPath !== "string" || !parentPath) return false;
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  if (child === parent) return true;
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(parentWithSep);
}

// Resolves whether `cwd` belongs to this repo: equal to, or a path-descendant
// of, repoRoot, OR one of the repo's registered worktree paths (from `git
// worktree list`). A cwd that's a general orchestration directory sitting
// outside both (e.g. ~/agent-workbench itself) matches nothing here.
// Returns { matched, worktree }: `worktree` is the specific worktree entry
// `cwd` fell under when the match wasn't repoRoot itself (null otherwise).
//
// Worktrees can be registered INSIDE repoRoot itself (e.g. the desktop app's
// own `<repoRoot>/.claude/worktrees/<name>`, which `git worktree list` always
// reports alongside the main worktree) — so a cwd can simultaneously satisfy
// "under repoRoot" AND "under one specific nested worktree". Whichever
// candidate path is the most specific (longest / deepest) wins, so a session
// working inside a nested worktree is credited to THAT worktree (and its own
// checked-out branch), not just to the repo in general.
export function resolveCwdOwnership(cwd, repoRoot, worktreeEntries) {
  if (!cwd || !repoRoot) return { matched: false, worktree: null };
  const candidates = [];
  if (isPathContainedIn(cwd, repoRoot)) candidates.push({ path: path.resolve(repoRoot), worktree: null });
  for (const w of worktreeEntries || []) {
    if (!w || !w.path) continue;
    if (isPathContainedIn(cwd, w.path)) candidates.push({ path: path.resolve(w.path), worktree: w });
  }
  if (candidates.length === 0) return { matched: false, worktree: null };
  candidates.sort((a, b) => b.path.length - a.path.length);
  return { matched: true, worktree: candidates[0].worktree };
}

// --- incremental scan ------------------------------------------------------------

// `cacheDir`: machine-local, shared across every repo in the workspace (see
// caches section above). gitCtx: { localBranches, remoteBranches, worktreeEntries, prList, repoOwner, repoName }
export async function scanSessions(cacheDir, gitCtx) {
  const cache = loadSessionsCache(cacheDir);
  const files = listTranscriptFiles();

  let scannedCount = 0;
  const resultsByFile = {};

  for (const f of files) {
    let stat;
    try {
      stat = fs.statSync(f.filePath);
    } catch {
      continue;
    }
    const cached = cache.files[f.filePath];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      resultsByFile[f.filePath] = cached;
      continue;
    }
    const facts = await extractSessionFacts(f.filePath, f.source);
    scannedCount++;
    resultsByFile[f.filePath] = {
      uuid: f.uuid,
      source: f.source,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lastActive: stat.mtime.toISOString(),
      firstPrompt: facts.firstPrompt,
      cwd: facts.cwd,
      branchMentions: facts.branchMentions,
      worktreePathCounts: facts.worktreePathCounts,
      prLinkMentions: facts.prLinkMentions,
    };
  }

  saveSessionsCache(cacheDir, { files: resultsByFile });

  const sessions = Object.values(resultsByFile).map((r) => ({
    ...r,
    branches: resolveSessionBranches(r, gitCtx),
  }));

  const matchedCount = sessions.filter((s) => s.branches.length > 0).length;
  return { sessions, scannedCount, totalCount: sessions.length, matchedCount };
}

// --- merging scanned + app-imported sessions into display rows -------------------

// Pure: merges one scanned-transcript record (or null) with one app-metadata
// record (or null) for the same uuid into a single display row. `scanned` is
// the raw cache record (branchMentions/worktreePathCounts/prLinkMentions) —
// resolveSessionBranches re-resolves it against the current gitCtx here.
//
// prNumber 兜底加仓库守卫 (title/alias matching removed — cwd/branch only):
// app.prNumber is only trusted to pull in a branch when ANY of:
//   (i)   the session's own transcript already carries a this-repo PR link or
//         a weighty worktree-path clue (scannedHasThisRepoClue, unchanged);
//   (ii)  the session's cwd (app.cwd or scanned.cwd) resolves to THIS repo,
//         per resolveCwdOwnership (repoRoot or one of its worktree paths);
//   (iii) workspace mode only — the PR number is unique to exactly this repo
//         across gitCtx.workspacePrIndex (Map<number, Set<repoLabel>>, built
//         from every workspace repo's OPEN PRs). Absent in single-repo mode,
//         so this path is simply unavailable there.
// (i) and (ii) are "we already know this session touched this repo" — the
// prNumber fallback just fills in the headRefName, no `prInferred` flag.
// (iii) is a genuine inference (no direct evidence, just PR-number-uniqueness
// arithmetic across the workspace) and DOES set `prInferred` so the UI can
// label it "按 PR 号推断" instead of presenting it as an equally-solid match.
export function mergeSessionRow(uuid, scanned, app, gitCtx) {
  const prHeadRefNames = (gitCtx.prList || []).map((p) => p.headRefName);
  const cwd = (app && app.cwd) || (scanned && scanned.cwd) || null;
  const cwdOwnership = resolveCwdOwnership(cwd, gitCtx.repoRoot, gitCtx.worktreeEntries);

  let branches = resolveSessionBranches(scanned, gitCtx);
  if (app && app.branch) branches.push(app.branch);
  if (cwdOwnership.worktree && cwdOwnership.worktree.branch) {
    branches.push(cwdOwnership.worktree.branch);
  }

  let prInferred = false;
  if (app && app.prNumber != null && Array.isArray(gitCtx.prList)) {
    const guardTranscript = scannedHasThisRepoClue(scanned, gitCtx);
    const guardCwd = cwdOwnership.matched;
    let guardPrUnique = false;
    if (!guardTranscript && !guardCwd && gitCtx.workspacePrIndex instanceof Map) {
      const owners = gitCtx.workspacePrIndex.get(app.prNumber);
      guardPrUnique = !!owners && owners.size === 1 && (!gitCtx.repoLabel || owners.has(gitCtx.repoLabel));
    }
    if (guardTranscript || guardCwd || guardPrUnique) {
      const pr = gitCtx.prList.find((p) => p.number === app.prNumber);
      if (pr) {
        branches.push(pr.headRefName);
        if (guardPrUnique) prInferred = true;
      }
    }
  }

  branches = filterBranchesToRepo(branches, gitCtx.localBranches, gitCtx.remoteBranches, prHeadRefNames);
  // A worktree in detached HEAD state has no branch name to offer — per
  // spec, its own path stands in as the branch "key" so a cwd match there
  // still surfaces as a clue, bypassing the real-branch allowlist above
  // (which would otherwise strip a non-ref string like a filesystem path).
  if (cwdOwnership.worktree && cwdOwnership.worktree.detached && cwdOwnership.worktree.path) {
    const key = cwdOwnership.worktree.path;
    if (!branches.includes(key)) branches = [...branches, key].sort();
  }

  const title = (app && app.title) || (scanned && scanned.firstPrompt) || (scanned && scanned.title) || "(无标题)";
  const pinned = !!(app && app.pinned);
  const lastActive = (app && app.lastActivityAt) || (scanned && scanned.lastActive) || null;

  return {
    uuid,
    appSessionId: (app && app.sessionId) || null,
    title,
    pinned,
    lastActive,
    branches,
    matchedViaTranscript: !!scanned,
    inApp: !!app,
    prInferred,
  };
}

// Builds the full list of display rows from the on-disk caches. I/O wrapper
// around mergeSessionRow. `cacheDir` is the shared workspace cache (see caches
// section above), not a per-repo path.
export function buildSessionRows(cacheDir, gitCtx) {
  const cache = loadSessionsCache(cacheDir);
  const appSessions = loadAppSessions(cacheDir);

  const scannedByUuid = new Map();
  for (const rec of Object.values(cache.files || {})) {
    scannedByUuid.set(rec.uuid, rec);
  }
  const appByUuid = new Map();
  for (const app of appSessions) {
    appByUuid.set(stripLocalPrefix(app.sessionId), app);
  }

  const rows = [];
  const seen = new Set();
  for (const [uuid, scanned] of scannedByUuid) {
    rows.push(mergeSessionRow(uuid, scanned, appByUuid.get(uuid) || null, gitCtx));
    seen.add(uuid);
  }
  for (const [uuid, app] of appByUuid) {
    if (seen.has(uuid)) continue;
    rows.push(mergeSessionRow(uuid, null, app, gitCtx));
  }
  return rows;
}

// --- session conclusion: 可关 / 别关 / 无线索 ------------------------------------

const KEEP_REASON_CHECKS = [
  (card) => (card.dirty_files || 0) > 0 && `有 ${card.dirty_files} 个未提交文件`,
  (card) => (card.unpushed_commits || 0) > 0 && `有 ${card.unpushed_commits} 个 commit 未 push`,
  (card) => card.pr && (card.pr_state === "OPEN" || card.pr_state === "DRAFT") && `PR #${card.pr} 还开着`,
  (card) => card.stage === "pushed" && `只 push 了没开 PR`,
  (card) => (card.conflicts_with || []).length > 0 && `与 ${card.conflicts_with[0]}`,
];

// sessionBranches: string[]; cardsByBranch: Map<branch, cardData>.
// Returns { verdict: "can-close" | "keep" | "no-clue", reason: string|null }.
export function judgeSession(sessionBranches, cardsByBranch) {
  if (!sessionBranches || sessionBranches.length === 0) {
    return { verdict: "no-clue", reason: null };
  }
  const touched = sessionBranches.map((b) => ({ branch: b, card: cardsByBranch.get(b) })).filter((x) => x.card);
  if (touched.length === 0) {
    return { verdict: "no-clue", reason: null };
  }

  const allDone = touched.every(
    ({ card }) => card.stage === "merged" || card.stage === "closed" || card.status === "dropped" || card.status === "done"
  );
  const anyDirtyOrUnpushed = touched.some(
    ({ card }) => (card.dirty_files || 0) > 0 || card.stage === "dirty" || card.stage === "unpushed"
  );
  if (allDone && !anyDirtyOrUnpushed) {
    return { verdict: "can-close", reason: null };
  }

  for (const check of KEEP_REASON_CHECKS) {
    for (const { branch, card } of touched) {
      const reasonTail = check(card);
      if (reasonTail) return { verdict: "keep", reason: `${branch} ${reasonTail}` };
    }
  }
  return { verdict: "keep", reason: "分支状态未知" };
}
