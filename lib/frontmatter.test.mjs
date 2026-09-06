import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.mjs";

test("round-trips scalars, arrays, and a plain body", () => {
  const data = {
    id: "T-abc123",
    title: "图生视频输入素材列",
    branch: "feat/i2v-input-assets",
    worktree: null,
    pr: 150,
    status_pinned: false,
    evidence: ["https://example.com/a", "path/to/log.txt"],
    flags: [],
    next_step: "",
  };
  const body = "这是正文笔记。\n第二行。\n";
  const text = stringifyFrontmatter(data, body);
  const parsed = parseFrontmatter(text);

  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, body);
});

test("body containing a literal --- line round-trips unmodified", () => {
  const data = { id: "T-000001", title: "x" };
  const body = "笔记开头\n\n---\n\n笔记结尾，中间那条横线不是 frontmatter 分隔符\n";
  const text = stringifyFrontmatter(data, body);
  const parsed = parseFrontmatter(text);

  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, body);
});

test("strings needing quoting are quoted and escaped, then parsed back exactly", () => {
  const data = {
    title: 'Say "hello", then: continue', // needs quoting (colon-space, quotes)
    weird: "---", // literal delimiter-looking scalar must be quoted
    empty: "",
    looksNumeric: "123",
    looksBool: "true",
    withNewlineEscaped: "line one\nline two",
  };
  const text = stringifyFrontmatter(data, "");
  // Ensure the raw serialized header actually quotes these values.
  assert.match(text, /title: "Say \\"hello\\", then: continue"/);
  assert.match(text, /weird: "---"/);
  assert.match(text, /empty: ""/);
  assert.match(text, /looksNumeric: "123"/);
  assert.match(text, /looksBool: "true"/);

  const parsed = parseFrontmatter(text);
  assert.deepEqual(parsed.data, data);
});

test("plain unquoted strings, numbers, booleans, and null parse to correct types", () => {
  const text = [
    "---",
    "branch: feat/board-v0",
    "pr: 150",
    "ahead: 3",
    "status_pinned: false",
    "worktree: null",
    "agent: claude",
    "---",
    "body text",
    "",
  ].join("\n");
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.branch, "feat/board-v0");
  assert.equal(data.pr, 150);
  assert.equal(data.ahead, 3);
  assert.equal(data.status_pinned, false);
  assert.equal(data.worktree, null);
  assert.equal(data.agent, "claude");
  assert.equal(body, "body text\n");
});

test("inline array syntax parses to a string array", () => {
  const text = ["---", "keys: [feat/a, feat/b]", "flags: []", "---", ""].join("\n");
  const { data } = parseFrontmatter(text);
  assert.deepEqual(data.keys, ["feat/a", "feat/b"]);
  assert.deepEqual(data.flags, []);
});

test("block-style array (- item lines) parses to a string array", () => {
  const text = ["---", "evidence:", "  - https://example.com/one", "  - path/two.png", "next_step: go", "---", ""].join(
    "\n"
  );
  const { data } = parseFrontmatter(text);
  assert.deepEqual(data.evidence, ["https://example.com/one", "path/two.png"]);
  assert.equal(data.next_step, "go");
});

test("Chinese text with punctuation round-trips", () => {
  const data = { title: "四站分享卡片统一（含中文标点：逗号，句号。）" };
  const text = stringifyFrontmatter(data, "正文也是中文。\n");
  const parsed = parseFrontmatter(text);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, "正文也是中文。\n");
});

test("empty body serializes without a trailing blank content block", () => {
  const text = stringifyFrontmatter({ id: "T-000000" }, "");
  assert.equal(text, "---\nid: T-000000\n---\n");
});

test("stringifyFrontmatter preserves key insertion order", () => {
  const data = { b: "2", a: "1", c: "3" };
  const text = stringifyFrontmatter(data, "");
  const lines = text.split("\n").filter((l) => l.includes(":"));
  assert.deepEqual(lines, ['b: "2"', 'a: "1"', 'c: "3"']);
});
