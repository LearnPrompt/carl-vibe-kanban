// Import Vibe Kanban (BloopAI/vibe-kanban, the local-first desktop task board)
// data into board markdown cards. Zero npm dependencies: the sqlite path uses
// Node's built-in node:sqlite (DatabaseSync, Node >= 22.13); the json path
// reads a plain normalized export (see NORMALIZED JSON below — there is no
// official/community JSON export for vibe-kanban's *local* sqlite data as of
// this writing; discussion #3412 / issue #3396 and domjancik's
// vibe-kanban-bloop-migration repo only cover CSV migration off the
// now-shut-down Bloop Cloud SaaS "Projects" feature, a different product
// surface from the local desktop task board this command targets).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as store from "./store.mjs";

// --- default db path (crates/utils/src/assets.rs: ProjectDirs::from("ai","bloop","vibe-kanban"),
// crates/db/src/lib.rs: asset_dir().join("db.v2.sqlite")) -----------------------

export function defaultDbPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "ai.bloop.vibe-kanban", "db.v2.sqlite");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "bloop", "vibe-kanban", "data", "db.v2.sqlite");
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(dataHome, "vibe-kanban", "db.v2.sqlite");
}

// --- status mapping (tasks.status CHECK constraint, unchanged since the very
// first migration: todo|inprogress|done|cancelled|inreview) --------------------

const STATUS_MAP = {
  todo: "backlog",
  inprogress: "doing",
  inreview: "review",
  done: "done",
  cancelled: "dropped",
};

export function mapVkStatus(vkStatus) {
  return STATUS_MAP[vkStatus] || "backlog";
}

// --- normalized shape used by both readers -------------------------------------
// { projects: [{ id, name, repoPaths: [string,...] }],
//   tasks: [{ id, projectId, title, description, status, createdAt, updatedAt,
//             branch: string|null, prs: [{ number, url, status }] }] }

function bufToHex(v) {
  if (v == null) return v;
  if (Buffer.isBuffer(v)) return v.toString("hex");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  return String(v);
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return !!row;
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

// --- sqlite reader ---------------------------------------------------------------
//
// Supports two schema eras, feature-detected (no hardcoded version dates):
//   modern: workspaces + repos + project_repos (+ pull_requests for PR tracking)
//   legacy: task_attempts + projects.git_repo_path (pre multi-repo refactor)
// `loadSqliteModule` is injectable so tests can simulate "no node:sqlite".

export async function readSqliteSource(dbPath, { loadSqliteModule } = {}) {
  const loader = loadSqliteModule || (() => import("node:sqlite"));
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await loader());
  } catch (err) {
    const e = new Error(
      `此 Node 版本没有内置 node:sqlite（需要 Node >= 22.13）。请升级 Node，或改用 vibe-kanban 的 JSON 导出格式。原始错误: ${err.message}`
    );
    e.cause = err;
    throw e;
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`找不到 vibe-kanban 数据库文件: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true, open: true });
  try {
    const modern = tableExists(db, "workspaces");

    let projects;
    if (modern && tableExists(db, "repos") && tableExists(db, "project_repos")) {
      const rows = db
        .prepare(
          `SELECT p.id AS project_id, p.name AS project_name, r.path AS repo_path
           FROM projects p
           JOIN project_repos pr ON pr.project_id = p.id
           JOIN repos r ON r.id = pr.repo_id`
        )
        .all();
      const byProject = new Map();
      for (const r of rows) {
        const pid = bufToHex(r.project_id);
        if (!byProject.has(pid)) byProject.set(pid, { id: pid, name: r.project_name, repoPaths: [] });
        byProject.get(pid).repoPaths.push(r.repo_path);
      }
      // Projects with zero linked repos still need to appear (e.g. cloud-only).
      for (const p of db.prepare("SELECT id, name FROM projects").all()) {
        const pid = bufToHex(p.id);
        if (!byProject.has(pid)) byProject.set(pid, { id: pid, name: p.name, repoPaths: [] });
      }
      projects = Array.from(byProject.values());
    } else {
      // legacy: projects.git_repo_path
      projects = db
        .prepare("SELECT id, name, git_repo_path FROM projects")
        .all()
        .map((p) => ({ id: bufToHex(p.id), name: p.name, repoPaths: p.git_repo_path ? [p.git_repo_path] : [] }));
    }

    const taskRows = db
      .prepare("SELECT id, project_id, title, description, status, created_at, updated_at FROM tasks")
      .all();

    // branch + PRs come from the task's latest attempt/workspace.
    const branchAndPrByTask = new Map();
    if (modern) {
      const attemptTable = "workspaces";
      const cols = columnsOf(db, attemptTable);
      const hasBranch = cols.includes("branch");
      const attempts = db
        .prepare(`SELECT id, task_id, ${hasBranch ? "branch" : "NULL AS branch"}, created_at FROM ${attemptTable} ORDER BY created_at ASC`)
        .all();
      const latestByTask = new Map();
      for (const a of attempts) latestByTask.set(bufToHex(a.task_id), a); // ORDER BY asc -> last write wins = latest
      const hasPullRequests = tableExists(db, "pull_requests");
      for (const [taskId, attempt] of latestByTask) {
        const prs = [];
        if (hasPullRequests) {
          const prRows = db
            .prepare("SELECT pr_number, pr_url, pr_status FROM pull_requests WHERE workspace_id = ?")
            .all(attempt.id);
          for (const pr of prRows) prs.push({ number: pr.pr_number, url: pr.pr_url, status: pr.pr_status });
        }
        if (prs.length === 0 && tableExists(db, "merges")) {
          const mergeCols = columnsOf(db, "merges");
          if (mergeCols.includes("workspace_id") && mergeCols.includes("pr_number")) {
            const mergeRows = db
              .prepare("SELECT pr_number, pr_url, pr_status FROM merges WHERE workspace_id = ? AND merge_type = 'pr'")
              .all(attempt.id);
            for (const pr of mergeRows) prs.push({ number: pr.pr_number, url: pr.pr_url, status: pr.pr_status });
          }
        }
        branchAndPrByTask.set(taskId, { branch: attempt.branch || null, prs });
      }
    } else if (tableExists(db, "task_attempts")) {
      const cols = columnsOf(db, "task_attempts");
      const hasBranch = cols.includes("branch");
      const attempts = db
        .prepare(`SELECT id, task_id, ${hasBranch ? "branch" : "NULL AS branch"}, created_at FROM task_attempts ORDER BY created_at ASC`)
        .all();
      const latestByTask = new Map();
      for (const a of attempts) latestByTask.set(bufToHex(a.task_id), a);
      const hasMerges = tableExists(db, "merges");
      const mergeCols = hasMerges ? columnsOf(db, "merges") : [];
      for (const [taskId, attempt] of latestByTask) {
        const prs = [];
        if (hasMerges && mergeCols.includes("task_attempt_id") && mergeCols.includes("pr_number")) {
          const mergeRows = db
            .prepare("SELECT pr_number, pr_url, pr_status FROM merges WHERE task_attempt_id = ? AND merge_type = 'pr'")
            .all(attempt.id);
          for (const pr of mergeRows) prs.push({ number: pr.pr_number, url: pr.pr_url, status: pr.pr_status });
        } else if (cols.includes("pr_number")) {
          const row = db.prepare("SELECT pr_number, pr_url, pr_status FROM task_attempts WHERE id = ?").get(attempt.id);
          if (row && row.pr_number) prs.push({ number: row.pr_number, url: row.pr_url, status: row.pr_status });
        }
        branchAndPrByTask.set(taskId, { branch: attempt.branch || null, prs });
      }
    }

    const tasks = taskRows.map((t) => {
      const id = bufToHex(t.id);
      const extra = branchAndPrByTask.get(id) || { branch: null, prs: [] };
      return {
        id,
        projectId: bufToHex(t.project_id),
        title: t.title,
        description: t.description || "",
        status: t.status,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        branch: extra.branch,
        prs: extra.prs,
      };
    });

    return { projects, tasks };
  } finally {
    db.close();
  }
}

// --- json reader -----------------------------------------------------------------
// NORMALIZED JSON shape (board's own — see module header for why there's no
// official export to target instead):
// { "projects": [{ "id": "...", "name": "...", "repoPaths": ["..."] }],
//   "tasks": [{ "id": "...", "projectId": "...", "title": "...", "description": "",
//               "status": "todo|inprogress|inreview|done|cancelled",
//               "createdAt": "...", "updatedAt": "...", "branch": "..."|null,
//               "prs": [{ "number": 1, "url": "...", "status": "open" }] }] }

export function readJsonSource(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`找不到导入文件: ${jsonPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  return {
    projects: projects.map((p) => ({ id: String(p.id), name: p.name || p.id, repoPaths: p.repoPaths || [] })),
    tasks: tasks.map((t) => ({
      id: String(t.id),
      projectId: String(t.projectId),
      title: t.title || "",
      description: t.description || "",
      status: t.status || "todo",
      createdAt: t.createdAt || null,
      updatedAt: t.updatedAt || null,
      branch: t.branch || null,
      prs: Array.isArray(t.prs) ? t.prs : [],
    })),
  };
}

export async function loadVibeKanbanData(sourcePath, opts = {}) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".json") return readJsonSource(sourcePath);
  if (ext === ".sqlite" || ext === ".db") return readSqliteSource(sourcePath, opts);
  throw new Error(`不认识的文件类型: ${sourcePath}（要 .sqlite/.db 或 .json）`);
}

// --- repo resolution ---------------------------------------------------------------
// candidateRepos: [{ repoRoot, repoLabel }] — workspace.repos entries plus (when
// running inside a specific repo) that repo itself. Matched by realpath against
// every repoPath the vk project reports. repoOverride is the --repo fallback,
// used only when no candidate matched.

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function resolveProjectRepo(project, { candidateRepos = [], repoOverride = null } = {}) {
  const projectRealpaths = (project.repoPaths || []).map((p) => safeRealpath(p));
  for (const candidate of candidateRepos) {
    const candidateReal = safeRealpath(candidate.repoRoot);
    if (projectRealpaths.includes(candidateReal)) return candidate;
  }
  if (repoOverride) return repoOverride;
  return null;
}

// --- card mapping ---------------------------------------------------------------

export function naturalKeyFor(taskId) {
  return `vk:${taskId}`;
}

export function buildImportLine(task) {
  return `导入自 vibe-kanban task ${task.id}（${task.status}，${task.createdAt}）`;
}

// Replaces the existing import-line for this task if present, else appends a
// new one via store.appendBodyLine. Everything else in body is left alone —
// this is the only mutation a re-import is allowed to make to an existing card.
export function upsertImportLine(body, task) {
  const importLine = buildImportLine(task);
  const marker = `导入自 vibe-kanban task ${task.id}`;
  const original = body || "";
  const lines = original.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(marker));
  if (idx === -1) {
    return { body: store.appendBodyLine(original, importLine), changed: true };
  }
  if (lines[idx] === importLine) return { body: original, changed: false };
  lines[idx] = importLine;
  return { body: lines.join("\n"), changed: true };
}

export function prEvidenceLines(task) {
  return (task.prs || [])
    .filter((pr) => pr.number)
    .map((pr) => `PR #${pr.number} ${pr.url || ""} (${pr.status || "unknown"})`.trim());
}

// --- plan / apply ---------------------------------------------------------------
//
// Builds a per-repo import plan without touching disk. `resolveRepo(project)`
// -> {repoRoot, repoLabel} | null. Each plan task entry carries `outcome`:
// "new" | "unchanged" | "updated" | "skip-no-branch" | "skip-no-repo".

export function planImport(data, { resolveRepo, branchless = false, existingCardsByRepo = new Map() } = {}) {
  const projectsById = new Map(data.projects.map((p) => [p.id, p]));
  const perRepo = new Map(); // repoRoot -> { repoRoot, repoLabel, projectNames: Set, entries: [] }

  for (const task of data.tasks) {
    const project = projectsById.get(task.projectId);
    const repo = project ? resolveRepo(project) : null;
    if (!repo) {
      const bucket = perRepo.get("__unresolved__") || {
        repoRoot: null,
        repoLabel: null,
        projectNames: new Set(),
        entries: [],
      };
      bucket.projectNames.add(project ? `${project.name} (${(project.repoPaths || []).join(", ") || "无关联仓库路径"})` : task.projectId);
      bucket.entries.push({ task, outcome: "skip-no-repo" });
      perRepo.set("__unresolved__", bucket);
      continue;
    }
    if (!task.branch && !branchless) {
      const bucket = perRepo.get(repo.repoRoot) || {
        repoRoot: repo.repoRoot,
        repoLabel: repo.repoLabel,
        projectNames: new Set(),
        entries: [],
      };
      bucket.projectNames.add(project.name);
      bucket.entries.push({ task, outcome: "skip-no-branch" });
      perRepo.set(repo.repoRoot, bucket);
      continue;
    }

    const bucket = perRepo.get(repo.repoRoot) || {
      repoRoot: repo.repoRoot,
      repoLabel: repo.repoLabel,
      projectNames: new Set(),
      entries: [],
    };
    bucket.projectNames.add(project.name);

    const id = store.computeId(naturalKeyFor(task.id));
    const cards = existingCardsByRepo.get(repo.repoRoot) || [];
    const existing = cards.find((c) => c.data.id === id);

    if (!existing) {
      bucket.entries.push({ task, outcome: "new", id });
    } else {
      const { changed } = upsertImportLine(existing.body || "", task);
      bucket.entries.push({ task, outcome: changed ? "updated" : "unchanged", id, existing });
    }
    perRepo.set(repo.repoRoot, bucket);
  }

  return Array.from(perRepo.values());
}

function nowIso() {
  return new Date().toISOString();
}

// Applies one repo bucket's plan entries to disk. Returns counts.
export function applyRepoPlan(repoRoot, entries) {
  const { tasksDir } = store.ensureBoardDirs(repoRoot);
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const entry of entries) {
    if (entry.outcome === "skip-no-branch" || entry.outcome === "skip-no-repo") continue;
    const { task, id } = entry;

    if (entry.outcome === "new") {
      const importLine = buildImportLine(task);
      let body = task.description && task.description.trim() ? `${task.description.trim()}\n\n` : "";
      body = store.appendBodyLine(body, importLine);
      const now = nowIso();
      const fields = {
        id,
        title: task.title,
        branch: task.branch || null,
        next_step: "",
        evidence: prEvidenceLines(task),
        agent: null,
        status_pinned: true,
        status: mapVkStatus(task.status),
        created: now,
        updated: now,
        flags: [],
        keys: [naturalKeyFor(task.id)],
      };
      store.writeCardFile(tasksDir, id, store.buildCardData(fields), body);
      created++;
    } else if (entry.outcome === "updated") {
      const { body } = upsertImportLine(entry.existing.body || "", task);
      const data = { ...entry.existing.data, updated: nowIso() };
      store.writeCardFile(tasksDir, id, store.buildCardData(data), body);
      updated++;
    } else if (entry.outcome === "unchanged") {
      unchanged++;
    }
  }

  return { created, updated, unchanged };
}

// --- dry-run summary table ---------------------------------------------------------

export function summarizePlan(perRepo) {
  const lines = [];
  for (const bucket of perRepo) {
    const label = bucket.repoRoot ? `${bucket.repoLabel}  ${bucket.repoRoot}` : "(未匹配到本地仓库)";
    const projects = Array.from(bucket.projectNames).join(", ");
    const total = bucket.entries.length;
    const withBranch = bucket.entries.filter((e) => e.task.branch).length;
    const withoutBranch = total - withBranch;
    const statusCounts = {};
    for (const e of bucket.entries) {
      const s = e.task.status;
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }
    const statusStr = Object.entries(statusCounts)
      .map(([s, n]) => `${s}:${n}`)
      .join(" ");
    const outcomeCounts = {};
    for (const e of bucket.entries) outcomeCounts[e.outcome] = (outcomeCounts[e.outcome] || 0) + 1;
    const outcomeStr = Object.entries(outcomeCounts)
      .map(([o, n]) => `${o}:${n}`)
      .join(" ");
    lines.push(`${label}`);
    lines.push(`  project: ${projects || "-"}`);
    lines.push(`  tasks: ${total}  有分支: ${withBranch}  无分支: ${withoutBranch}`);
    lines.push(`  状态分布: ${statusStr || "-"}`);
    lines.push(`  outcome: ${outcomeStr || "-"}`);
  }
  return lines;
}
