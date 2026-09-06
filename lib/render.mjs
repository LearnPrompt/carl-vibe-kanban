// Renders the static board/index.html viewer. Pure string-building function
// (no fs/process access) so it stays unit-testable; board.mjs writes the
// returned string to disk.
//
// Visual language borrowed from goodcase.ai / aimap (carlwow.com/aimap):
// warm off-white paper, 1px hairline borders, zero border-radius, one
// accent color, mono labels. See board-spec-v0.2.md section B for the
// full spec this file implements.

const COLUMN_ORDER = ["backlog", "doing", "review", "blocked", "done", "dropped"];

const COLUMN_LABELS = {
  backlog: "待办",
  doing: "进行中",
  review: "待审",
  blocked: "阻塞",
  done: "完成",
  dropped: "放弃",
};

const RED_FLAGS = new Set(["branch_missing", "stale_7d", "prunable", "pr_closed_unmerged"]);

export function cardColor(card) {
  const flags = card.flags || [];
  const isRed =
    card.status === "blocked" ||
    card.status === "dropped" ||
    flags.some((f) => RED_FLAGS.has(f));
  if (isRed) return "red";
  const isGreen = card.status === "done" && (card.evidence || []).length > 0;
  if (isGreen) return "green";
  const isYellow = card.status === "review" || flags.includes("no_next_step");
  if (isYellow) return "yellow";
  return "grey";
}

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function groupByStatus(cards) {
  const groups = {};
  for (const status of COLUMN_ORDER) groups[status] = [];
  for (const card of cards) {
    if (!groups[card.status]) groups[card.status] = [];
    groups[card.status].push(card);
  }
  return groups;
}

export function relativeTime(isoDate, nowIso) {
  if (!isoDate) return "未知时间";
  const then = new Date(isoDate).getTime();
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  const diffMs = now - then;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < hour) return `${Math.max(1, Math.round(diffMs / minute))} 分钟前`;
  if (diffMs < day) return `${Math.round(diffMs / hour)} 小时前`;
  return `${Math.round(diffMs / day)} 天前`;
}

export function formatLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Style (goodcase / aimap tokens — see board-spec-v0.2.md §B Token)
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  --bg: #FAFAF7;
  --panel: #FFFFFF;
  --ink: #141412;
  --ink-soft: #6B6A64;
  --line: #141412;
  --line-faint: #D8D7D0;
  --accent: #FF4400;
  --accent-soft: #FFE8DF;
  --ok: #1F7A3A;
  --warn: #B7791F;
  --hdr: 52px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131311;
    --panel: #1B1B18;
    --ink: #EDECE6;
    --ink-soft: #8F8E86;
    --line: #EDECE6;
    --line-faint: #33322E;
    --accent: #FF5511;
    --accent-soft: #3A1A0D;
    --ok: #4FBF6F;
    --warn: #E0A43C;
  }
}
* { box-sizing: border-box; border-radius: 0; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Helvetica Neue", "Avenir Next", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;
}
a { color: var(--accent); }
.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}

/* ---- header ---- */
header.board-header {
  display: flex;
  align-items: stretch;
  min-height: var(--hdr);
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-right: 1px solid var(--line);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.brand .sq {
  width: 10px;
  height: 10px;
  background: var(--accent);
  display: inline-block;
}
.hdr-subtitle {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 120px;
  padding: 0 16px;
  border-right: 1px solid var(--line-faint);
  color: var(--ink-soft);
  font-size: 12px;
}
nav.tabs {
  display: flex;
  flex: 0 0 auto;
}
nav.tabs .tab-btn {
  font: inherit;
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  background: transparent;
  color: var(--ink-soft);
  border: none;
  border-right: 1px solid var(--line-faint);
  padding: 0 18px;
  height: var(--hdr);
  cursor: pointer;
}
nav.tabs .tab-btn:hover { color: var(--ink); }
nav.tabs .tab-btn.active { background: var(--ink); color: var(--bg); }
.hdr-stats {
  margin-left: auto;
  display: flex;
  align-items: center;
  padding: 0 16px;
  font-size: 11px;
  color: var(--ink-soft);
  white-space: nowrap;
}
.hdr-stats strong { color: var(--accent); font-weight: 700; }

details.group-details.nested { margin: 8px 0 0 24px; border-left: 1px solid var(--line-faint); }
details.group-details.nested summary { font-weight: 400; color: var(--ink-soft); }

/* ---- summary bar ---- */
.summary-bar {
  padding: 8px 24px;
  border-bottom: 1px solid var(--line-faint);
  font-size: 12px;
  color: var(--ink-soft);
}

.tab-panel { padding: 0 0 24px 0; }

/* ---- tree: section head (goodcase "§ 01 ·" pattern) ---- */
.section-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.kicker {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-soft);
  white-space: nowrap;
}
.section-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 19px;
  font-weight: 700;
}
.section-title .sq {
  width: 10px;
  height: 10px;
  background: var(--accent);
  display: inline-block;
  flex: none;
}
.section-stats {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-soft);
  white-space: nowrap;
}

/* ---- tree: branch rows ---- */
.branch-row { border-top: 1px solid var(--line-faint); }
.branch-row:first-child { border-top: none; }
.branch-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 24px;
  font-size: 13px;
}
.stage-dots { display: inline-flex; gap: 2px; flex: none; }
.stage-dots .dot {
  width: 10px;
  height: 10px;
  border: 1px solid var(--ink-soft);
  display: inline-block;
  background: transparent;
}
.stage-dots .dot.filled { border-color: transparent; }
.stage-dots .dot.filled.stage-accent { background: var(--accent); }
.stage-dots .dot.filled.stage-warn { background: var(--warn); }
.stage-dots .dot.filled.stage-ok { background: var(--ok); }
.stage-label {
  font-size: 10px;
  border: 1px solid var(--ink-soft);
  color: var(--ink-soft);
  padding: 0 4px;
}
.stage-label.stage-ok { border-color: var(--ok); color: var(--ok); }
.branch-title { font-weight: 700; }
.branch-name { color: var(--ink-soft); }
.pr-link { color: var(--accent); text-decoration: underline; }
.diff, .agent-tag { color: var(--ink-soft); }
.next-step { font-style: italic; }
.next-step.empty { color: var(--ink-soft); }
.conflict-row {
  padding: 0 24px 8px 24px;
  font-size: 12px;
  color: var(--accent);
}
.conflict-row .sq {
  width: 8px;
  height: 8px;
  background: var(--accent);
  display: inline-block;
  margin-right: 4px;
}

/* ---- tree: conversation rows (tree branch line) ---- */
.conv-list {
  margin: 0 24px 8px 40px;
  padding: 4px 0 4px 16px;
  border-left: 1px solid var(--line-faint);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.conv-list.empty { color: var(--ink-soft); font-style: italic; font-size: 12px; }
.conv-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}
.conv-title { font-weight: 600; }
.pinned-mark {
  border: 1px solid var(--ink);
  color: var(--ink);
  text-transform: uppercase;
  padding: 0 4px;
  font-size: 10px;
}
.pr-inferred-mark {
  border: 1px solid var(--line-faint);
  color: var(--ink-soft);
  text-transform: uppercase;
  padding: 0 4px;
  font-size: 10px;
}
.conv-time { color: var(--ink-soft); }
.verdict {
  border: 1px solid currentColor;
  text-transform: uppercase;
  padding: 0 4px;
  font-size: 10px;
}
.verdict-can-close { color: var(--ok); }
.verdict-keep { color: var(--accent); }
.verdict-no-clue { color: var(--ink-soft); }
.verdict-reason { color: var(--ink-soft); }

details.group-details {
  border-top: 1px solid var(--line);
}
details.group-details summary {
  cursor: pointer;
  padding: 10px 24px;
  font-size: 12px;
  font-weight: 700;
  background: var(--panel);
}
details.group-details .conv-list {
  margin: 0 24px 12px 24px;
  padding-left: 16px;
}

/* ---- kanban ---- */
.board-columns {
  display: flex;
  gap: 0;
  overflow-x: auto;
  align-items: flex-start;
  border-top: 1px solid var(--line);
}
.board-column {
  min-width: 260px;
  flex: 1 0 260px;
  border-right: 1px solid var(--line-faint);
}
.board-column:last-child { border-right: none; }
.board-column-header {
  border-bottom: 1px solid var(--line);
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  display: flex;
  justify-content: space-between;
}
.board-column-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card {
  border: 1px solid var(--line-faint);
  padding: 8px 8px 8px 11px;
  position: relative;
  font-size: 12px;
  background: var(--panel);
}
.card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--ink-soft);
}
.card.color-green::before { background: var(--ok); }
.card.color-red::before { background: var(--accent); }
.card.color-yellow::before { background: var(--warn); }
.card.color-grey::before { background: var(--ink-soft); }
.card .title { font-weight: 700; margin-bottom: 4px; }
.card .id, .card .repo-tag { color: var(--ink-soft); font-size: 11px; }
.card .row { margin-top: 3px; }
.card .row.muted { color: var(--ink-soft); }
.card a { text-decoration: underline; }
.card .flags span {
  display: inline-block;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 0 4px;
  margin: 2px 4px 0 0;
  font-size: 10px;
}
.card .next-step.empty { color: var(--ink-soft); font-style: italic; }
.card .evidence-list a { display: block; }

/* ---- conflicts ---- */
.conflicts-project { border-top: 1px solid var(--line); }
.matrix-scroll { overflow-x: auto; padding: 16px 24px; }
table.matrix { border-collapse: collapse; font-size: 11px; white-space: nowrap; }
table.matrix th, table.matrix td {
  border: 1px solid var(--line-faint);
  padding: 4px 8px;
  text-align: center;
  min-width: 32px;
}
table.matrix th { color: var(--ink-soft); font-weight: 600; }
table.matrix td.hit { background: var(--accent-soft); color: var(--accent); font-weight: 700; }
table.matrix td.self { background: var(--line-faint); }
.conflict-pairs { list-style: none; margin: 0; padding: 0 24px 16px 24px; font-size: 12px; }
.conflict-pairs li { padding: 2px 0; }
.conflict-pairs .accent { color: var(--accent); font-weight: 700; }
.empty-note { padding: 12px 24px; color: var(--ink-soft); font-size: 12px; font-style: italic; }

@media (max-width: 900px) {
  header.board-header { flex-wrap: wrap; height: auto; }
  .hdr-subtitle { order: 3; border-right: none; flex-basis: 100%; }
  nav.tabs { flex-wrap: wrap; }
  .hdr-stats { border-left: 1px solid var(--line-faint); }
  .branch-head { white-space: normal; }
  .section-stats { margin-left: 0; flex-basis: 100%; }
  .board-columns { overflow-x: auto; }
}
`;

// ---------------------------------------------------------------------------
// Tree tab
// ---------------------------------------------------------------------------

const STAGE_DOT_ORDER = ["dirty", "unpushed", "pushed", "pr_open", "merged"];
const STAGE_DOT_CLASS = {
  dirty: "stage-accent",
  unpushed: "stage-accent",
  pushed: "stage-warn",
  pr_open: "stage-warn",
  merged: "stage-ok",
};
// Sort key for the branch tree: active work first, settled branches last.
const STAGE_TREE_ORDER = ["dirty", "unpushed", "pr_open", "pushed", "merged", "closed", "missing"];
const VERDICT_LABEL = { "can-close": "可关", keep: "别关", "no-clue": "无线索" };
const VERDICT_CLASS = { "can-close": "verdict-can-close", keep: "verdict-keep", "no-clue": "verdict-no-clue" };

function renderStageDots(stage) {
  const idx = STAGE_DOT_ORDER.indexOf(stage);
  const dots = STAGE_DOT_ORDER.map((s) => {
    const filled = s === stage;
    const cls = filled ? `dot filled ${STAGE_DOT_CLASS[s]}` : "dot";
    return `<span class="${cls}" title="${esc(s)}"></span>`;
  }).join("");
  const offPath =
    idx === -1 && stage
      ? `<span class="stage-label${stage === "merged" ? " stage-ok" : ""}">${esc(stage)}</span>`
      : "";
  return `<span class="stage-dots">${dots}</span>${offPath}`;
}

function renderSessionRow(session, generatedAt) {
  const pinnedMark = session.pinned ? `<span class="pinned-mark mono">置顶</span>` : "";
  const inferredMark = session.prInferred ? `<span class="pr-inferred-mark mono">按 PR 号推断</span>` : "";
  const judge = session.judge || { verdict: "no-clue", reason: null };
  const verdictLabel = VERDICT_LABEL[judge.verdict] || judge.verdict;
  const verdictClass = VERDICT_CLASS[judge.verdict] || "verdict-no-clue";
  const reason = judge.reason ? `<span class="verdict-reason mono">${esc(judge.reason)}</span>` : "";
  const time = session.lastActive ? esc(relativeTime(session.lastActive, generatedAt)) : "";
  return `<div class="conv-row">
  <span class="conv-title">${esc(session.title || "(无标题)")}</span>
  ${pinnedMark}
  ${inferredMark}
  <span class="conv-time mono">${time}</span>
  <span class="verdict mono ${verdictClass}">${esc(verdictLabel)}</span>
  ${reason}
</div>`;
}

function renderBranchRow(card, branchSessions) {
  const branchLabel = card.branch || `detached: ${card.title || card.id}`;
  const dots = renderStageDots(card.stage);
  const prLine = card.pr
    ? `<a class="pr-link mono" href="${esc(card.pr_url)}" target="_blank" rel="noopener">#${esc(card.pr)} ${esc(card.pr_state || "")}</a>`
    : "";
  const aheadBehind =
    card.ahead != null || card.behind != null
      ? `<span class="diff mono">+${card.ahead ?? 0}/−${card.behind ?? 0}</span>`
      : "";
  const agent = `<span class="agent-tag mono">agent: ${esc(card.agent || "—")}</span>`;
  const nextStep =
    card.next_step && card.next_step.trim() !== ""
      ? `<span class="next-step">${esc(card.next_step)}</span>`
      : `<span class="next-step empty">未写下一步</span>`;
  const conflictList = card.conflicts_with || [];
  const conflicts = conflictList.length
    ? `<div class="conflict-row mono"><span class="sq"></span>冲突 · ${conflictList.map(esc).join(" · ")}</div>`
    : "";

  const rowsForBranch = card.branch ? branchSessions.get(card.branch) || [] : [];
  const sessRowsHtml = rowsForBranch.map((s) => renderSessionRow(s)).join("\n");
  const sessBlock = rowsForBranch.length
    ? `<div class="conv-list">${sessRowsHtml}</div>`
    : `<div class="conv-list empty">（暂无关联对话）</div>`;

  return `<div class="branch-row">
  <div class="branch-head">
    ${dots}
    <span class="branch-title">${esc(card.title || branchLabel)}</span>
    <span class="branch-name mono">${esc(branchLabel)}</span>
    ${prLine}
    ${aheadBehind}
    ${agent}
    ${nextStep}
  </div>
  ${conflicts}
  ${sessBlock}
</div>`;
}

function renderProjectSection(project, index, generatedAt) {
  const cards = project.cards || [];
  const sessions = project.sessions || [];

  const branchSessions = new Map();
  for (const s of sessions) {
    for (const b of s.branches || []) {
      if (!branchSessions.has(b)) branchSessions.set(b, []);
      branchSessions.get(b).push(s);
    }
  }

  const sortedCards = [...cards].sort((a, b) => {
    const rank = (c) => {
      const i = STAGE_TREE_ORDER.indexOf(c.stage);
      return i === -1 ? STAGE_TREE_ORDER.length : i;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return String(a.branch || a.title || "").localeCompare(String(b.branch || b.title || ""));
  });

  const branchRowsHtml = sortedCards.map((card) => renderBranchRow(card, branchSessions)).join("\n");

  // 分支全部已落地（没有活跃卡片）的对话：这就是可以取消置顶的清单，置顶的排前面
  const cardBranches = new Set(cards.map((c) => c.branch).filter(Boolean));
  const landedSessions = sessions
    .filter((s) => (s.branches || []).length > 0 && !(s.branches || []).some((b) => cardBranches.has(b)))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.lastActive || "").localeCompare(String(a.lastActive || "")));
  // 置顶的摊开（这是取消置顶清单），没置顶的折进二级 details，免得几十条历史对话把树撑爆
  const landedPinned = landedSessions.filter((s) => s.pinned);
  const landedRest = landedSessions.filter((s) => !s.pinned);
  const landedRestHtml = landedRest.length
    ? `<details class="group-details nested">
  <summary>其余未置顶的（${landedRest.length}）</summary>
  <div class="conv-list">${landedRest.map((s) => renderSessionRow(s, generatedAt)).join("\n")}</div>
</details>`
    : "";
  const landedHtml = landedSessions.length
    ? `<details class="group-details" open>
  <summary>分支已落地，对话可以关（置顶 ${landedPinned.length} · 共 ${landedSessions.length}）</summary>
  <div class="conv-list">${landedPinned.map((s) => renderSessionRow(s, generatedAt)).join("\n")}</div>
  ${landedRestHtml}
</details>`
    : "";

  const reviewCount = cards.filter((c) => c.status === "review").length;
  const keepCount = sessions.filter((s) => s.judge && s.judge.verdict === "keep").length;

  const sectionNo = String(index + 1).padStart(2, "0");
  const kickerText = project.remote || project.repoName || "";

  return `<section class="project-section">
  <div class="section-head">
    <span class="kicker mono">§ ${sectionNo} · ${esc(kickerText)}</span>
    <h2 class="section-title"><span class="sq"></span>${esc(project.repoName || "")}</h2>
    <span class="section-stats mono">卡 ${cards.length} · 待审 ${reviewCount} · 别关对话 ${keepCount}</span>
  </div>
  <div class="branch-list">
${branchRowsHtml}
  </div>
  ${landedHtml}
</section>`;
}

function renderTreeTab({ projects, noClueSessions, generatedAt }) {
  const sections = projects.map((p, i) => renderProjectSection(p, i, generatedAt)).join("\n");
  const noClue = noClueSessions || [];
  const noClueHtml = noClue.length
    ? `<details class="group-details">
  <summary>无分支线索（${noClue.length}）</summary>
  <div class="conv-list">${noClue.map((s) => renderSessionRow(s, generatedAt)).join("\n")}</div>
</details>`
    : "";
  return `${sections}\n${noClueHtml}`;
}

// ---------------------------------------------------------------------------
// Kanban tab
// ---------------------------------------------------------------------------

function renderKanbanTab(projects) {
  const allCards = [];
  for (const p of projects) {
    for (const c of p.cards || []) allCards.push({ ...c, __repo: p.repoName });
  }
  const groups = groupByStatus(allCards);

  const columnsHtml = COLUMN_ORDER.map((status) => {
    const columnCards = groups[status] || [];
    const cardsHtml = columnCards
      .map((card) => {
        const color = cardColor(card);
        const prLine = card.pr
          ? `<div class="row"><a href="${esc(card.pr_url)}" target="_blank" rel="noopener">PR #${esc(card.pr)}</a> ${esc(card.pr_state || "")}</div>`
          : `<div class="row muted">无 PR</div>`;
        const lastCommitLine = card.last_commit
          ? `<div class="row muted mono">${esc(relativeTime(card.last_commit_at))} · ${esc(String(card.last_commit).slice(0, 7))}</div>`
          : `<div class="row muted">无提交记录</div>`;
        const branchLine = `<div class="row mono">${esc(card.branch || "(detached)")}</div>`;
        const agentLine = `<div class="row muted mono">agent: ${esc(card.agent || "—")}</div>`;
        const nextStep = card.next_step && card.next_step.trim() !== ""
          ? `<div class="row next-step">${esc(card.next_step)}</div>`
          : `<div class="row next-step empty">未写下一步</div>`;
        const flags = (card.flags || []).length
          ? `<div class="row flags">${(card.flags || []).map((f) => `<span>${esc(f)}</span>`).join("")}</div>`
          : "";
        const evidence = (card.evidence || []).length
          ? `<div class="row evidence-list">${(card.evidence || [])
              .map((e) => (/^https?:\/\//.test(e) ? `<a href="${esc(e)}" target="_blank" rel="noopener">${esc(e)}</a>` : `<span>${esc(e)}</span>`))
              .join("")}</div>`
          : "";
        return `<div class="card color-${color}">
  <div class="title">${esc(card.title)}</div>
  <div class="id mono">${esc(card.id)}${card.__repo ? ` · <span class="repo-tag">${esc(card.__repo)}</span>` : ""}</div>
  ${branchLine}
  ${prLine}
  ${lastCommitLine}
  ${agentLine}
  ${nextStep}
  ${flags}
  ${evidence}
</div>`;
      })
      .join("\n");
    return `<section class="board-column">
  <div class="board-column-header mono"><span>${COLUMN_LABELS[status]}</span><span>${columnCards.length}</span></div>
  <div class="board-column-body">${cardsHtml}</div>
</section>`;
  }).join("\n");

  return `<main class="board-columns">\n${columnsHtml}\n</main>`;
}

// ---------------------------------------------------------------------------
// Conflicts tab
// ---------------------------------------------------------------------------

function parseConflictEntry(entry) {
  const m = /^(.*)\s\((\d+)/.exec(entry);
  if (!m) return { branch: entry, count: null };
  return { branch: m[1], count: Number(m[2]) };
}

function buildConflictMatrix(cards) {
  const branches = new Set();
  const pairCount = new Map(); // key: sorted "a b" -> count

  for (const c of cards) {
    const list = c.conflicts_with || [];
    if (!c.branch || list.length === 0) continue;
    branches.add(c.branch);
    for (const entry of list) {
      const { branch: other, count } = parseConflictEntry(entry);
      branches.add(other);
      const key = [c.branch, other].sort().join(" ");
      if (!pairCount.has(key)) pairCount.set(key, count ?? 1);
    }
  }
  return { branches: Array.from(branches).sort(), pairCount };
}

function renderConflictProject(project) {
  const { branches, pairCount } = buildConflictMatrix(project.cards || []);
  if (branches.length === 0) {
    return `<section class="conflicts-project">
  <div class="section-head">
    <span class="kicker mono">${esc(project.remote || project.repoName || "")}</span>
    <h2 class="section-title"><span class="sq"></span>${esc(project.repoName || "")}</h2>
  </div>
  <div class="empty-note">无冲突</div>
</section>`;
  }

  const headerCells = branches.map((b) => `<th class="mono">${esc(b)}</th>`).join("");
  const rows = branches
    .map((rowBranch) => {
      const cells = branches
        .map((colBranch) => {
          if (rowBranch === colBranch) return `<td class="self">—</td>`;
          const key = [rowBranch, colBranch].sort().join(" ");
          const count = pairCount.get(key);
          return count ? `<td class="hit">${count}</td>` : `<td></td>`;
        })
        .join("");
      return `<tr><th class="mono">${esc(rowBranch)}</th>${cells}</tr>`;
    })
    .join("\n");

  const pairsHtml = Array.from(pairCount.entries())
    .map(([key, count]) => {
      const [a, b] = key.split(" ");
      return `<li><span class="mono">${esc(a)}</span> × <span class="mono">${esc(b)}</span> — <span class="accent mono">${count} files</span></li>`;
    })
    .join("\n");

  return `<section class="conflicts-project">
  <div class="section-head">
    <span class="kicker mono">${esc(project.remote || project.repoName || "")}</span>
    <h2 class="section-title"><span class="sq"></span>${esc(project.repoName || "")}</h2>
  </div>
  <div class="matrix-scroll">
    <table class="matrix">
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <ul class="conflict-pairs">${pairsHtml}</ul>
</section>`;
}

function renderConflictsTab(projects) {
  return projects.map((p) => renderConflictProject(p)).join("\n");
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export function renderBoardHtml({ generatedAt, projects = [], noClueSessions = [], summary = {} }) {
  const alertCount = projects.reduce(
    (sum, p) => sum + (p.cards || []).reduce((s, c) => s + (c.flags || []).length, 0),
    0
  );
  const repoCount = summary.repos ?? projects.length;
  const cardCount = summary.cards ?? projects.reduce((s, p) => s + (p.cards || []).length, 0);
  const sessionCount =
    summary.sessions ?? projects.reduce((s, p) => s + (p.sessions || []).length, 0);
  const pinned = summary.pinned ?? 0;
  const pinnedCanClose = summary.pinnedCanClose ?? 0;

  const treeHtml = renderTreeTab({ projects, noClueSessions, generatedAt });
  const kanbanHtml = renderKanbanTab(projects);
  const conflictsHtml = renderConflictsTab(projects);

  const dataJson = JSON.stringify({ generatedAt, projects, noClueSessions, summary }, null, 0);

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>board</title>
<style>${STYLE}</style>
</head>
<body>
<header class="board-header">
  <div class="brand"><span class="sq"></span>BOARD</div>
  <div class="hdr-subtitle">agent 任务板 · 对话 → 分支 → 落地</div>
  <nav class="tabs">
    <button type="button" class="tab-btn active" data-tab="tree" onclick="boardShowTab('tree')">树</button>
    <button type="button" class="tab-btn" data-tab="kanban" onclick="boardShowTab('kanban')">看板</button>
    <button type="button" class="tab-btn" data-tab="conflicts" onclick="boardShowTab('conflicts')">冲突</button>
  </nav>
  <div class="hdr-stats mono"><strong>${pinned}</strong>&nbsp;置顶 · <strong>${pinnedCanClose}</strong>&nbsp;可关</div>
</header>
<div class="summary-bar mono">生成 ${esc(formatLocal(generatedAt))} · ${repoCount} 个仓库 · ${cardCount} 张卡 · ${sessionCount} 个对话有线索 · 告警 ${alertCount}</div>
<script>
function boardShowTab(name) {
  document.querySelectorAll(".tab-panel").forEach(function (el) {
    el.hidden = el.id !== "tab-" + name;
  });
  document.querySelectorAll(".tab-btn").forEach(function (el) {
    el.classList.toggle("active", el.dataset.tab === name);
  });
}
</script>
<section id="tab-tree" class="tab-panel">
${treeHtml}
</section>
<section id="tab-kanban" class="tab-panel" hidden>
${kanbanHtml}
</section>
<section id="tab-conflicts" class="tab-panel" hidden>
${conflictsHtml}
</section>
<script type="application/json" id="board-data">${dataJson}</script>
</body>
</html>
`;
}
