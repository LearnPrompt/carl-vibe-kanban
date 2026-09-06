// Card storage: stable ids, frontmatter read/write, idempotent comparison.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.mjs";

// Fixed frontmatter key order (must match board-spec-v0.md exactly).
export const CARD_KEY_ORDER = [
  "id",
  "repo",
  "title",
  "branch",
  "worktree",
  "worktree_state",
  "pr",
  "pr_state",
  "pr_url",
  "last_commit",
  "last_commit_at",
  "last_commit_msg",
  "ahead",
  "behind",
  "stage",
  "dirty_files",
  "unpushed_commits",
  "base",
  "status",
  "status_pinned",
  "agent",
  "evidence",
  "next_step",
  "created",
  "updated",
  "flags",
  "conflicts_with",
  "keys",
];

export function computeId(naturalKey) {
  const hash = crypto.createHash("sha1").update(naturalKey).digest("hex");
  return `T-${hash.slice(0, 6)}`;
}

// Builds the ordered frontmatter object from a loosely-shaped fields object.
export function buildCardData(fields) {
  const ordered = {};
  for (const key of CARD_KEY_ORDER) {
    ordered[key] = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : null;
  }
  // Arrays default to [] rather than null when unset.
  if (ordered.evidence === null) ordered.evidence = [];
  if (ordered.flags === null) ordered.flags = [];
  if (ordered.keys === null) ordered.keys = [];
  if (ordered.conflicts_with === null) ordered.conflicts_with = [];
  // Counters default to 0 rather than null when unset (board-spec-v0.1).
  if (ordered.dirty_files === null) ordered.dirty_files = 0;
  if (ordered.unpushed_commits === null) ordered.unpushed_commits = 0;
  return ordered;
}

export function cardsEqualIgnoringUpdated(a, b) {
  const strip = (obj) => {
    const { updated, ...rest } = obj;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export function unionKeys(existingKeys, newKeys) {
  const set = new Set([...(existingKeys || []), ...(newKeys || [])].filter(Boolean));
  return Array.from(set).sort();
}

export function ensureBoardDirs(boardRoot) {
  const tasksDir = path.join(boardRoot, "board", "tasks");
  const archiveDir = path.join(boardRoot, "board", "archive");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  return { tasksDir, archiveDir };
}

export function tasksDirFor(boardRoot) {
  return path.join(boardRoot, "board", "tasks");
}

export function archiveDirFor(boardRoot) {
  return path.join(boardRoot, "board", "archive");
}

export function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dir, f));
}

export function readCardFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const { data, body } = parseFrontmatter(text);
  return { filePath, data, body };
}

export function readAllCards(dir) {
  return listMarkdownFiles(dir).map(readCardFile);
}

export function writeCardFile(dir, id, data, body) {
  const filePath = path.join(dir, `${id}.md`);
  const text = stringifyFrontmatter(data, body);
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

export function deleteCardFile(dir, id) {
  const filePath = path.join(dir, `${id}.md`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// Finds an existing card whose `keys` (or id) intersects any of the given
// candidate natural keys. Used by discovery to avoid duplicate cards across
// detached -> checkout transitions etc.
export function findCardByAnyKey(cards, candidateKeys) {
  const candidateSet = new Set(candidateKeys.filter(Boolean));
  return cards.find((card) => {
    const keys = card.data.keys || [];
    return keys.some((k) => candidateSet.has(k));
  });
}

export function moveCardToArchive(boardRoot, id) {
  const { tasksDir, archiveDir } = ensureBoardDirs(boardRoot);
  const src = path.join(tasksDir, `${id}.md`);
  const dest = path.join(archiveDir, `${id}.md`);
  if (!fs.existsSync(src)) return false;
  fs.renameSync(src, dest);
  return true;
}

export function listArchivedIds(boardRoot) {
  const dir = archiveDirFor(boardRoot);
  return listMarkdownFiles(dir).map((f) => path.basename(f, ".md"));
}
