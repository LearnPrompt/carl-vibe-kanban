import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseClaudeHookPayload,
  buildClaudeEvent,
  computeGitFieldsForCwd,
  recordClaudeHookEvent,
  appendHookEvent,
  readHookEventsRaw,
  eventsPath,
  parseCodexNotifyArg,
  parseCodexSessionMetaLine,
  buildCodexEvent,
  readFirstLine,
  findLatestCodexSessionFile,
  recordCodexHookEvent,
  claudeHookEventsInstalled,
  planClaudeSettingsInstall,
  installClaudeHooks,
  findCodexNotifyLine,
  installCodexNotify,
  claudeSettingsPath,
  codexConfigPath,
  CLAUDE_HOOK_COMMAND,
  CODEX_NOTIFY_LINE,
} from "./hooks.mjs";

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- parseClaudeHookPayload / buildClaudeEvent (pure) ------------------------

test("parseClaudeHookPayload: parses a well-formed hook JSON", () => {
  const raw = JSON.stringify({ session_id: "abc-123", cwd: "/tmp/x", hook_event_name: "SessionStart" });
  const payload = parseClaudeHookPayload(raw);
  assert.equal(payload.session_id, "abc-123");
  assert.equal(payload.hook_event_name, "SessionStart");
});

test("parseClaudeHookPayload: malformed JSON never throws, returns null", () => {
  assert.equal(parseClaudeHookPayload("{not json"), null);
  assert.equal(parseClaudeHookPayload(""), null);
  assert.equal(parseClaudeHookPayload(undefined), null);
  assert.equal(parseClaudeHookPayload(null), null);
});

test("parseClaudeHookPayload: missing fields still parses (fields read defensively downstream)", () => {
  const payload = parseClaudeHookPayload(JSON.stringify({ hook_event_name: "Stop" }));
  assert.equal(payload.hook_event_name, "Stop");
  assert.equal(payload.session_id, undefined);
});

test("buildClaudeEvent: assembles the full event shape from payload + git fields", () => {
  const payload = { session_id: "s1", cwd: "/x", hook_event_name: "Stop", transcript_path: "/x/t.jsonl" };
  const gitFields = { repoRoot: "/x", branch: "feat/a", worktree: "/x/.git" };
  const event = buildClaudeEvent(payload, gitFields);
  assert.equal(event.source, "claude");
  assert.equal(event.event, "Stop");
  assert.equal(event.sessionId, "s1");
  assert.equal(event.cwd, "/x");
  assert.equal(event.transcriptPath, "/x/t.jsonl");
  assert.equal(event.repoRoot, "/x");
  assert.equal(event.branch, "feat/a");
  assert.equal(event.worktree, "/x/.git");
  assert.ok(typeof event.ts === "string" && event.ts.length > 0);
});

test("buildClaudeEvent: missing payload fields degrade to null, never throw", () => {
  const event = buildClaudeEvent(null, { repoRoot: null, branch: null, worktree: null });
  assert.equal(event.event, null);
  assert.equal(event.sessionId, null);
  assert.equal(event.cwd, null);
});

// --- computeGitFieldsForCwd: real git repos (non-git cwd, plain repo, worktree) --

function initTmpRepo() {
  const dir = mkTmpDir("board-hooks-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hi\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("computeGitFieldsForCwd: a non-git cwd yields all nulls, never throws", () => {
  const dir = mkTmpDir("board-hooks-nongit-");
  const fields = computeGitFieldsForCwd(dir);
  assert.deepEqual(fields, { repoRoot: null, branch: null, worktree: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("computeGitFieldsForCwd: null/undefined cwd yields all nulls", () => {
  assert.deepEqual(computeGitFieldsForCwd(null), { repoRoot: null, branch: null, worktree: null });
  assert.deepEqual(computeGitFieldsForCwd(undefined), { repoRoot: null, branch: null, worktree: null });
});

test("computeGitFieldsForCwd: a plain repo cwd resolves repoRoot/branch/worktree", () => {
  const dir = initTmpRepo();
  const fields = computeGitFieldsForCwd(dir);
  assert.equal(fs.realpathSync(fields.repoRoot), fs.realpathSync(dir));
  assert.equal(fields.branch, "main");
  assert.ok(fields.worktree.endsWith(".git"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("computeGitFieldsForCwd: a linked worktree cwd resolves its OWN toplevel as repoRoot, common-dir points at the main repo's .git", () => {
  const mainDir = initTmpRepo();
  execFileSync("git", ["branch", "feat/wt"], { cwd: mainDir });
  const wtDir = path.join(mkTmpDir("board-hooks-wtparent-"), "wt");
  execFileSync("git", ["worktree", "add", wtDir, "feat/wt"], { cwd: mainDir });

  const fields = computeGitFieldsForCwd(wtDir);
  assert.equal(fs.realpathSync(fields.repoRoot), fs.realpathSync(wtDir));
  assert.equal(fields.branch, "feat/wt");
  assert.equal(fs.realpathSync(fields.worktree), fs.realpathSync(path.join(mainDir, ".git")));

  execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: mainDir });
  fs.rmSync(mainDir, { recursive: true, force: true });
});

test("computeGitFieldsForCwd: detached HEAD resolves branch to null, not the literal 'HEAD'", () => {
  const dir = initTmpRepo();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", sha], { cwd: dir });
  const fields = computeGitFieldsForCwd(dir);
  assert.equal(fields.branch, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- appendHookEvent / readHookEventsRaw / recordClaudeHookEvent (I/O) -------

test("appendHookEvent + readHookEventsRaw: round-trips one JSON line per event", () => {
  const cacheDir = mkTmpDir("board-hooks-cache-");
  assert.equal(readHookEventsRaw(cacheDir).length, 0);
  appendHookEvent(cacheDir, { ts: "t1", source: "claude", event: "Stop" });
  appendHookEvent(cacheDir, { ts: "t2", source: "codex", event: "turn-ended" });
  const events = readHookEventsRaw(cacheDir);
  assert.equal(events.length, 2);
  assert.equal(events[0].source, "claude");
  assert.equal(events[1].source, "codex");
  assert.ok(fs.existsSync(eventsPath(cacheDir)));
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("readHookEventsRaw: a malformed line is skipped, not fatal", () => {
  const cacheDir = mkTmpDir("board-hooks-cache-");
  fs.mkdirSync(path.dirname(eventsPath(cacheDir)), { recursive: true });
  fs.writeFileSync(eventsPath(cacheDir), '{"ts":"t1"}\nnot json\n{"ts":"t2"}\n', "utf8");
  const events = readHookEventsRaw(cacheDir);
  assert.deepEqual(
    events.map((e) => e.ts),
    ["t1", "t2"]
  );
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("recordClaudeHookEvent: writes a full event for a git worktree cwd (integration)", () => {
  const dir = initTmpRepo();
  const cacheDir = mkTmpDir("board-hooks-cache-");
  const raw = JSON.stringify({ session_id: "sess-1", cwd: dir, hook_event_name: "SessionStart" });
  const ok = recordClaudeHookEvent(cacheDir, raw);
  assert.equal(ok, true);
  const events = readHookEventsRaw(cacheDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "sess-1");
  assert.equal(events[0].branch, "main");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("recordClaudeHookEvent: garbage stdin never throws and writes nothing", () => {
  const cacheDir = mkTmpDir("board-hooks-cache-");
  const ok = recordClaudeHookEvent(cacheDir, "{{{not json");
  assert.equal(ok, false);
  assert.equal(readHookEventsRaw(cacheDir).length, 0);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

// --- Codex notify JSON parsing (pure) -----------------------------------------

test("parseCodexNotifyArg: parses the notify JSON Codex passes as the last arg", () => {
  const obj = parseCodexNotifyArg(JSON.stringify({ type: "agent-turn-complete", "turn-id": "42" }));
  assert.equal(obj.type, "agent-turn-complete");
});

test("parseCodexNotifyArg: malformed arg never throws, returns null", () => {
  assert.equal(parseCodexNotifyArg("not json"), null);
  assert.equal(parseCodexNotifyArg(""), null);
});

test("parseCodexSessionMetaLine: extracts sessionId + cwd from a real session_meta line", () => {
  const line = JSON.stringify({
    type: "session_meta",
    payload: { session_id: "01a0-abc", cwd: "/Users/x/projects/goodcaseai", originator: "cli" },
  });
  const meta = parseCodexSessionMetaLine(line);
  assert.equal(meta.sessionId, "01a0-abc");
  assert.equal(meta.cwd, "/Users/x/projects/goodcaseai");
});

test("parseCodexSessionMetaLine: a non-session_meta line, or garbage, yields null", () => {
  assert.equal(parseCodexSessionMetaLine(JSON.stringify({ type: "response_item" })), null);
  assert.equal(parseCodexSessionMetaLine("not json"), null);
  assert.equal(parseCodexSessionMetaLine(null), null);
});

test("buildCodexEvent: assembles the full event shape", () => {
  const notifyPayload = { type: "agent-turn-complete" };
  const sessionMeta = { sessionId: "s1", cwd: "/x" };
  const gitFields = { repoRoot: "/x", branch: "main", worktree: "/x/.git" };
  const event = buildCodexEvent(notifyPayload, sessionMeta, gitFields, "/path/to/session.jsonl");
  assert.equal(event.source, "codex");
  assert.equal(event.event, "agent-turn-complete");
  assert.equal(event.sessionId, "s1");
  assert.equal(event.cwd, "/x");
  assert.equal(event.transcriptPath, "/path/to/session.jsonl");
});

// --- readFirstLine / findLatestCodexSessionFile (I/O) -------------------------

test("readFirstLine: returns just the first line of a multi-line file", () => {
  const dir = mkTmpDir("board-hooks-file-");
  const f = path.join(dir, "x.jsonl");
  fs.writeFileSync(f, "line one\nline two\nline three\n", "utf8");
  assert.equal(readFirstLine(f), "line one");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readFirstLine: a very long first line (bigger than one read chunk) is still returned whole", () => {
  const dir = mkTmpDir("board-hooks-file-");
  const f = path.join(dir, "x.jsonl");
  const longLine = "x".repeat(200000); // bigger than the 64KB internal read buffer
  fs.writeFileSync(f, longLine + "\nsecond line\n", "utf8");
  assert.equal(readFirstLine(f), longLine);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readFirstLine: a missing file returns null, never throws", () => {
  assert.equal(readFirstLine("/nonexistent/path/x.jsonl"), null);
});

test("findLatestCodexSessionFile: picks the most recently modified .jsonl across nested dirs", async () => {
  const dir = mkTmpDir("board-hooks-sessions-");
  const older = path.join(dir, "2026", "01", "01");
  const newer = path.join(dir, "2026", "02", "02");
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, "rollout-a.jsonl"), '{"type":"session_meta"}\n');
  await new Promise((r) => setTimeout(r, 10));
  fs.writeFileSync(path.join(newer, "rollout-b.jsonl"), '{"type":"session_meta"}\n');
  const latest = findLatestCodexSessionFile(dir);
  assert.equal(latest, path.join(newer, "rollout-b.jsonl"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findLatestCodexSessionFile: a missing/empty sessions dir returns null, never throws", () => {
  assert.equal(findLatestCodexSessionFile("/nonexistent/codex/sessions"), null);
});

test("recordCodexHookEvent: infers sessionId/cwd from the latest session file and writes an event", () => {
  const sessionsDir = mkTmpDir("board-hooks-sessions-");
  const day = path.join(sessionsDir, "2026", "09", "07");
  fs.mkdirSync(day, { recursive: true });
  const repoDir = initTmpRepo();
  fs.writeFileSync(
    path.join(day, "rollout-x.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { session_id: "codex-sess-1", cwd: repoDir } }) + "\n"
  );
  const cacheDir = mkTmpDir("board-hooks-cache-");
  const ok = recordCodexHookEvent(cacheDir, JSON.stringify({ type: "agent-turn-complete" }), sessionsDir);
  assert.equal(ok, true);
  const events = readHookEventsRaw(cacheDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "codex");
  assert.equal(events[0].sessionId, "codex-sess-1");
  assert.equal(events[0].branch, "main");
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("recordCodexHookEvent: nothing resolvable (no sessions dir, garbage arg) writes nothing and never throws", () => {
  const cacheDir = mkTmpDir("board-hooks-cache-");
  const ok = recordCodexHookEvent(cacheDir, "not json", "/nonexistent/codex/sessions");
  assert.equal(ok, false);
  assert.equal(readHookEventsRaw(cacheDir).length, 0);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

// --- Claude settings.json install plan (pure) + idempotency ------------------

test("claudeHookEventsInstalled: none installed on an empty settings object", () => {
  const installed = claudeHookEventsInstalled({});
  assert.deepEqual(installed, { SessionStart: false, Stop: false, UserPromptSubmit: false });
});

test("claudeHookEventsInstalled: detects an existing board hook entry among unrelated ones", () => {
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "startup", hooks: [{ type: "command", command: "some-other-tool" }] },
        { matcher: "", hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }] },
      ],
    },
  };
  const installed = claudeHookEventsInstalled(settings);
  assert.equal(installed.SessionStart, true);
  assert.equal(installed.Stop, false);
});

test("planClaudeSettingsInstall: adds the hook to all three events, preserving unrelated keys/entries", () => {
  const settings = {
    someOtherTopLevelKey: true,
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "existing-tool" }] }],
      Notification: [{ matcher: "*", hooks: [{ type: "command", command: "unrelated" }] }],
    },
  };
  const { settings: next, added } = planClaudeSettingsInstall(settings);
  assert.deepEqual(added.sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(next.someOtherTopLevelKey, true);
  assert.deepEqual(next.hooks.Notification, settings.hooks.Notification);
  // existing SessionStart entry preserved, new one appended (not replaced)
  assert.equal(next.hooks.SessionStart.length, 2);
  assert.equal(next.hooks.SessionStart[0].hooks[0].command, "existing-tool");
  assert.equal(next.hooks.SessionStart[1].hooks[0].command, CLAUDE_HOOK_COMMAND);
  assert.equal(next.hooks.Stop.length, 1);
  assert.equal(next.hooks.UserPromptSubmit.length, 1);
});

test("planClaudeSettingsInstall: idempotent — running twice adds nothing the second time", () => {
  const { settings: once } = planClaudeSettingsInstall({});
  const { settings: twice, added } = planClaudeSettingsInstall(once);
  assert.deepEqual(added, []);
  assert.deepEqual(twice, once);
});

test("installClaudeHooks: dry-run reports the plan but writes nothing, no file created", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const result = installClaudeHooks(cacheDir, { dryRun: true });
    assert.equal(result.changed, true);
    assert.deepEqual(result.added.sort(), ["SessionStart", "Stop", "UserPromptSubmit"]);
    assert.equal(fs.existsSync(claudeSettingsPath()), false);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installClaudeHooks: real run creates settings.json, backs up nothing (no prior file), then is a no-op idempotently", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const first = installClaudeHooks(cacheDir, { dryRun: false });
    assert.equal(first.changed, true);
    assert.equal(first.backupPath, null); // nothing existed to back up
    assert.equal(fs.existsSync(claudeSettingsPath()), true);

    const second = installClaudeHooks(cacheDir, { dryRun: false });
    assert.equal(second.changed, false);
    assert.deepEqual(second.added, []);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installClaudeHooks: backs up a pre-existing settings.json before overwriting", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(claudeSettingsPath(), JSON.stringify({ keepMe: "yes" }), "utf8");
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const result = installClaudeHooks(cacheDir, { dryRun: false });
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    const backedUp = JSON.parse(fs.readFileSync(result.backupPath, "utf8"));
    assert.equal(backedUp.keepMe, "yes");
    const written = JSON.parse(fs.readFileSync(claudeSettingsPath(), "utf8"));
    assert.equal(written.keepMe, "yes"); // preserved through the merge
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --- Codex notify TOML (hand-rolled scan, pure) -------------------------------

test("findCodexNotifyLine: no notify line at all", () => {
  const result = findCodexNotifyLine('model = "gpt-6"\nsandbox_mode = "danger-full-access"\n');
  assert.equal(result.found, false);
});

test("findCodexNotifyLine: existing notify line pointing elsewhere is detected but not board", () => {
  const result = findCodexNotifyLine('notify = ["/path/to/other-tool", "turn-ended"]\nmodel = "x"\n');
  assert.equal(result.found, true);
  assert.equal(result.hasBoard, false);
  assert.match(result.line, /other-tool/);
});

test("findCodexNotifyLine: existing notify line that already includes board is detected", () => {
  const result = findCodexNotifyLine(CODEX_NOTIFY_LINE + "\n");
  assert.equal(result.found, true);
  assert.equal(result.hasBoard, true);
});

test("installCodexNotify: no config.toml at all -> creates one with the notify line", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const result = installCodexNotify(cacheDir, { dryRun: false });
    assert.equal(result.action, "create");
    const text = fs.readFileSync(codexConfigPath(), "utf8");
    assert.match(text, /notify = \["board", "hook", "codex"\]/);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installCodexNotify: appends to an existing config.toml with no notify line, preserving the rest, and backs it up", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(codexConfigPath(), 'model = "gpt-6"\n', "utf8");
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const result = installCodexNotify(cacheDir, { dryRun: false });
    assert.equal(result.action, "append");
    assert.ok(result.backupPath && fs.existsSync(result.backupPath));
    const text = fs.readFileSync(codexConfigPath(), "utf8");
    assert.match(text, /model = "gpt-6"/);
    assert.match(text, /notify = \["board", "hook", "codex"\]/);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installCodexNotify: an existing notify line that already contains board is left untouched (skip)", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const original = `model = "gpt-6"\n${CODEX_NOTIFY_LINE}\n`;
    fs.writeFileSync(codexConfigPath(), original, "utf8");
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const result = installCodexNotify(cacheDir, { dryRun: false });
    assert.equal(result.action, "skip-already-installed");
    assert.equal(fs.readFileSync(codexConfigPath(), "utf8"), original); // byte-for-byte untouched
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installCodexNotify: an existing notify line pointing elsewhere is NEVER modified — reported as 'manual' instead", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const original = 'notify = ["/path/to/other-tool", "turn-ended"]\nmodel = "x"\n';
    fs.writeFileSync(codexConfigPath(), original, "utf8");
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const result = installCodexNotify(cacheDir, { dryRun: false });
    assert.equal(result.action, "manual");
    assert.match(result.existingLine, /other-tool/);
    assert.equal(result.suggestedLine, CODEX_NOTIFY_LINE);
    assert.equal(fs.readFileSync(codexConfigPath(), "utf8"), original); // byte-for-byte untouched
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installCodexNotify: dry-run never writes", () => {
  const home = mkTmpDir("board-hooks-home-");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cacheDir = mkTmpDir("board-hooks-cache-");
    const result = installCodexNotify(cacheDir, { dryRun: true });
    assert.equal(result.action, "create");
    assert.equal(fs.existsSync(codexConfigPath()), false);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
