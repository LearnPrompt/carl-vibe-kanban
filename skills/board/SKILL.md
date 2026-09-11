---
name: board
description: 跨仓库任务板：对话 → 分支 → 落地。用户问某个项目进度、哪些分支在等 review、哪些置顶对话可以关掉或归档、要派活开 worktree、给某张卡写下一步或补证据时用；自己开始或结束一段分支工作时也要过一遍。
---

# board：给并行分支和对话记账

`board` 是全局命令（安装见仓库 README）。每个仓库的卡片在该仓 `board/tasks/<id>.md`，一卡一分支，frontmatter 派生区由 `board sync` 从 git 和 gh 推导，人只写 `next_step`、`evidence`、`agent`、正文。工作区里有哪些仓看 `board repos`；子命令与参数看 `board --help`。

**真相源边界**：branch、worktree、PR、最近提交、stage、conflicts_with、status、flags 全是派生字段，手改必被覆盖。要锁状态用 `board pin`。

## 何时跑什么

1. **回答进度或"哪些对话能关"之前**：`board sync --all` 再 `board sessions ls --all --pinned --json`。用刷出来的字段作答，不引用记忆里的 PR 状态。关对话之前可先跑 `board sessions judge --all --ai` 拿 AI 建议，结果只是建议，归档仍等用户点头。不带 `--ai` 时表里也可能出现 `ai-archive` 行，那是上次 `--ai` 留在缓存里的决策，别据此说自己刚跑过 AI。
2. **对话元数据只有桌面 app 有**：在 Claude 桌面 app 里时，先用 `list_sessions` 拿会话列表（limit 100），写成 JSON 文件，`board sessions import <文件>`。不导入就没有标题、置顶、PR 号，树上只剩转录抽出来的第一句话。
3. **开始一段分支工作**：`board dispatch <branch> --agent <你是谁>` 建 worktree 并落卡，然后 `board next <id> "<这轮要做到什么>"`。已有卡就只写 next。
4. **结束一段工作**：`board evidence <id> <PR链接|截图路径|测试输出路径>`，再 `board next <id>` 写下一步或「等卡尔过目」，最后 `board sync`。没有 evidence 的 done 卡不亮绿。
5. **给人看**：`board render --all`，用 headless Chrome 截 `~/agent-workbench/board/index.html` 发给用户。
6. **合并后的收尾**：`board cleanup --all` 列出已合并却还留着 worktree 的卡；用户点头后 `board cleanup --all --apply` 删 worktree 和本地分支，有脏文件或未 push 的会被拒绝，别用 `--force` 绕过，把拒绝原因告诉用户。
7. **卡片入库的仓，同步后要落盘**：`board/` 已经纳入 git（`git ls-files -- board/` 非空）的仓，`sync` 之后跑 `board commit --push` 把刷新的卡片提交进主干；只碰 `board/tasks`、`board/archive`、`board/board.config.json`，不会碰同一工作树里别的未提交改动。定时刷新交给 `board schedule install`（macOS LaunchAgent，默认早晚各一次），agent 自己不要再手搭 cron 或 launchd job。

## 三条进门的路

- **CLI**：本文所有命令。
- **hooks**：`board hooks install` 装一次后，Claude Code 每次会话开始、每条用户消息、每次结束都会把 (session, cwd, 当前分支) 记进 `~/.cache/board/hooks/events.jsonl`，对话↔分支不用再猜。`sessions ls` 里带 `hook` 标签的行就是这条路来的，置信度最高。`board hooks status` 看装没装。
- **MCP**：`board mcp install` 后，Claude Code 和 Codex 都能用 `board_ls`、`board_sessions`、`board_judge`、`board_next`、`board_evidence`、`board_pin`、`board_cleanup`、`board_dispatch` 这些工具直接读写卡片，效果与 CLI 一致。Grok 不用另配：它直接读 `~/.claude.json` 的 mcpServers 和 `~/.claude/skills`，工具名前缀是 `board__`。有 MCP 就优先用工具，少开 shell。多仓工作区里 `board_ls` 和 `board_judge` 带 `repo` 或 `limit`（对应 CLI 的 `--repo <label>` 和 `--limit N`，label 就是 `board repos` 第一列），别裸传 `all:true` 拉全量，原因见下面「各宿主的坑」。

## 关对话的流程

`sessions ls` 的 verdict 有三种：`can-close`（碰过的分支全部合并或放弃，worktree 干净）、`keep`（reason 里写着哪条分支为什么不能关）、`no-clue`（没碰过任何仓库的分支，写作类对话）。

桌面 app 的归档接口拒绝置顶会话，agent 也没有取消置顶的工具。所以：
1. 把 `can-close` 且 `pinned` 的列成一张表给用户：标题、碰过的分支、reason，标出 `prInferred` 的（按 PR 号推断，置信度低）。
2. 用户在侧栏取消置顶后说「归档」，再对每个 `appSessionId` 调 `archive_session`，reason 写「分支已合并」。用户没点头的一个都不动。
3. `keep` 的把 reason 原话告诉用户，让用户决定推进还是放弃；放弃就 `board pin <id> dropped`。

Codex 里没有 app 的会话工具，只做第 1 步给清单。

页面这条路：`board render --all` 生成的页里每个仓库上方有「建议归档」面板（只列有 appSessionId 的会话，转录行折在下面），用户勾选后点「让 Claude 归档」，桌面 app 会用 `claude://code/new?prompt=…` 新开一个会话并把清单塞进首条消息。你若在那个会话里醒来，看到「请用 archive_session 逐个归档以下桌面会话」就按清单逐个调 `archive_session`（reason 写「分支已合并」），置顶的报出来让用户取消置顶，清单之外的一个都别动。chip 上的「打开」是 `claude://code/continue?session=<local_id>`，直接跳到那个会话；Codex 会话暂无跳转。

## 各宿主的坑

09-10 在 Codex 与 Grok 上实测 v0.7 得到的三处，遇到对应症状先照这里处理，别重新排查。

- **Codex 二进制与 skill 预算**：PATH 上的 `codex` 比配置里的模型老时，`codex exec` 直接报 `The '<model>' model requires a newer version of Codex`，改用 ChatGPT.app 自带的 `/Applications/ChatGPT.app/Contents/Resources/codex`。Codex 的 skill 上下文预算只有 2%，`~/.codex/skills` 一多就报 `Exceeded skills context budget`，随后把所有 skill 描述清空，board 也不在可见列表里。这时只能按绝对路径读 `~/.codex/skills/board/SKILL.md`。另外 Codex 的 notify 只有一个槽位，被别的工具占着时 `board hooks install` 装不进去，`board hooks status` 会写明，Codex 对话就不会进 events.jsonl。
- **Grok 截断 MCP 返回**：返回超过约 19.5 KB 时 Grok 只把前半截给模型，末尾附一行 `[MCP output truncated: … Full output written to: ~/.grok/sessions/<cwd>/<session>/mcp/<call>.json]`。`board_ls` 与 `board_judge` 裸传 `all:true` 都会超。在 Grok 里一律带 `repo` 或 `limit` 分批拿；已经截断的，用 `run_terminal_command` 配 `jq` 或 `python3` 读那个落盘文件，别拿半截 JSON 硬解析。
- **Grok 沙箱 shell 无网**：`run_terminal_command` 跑在 `~/.grok/sandbox.toml` 的沙箱里，`gh` 查不到 PR，按 PR 号推断的 landed 行会整批漏掉（实测比 MCP 少 68 行，且 exit 0 无报错）。在 Grok 里判「可关」只信 MCP 路的结果，shell 里的 `board sessions judge` 只当参考。

## 读 sync 输出

每行一张有变化的卡，`status: a → b` 就是覆盖记录。`ARCHIVE` 行表示 done/dropped 超过配置天数的卡被移进 `board/archive/`，归档后不再自动重建。`SKIP <path>` 表示工作区里某个仓路径不存在或不是 git 仓。

## flags 与 stage

- stage 七档：`dirty`（有未提交文件，优先级最高）→ `unpushed` → `pushed` → `pr_open` → `merged` / `closed` / `missing`。
- `conflict`：与其它活跃分支改了同一批文件，合并前先看 `conflicts_with`。
- `branch_missing`：本地和 origin 都没这条分支，考虑 `board archive <id>`。
- `stale_7d`：doing/review 却七天没提交，问用户还做不做。
- `pr_closed_unmerged`：PR 关了没合，找原因写进正文。
- `prunable`：worktree 目录已不在，`git worktree prune` 后 sync。
- `no_next_step`：账没记完，补上。

## 边界

- 在任何 worktree 里跑，卡都写进该仓主工作树的 `board/`；`BOARD_HOME` 可覆盖数据目录。
- `board dispatch` 默认只打印启动命令，`--run` 才真起 agent 进程。
- 仓库级 `board/board.config.json` 不含可执行内容；`on_done` 钩子与工作区仓库列表在 `~/.config/board/config.json`。
- 各仓 `board/` 目录要不要提交进 git 由用户决定，agent 不替用户 commit 它；`board commit` 对没把 `board/` 纳入 git 的仓一律 SKIP（`卡片未入库`），不会替用户做这个决定。
