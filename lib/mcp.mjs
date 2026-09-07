// MCP (Model Context Protocol) stdio server for `board mcp`, plus
// `board mcp install` (registers this server with Claude Code / Codex).
// Zero dependencies: hand-rolled JSON-RPC 2.0 over stdio, and every tool is a
// thin wrapper that shells out to bin/board.mjs itself (spawnSync) rather
// than re-implementing any board business logic here.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD_BIN = path.resolve(HERE, "../bin/board.mjs");

function readPkgVersion() {
  try {
    const p = path.resolve(HERE, "../package.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PKG_VERSION = readPkgVersion();

// --- tool schema -------------------------------------------------------------

export const TOOLS = [
  {
    name: "board_sync",
    description: "运行 board sync，刷新卡片派生字段",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "遍历工作区所有仓库" },
        repo: { type: "string", description: "只同步指定仓库（按 workspace.repos 中的目录名匹配）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "board_ls",
    description: "列出卡片（含 stage、conflicts_with 等派生字段）",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "遍历工作区所有仓库" },
        status: { type: "string", description: "按 status 过滤" },
        repo: { type: "string", description: "按 repo 名过滤（需配合 all）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "board_sessions",
    description: "列出对话 session 及其可关/别关/无线索判断",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "遍历工作区所有仓库" },
        pinned: { type: "boolean", description: "只看置顶对话" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "board_next",
    description: "更新一张卡片的 next_step",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "卡片 id，如 T-abc123" },
        text: { type: "string", description: "next_step 文本" },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "board_evidence",
    description: "给一张卡片追加一条 evidence（url 或路径）",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "卡片 id" },
        item: { type: "string", description: "evidence 内容：url 或路径" },
      },
      required: ["id", "item"],
      additionalProperties: false,
    },
  },
  {
    name: "board_pin",
    description: "锁定卡片 status（sync 不再覆盖）",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "卡片 id" },
        status: { type: "string", description: "backlog|doing|review|blocked|done|dropped" },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "board_unpin",
    description: "解除卡片 status 锁定",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "卡片 id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "board_cleanup",
    description: "清理已合并/已关闭且带 worktree 的卡片（默认只列出，apply 才真正删除）",
    inputSchema: {
      type: "object",
      properties: { apply: { type: "boolean", description: "true 则真正执行删除，默认 dry-run" } },
      additionalProperties: false,
    },
  },
  {
    name: "board_dispatch",
    description: "为分支创建 worktree 并落卡（只建 worktree，不启动 agent）",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "分支名或卡片 id" },
        agent: { type: "string", description: "agent 名（claude/codex 等）" },
        base: { type: "string", description: "base 分支，默认仓库配置的 base" },
      },
      required: ["branch"],
      additionalProperties: false,
    },
  },
];

// --- board.mjs invocation helpers --------------------------------------------

function runBoard(args, { cwd } = {}) {
  return spawnSync(process.execPath, [BOARD_BIN, ...args], {
    encoding: "utf8",
    cwd: cwd || process.cwd(),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function textResult(text, isError = false) {
  const result = { content: [{ type: "text", text: String(text) }] };
  if (isError) result.isError = true;
  return result;
}

// Wraps a spawnSync() result into a tool result. `json:true` means the
// subcommand supports --json — we parse it and re-serialize (so the caller
// gets a validated JSON string back), falling back to raw text on parse
// failure rather than hiding the underlying output.
function commandResult(res, { json = false } = {}) {
  if (res.error) {
    return textResult(`调用 board 失败: ${res.error.message}`, true);
  }
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  if (res.status !== 0) {
    return textResult(stderr.trim() || stdout.trim() || `board 退出码 ${res.status}`, true);
  }
  if (json) {
    try {
      const parsed = JSON.parse(stdout.trim() || "[]");
      return textResult(JSON.stringify(parsed));
    } catch {
      return textResult(stdout);
    }
  }
  return textResult(stdout.trim() || "(no output)");
}

// Resolves a `repo` argument (e.g. "goodcaseai") to its absolute path by
// matching the directory basename of an entry in ~/.config/board/config.json
// workspace.repos. Only used to pick a `cwd` for a single-repo sync — no
// business logic beyond that path lookup lives here.
function findWorkspaceRepoPath(repoName) {
  const p = path.join(os.homedir(), ".config", "board", "config.json");
  if (!fs.existsSync(p)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const repos = (cfg.workspace && cfg.workspace.repos) || [];
    for (const r of repos) {
      const expanded = r.startsWith("~") ? path.join(os.homedir(), r.slice(1)) : r;
      if (path.basename(expanded) === repoName) return path.resolve(expanded);
    }
  } catch {
    // fall through to null
  }
  return null;
}

// --- tool implementations -----------------------------------------------------

function toolBoardSync(args) {
  const a = ["sync"];
  let cwd;
  if (args.repo) {
    const p = findWorkspaceRepoPath(args.repo);
    if (!p) return textResult(`未在 workspace.repos 中找到 repo: ${args.repo}`, true);
    cwd = p;
  } else if (args.all) {
    a.push("--all");
  }
  return commandResult(runBoard(a, { cwd }));
}

function toolBoardLs(args) {
  const a = ["ls"];
  if (args.all) a.push("--all");
  if (args.status) a.push("--status", String(args.status));
  a.push("--json");
  const result = commandResult(runBoard(a), { json: true });
  if (result.isError || !args.repo) return result;
  try {
    const arr = JSON.parse(result.content[0].text);
    return textResult(JSON.stringify(arr.filter((c) => c.repo === args.repo)));
  } catch {
    return result;
  }
}

function toolBoardSessions(args) {
  const a = ["sessions", "ls"];
  if (args.all) a.push("--all");
  if (args.pinned) a.push("--pinned");
  a.push("--json");
  return commandResult(runBoard(a), { json: true });
}

function toolBoardNext(args) {
  if (!args.id || args.text === undefined) return textResult("缺少参数 id/text", true);
  return commandResult(runBoard(["next", args.id, args.text]));
}

function toolBoardEvidence(args) {
  if (!args.id || args.item === undefined) return textResult("缺少参数 id/item", true);
  return commandResult(runBoard(["evidence", args.id, args.item]));
}

function toolBoardPin(args) {
  if (!args.id || !args.status) return textResult("缺少参数 id/status", true);
  return commandResult(runBoard(["pin", args.id, args.status]));
}

function toolBoardUnpin(args) {
  if (!args.id) return textResult("缺少参数 id", true);
  return commandResult(runBoard(["unpin", args.id]));
}

// board cleanup 子命令由实现者 A 另行开发；接口在这里先接好，跑不通就把
// board.mjs 的错误原样透传（未知命令）而不是本地伪造结果。
function toolBoardCleanup(args) {
  const a = ["cleanup", "--all"];
  if (args.apply) a.push("--apply");
  return commandResult(runBoard(a));
}

function toolBoardDispatch(args) {
  if (!args.branch) return textResult("缺少参数 branch", true);
  const a = ["dispatch", args.branch];
  if (args.agent) a.push("--agent", args.agent);
  if (args.base) a.push("--base", args.base);
  // 永不传 --run：MCP 只负责建 worktree + 落卡，绝不代为启动 agent。
  return commandResult(runBoard(a));
}

const TOOL_HANDLERS = {
  board_sync: toolBoardSync,
  board_ls: toolBoardLs,
  board_sessions: toolBoardSessions,
  board_next: toolBoardNext,
  board_evidence: toolBoardEvidence,
  board_pin: toolBoardPin,
  board_unpin: toolBoardUnpin,
  board_cleanup: toolBoardCleanup,
  board_dispatch: toolBoardDispatch,
};

function handleToolCall(name, toolArgs) {
  const fn = TOOL_HANDLERS[name];
  if (!fn) return textResult(`未知 tool: ${name}`, true);
  try {
    return fn(toolArgs || {});
  } catch (err) {
    return textResult(`执行出错: ${err.message}`, true);
  }
}

// --- JSON-RPC message handling ------------------------------------------------

// Returns a response object, or `undefined` when no response should be sent
// (JSON-RPC notifications — messages without an `id` — never get one).
export function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return undefined;
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const { method, params, id } = msg;

  if (!hasId) {
    // e.g. notifications/initialized — nothing to do, and no response ever.
    return undefined;
  }

  switch (method) {
    case "initialize": {
      const protocolVersion = (params && params.protocolVersion) || "2025-06-18";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          serverInfo: { name: "carl-vibe-kanban", version: PKG_VERSION },
          capabilities: { tools: {} },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      return { jsonrpc: "2.0", id, result: handleToolCall(name, toolArgs) };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// --- stdio framing: newline-delimited JSON, and Content-Length (LSP-style) ---
// Both are accepted on read (mixed within the same stream is fine); every
// response we WRITE is newline-delimited JSON (the standard MCP stdio wire
// format), regardless of which framing the request arrived in.

export function makeReader(onMessage) {
  let buf = Buffer.alloc(0);

  function dispatchLine(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore unparsable lines rather than crashing the server
    }
    onMessage(msg);
  }

  return function feed(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      while (buf.length && (buf[0] === 0x0a || buf[0] === 0x0d)) buf = buf.subarray(1);
      if (buf.length === 0) return;

      const prefix = buf.subarray(0, Math.min(buf.length, 15)).toString("latin1").toLowerCase();
      if (prefix.startsWith("content-length")) {
        const idx4 = buf.indexOf("\r\n\r\n");
        const idx2 = buf.indexOf("\n\n");
        let sepIdx = -1;
        let sepLen = 0;
        if (idx4 !== -1 && (idx2 === -1 || idx4 <= idx2)) {
          sepIdx = idx4;
          sepLen = 4;
        } else if (idx2 !== -1) {
          sepIdx = idx2;
          sepLen = 2;
        }
        if (sepIdx === -1) return; // header incomplete, wait for more data

        const headerText = buf.subarray(0, sepIdx).toString("utf8");
        const m = /content-length:\s*(\d+)/i.exec(headerText);
        if (!m) {
          buf = buf.subarray(sepIdx + sepLen); // malformed header, drop and resync
          continue;
        }
        const len = parseInt(m[1], 10);
        const bodyStart = sepIdx + sepLen;
        if (buf.length - bodyStart < len) return; // body incomplete, wait for more data

        const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
        buf = buf.subarray(bodyStart + len);
        dispatchLine(body);
        continue;
      }

      const nlIdx = buf.indexOf(0x0a);
      if (nlIdx === -1) return; // incomplete line, wait for more data
      let line = buf.subarray(0, nlIdx).toString("utf8");
      buf = buf.subarray(nlIdx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      dispatchLine(line);
    }
  };
}

// Drives the server off `input`/`output` streams (defaults: process stdio).
// Resolves once `input` ends/closes.
export function runServer({ input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const feed = makeReader((msg) => {
      const resp = handleMessage(msg);
      if (resp !== undefined) output.write(JSON.stringify(resp) + "\n");
    });
    input.on("data", (chunk) => feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    input.on("end", resolve);
    input.on("close", resolve);
    input.on("error", resolve);
  });
}

// --- board mcp install ---------------------------------------------------------

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupDir = path.join(os.homedir(), ".cache", "board", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, `${path.basename(filePath)}.${ts}`);
  fs.copyFileSync(filePath, dest);
  return dest;
}

function commandExists(cmd) {
  const res = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  return !res.error;
}

function installClaudeMcp({ dryRun }) {
  console.log("== Claude Code ==");
  if (!commandExists("claude")) {
    console.log("未找到 claude 命令，请手动执行:");
    console.log("  claude mcp add --scope user board -- board mcp");
    return;
  }
  const listRes = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });
  if (listRes.stdout && /^board\b/m.test(listRes.stdout)) {
    console.log("已存在 board MCP server，跳过");
    return;
  }
  const cmdStr = "claude mcp add --scope user board -- board mcp";
  if (dryRun) {
    console.log(`[dry-run] 将执行: ${cmdStr}`);
    return;
  }
  const res = spawnSync("claude", ["mcp", "add", "--scope", "user", "board", "--", "board", "mcp"], {
    encoding: "utf8",
  });
  if (res.status === 0) {
    console.log(`已注册: ${cmdStr}`);
    if (res.stdout && res.stdout.trim()) console.log(res.stdout.trim());
  } else {
    console.log(`注册失败(exit ${res.status}): ${(res.stderr || res.stdout || "").trim()}`);
  }
}

function installCodexMcp({ dryRun }) {
  console.log("== Codex ==");
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const block = `[mcp_servers.board]\ncommand = "board"\nargs = ["mcp"]\n`;
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

  if (content.includes("[mcp_servers.board]")) {
    console.log(`已存在 [mcp_servers.board]，跳过 (${configPath})`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] 将追加到 ${configPath}:`);
    console.log(block);
    return;
  }
  const backup = backupFile(configPath);
  if (backup) console.log(`已备份到 ${backup}`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(configPath, content + sep + block, "utf8");
  console.log(`已写入 ${configPath}`);
}

export function installMcp({ dryRun = false } = {}) {
  installClaudeMcp({ dryRun });
  installCodexMcp({ dryRun });
}
