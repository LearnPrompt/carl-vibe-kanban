// board-spec-v0.4 §A1: hooks 直写 — the conversation<->branch relationship is
// written down the moment it happens (a Claude Code / Codex hook fires),
// instead of being guessed after the fact from transcripts.
//
// Two entry points write to the SAME append-only log
// (`<cacheDir>/hooks/events.jsonl`, one JSON object per line):
//   - recordClaudeHookEvent: `board hook claude` reads stdin (the hook JSON
//     Claude Code pipes in on SessionStart/Stop/UserPromptSubmit).
//   - recordCodexHookEvent: `board hook codex` reads its last CLI argument
//     (the JSON Codex's `notify` mechanism passes). That payload carries no
//     session_id/cwd of its own, so this falls back to the most recently
//     modified file under ~/.codex/sessions to infer them (see
//     findLatestCodexSessionFile / readCodexSessionMeta below).
//
// Hard requirement (board-spec-v0.4): a `board hook *` invocation must NEVER
// throw, NEVER exit non-zero, and NEVER shell out to `gh`. Every I/O function
// here is wrapped so a failure degrades to "wrote nothing" rather than an
// exception. Target latency is <100ms — no network, no `gh`, bounded reads.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as git from "./git.mjs";

export const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

// --- event log path + append -------------------------------------------------

export function hooksDir(cacheDir) {
  return path.join(cacheDir, "hooks");
}

export function eventsPath(cacheDir) {
  return path.join(hooksDir(cacheDir), "events.jsonl");
}

// Appends one event object as a single JSON line. Never throws; returns
// true/false so callers can decide whether to log anything (they mostly
// don't — the hook command itself must stay silent-on-failure).
export function appendHookEvent(cacheDir, event) {
  try {
    const p = eventsPath(cacheDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(event) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// --- git facts, computed on the spot at hook time -----------------------------

// board-spec-v0.4: repoRoot / branch / worktree computed live via
// `git -C <cwd> rev-parse --show-toplevel`, `--abbrev-ref HEAD`,
// `--git-common-dir` respectively. Every git.mjs call already swallows its
// own errors (returns null), so this rarely throws — the try/catch is a
// second safety net, per the "hook must never throw" requirement.
export function computeGitFieldsForCwd(cwd) {
  const empty = { repoRoot: null, branch: null, worktree: null };
  if (!cwd || typeof cwd !== "string") return empty;
  try {
    if (!git.isGitRepo(cwd)) return empty;
    return {
      repoRoot: git.getShowToplevel(cwd),
      branch: git.getCurrentBranch(cwd),
      worktree: git.getGitCommonDir(cwd),
    };
  } catch {
    return empty;
  }
}

// --- Claude Code hook (stdin JSON) --------------------------------------------

// Pure: parses the raw stdin text Claude Code pipes into `board hook claude`.
// Returns null on any parse failure (missing fields are tolerated — the
// fields board-spec-v0.4 documents as present are read defensively below).
export function parseClaudeHookPayload(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// Pure: builds the event object from an already-parsed payload + precomputed
// git fields, so this half of the logic is unit-testable without shelling
// out to git at all.
export function buildClaudeEvent(payload, gitFields) {
  return {
    ts: new Date().toISOString(),
    source: "claude",
    event: (payload && payload.hook_event_name) || null,
    sessionId: (payload && payload.session_id) || null,
    cwd: (payload && payload.cwd) || null,
    transcriptPath: (payload && payload.transcript_path) || null,
    repoRoot: gitFields.repoRoot,
    branch: gitFields.branch,
    worktree: gitFields.worktree,
  };
}

// I/O orchestration for `board hook claude`. Reads nothing itself (the caller
// passes in the already-read stdin text) — never throws.
export function recordClaudeHookEvent(cacheDir, rawStdin) {
  try {
    const payload = parseClaudeHookPayload(rawStdin);
    if (!payload) return false;
    const gitFields = computeGitFieldsForCwd(payload.cwd);
    const event = buildClaudeEvent(payload, gitFields);
    return appendHookEvent(cacheDir, event);
  } catch {
    return false;
  }
}

// --- Codex hook (notify JSON as last CLI arg) ---------------------------------

// Pure: Codex's `notify` mechanism invokes the configured program with a
// single JSON string as its last argument. That payload's shape carries no
// session_id/cwd (see board-spec-v0.4 §A1) — just an event type and turn
// details — so this only extracts what's actually there.
export function parseCodexNotifyArg(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function walkCodexSessionFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkCodexSessionFiles(full, out);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

// Finds the most recently modified Codex transcript file — the session that
// most plausibly just triggered this notify call. Bounded, read-only
// directory walk (no file contents touched here).
export function findLatestCodexSessionFile(sessionsDir = CODEX_SESSIONS_DIR) {
  try {
    const files = [];
    walkCodexSessionFiles(sessionsDir, files);
    if (files.length === 0) return null;
    let latest = null;
    let latestMtime = -Infinity;
    for (const f of files) {
      let stat;
      try {
        stat = fs.statSync(f);
      } catch {
        continue;
      }
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = f;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

// Reads just the first line of a (potentially huge) transcript file, without
// ever reading the whole thing — Codex's own session_meta line can itself be
// large (base_instructions is embedded inline), so this grows its read
// window instead of assuming a fixed line length, capped at maxBytes.
export function readFirstLine(filePath, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(65536);
    let collected = "";
    let total = 0;
    while (total < maxBytes) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, total);
      if (bytesRead === 0) break;
      collected += buf.toString("utf8", 0, bytesRead);
      total += bytesRead;
      const nlIdx = collected.indexOf("\n");
      if (nlIdx !== -1) return collected.slice(0, nlIdx);
    }
    return collected;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// Pure: extracts {sessionId, cwd} from a Codex `session_meta` line's raw
// text (see readFirstLine above). Returns null on anything unexpected.
export function parseCodexSessionMetaLine(line) {
  if (typeof line !== "string" || !line) return null;
  try {
    const obj = JSON.parse(line);
    if (!obj || obj.type !== "session_meta" || !obj.payload) return null;
    const sessionId = obj.payload.session_id || obj.payload.id || null;
    const cwd = obj.payload.cwd || null;
    if (!sessionId && !cwd) return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

// Pure: builds the event object from the notify payload + resolved session
// meta (sessionId/cwd, from the latest session file) + precomputed git
// fields.
export function buildCodexEvent(notifyPayload, sessionMeta, gitFields, transcriptPath) {
  return {
    ts: new Date().toISOString(),
    source: "codex",
    event: (notifyPayload && (notifyPayload.type || notifyPayload["event-type"])) || null,
    sessionId: (sessionMeta && sessionMeta.sessionId) || null,
    cwd: (sessionMeta && sessionMeta.cwd) || null,
    transcriptPath: transcriptPath || null,
    repoRoot: gitFields.repoRoot,
    branch: gitFields.branch,
    worktree: gitFields.worktree,
  };
}

// I/O orchestration for `board hook codex`. `rawArg` is the last argv entry
// Codex's notify mechanism passed. Never throws.
export function recordCodexHookEvent(cacheDir, rawArg, sessionsDir = CODEX_SESSIONS_DIR) {
  try {
    const notifyPayload = parseCodexNotifyArg(rawArg);
    const latestFile = findLatestCodexSessionFile(sessionsDir);
    let sessionMeta = null;
    if (latestFile) {
      const firstLine = readFirstLine(latestFile);
      sessionMeta = parseCodexSessionMetaLine(firstLine);
    }
    const gitFields = computeGitFieldsForCwd(sessionMeta && sessionMeta.cwd);
    const event = buildCodexEvent(notifyPayload, sessionMeta, gitFields, latestFile);
    // Nothing at all resolved (no notify JSON, no session file) — skip
    // rather than write an all-null row.
    if (!event.event && !event.sessionId && !event.cwd) return false;
    return appendHookEvent(cacheDir, event);
  } catch {
    return false;
  }
}

// --- reading the log back (used by `hooks status`) ----------------------------

export function readHookEventsRaw(cacheDir) {
  const p = eventsPath(cacheDir);
  if (!fs.existsSync(p)) return [];
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// --- install: Claude Code settings.json + Codex config.toml -------------------

export function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function codexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function backupsDir(cacheDir) {
  return path.join(cacheDir, "backups");
}

// Backs up a file's current bytes (if it exists) before we touch it. Returns
// the backup path, or null if there was nothing to back up.
export function backupFile(cacheDir, filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = backupsDir(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${path.basename(filePath)}.${ts}`);
  fs.copyFileSync(filePath, dest);
  return dest;
}

export const CLAUDE_HOOK_EVENTS = ["SessionStart", "Stop", "UserPromptSubmit"];
export const CLAUDE_HOOK_COMMAND = "board hook claude";

// Pure: given the parsed settings.json object, returns which of
// CLAUDE_HOOK_EVENTS already have an entry whose hooks[].command matches
// CLAUDE_HOOK_COMMAND — used both to decide what to add and to report status.
export function claudeHookEventsInstalled(settings) {
  const hooks = (settings && settings.hooks) || {};
  const installed = {};
  for (const evt of CLAUDE_HOOK_EVENTS) {
    const entries = Array.isArray(hooks[evt]) ? hooks[evt] : [];
    installed[evt] = entries.some(
      (e) => Array.isArray(e.hooks) && e.hooks.some((h) => h && h.command === CLAUDE_HOOK_COMMAND)
    );
  }
  return installed;
}

// Pure: returns a NEW settings object with CLAUDE_HOOK_COMMAND added to every
// event in CLAUDE_HOOK_EVENTS that doesn't already have it. Preserves every
// other key/entry untouched (JSON.parse/stringify round-trip semantics —
// no comments to lose, this is JSON not JSONC).
export function planClaudeSettingsInstall(settings) {
  const next = { ...(settings || {}) };
  next.hooks = { ...(next.hooks || {}) };
  const installed = claudeHookEventsInstalled(settings || {});
  const added = [];
  for (const evt of CLAUDE_HOOK_EVENTS) {
    const existing = Array.isArray(next.hooks[evt]) ? next.hooks[evt] : [];
    if (installed[evt]) {
      next.hooks[evt] = existing;
      continue;
    }
    next.hooks[evt] = [
      ...existing,
      { matcher: "", hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, timeout: 5 }] },
    ];
    added.push(evt);
  }
  return { settings: next, added };
}

// I/O: installs (or reports the plan for --dry-run) the Claude Code hooks.
// Returns { changed, added, backupPath, dryRun }.
export function installClaudeHooks(cacheDir, { dryRun = false } = {}) {
  const p = claudeSettingsPath();
  let current = {};
  if (fs.existsSync(p)) {
    try {
      current = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      throw new Error(`读取 ${p} 失败（JSON 解析错误）：${err.message}`);
    }
  }
  const { settings: next, added } = planClaudeSettingsInstall(current);
  if (added.length === 0) {
    return { changed: false, added, backupPath: null, dryRun, path: p };
  }
  if (dryRun) {
    return { changed: true, added, backupPath: null, dryRun, path: p };
  }
  const backupPath = backupFile(cacheDir, p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { changed: true, added, backupPath, dryRun, path: p };
}

// --- Codex notify (TOML, hand-rolled — no parser) ------------------------------

// Pure: scans raw config.toml text for a top-level `notify = [...]` line.
// Deliberately naive (no TOML parser, per board-spec-v0.4) — only matches a
// single-line array assignment, which is how both the default and this
// tool's own writes look. Returns { found, line, hasBoard } — `line` is the
// raw matched line (for the "print the existing line" manual-fix path).
export function findCodexNotifyLine(configText) {
  const lines = (configText || "").split("\n");
  for (const line of lines) {
    if (/^\s*notify\s*=/.test(line)) {
      return { found: true, line, hasBoard: /board/.test(line) };
    }
  }
  return { found: false, line: null, hasBoard: false };
}

export const CODEX_NOTIFY_LINE = `notify = ["board", "hook", "codex"]`;

// I/O: installs (or reports the plan for --dry-run) the Codex notify config.
// Returns a discriminated result: action is one of "skip-already-installed",
// "append", "manual" (existing notify points elsewhere — never touched),
// "create" (no config.toml at all yet).
export function installCodexNotify(cacheDir, { dryRun = false } = {}) {
  const p = codexConfigPath();
  const exists = fs.existsSync(p);
  const text = exists ? fs.readFileSync(p, "utf8") : "";
  const found = findCodexNotifyLine(text);

  if (found.found && found.hasBoard) {
    return { action: "skip-already-installed", path: p, existingLine: found.line, dryRun };
  }
  if (found.found && !found.hasBoard) {
    return { action: "manual", path: p, existingLine: found.line, suggestedLine: CODEX_NOTIFY_LINE, dryRun };
  }

  // No notify line at all — append one.
  if (dryRun) {
    return { action: exists ? "append" : "create", path: p, dryRun };
  }
  const backupPath = exists ? backupFile(cacheDir, p) : null;
  const withNewline = text.length > 0 && !text.endsWith("\n") ? text + "\n" : text;
  const next = `${withNewline}${CODEX_NOTIFY_LINE}\n`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, next, "utf8");
  return { action: exists ? "append" : "create", path: p, backupPath, dryRun };
}

// --- status ---------------------------------------------------------------------

export function hooksStatus(cacheDir) {
  let claudeSettings = {};
  try {
    if (fs.existsSync(claudeSettingsPath())) {
      claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf8"));
    }
  } catch {
    claudeSettings = {};
  }
  const claudeInstalled = claudeHookEventsInstalled(claudeSettings);

  let codexNotify = { found: false, line: null, hasBoard: false };
  try {
    if (fs.existsSync(codexConfigPath())) {
      codexNotify = findCodexNotifyLine(fs.readFileSync(codexConfigPath(), "utf8"));
    }
  } catch {
    // leave default
  }

  const events = readHookEventsRaw(cacheDir);
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return {
    claude: claudeInstalled,
    codexNotifyInstalled: codexNotify.hasBoard,
    codexNotifyLine: codexNotify.line,
    eventCount: events.length,
    lastEventTs: lastEvent ? lastEvent.ts : null,
  };
}
