import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeReader, handleMessage, TOOLS } from "./mcp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD_BIN = path.resolve(HERE, "../bin/board.mjs");
const REPO_ROOT = path.resolve(HERE, "..");

function spawnMcp() {
  return spawn(process.execPath, [BOARD_BIN, "mcp"], { cwd: REPO_ROOT });
}

function collectLines(child, count, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const lines = [];
    const timer = setTimeout(() => {
      reject(new Error(`超时: 等待 ${count} 行，已收到 ${lines.length}: ${JSON.stringify(lines)}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) lines.push(line.trim());
        if (lines.length >= count) {
          clearTimeout(timer);
          resolve(lines);
          return;
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function endChild(child) {
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  child.kill();
}

// --- unit-level: frame reader ------------------------------------------------

test("makeReader: 行分隔帧，跨 chunk 边界也能解析", () => {
  const received = [];
  const feed = makeReader((msg) => received.push(msg));
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
  feed(Buffer.from(line.slice(0, 5)));
  feed(Buffer.from(line.slice(5)));
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 1);
  assert.equal(received[0].method, "ping");
});

test("makeReader: Content-Length 帧，跨 chunk 边界也能解析", () => {
  const received = [];
  const feed = makeReader((msg) => received.push(msg));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
  const framed = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  feed(Buffer.from(framed.slice(0, 10)));
  feed(Buffer.from(framed.slice(10)));
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 2);
});

test("makeReader: 同一条流里两种帧格式混用", () => {
  const received = [];
  const feed = makeReader((msg) => received.push(msg));
  const lineMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
  const body2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
  const framed2 = `Content-Length: ${Buffer.byteLength(body2, "utf8")}\r\n\r\n${body2}`;
  feed(Buffer.from(lineMsg + framed2));
  assert.equal(received.length, 2);
  assert.deepEqual(received.map((m) => m.id), [1, 2]);
});

// --- unit-level: message handling --------------------------------------------

test("handleMessage: initialize 回显 protocolVersion 并带 serverInfo", () => {
  const resp = handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(resp.jsonrpc, "2.0");
  assert.equal(resp.id, 1);
  assert.equal(resp.result.protocolVersion, "2099-01-01");
  assert.equal(resp.result.serverInfo.name, "carl-vibe-kanban");
  assert.deepEqual(resp.result.capabilities, { tools: {} });
});

test("handleMessage: tools/list 返回全部 tool 定义", () => {
  const resp = handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(resp.result.tools.length, TOOLS.length);
  const names = resp.result.tools.map((t) => t.name);
  for (const n of [
    "board_sync",
    "board_ls",
    "board_sessions",
    "board_judge",
    "board_next",
    "board_evidence",
    "board_pin",
    "board_unpin",
    "board_cleanup",
    "board_dispatch",
  ]) {
    assert.ok(names.includes(n), `缺少 tool: ${n}`);
  }
});

test("handleMessage: tools/list — board_ls 与 board_judge 的 schema 都含 repo/limit（多仓截断防截断参数）", () => {
  const resp = handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const byName = Object.fromEntries(resp.result.tools.map((t) => [t.name, t]));

  const lsProps = byName.board_ls.inputSchema.properties;
  assert.equal(lsProps.repo.type, "string");
  assert.equal(lsProps.limit.type, "number");

  const judgeProps = byName.board_judge.inputSchema.properties;
  assert.equal(judgeProps.repo.type, "string");
  assert.equal(judgeProps.limit.type, "number");
});

test("handleMessage: notification（无 id）永远不产生响应", () => {
  const resp = handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(resp, undefined);
});

test("handleMessage: 未知方法返回 -32601", () => {
  const resp = handleMessage({ jsonrpc: "2.0", id: 3, method: "nope/does-not-exist" });
  assert.equal(resp.error.code, -32601);
});

test("handleMessage: tools/call 未知 tool 名 -> isError", () => {
  const resp = handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "board_nope", arguments: {} } });
  assert.equal(resp.result.isError, true);
});

test("handleMessage: tools/call board_dispatch 永不添加 --run", () => {
  // 不实际起子进程：直接检查缺少必填参数时的早退路径，避免这条用例真的建 worktree。
  const resp = handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "board_dispatch", arguments: {} } });
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /branch/);
});

test("handleMessage: tools/call board_judge 不带 ai 时跑规则表，不会挂起等 claude", () => {
  const resp = handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "board_judge", arguments: {} } });
  assert.equal(resp.result.content[0].type, "text");
  // 没有会话缓存时也该是"没有建议"而不是报错，且从不因为缺 --ai 就去调 claude。
  assert.equal(resp.result.isError, undefined);
});

// --- process-level: real `board mcp` child over stdio ------------------------

test("board mcp（行分隔帧）: initialize / tools/list / tools/call board_ls", async () => {
  const child = spawnMcp();
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "0" }, capabilities: {} },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board_ls", arguments: {} } },
  ];
  const linesPromise = collectLines(child, 3);
  for (const req of requests) child.stdin.write(JSON.stringify(req) + "\n");
  const lines = await linesPromise;
  endChild(child);

  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((r) => [r.id, r]));

  assert.equal(byId[1].result.serverInfo.name, "carl-vibe-kanban");
  assert.equal(byId[1].result.protocolVersion, "2025-06-18");

  assert.ok(Array.isArray(byId[2].result.tools));
  assert.ok(byId[2].result.tools.some((t) => t.name === "board_ls"));

  assert.equal(byId[3].result.content[0].type, "text");
  const parsed = JSON.parse(byId[3].result.content[0].text);
  assert.ok(Array.isArray(parsed));
});

test("board mcp（Content-Length 帧）: initialize / tools/list / tools/call board_ls", async () => {
  const child = spawnMcp();
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board_ls", arguments: {} } },
  ];
  const linesPromise = collectLines(child, 3);
  for (const req of requests) {
    const body = JSON.stringify(req);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
  const lines = await linesPromise;
  endChild(child);

  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  assert.equal(byId[1].result.serverInfo.name, "carl-vibe-kanban");
  assert.ok(Array.isArray(byId[2].result.tools));
  assert.ok(Array.isArray(byId[3].result.content));
});

test("board mcp: notification 不产生响应，ping 与未知方法各自正确", async () => {
  const child = spawnMcp();
  const linesPromise = collectLines(child, 2);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "does/not-exist" }) + "\n");
  const lines = await linesPromise;
  endChild(child);

  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  assert.deepEqual(byId[1].result, {});
  assert.equal(byId[2].error.code, -32601);
});

// board_judge --limit 1: whether a second "LIMIT 显示 N/M" content block
// appears depends on how many suggestion rows this environment's real
// sessions/board state actually produces (see REPO_ROOT's own board/
// sessions cache) — so this first asks for the unlimited baseline, then
// asserts the limit:1 call's shape against that baseline instead of a
// hardcoded row count.
test("board mcp: tools/call board_judge --limit 1 附带 LIMIT 第二块，行数按实际环境分支断言", async () => {
  const child = spawnMcp();
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board_judge", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board_judge", arguments: { limit: 1 } } },
  ];
  const linesPromise = collectLines(child, 3, 20000);
  for (const req of requests) child.stdin.write(JSON.stringify(req) + "\n");
  const lines = await linesPromise;
  endChild(child);

  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  const baseline = byId[2].result;
  const limited = byId[3].result;
  assert.equal(baseline.isError, undefined);
  assert.equal(limited.isError, undefined);

  const baselineText = baseline.content[0].text;
  const baselineRowCount = baselineText.startsWith("(no suggestions")
    ? 0
    : baselineText.split("\n").length - 1; // minus the header line

  if (baselineRowCount > 1) {
    assert.equal(limited.content.length, 2, "应该带 LIMIT 第二块");
    assert.equal(limited.content[1].type, "text");
    assert.match(limited.content[1].text, new RegExp(`^LIMIT 显示 1/${baselineRowCount}$`));
    // First block stays a plain (1-suggestion) table, uncontaminated by the LIMIT line.
    assert.equal(limited.content[0].text.split("\n").length, 2);
  } else {
    assert.equal(limited.content.length, 1, "建议行 <= 1 条时不应该有 LIMIT 第二块");
  }
});
