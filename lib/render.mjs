// Renders the static board/index.html viewer. Pure string-building function
// (no fs/process access) so it stays unit-testable; board.mjs writes the
// returned string to disk.
//
// Visual language borrowed from goodcase.ai / aimap (carlwow.com/aimap):
// warm off-white paper, 1px hairline borders, zero border-radius, one
// accent color, mono labels. See board-spec-v0.6-render.md for the single
// horizontal-tree layout this file implements (replaces the old
// 树/看板/冲突 three-tab v0.2 layout — one tree per project, connector
// lines drawn client-side from getBoundingClientRect, conflicts shown as
// dashed lines + a small count badge instead of a separate matrix tab).

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

function truncateTitle(str, max) {
  const s = String(str ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Style (goodcase / aimap tokens — see board-spec-v0.6-render.md §Token)
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
  --tabs: 38px;
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
  font-size: 14px;
}
a { color: var(--accent); }
.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
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
.conflict-toggle-btn {
  font: inherit;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  font-weight: 700;
  background: transparent;
  color: var(--ink-soft);
  border: 1px solid var(--line-faint);
  margin: 8px 0 8px 16px;
  padding: 0 12px;
  cursor: pointer;
}
.conflict-toggle-btn:hover { color: var(--ink); border-color: var(--ink); }
.hdr-stats {
  margin-left: 16px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-left: 1px solid var(--line-faint);
  font-size: 11px;
  color: var(--ink-soft);
  white-space: nowrap;
}
.hdr-stats strong { color: var(--accent); font-weight: 700; }

/* ---- summary + legend ---- */
.summary-bar {
  padding: 8px 24px 4px 24px;
  border-bottom: 1px solid var(--line-faint);
  font-size: 13px;
  color: var(--ink-soft);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 0 24px 8px 24px;
  border-bottom: 1px solid var(--line-faint);
  font-size: 12px;
  color: var(--ink-soft);
}
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.legend-cell { width: 12px; height: 12px; display: inline-block; border: 1px solid var(--ink-soft); }
.legend-cell.stage-accent { background: var(--accent); border-color: transparent; }
.legend-cell.stage-warn { background: var(--warn); border-color: transparent; }
.legend-cell.stage-ok { background: var(--ok); border-color: transparent; }
/* 线型图例：实线=归属（项目→分支→对话），橙虚线=冲突对 */
.legend-line {
  width: 24px;
  height: 0;
  display: inline-block;
  border-top: 1.5px solid var(--line-faint);
  transform: translateY(-3px);
}
.legend-line.dashed { border-top-style: dashed; border-top-color: var(--accent); }

/* ---- repo tabs (sticky, one per project + 全部) ---- */
.repo-tabs {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  /* 8 个 repo 一行放不完（1440 下 afu-llm-todo 之后的项目直接被裁掉看不见），
     所以换行而不是横向滚动。分隔线走每个 tab 的 border-left/border-top 加
     -1px 外边距：相邻 tab 的边框叠成一根，每行第一个 tab 的左边线、第一行的
     顶边线都被 overflow:hidden 裁在盒子外，两行都不会留下悬空的半截线。 */
  flex-wrap: wrap;
  overflow: hidden;
  min-height: var(--tabs);
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}
.repo-tab {
  font: inherit;
  font-size: 13px;
  background: transparent;
  color: var(--ink-soft);
  border: none;
  border-left: 1px solid var(--line-faint);
  border-top: 1px solid var(--line-faint);
  border-bottom: 1.5px solid transparent;
  margin-left: -1px;
  margin-top: -1px;
  padding: 6px 14px;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}
.repo-tab:hover { color: var(--ink); }
.repo-tab.active {
  color: var(--ink);
  font-weight: 700;
  background: var(--accent-soft);
  border-bottom-color: var(--accent);
  /* 换行后第二行的 -1px 顶边会压住第一行 active tab 的重音下划线，抬一层。 */
  position: relative;
  z-index: 1;
}
.repo-tab .repo-tab-counts {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  font-weight: 400;
  color: var(--ink-soft);
}
.project-section[hidden] { display: none; }

/* ---- tree: project section ---- */
.project-section { border-bottom: 1px solid var(--line); }
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

.tree-scroll { overflow-x: auto; }
.tree-grid {
  position: relative;
  display: flex;
  align-items: stretch;
  min-width: 1100px;
  padding: 16px 24px;
}
.conn-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.conn-line { fill: none; stroke: var(--line-faint); stroke-width: 1.5px; }
.conn-line.conn-conflict { stroke: var(--accent); stroke-dasharray: 4 3; }
body[data-conflicts="off"] .conn-line.conn-conflict { display: none; }

/* 项目节点列：贴顶吸附，跟随该项目节滚动；旁边留 56px 给一根贯穿所有行的
   竖线（trunk），每行再横向接回分支节点左边缘（见 .node.branch-node::before）。 */
.tree-col-project {
  flex: 0 0 220px;
  width: 220px;
  margin-right: 56px;
  position: relative;
  display: flex;
  flex-direction: column;
}
.project-trunk-line {
  position: absolute;
  top: 44px;
  bottom: 44px;
  right: -28px;
  width: 0;
  border-left: 1.5px solid var(--line-faint);
}
.tree-col-rows {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 每行 = 一条分支 + 它的全部对话，三列固定宽度，中格留给连接线。 */
.branch-row {
  position: relative;
  display: grid;
  grid-template-columns: 380px 56px minmax(360px, 1fr);
  align-items: start;
}
.row-spine {
  position: absolute;
  left: 408px;
  top: 20px;
  bottom: 20px;
  width: 0;
  border-left: 1.5px solid var(--line-faint);
}
.row-convs {
  grid-column: 3;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.node {
  border: 1px solid var(--line-faint);
  background: var(--panel);
  padding: 12px;
  position: relative;
}
.project-node {
  border-color: var(--line);
  position: sticky;
  top: calc(var(--tabs) + 16px);
  align-self: start;
}
.node-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.node-head .sq { width: 10px; height: 10px; background: var(--accent); display: inline-block; flex: none; }
.node-title { font-size: 16px; font-weight: 700; }
.node-sub { color: var(--ink-soft); font-size: 11px; margin-bottom: 6px; }
.stat-line { font-size: 12px; color: var(--ink-soft); }

/* ---- branch node ---- */
.branch-node { border-color: var(--line-faint); }
/* left connector: every branch row hangs off the project trunk line (56px
   outer gap between .tree-col-project and .tree-col-rows) */
.branch-node::before {
  content: "";
  position: absolute;
  left: -28px;
  top: 50%;
  width: 28px;
  height: 0;
  border-top: 1.5px solid var(--line-faint);
}
/* right connector: only drawn when the row has conversation chips (meets
   .row-spine in the row's own 56px middle gap) */
.branch-node.has-conv::after {
  content: "";
  position: absolute;
  right: -28px;
  top: 50%;
  width: 28px;
  height: 0;
  border-top: 1.5px solid var(--line-faint);
}
.stage-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.stage-bar { display: inline-flex; gap: 3px; flex: none; }
.stage-cell {
  width: 14px;
  height: 14px;
  border: 1px solid var(--ink-soft);
  display: inline-block;
  background: transparent;
}
.stage-cell.filled { border-color: transparent; }
.stage-cell.filled.stage-accent { background: var(--accent); }
.stage-cell.filled.stage-warn { background: var(--warn); }
.stage-cell.filled.stage-ok { background: var(--ok); }
.stage-name { font-size: 12px; color: var(--ink-soft); }
.stage-offlabel {
  font-size: 10px;
  border: 1px solid var(--ink-soft);
  color: var(--ink-soft);
  padding: 0 4px;
}
.branch-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
.branch-meta {
  font-size: 12px;
  color: var(--ink-soft);
  margin-bottom: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pr-link { color: var(--accent); text-decoration: underline; }
.next-step { font-size: 12px; font-style: italic; }
.next-step.empty { color: var(--ink-soft); }
.conflict-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 11px;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 0 4px;
}

/* ---- conversation chips (right cell of .branch-row) ---- */
.conv-empty { font-size: 12px; color: var(--ink-soft); font-style: italic; padding: 4px 0; }
.conv-chip { border: 1px solid var(--line-faint); padding: 6px 8px; position: relative; }
/* stub back to the row's spine, plus a 6px solid square where the line
   enters the chip */
.conv-chip::before {
  content: "";
  position: absolute;
  left: -28px;
  top: 50%;
  width: 28px;
  height: 0;
  border-top: 1.5px solid var(--line-faint);
}
.conv-chip::after {
  content: "";
  position: absolute;
  left: -6px;
  top: calc(50% - 3px);
  width: 6px;
  height: 6px;
  background: var(--line-faint);
}
.conv-chip summary {
  cursor: pointer;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 14px;
}
.verdict-sq { width: 10px; height: 10px; display: inline-block; flex: none; }
.verdict-sq.verdict-can-close { background: var(--ok); }
.verdict-sq.verdict-keep { background: var(--accent); }
.verdict-sq.verdict-no-clue { background: var(--ink-soft); }
.conv-title { font-size: 14px; font-weight: 600; }
.conv-time { font-size: 11px; color: var(--ink-soft); }
.pinned-mark {
  border: 1px solid var(--ink);
  color: var(--ink);
  text-transform: uppercase;
  padding: 0 4px;
  font-size: 10px;
}
.hook-mark, .pr-inferred-mark {
  border: 1px solid var(--line-faint);
  color: var(--ink-soft);
  text-transform: uppercase;
  padding: 0 4px;
  font-size: 10px;
}
.conv-reason { font-size: 12px; color: var(--ink-soft); padding-top: 4px; }
.landed-node .stat-line { font-size: 14px; font-weight: 700; color: var(--ink); }

/* 同名对话聚成一个 chip，展开后逐条列出成员 */
.cluster-mark {
  border: 1px solid var(--ink-soft);
  color: var(--ink-soft);
  padding: 0 4px;
  font-size: 10px;
}
.conv-members {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--line-faint);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.conv-member { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.open-link {
  margin-left: auto;
  flex: none;
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid var(--accent);
}
.open-link.disabled {
  color: var(--ink-soft);
  border-bottom: 1px dashed var(--line-faint);
  cursor: default;
}

/* 超过 N 条后折叠的剩余对话 */
details.conv-more { border: 1px solid var(--line-faint); padding: 6px 8px; position: relative; }
details.conv-more > summary { cursor: pointer; color: var(--ink-soft); }
details.conv-more .conv-list-flat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
}
/* 折叠盒里的 chip 不再往左画归属线（线只属于树的一层） */
details.conv-more .conv-chip::before,
details.conv-more .conv-chip::after { display: none; }

/* ---- 建议归档面板 ---- */
details.archive-panel {
  background: var(--panel);
  border-bottom: 1px solid var(--line-faint);
  padding: 0 24px 12px 24px;
}
details.archive-panel > summary {
  cursor: pointer;
  padding: 10px 0;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ink);
}
.archive-note { color: var(--warn); padding-bottom: 6px; }
/* 标题上的「+N 转录」：那批归档不了，压成次要信息，别抢主计数 */
.archive-rest-count {
  margin-left: 8px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--ink-soft);
}
/* 无 app id 的会话桌面 app 归档不了，默认收起，不给勾选框 */
details.archive-rest { margin-top: 12px; }
details.archive-rest > summary {
  cursor: pointer;
  padding: 6px 0;
  color: var(--ink-soft);
  border-top: 1px solid var(--line-faint);
}
details.archive-rest > summary:hover { color: var(--ink); }
details.archive-rest .archive-rows { border-top: none; padding-top: 4px; }
/* 一个项目可能攒了上百条建议，面板默认展开但自己滚，别把下面的树顶出屏幕 */
.archive-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--line-faint);
  padding-top: 8px;
  max-height: 40vh;
  overflow-y: auto;
}
.archive-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
/* chip 里「打开」推到右边，归档行是整宽的，推到右边就跟标题断了联系 */
.archive-row .open-link { margin-left: 0; }
.archive-row input {
  margin: 0;
  flex: none;
  accent-color: var(--accent);
  transform: translateY(1px);
}
.archive-title { font-weight: 600; }
.archive-reason { color: var(--ink-soft); }
.archive-btn {
  font: inherit;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  font-weight: 700;
  margin-top: 10px;
  align-self: flex-start;
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 4px 12px;
  cursor: pointer;
}
.archive-btn:hover { background: var(--accent-soft); }

details.group-details.nested { margin: 8px 0 0 0; border-left: 1px solid var(--line-faint); padding-left: 12px; }
details.group-details.nested summary { font-weight: 400; color: var(--ink-soft); font-size: 12px; cursor: pointer; }

details.bottom-details {
  border-top: 1px solid var(--line);
}
details.bottom-details summary {
  cursor: pointer;
  padding: 10px 24px;
  font-size: 12px;
  font-weight: 700;
  background: var(--panel);
}
details.bottom-details .conv-list-flat {
  margin: 0 24px 12px 24px;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

@media (max-width: 900px) {
  header.board-header { flex-wrap: wrap; height: auto; }
  .hdr-subtitle { order: 3; border-right: none; flex-basis: 100%; }
  .hdr-stats { border-left: 1px solid var(--line-faint); }
  .section-stats { margin-left: 0; flex-basis: 100%; }
}
`;

// ---------------------------------------------------------------------------
// Stage bar (project → branch progress) — five cells, one filled at a time
// ---------------------------------------------------------------------------

const STAGE_DOT_ORDER = ["dirty", "unpushed", "pushed", "pr_open", "merged"];
const STAGE_DOT_CLASS = {
  dirty: "stage-accent",
  unpushed: "stage-accent",
  pushed: "stage-warn",
  pr_open: "stage-warn",
  merged: "stage-ok",
};
const STAGE_ZH_NAME = {
  dirty: "未提交",
  unpushed: "未推送",
  pushed: "已推送",
  pr_open: "审阅中",
  merged: "已合并",
  closed: "已关闭",
  missing: "分支丢失",
};
// Sort key for the branch tree: active work first, settled branches last.
const STAGE_TREE_ORDER = ["dirty", "unpushed", "pr_open", "pushed", "merged", "closed", "missing"];
const VERDICT_LABEL = { "can-close": "可关", keep: "别关", "no-clue": "无线索" };
const VERDICT_CLASS = { "can-close": "verdict-can-close", keep: "verdict-keep", "no-clue": "verdict-no-clue" };

function renderStageBar(stage) {
  const idx = STAGE_DOT_ORDER.indexOf(stage);
  const cells = STAGE_DOT_ORDER.map((s) => {
    const filled = s === stage;
    const cls = filled ? `stage-cell filled ${STAGE_DOT_CLASS[s]}` : "stage-cell";
    return `<span class="${cls}" title="${esc(s)}"></span>`;
  }).join("");
  const zhName = STAGE_ZH_NAME[stage] || "";
  const offLabel = idx === -1 && stage ? `<span class="stage-offlabel mono">${esc(stage)}</span>` : "";
  return `<div class="stage-row"><span class="stage-bar">${cells}</span><span class="stage-name">${esc(zhName)}</span>${offLabel}</div>`;
}

function renderLandedStageBar(label) {
  const cells = STAGE_DOT_ORDER.map(() => `<span class="stage-cell filled stage-ok"></span>`).join("");
  return `<div class="stage-row"><span class="stage-bar">${cells}</span><span class="stage-name">${esc(label)}</span></div>`;
}

// ---------------------------------------------------------------------------
// Conversation chips
// ---------------------------------------------------------------------------

// 桌面 app 的会话 id（local_<uuid>）和 CLI 会话的裸 uuid 走两条不同的深链。
const APP_SESSION_RE = /^local_[A-Za-z0-9-]{1,64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// 只有带合法 local_ app id 的会话，archive_session 才动得了。转录里翻出来的
// 会话（无 app id）既不该占归档清单，也不该算进「可关」——不然计数承诺的事
// 面板根本做不到（goodcaseai 曾经显示 63 可关、实际只能归档 26 个）。
export function hasAppSession(session) {
  return APP_SESSION_RE.test((session && session.appSessionId) || "");
}

// 页面上所有「可关 N」的唯一口径：判定 can-close 且桌面 app 归档得了。
export function countArchivableCanClose(sessions) {
  return (sessions || []).filter((s) => s.judge && s.judge.verdict === "can-close" && hasAppSession(s))
    .length;
}

// 同一条分支上反复开的同名对话（含 " (fork)" 后缀）算一个簇。
export function normalizeConvTitle(title) {
  return String(title ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*(\(fork\)|（fork）)$/i, "")
    .trim();
}

// 置顶 → hook 来的 → 最近活跃。
export function sortSessions(sessions) {
  return [...(sessions || [])].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      Number(b.via === "hook") - Number(a.via === "hook") ||
      String(b.lastActive || "").localeCompare(String(a.lastActive || ""))
  );
}

export function clusterSessions(sessions) {
  const clusters = [];
  const byTitle = new Map();
  for (const s of sortSessions(sessions)) {
    const key = normalizeConvTitle(s.title) || `__uuid_${s.uuid}`;
    const hit = byTitle.get(key);
    if (hit) {
      hit.members.push(s);
      continue;
    }
    const cluster = { key, lead: s, members: [s] };
    byTitle.set(key, cluster);
    clusters.push(cluster);
  }
  return clusters;
}

// 桌面 app 有 local_ id 就直接续聊；CLI 会话退回 claude://resume 走一次导入；
// Codex 目前没有可跳的协议，占位一个禁用样式的 mono 标记。
export function openAppLink(session) {
  const appId = session.appSessionId || "";
  if (APP_SESSION_RE.test(appId)) {
    const href = `claude://code/continue?session=${appId}&source=board`;
    return `<a class="open-link mono" href="${esc(href)}" title="在桌面 app 里继续这个会话" onclick="event.stopPropagation()">打开</a>`;
  }
  if (session.source === "claude" && UUID_RE.test(String(session.uuid || ""))) {
    const href = `claude://resume?session=${session.uuid}`;
    return `<a class="open-link mono" href="${esc(href)}" title="导入 CLI 会话到桌面 app" onclick="event.stopPropagation()">打开</a>`;
  }
  if (session.source === "codex") {
    return `<span class="open-link mono disabled" title="Codex 跳转待做">codex</span>`;
  }
  return "";
}

function renderConvMarks(session) {
  const marks = [];
  if (session.pinned) marks.push(`<span class="pinned-mark mono">置顶</span>`);
  if (session.via === "hook") marks.push(`<span class="hook-mark mono">hook</span>`);
  if (session.prInferred) marks.push(`<span class="pr-inferred-mark mono">按 PR 号推断</span>`);
  return marks.join("\n    ");
}

function renderConvMember(session, generatedAt) {
  const title = session.title || "(无标题)";
  const time = session.lastActive ? esc(relativeTime(session.lastActive, generatedAt)) : "";
  return `<div class="conv-member"><span class="conv-time mono">${time}</span><span class="conv-title" title="${esc(title)}">${esc(truncateTitle(title, 36))}</span>${renderConvMarks(session)}${openAppLink(session)}</div>`;
}

function renderConvChip(session, generatedAt, members) {
  const cluster = members && members.length > 1 ? members : null;
  const judge = session.judge || { verdict: "no-clue", reason: null };
  const verdictClass = VERDICT_CLASS[judge.verdict] || "verdict-no-clue";
  const title = session.title || "(无标题)";
  const shortTitle = truncateTitle(title, 36);
  const time = session.lastActive ? esc(relativeTime(session.lastActive, generatedAt)) : "";
  const reason = judge.reason ? esc(judge.reason) : "（无理由）";
  const clusterMark = cluster ? `<span class="cluster-mark mono">×${cluster.length}</span>` : "";
  const membersHtml = cluster
    ? `\n  <div class="conv-members">${cluster.map((m) => renderConvMember(m, generatedAt)).join("")}</div>`
    : "";
  const dataSession = esc(session.appSessionId || session.uuid || "");
  return `<details class="conv-chip" data-session="${dataSession}">
  <summary>
    <span class="verdict-sq ${verdictClass}" title="${esc(VERDICT_LABEL[judge.verdict] || judge.verdict)}"></span>
    <span class="conv-title" title="${esc(title)}">${esc(shortTitle)}</span>
    <span class="conv-time mono">${time}</span>
    ${clusterMark}
    ${renderConvMarks(session)}
    ${openAppLink(session)}
  </summary>
  <div class="conv-reason mono">${reason}</div>${membersHtml}
</details>`;
}

function renderConvListFlat(sessions, generatedAt) {
  return clusterSessions(sessions)
    .map((c) => renderConvChip(c.lead, generatedAt, c.members))
    .join("\n");
}

// 一行分支下最多 inlineLimit 个 chip，其余收进「还有 N 个对话」。
function renderConvGroup(sessions, generatedAt, inlineLimit) {
  const clusters = clusterSessions(sessions);
  const inline = clusters.slice(0, inlineLimit);
  const rest = clusters.slice(inlineLimit);
  const inlineHtml = inline.map((c) => renderConvChip(c.lead, generatedAt, c.members)).join("\n");
  if (!rest.length) return inlineHtml;
  const restCount = rest.reduce((n, c) => n + c.members.length, 0);
  const restHtml = rest.map((c) => renderConvChip(c.lead, generatedAt, c.members)).join("\n");
  return `${inlineHtml}
<details class="conv-more">
  <summary class="mono">还有 ${restCount} 个对话</summary>
  <div class="conv-list-flat">${restHtml}</div>
</details>`;
}

// ---------------------------------------------------------------------------
// 建议归档面板：judge 判 can-close，或 sessions.mjs 给了 suggest 的会话
// ---------------------------------------------------------------------------

function archiveCandidates(sessions) {
  return sortSessions(
    (sessions || []).filter((s) => (s.judge && s.judge.verdict === "can-close") || s.suggest)
  );
}

// 主清单只放桌面 app 真归档得了的会话。转录里翻出来的那批（无 app id）
// 数量能压倒主清单（done-lamp-source 一家 167 个），全收进折叠盒。
export function suggestedArchiveSessions(sessions) {
  return archiveCandidates(sessions).filter(hasAppSession);
}

export function transcriptOnlyArchiveSessions(sessions) {
  return archiveCandidates(sessions).filter((s) => !hasAppSession(s));
}

function archiveRowInner(session) {
  const judge = session.judge || {};
  const verdictClass = VERDICT_CLASS[judge.verdict] || "verdict-no-clue";
  const title = session.title || "(无标题)";
  const reason = (session.suggest && session.suggest.reason) || "判定：分支已合并";
  const pinnedMark = session.pinned ? `<span class="pinned-mark mono">置顶</span>` : "";
  return `<span class="verdict-sq ${verdictClass}" title="${esc(VERDICT_LABEL[judge.verdict] || "建议归档")}"></span>
      <span class="archive-title" title="${esc(title)}">${esc(truncateTitle(title, 48))}</span>
      <span class="archive-reason mono">${esc(reason)}</span>
      ${pinnedMark}${openAppLink(session)}`;
}

function renderArchiveRow(session) {
  const title = session.title || "(无标题)";
  const appAttr = ` data-app-id="${esc(session.appSessionId || "")}"`;
  return `    <div class="archive-row">
      <input type="checkbox" class="archive-cb" checked${appAttr} data-title="${esc(title)}" onchange="boardArchiveCount(this)" />
      ${archiveRowInner(session)}
    </div>`;
}

// 折叠盒里的行没有勾选框：勾了也归档不了，给个框只会骗人。
function renderArchiveRestRow(session) {
  return `    <div class="archive-row archive-row-rest">
      ${archiveRowInner(session)}
    </div>`;
}

function renderArchivePanel(sessions, sectionId, folder) {
  const list = suggestedArchiveSessions(sessions);
  const rest = transcriptOnlyArchiveSessions(sessions);
  if (!list.length && !rest.length) return "";
  const note = list.some((s) => s.pinned)
    ? `<div class="archive-note mono">置顶的会话桌面 app 拒绝归档，先在侧栏取消置顶</div>`
    : "";
  const restCount = rest.length
    ? `<span class="archive-rest-count mono">+${rest.length} 转录</span>`
    : "";
  const mainHtml = list.length
    ? `  <div class="archive-rows">
${list.map(renderArchiveRow).join("\n")}
  </div>
  <button type="button" class="archive-btn mono" id="${esc(sectionId)}-btn" onclick="boardArchivePrompt('${esc(sectionId)}')">让 Claude 归档选中的 ${list.length} 个</button>`
    : "";
  const restHtml = rest.length
    ? `  <details class="archive-rest">
    <summary class="mono">转录里的另外 ${rest.length} 个（无 app id，桌面 app 归档不了）</summary>
    <div class="archive-rows">
${rest.map(renderArchiveRestRow).join("\n")}
    </div>
  </details>`
    : "";
  return `<details class="archive-panel" open data-archive="${esc(sectionId)}" data-folder="${esc(folder || "")}">
  <summary class="mono">建议归档（${list.length}）${restCount}</summary>
  ${note}
${mainHtml}
${restHtml}
</details>`;
}

// ---------------------------------------------------------------------------
// Conflicts — dedup pairs per project, drawn as dashed connector lines
// ---------------------------------------------------------------------------

function parseConflictEntry(entry) {
  const m = /^(.*)\s\((\d+)/.exec(entry);
  if (!m) return { branch: entry, count: null };
  return { branch: m[1], count: Number(m[2]) };
}

function buildConflictPairs(cards) {
  const pairs = new Map(); // key: sorted "a\u0000b" -> {a, b, count}
  for (const c of cards) {
    const list = c.conflicts_with || [];
    if (!c.branch || list.length === 0) continue;
    for (const entry of list) {
      const { branch: other, count } = parseConflictEntry(entry);
      if (!other) continue;
      const [a, b] = [c.branch, other].sort();
      const key = `${a}\u0000${b}`;
      if (!pairs.has(key)) pairs.set(key, { a, b, count: count ?? null });
    }
  }
  return Array.from(pairs.values());
}

// ---------------------------------------------------------------------------
// Tree: one horizontal tree per project
// ---------------------------------------------------------------------------

function renderProjectNode(project, reviewCount, keepCount) {
  const kickerText = project.remote || project.repoName || "";
  return `<div class="node project-node">
  <div class="node-head"><span class="sq"></span><span class="node-title">${esc(project.repoName || "")}</span></div>
  <div class="node-sub mono">${esc(kickerText)}</div>
  <div class="stat-line mono">卡 ${(project.cards || []).length}</div>
  <div class="stat-line mono">待审 ${reviewCount}</div>
  <div class="stat-line mono">别关对话 ${keepCount}</div>
</div>`;
}

function renderBranchNode(card, hasConv) {
  const branchLabel = card.branch || `detached: ${card.title || card.id}`;
  const stageBar = renderStageBar(card.stage);
  const prLine = card.pr
    ? `<a class="pr-link mono" href="${esc(card.pr_url)}" target="_blank" rel="noopener">#${esc(card.pr)} ${esc(card.pr_state || "")}</a>`
    : "";
  const aheadBehind =
    card.ahead != null || card.behind != null
      ? `<span class="mono">+${card.ahead ?? 0}/−${card.behind ?? 0}</span>`
      : "";
  const agent = `<span class="mono">agent: ${esc(card.agent || "—")}</span>`;
  const nextStep =
    card.next_step && card.next_step.trim() !== ""
      ? `<div class="next-step">${esc(card.next_step)}</div>`
      : `<div class="next-step empty">未写下一步</div>`;
  const conflictList = card.conflicts_with || [];
  const conflictBadge = conflictList.length
    ? `<span class="conflict-badge mono">冲突 ${conflictList.length}</span>`
    : "";
  const nodeClass = hasConv ? "node branch-node has-conv" : "node branch-node";

  return `<div class="${nodeClass}" data-branch="${esc(card.branch || "")}">
  ${conflictBadge}
  ${stageBar}
  <div class="branch-title">${esc(card.title || branchLabel)}</div>
  <div class="branch-meta mono">
    <span class="mono">${esc(branchLabel)}</span>
    ${prLine}
    ${aheadBehind}
    ${agent}
  </div>
  ${nextStep}
</div>`;
}

function renderLandedBranchNode(landedCount) {
  const stageBar = renderLandedStageBar(`已落地 · 可关 ${landedCount}`);
  return `<div class="node branch-node landed-node has-conv">
  ${stageBar}
</div>`;
}

// One row = one branch + all of its conversation chips, laid out side by
// side (grid-template-columns: 380px 56px minmax(360px, 1fr)) so a branch
// and its chips never drift apart into separately-flowing columns.
function renderBranchRow(branchNodeHtml, convsInnerHtml, hasConv) {
  const spine = hasConv ? `<div class="row-spine"></div>` : "";
  return `<div class="branch-row">
  ${branchNodeHtml}
  ${spine}
  <div class="row-convs">
${convsInnerHtml}
  </div>
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

  const reviewCount = cards.filter((c) => c.status === "review").length;
  const keepCount = sessions.filter((s) => s.judge && s.judge.verdict === "keep").length;

  const rowsHtml = [];

  sortedCards.forEach((card) => {
    const rowsForBranch = card.branch ? branchSessions.get(card.branch) || [] : [];
    const hasConv = rowsForBranch.length > 0;
    const branchNodeHtml = renderBranchNode(card, hasConv);
    const convsInnerHtml = hasConv
      ? renderConvGroup(rowsForBranch, generatedAt, 3)
      // "没有对话的分支显示一行 --ink-soft 的「暂无关联对话」，不画线" — hasConv
      // stays false so neither the node's ::after nor the row spine render.
      : `<div class="conv-empty">暂无关联对话</div>`;
    rowsHtml.push(renderBranchRow(branchNodeHtml, convsInnerHtml, hasConv));
  });

  // 分支全部已落地（没有活跃卡片）的对话：这就是可以取消置顶的清单，置顶的排前面
  const cardBranches = new Set(cards.map((c) => c.branch).filter(Boolean));
  const landedSessions = sessions
    .filter((s) => (s.branches || []).length > 0 && !(s.branches || []).some((b) => cardBranches.has(b)))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.lastActive || "").localeCompare(String(a.lastActive || "")));

  if (landedSessions.length) {
    const landedNodeHtml = renderLandedBranchNode(landedSessions.length);
    rowsHtml.push(renderBranchRow(landedNodeHtml, renderConvGroup(landedSessions, generatedAt, 8), true));
  }

  const conflictPairs = buildConflictPairs(cards);
  const conflictsAttr = esc(JSON.stringify(conflictPairs.map((p) => [p.a, p.b, p.count])));

  const sectionNo = String(index + 1).padStart(2, "0");
  const kickerText = project.remote || project.repoName || "";
  const canCloseCount = countArchivableCanClose(sessions);
  const archiveHtml = renderArchivePanel(sessions, `ap-${sectionNo}`, project.repoRoot);
  // 默认只显示第一个项目，其余靠顶部 tab（或 #repo= hash）切出来。
  const hiddenAttr = index === 0 ? "" : " hidden";

  return `<section class="project-section" data-repo="${esc(project.repoName || "")}"${hiddenAttr}>
  <div class="section-head">
    <span class="kicker mono">§ ${sectionNo} · ${esc(kickerText)}</span>
    <h2 class="section-title"><span class="sq"></span>${esc(project.repoName || "")}</h2>
    <span class="section-stats mono">卡 ${cards.length} · 待审 ${reviewCount} · 可关 ${canCloseCount} · 别关对话 ${keepCount}</span>
  </div>
  ${archiveHtml}
  <div class="tree-scroll">
    <div class="tree-grid" data-conflicts="${conflictsAttr}">
      <svg class="conn-svg"></svg>
      <div class="tree-col-project">
        ${renderProjectNode(project, reviewCount, keepCount)}
        <div class="project-trunk-line"></div>
      </div>
      <div class="tree-col-rows">
${rowsHtml.join("\n")}
      </div>
    </div>
  </div>
</section>`;
}

function renderTreeBody({ projects, noClueSessions, generatedAt }) {
  const sections = projects.map((p, i) => renderProjectSection(p, i, generatedAt)).join("\n");
  const noClue = noClueSessions || [];
  // 无分支线索的会话没有自己的 repoRoot，深链落到第一个项目的目录。
  const fallbackFolder = (projects.find((p) => p.repoRoot) || {}).repoRoot || "";
  const globalArchive = renderArchivePanel(noClue, "ap-noclue", fallbackFolder);
  const noClueHtml = noClue.length
    ? `<details class="bottom-details">
  <summary>无分支线索（${noClue.length}）</summary>
  <div class="conv-list-flat">${renderConvGroup(noClue, generatedAt, 8)}</div>
</details>`
    : "";
  return `${sections}\n${globalArchive}\n${noClueHtml}`;
}

// ---------------------------------------------------------------------------
// Repo tabs — 顶部一行，「全部」+ 每个项目一个，计数复用 section-stats 的数字
// ---------------------------------------------------------------------------

function projectCounts(project) {
  const cards = project.cards || [];
  const sessions = project.sessions || [];
  return {
    cards: cards.length,
    review: cards.filter((c) => c.status === "review").length,
    canClose: countArchivableCanClose(sessions),
  };
}

// tab 里空间紧张（8 个 repo 挤两行），量词压到一个字，数字仍走 mono。
function tabCounts(c) {
  return `<span class="repo-tab-counts mono">${c.cards} 卡 · ${c.review} 审 · ${c.canClose} 可关</span>`;
}

function renderRepoTabs(projects) {
  const totals = projects.reduce(
    (acc, p) => {
      const c = projectCounts(p);
      return { cards: acc.cards + c.cards, review: acc.review + c.review, canClose: acc.canClose + c.canClose };
    },
    { cards: 0, review: 0, canClose: 0 }
  );
  const tabs = [
    `<button type="button" class="repo-tab" data-repo="__all__" onclick="boardSelectRepo(this.getAttribute('data-repo'))">全部${tabCounts(totals)}</button>`,
  ];
  projects.forEach((p, i) => {
    const cls = i === 0 ? "repo-tab active" : "repo-tab";
    tabs.push(
      `<button type="button" class="${cls}" data-repo="${esc(p.repoName || "")}" onclick="boardSelectRepo(this.getAttribute('data-repo'))">${esc(p.repoName || "")}${tabCounts(projectCounts(p))}</button>`
    );
  });
  return `<nav class="repo-tabs">\n  ${tabs.join("\n  ")}\n</nav>`;
}

// ---------------------------------------------------------------------------
// Client-side connector script. Project→branch and branch→conversation
// lines are now pure CSS (fixed-width grid columns + ::before/::after, see
// .project-trunk-line / .branch-node::before / .row-spine / .conv-chip::before
// in STYLE above) — no JS measurement needed for those. The one connector
// that still needs getBoundingClientRect is the conflict dashed line, since
// it can span two branch rows anywhere in the tree. It now leaves from each
// branch node's LEFT edge (conversation chips sit on the right and would
// occlude a right-side line) and bulges 24px further left into the empty
// project-column gap, redrawn on load/resize. If JS is disabled, no
// conflict line draws but the 冲突 N badge on the node still reads fine.
// ---------------------------------------------------------------------------

const CONNECTOR_SCRIPT = `
function boardDrawConnectors() {
  document.querySelectorAll(".tree-grid").forEach(function (grid) {
    var svg = grid.querySelector("svg.conn-svg");
    if (!svg) return;
    var rect = grid.getBoundingClientRect();
    svg.setAttribute("width", rect.width);
    svg.setAttribute("height", rect.height);
    svg.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var conflictsRaw = grid.getAttribute("data-conflicts");
    var pairs = [];
    try { pairs = JSON.parse(conflictsRaw || "[]"); } catch (e) { pairs = []; }
    pairs.forEach(function (pair) {
      var aEl = grid.querySelector('[data-branch="' + pair[0] + '"]');
      var bEl = grid.querySelector('[data-branch="' + pair[1] + '"]');
      if (!aEl || !bEl || aEl === bEl) return;
      var a = aEl.getBoundingClientRect();
      var b = bEl.getBoundingClientRect();
      var x1 = a.left - rect.left;
      var y1 = a.top + a.height / 2 - rect.top;
      var x2 = b.left - rect.left;
      var y2 = b.top + b.height / 2 - rect.top;
      var bulgeX = Math.min(x1, x2) - 24;
      var d = "M " + x1 + " " + y1 + " L " + bulgeX + " " + y1 + " L " + bulgeX + " " + y2 + " L " + x2 + " " + y2;
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "conn-line conn-conflict");
      svg.appendChild(path);
    });
  });
}
function boardToggleConflicts() {
  var on = document.body.getAttribute("data-conflicts") !== "off";
  document.body.setAttribute("data-conflicts", on ? "off" : "on");
  var btn = document.getElementById("conflict-toggle");
  if (btn) btn.textContent = "冲突线 " + (on ? "关" : "开");
}

// ---- repo tabs ----------------------------------------------------------
// 隐藏的 section 几何全是 0，切完必须重画一次冲突线。
function boardSelectRepo(repo, persist) {
  var tabs = document.querySelectorAll(".repo-tab");
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute("data-repo") === repo) tabs[i].classList.add("active");
    else tabs[i].classList.remove("active");
  }
  var secs = document.querySelectorAll("section.project-section");
  for (var j = 0; j < secs.length; j++) {
    var sr = secs[j].getAttribute("data-repo");
    secs[j].hidden = !(repo === "__all__" || sr === repo);
  }
  if (persist !== false) {
    try { localStorage.setItem("board-repo", repo); } catch (e) {}
    try { location.hash = "repo=" + encodeURIComponent(repo); } catch (e) {}
  }
  boardDrawConnectors();
}
function boardKnownRepo(repo) {
  if (!repo) return false;
  var tabs = document.querySelectorAll(".repo-tab");
  for (var i = 0; i < tabs.length; i++) if (tabs[i].getAttribute("data-repo") === repo) return true;
  return false;
}
function boardRestoreRepo() {
  var want = null;
  var m = /repo=([^&]+)/.exec(location.hash || "");
  if (m) { try { want = decodeURIComponent(m[1]); } catch (e) { want = m[1]; } }
  if (!boardKnownRepo(want)) { try { want = localStorage.getItem("board-repo"); } catch (e) { want = null; } }
  if (!boardKnownRepo(want)) { boardDrawConnectors(); return; }
  boardSelectRepo(want, false);
}

// ---- 建议归档 ------------------------------------------------------------
function boardArchiveCount(el) {
  var panel = el && el.closest ? el.closest("[data-archive]") : null;
  if (!panel) return;
  var boxes = panel.querySelectorAll("input.archive-cb");
  var n = 0;
  for (var i = 0; i < boxes.length; i++) {
    if (boxes[i].checked && boxes[i].getAttribute("data-app-id")) n++;
  }
  var btn = document.getElementById(panel.getAttribute("data-archive") + "-btn");
  if (btn) btn.textContent = "让 Claude 归档选中的 " + n + " 个";
}
function boardArchivePrompt(sectionId) {
  var panel = document.querySelector('[data-archive="' + sectionId + '"]');
  if (!panel) return;
  var boxes = panel.querySelectorAll("input.archive-cb");
  var lines = [];
  for (var i = 0; i < boxes.length; i++) {
    var appId = boxes[i].getAttribute("data-app-id");
    if (!boxes[i].checked || !appId) continue;
    lines.push("- " + boxes[i].getAttribute("data-title") + " — " + appId);
  }
  if (!lines.length) { window.alert("没有选中带 app id 的会话，桌面 app 归档不了。"); return; }
  var text = "请用 archive_session 逐个归档以下桌面会话，reason 写「分支已合并」；置顶的先告诉我需要取消置顶，一个都别猜：\\n" + lines.join("\\n");
  var url = "claude://code/new?prompt=" + encodeURIComponent(text);
  var folder = panel.getAttribute("data-folder");
  if (folder) url += "&folder=" + encodeURIComponent(folder);
  window.location.href = url;
}

window.addEventListener("load", boardDrawConnectors);
window.addEventListener("load", boardRestoreRepo);
window.addEventListener("hashchange", boardRestoreRepo);
window.addEventListener("resize", boardDrawConnectors);
`;

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

  const treeHtml = renderTreeBody({ projects, noClueSessions, generatedAt });
  const repoTabsHtml = renderRepoTabs(projects);

  // 线太多时（>12 条）默认关 — total distinct conflict pairs across all projects.
  const totalConflictPairs = projects.reduce((sum, p) => sum + buildConflictPairs(p.cards || []).length, 0);
  const conflictsDefault = totalConflictPairs > 12 ? "off" : "on";
  const toggleLabel = conflictsDefault === "off" ? "冲突线 关" : "冲突线 开";

  const dataJson = JSON.stringify({ generatedAt, projects, noClueSessions, summary }, null, 0);

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>board</title>
<style>${STYLE}</style>
</head>
<body data-conflicts="${conflictsDefault}">
<header class="board-header">
  <div class="brand"><span class="sq"></span>BOARD</div>
  <div class="hdr-subtitle">agent 任务板 · 对话 → 分支 → 落地</div>
  <button type="button" id="conflict-toggle" class="conflict-toggle-btn" onclick="boardToggleConflicts()">${esc(toggleLabel)}</button>
  <div class="hdr-stats mono"><strong>${pinned}</strong>&nbsp;置顶 · <strong>${pinnedCanClose}</strong>&nbsp;可关</div>
</header>
${repoTabsHtml}
<div class="summary-bar mono">生成 ${esc(formatLocal(generatedAt))} · ${repoCount} 个仓库 · ${cardCount} 张卡 · ${sessionCount} 个对话有线索 · 告警 ${alertCount}</div>
<div class="legend">
  <span class="legend-item"><span class="legend-cell stage-accent"></span>未提交</span>
  <span class="legend-item"><span class="legend-cell stage-accent"></span>未推送</span>
  <span class="legend-item"><span class="legend-cell stage-warn"></span>已推送</span>
  <span class="legend-item"><span class="legend-cell stage-warn"></span>审阅中</span>
  <span class="legend-item"><span class="legend-cell stage-ok"></span>已合并</span>
  <span class="legend-item"><span class="legend-line"></span>归属线：项目 → 分支 → 对话</span>
  <span class="legend-item"><span class="legend-line dashed"></span>冲突线：两条分支改了同一批文件（可用右上角开关）</span>
</div>
<script>${CONNECTOR_SCRIPT}</script>
<main>
${treeHtml}
</main>
<script type="application/json" id="board-data">${dataJson}</script>
</body>
</html>
`;
}
