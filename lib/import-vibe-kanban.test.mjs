import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import * as store from "./store.mjs";
import {
  defaultDbPath,
  defaultDbCandidates,
  mapVkStatus,
  readSqliteSource,
  readJsonSource,
  loadVibeKanbanData,
  resolveProjectRepo,
  naturalKeyFor,
  buildImportLine,
  upsertImportLine,
  prEvidenceLines,
  planImport,
  applyRepoPlan,
  summarizePlan,
} from "./import-vibe-kanban.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- fixture: a small sqlite db built from the *modern* vibe-kanban schema
// (workspaces + repos + project_repos + pull_requests, current as of the
// crates/db/migrations/*.sql history read from BloopAI/vibe-kanban) --------

function blob16(seed) {
  // deterministic 16-byte "uuid-ish" blob so hex ids are stable across runs;
  // hashed (not written as raw hex) so arbitrary ASCII seeds like "t1"/"pra"
  // always produce 16 well-formed, distinct bytes.
  return crypto.createHash("sha1").update(seed).digest().subarray(0, 16);
}

function buildFixtureDb(dbPath, { repoAPath, repoBPath }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id BLOB PRIMARY KEY,
      name TEXT NOT NULL,
      dev_script TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE repos (
      id BLOB PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL
    );
    CREATE TABLE project_repos (
      id BLOB PRIMARY KEY,
      project_id BLOB NOT NULL,
      repo_id BLOB NOT NULL
    );
    CREATE TABLE tasks (
      id BLOB PRIMARY KEY,
      project_id BLOB NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL CHECK (status IN ('todo','inprogress','done','cancelled','inreview')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workspaces (
      id BLOB PRIMARY KEY,
      task_id BLOB,
      branch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pull_requests (
      id TEXT PRIMARY KEY,
      workspace_id BLOB,
      repo_id BLOB,
      pr_url TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_status TEXT NOT NULL,
      target_branch_name TEXT NOT NULL
    );
  `);

  const insProject = db.prepare("INSERT INTO projects (id, name, dev_script, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)");
  const insRepo = db.prepare("INSERT INTO repos (id, path, name, display_name) VALUES (?, ?, ?, ?)");
  const insProjectRepo = db.prepare("INSERT INTO project_repos (id, project_id, repo_id) VALUES (?, ?, ?)");
  const insTask = db.prepare(
    "INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const insWorkspace = db.prepare(
    "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insPr = db.prepare(
    "INSERT INTO pull_requests (id, workspace_id, repo_id, pr_url, pr_number, pr_status, target_branch_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  const projectA = blob16("aa");
  const projectB = blob16("bb");
  const repoA = blob16("a1");
  const repoB = blob16("b1");

  insProject.run(projectA, "Project A", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  insProject.run(projectB, "Project B", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  insRepo.run(repoA, repoAPath, "repo-a", "Repo A");
  insRepo.run(repoB, repoBPath, "repo-b", "Repo B");
  insProjectRepo.run(blob16("pra"), projectA, repoA);
  insProjectRepo.run(blob16("prb"), projectB, repoB);

  const tasks = [
    { id: blob16("t1"), project: projectA, title: "Task todo", status: "todo", branch: "feat/todo" },
    { id: blob16("t2"), project: projectA, title: "Task inprogress", status: "inprogress", branch: "feat/inprogress" },
    { id: blob16("t3"), project: projectA, title: "Task inreview", status: "inreview", branch: "feat/inreview" },
    { id: blob16("t4"), project: projectB, title: "Task done", status: "done", branch: "feat/done" },
    { id: blob16("t5"), project: projectB, title: "Task cancelled, no branch", status: "cancelled", branch: null },
  ];

  for (const t of tasks) {
    insTask.run(t.id, t.project, t.title, `desc for ${t.title}`, t.status, "2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z");
    if (t.branch) {
      const wsId = Buffer.concat([t.id]); // reuse task id bytes as workspace id (fine for a fixture)
      insWorkspace.run(wsId, t.id, t.branch, "2026-02-01T01:00:00Z", "2026-02-01T01:00:00Z");
      if (t.title === "Task inprogress") {
        insPr.run("pr-1", wsId, repoA, "https://github.com/x/y/pull/42", 42, "open", "main");
      }
    }
  }

  db.close();
}

test("readSqliteSource: parses the modern (workspaces + repos + project_repos + pull_requests) schema", async () => {
  const dir = tmpDir("vk-import-sqlite-");
  const dbPath = path.join(dir, "db.v2.sqlite");
  const repoAPath = path.join(dir, "repo-a");
  const repoBPath = path.join(dir, "repo-b");
  fs.mkdirSync(repoAPath, { recursive: true });
  fs.mkdirSync(repoBPath, { recursive: true });
  buildFixtureDb(dbPath, { repoAPath, repoBPath });

  const data = await readSqliteSource(dbPath);
  assert.equal(data.projects.length, 2);
  assert.equal(data.tasks.length, 5);

  const byTitle = Object.fromEntries(data.tasks.map((t) => [t.title, t]));
  assert.equal(byTitle["Task todo"].branch, "feat/todo");
  assert.equal(mapVkStatus(byTitle["Task todo"].status), "backlog");
  assert.equal(mapVkStatus(byTitle["Task inprogress"].status), "doing");
  assert.equal(mapVkStatus(byTitle["Task inreview"].status), "review");
  assert.equal(mapVkStatus(byTitle["Task done"].status), "done");
  assert.equal(mapVkStatus(byTitle["Task cancelled, no branch"].status), "dropped");

  assert.equal(byTitle["Task cancelled, no branch"].branch, null);
  assert.deepEqual(byTitle["Task inprogress"].prs, [{ number: 42, url: "https://github.com/x/y/pull/42", status: "open" }]);
  assert.deepEqual(byTitle["Task todo"].prs, []);

  const projA = data.projects.find((p) => p.name === "Project A");
  assert.deepEqual(projA.repoPaths, [repoAPath]);
});

test("readSqliteSource: missing db file throws a clear error", async () => {
  await assert.rejects(() => readSqliteSource("/nonexistent/path/db.v2.sqlite"), /找不到 vibe-kanban 数据库文件/);
});

test("readSqliteSource: missing node:sqlite module surfaces an upgrade-Node hint (mocked loader)", async () => {
  const failingLoader = () => Promise.reject(new Error("No such built-in module: node:sqlite"));
  await assert.rejects(
    () => readSqliteSource("/tmp/whatever.sqlite", { loadSqliteModule: failingLoader }),
    /Node >= 22\.13|升级 Node/
  );
});

test("defaultDbPath points at ai.bloop.vibe-kanban/db.v2.sqlite on macOS", () => {
  if (process.platform !== "darwin") return;
  const p = defaultDbPath();
  assert.match(p, /Library\/Application Support\/ai\.bloop\.vibe-kanban\/db\.v2\.sqlite$/);
});

test("readJsonSource: normalizes the board's own JSON export shape", () => {
  const dir = tmpDir("vk-import-json-");
  const jsonPath = path.join(dir, "export.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      projects: [{ id: "p1", name: "P1", repoPaths: ["/repo/p1"] }],
      tasks: [{ id: "t1", projectId: "p1", title: "T1", status: "todo", createdAt: "2026-01-01", branch: "b1", prs: [] }],
    })
  );
  const data = readJsonSource(jsonPath);
  assert.equal(data.projects.length, 1);
  assert.equal(data.tasks[0].title, "T1");
});

test("loadVibeKanbanData dispatches by extension and rejects unknown ones", async () => {
  await assert.rejects(() => loadVibeKanbanData("/tmp/whatever.txt"), /不认识的文件类型/);
});

test("resolveProjectRepo matches by realpath against candidates, falls back to override", () => {
  const dir = tmpDir("vk-import-resolve-");
  const repoPath = path.join(dir, "repo");
  fs.mkdirSync(repoPath);
  const project = { repoPaths: [repoPath] };

  const matched = resolveProjectRepo(project, {
    candidateRepos: [{ repoRoot: repoPath, repoLabel: "repo" }],
  });
  assert.deepEqual(matched, { repoRoot: repoPath, repoLabel: "repo" });

  const unmatched = resolveProjectRepo({ repoPaths: ["/somewhere/else"] }, { candidateRepos: [] });
  assert.equal(unmatched, null);

  const overridden = resolveProjectRepo(
    { repoPaths: ["/somewhere/else"] },
    { candidateRepos: [], repoOverride: { repoRoot: "/override", repoLabel: "override" } }
  );
  assert.deepEqual(overridden, { repoRoot: "/override", repoLabel: "override" });
});

test("naturalKeyFor / buildImportLine / upsertImportLine round-trip", () => {
  const task = { id: "abc123", status: "todo", createdAt: "2026-01-01T00:00:00Z" };
  assert.equal(naturalKeyFor("abc123"), "vk:abc123");
  const line = buildImportLine(task);
  assert.equal(line, "导入自 vibe-kanban task abc123（todo，2026-01-01T00:00:00Z）");

  const first = upsertImportLine("", task);
  assert.equal(first.changed, true);
  assert.match(first.body, /导入自 vibe-kanban task abc123/);

  const sameAgain = upsertImportLine(first.body, task);
  assert.equal(sameAgain.changed, false);

  const movedTask = { ...task, status: "done" };
  const updated = upsertImportLine(first.body, movedTask);
  assert.equal(updated.changed, true);
  assert.match(updated.body, /task abc123（done/);
  assert.doesNotMatch(updated.body, /task abc123（todo/);
});

test("prEvidenceLines formats PR entries and skips PRs without a number", () => {
  const lines = prEvidenceLines({ prs: [{ number: 42, url: "https://x/42", status: "open" }, { number: null }] });
  assert.deepEqual(lines, ["PR #42 https://x/42 (open)"]);
});

// --- end-to-end plan/apply idempotency, against real store.mjs on disk -------

function makeBoardRoot() {
  return tmpDir("vk-import-board-");
}

test("planImport + applyRepoPlan: creates cards, is idempotent on re-import, skips branchless by default", () => {
  const repoRoot = makeBoardRoot();
  const data = {
    projects: [{ id: "p1", name: "P1", repoPaths: [repoRoot] }],
    tasks: [
      { id: "t1", projectId: "p1", title: "Has branch", description: "d1", status: "todo", createdAt: "2026-01-01", branch: "feat/a", prs: [] },
      { id: "t2", projectId: "p1", title: "No branch", description: "d2", status: "cancelled", createdAt: "2026-01-01", branch: null, prs: [] },
      {
        id: "t3",
        projectId: "p1",
        title: "Has PR",
        description: "d3",
        status: "inreview",
        createdAt: "2026-01-01",
        branch: "feat/c",
        prs: [{ number: 7, url: "https://x/7", status: "open" }],
      },
    ],
  };
  const resolveRepo = () => ({ repoRoot, repoLabel: "p1" });

  // first pass: no existing cards yet
  const plan1 = planImport(data, { resolveRepo, branchless: false, existingCardsByRepo: new Map() });
  assert.equal(plan1.length, 1);
  const outcomes1 = plan1[0].entries.map((e) => e.outcome);
  assert.deepEqual(outcomes1.sort(), ["new", "new", "skip-no-branch"].sort());

  const result1 = applyRepoPlan(repoRoot, plan1[0].entries);
  assert.equal(result1.created, 2);

  const cardsOnDisk = store.readAllCards(store.tasksDirFor(repoRoot));
  assert.equal(cardsOnDisk.length, 2);
  const hasBranchCard = cardsOnDisk.find((c) => c.data.branch === "feat/a");
  assert.equal(hasBranchCard.data.status, "backlog");
  assert.equal(hasBranchCard.data.status_pinned, true);
  assert.deepEqual(hasBranchCard.data.keys, ["vk:t1"]);
  assert.match(hasBranchCard.body, /导入自 vibe-kanban task t1/);
  assert.match(hasBranchCard.body, /d1/);

  const prCard = cardsOnDisk.find((c) => c.data.branch === "feat/c");
  assert.deepEqual(prCard.data.evidence, ["PR #7 https://x/7 (open)"]);
  assert.equal(prCard.data.status, "review");

  // second pass: re-import the SAME data — must be idempotent (no duplicate
  // cards, no field overwrite), even after a human hand-edits next_step.
  const tasksDir = store.tasksDirFor(repoRoot);
  const manual = store.readCardFile(path.join(tasksDir, hasBranchCard.data.id + ".md"));
  const manualData = { ...manual.data, next_step: "human wrote this", status: "doing" };
  store.writeCardFile(tasksDir, manualData.id, store.buildCardData(manualData), manual.body);

  const existingCardsByRepo = new Map([[repoRoot, store.readAllCards(tasksDir)]]);
  const plan2 = planImport(data, { resolveRepo, branchless: false, existingCardsByRepo });
  const outcomes2 = plan2[0].entries.map((e) => e.outcome);
  assert.deepEqual(outcomes2.sort(), ["unchanged", "unchanged", "skip-no-branch"].sort());

  const result2 = applyRepoPlan(repoRoot, plan2[0].entries);
  assert.deepEqual(result2, { created: 0, updated: 0, unchanged: 2 });

  const cardsAfter = store.readAllCards(tasksDir);
  assert.equal(cardsAfter.length, 2); // still no duplicate card
  const untouched = cardsAfter.find((c) => c.data.id === hasBranchCard.data.id);
  assert.equal(untouched.data.next_step, "human wrote this"); // human field preserved
  assert.equal(untouched.data.status, "doing"); // human status change preserved, not re-pinned over
});

test("planImport: --branchless imports tasks with no branch too", () => {
  const repoRoot = makeBoardRoot();
  const data = {
    projects: [{ id: "p1", name: "P1", repoPaths: [repoRoot] }],
    tasks: [{ id: "t9", projectId: "p1", title: "No branch", description: "", status: "todo", createdAt: "2026-01-01", branch: null, prs: [] }],
  };
  const resolveRepo = () => ({ repoRoot, repoLabel: "p1" });
  const plan = planImport(data, { resolveRepo, branchless: true, existingCardsByRepo: new Map() });
  assert.equal(plan[0].entries[0].outcome, "new");
  const result = applyRepoPlan(repoRoot, plan[0].entries);
  assert.equal(result.created, 1);
});

test("planImport: a project with no resolvable repo lands in the unresolved bucket", () => {
  const data = {
    projects: [{ id: "p1", name: "Orphan", repoPaths: ["/nowhere"] }],
    tasks: [{ id: "t1", projectId: "p1", title: "X", description: "", status: "todo", createdAt: "2026-01-01", branch: "b", prs: [] }],
  };
  const resolveRepo = () => null;
  const plan = planImport(data, { resolveRepo, branchless: false, existingCardsByRepo: new Map() });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].repoRoot, null);
  assert.equal(plan[0].entries[0].outcome, "skip-no-repo");
});

test("summarizePlan renders a per-repo table without throwing on the unresolved bucket", () => {
  const perRepo = [
    {
      repoRoot: null,
      repoLabel: null,
      projectNames: new Set(["Orphan (/nowhere)"]),
      entries: [{ task: { status: "todo", branch: "b" }, outcome: "skip-no-repo" }],
    },
  ];
  const lines = summarizePlan(perRepo);
  assert.ok(lines.some((l) => l.includes("未匹配到本地仓库")));
});
