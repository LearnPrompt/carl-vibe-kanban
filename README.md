# carl-vibe-kanban

```bash
git clone https://github.com/LearnPrompt/carl-vibe-kanban.git ~/projects/carl-vibe-kanban && cd ~/projects/carl-vibe-kanban && bash scripts/install.sh && board init
```

不起 agent 进程、不内嵌终端、不要登录、没有服务端。每条分支一张 markdown 卡，状态从 git 和 GitHub 现场读，告诉你每个对话对应的分支推到哪一步、这个对话敢不敢关。Claude Code 与 Codex 共用一份 skill，也可以走 MCP 或 hooks。

A local-only ledger for coding agents: one markdown card per branch, state read live from git and GitHub, telling you where every conversation's branch stands and whether that conversation is safe to close. No agent runner, no embedded terminal, no login, no server. One skill shared by Claude Code and Codex; MCP and hooks included.

## 从 vibe-kanban 过来

名词对照：vibe-kanban 的 project 是这里的一个 repo；task 是一张 markdown 卡；workspace 或 attempt 是一条分支加一个 worktree；attempt 的状态是卡上的派生字段和证据行（PR 链接、合并 commit、截图路径）。

三处不一样，每处对应它 issue 里反复出现的问题：

vibe-kanban 把看板放在自己的数据库里，手动 checkout 它不认，外部开的 PR 它不识别，清掉 worktree 卡片会静默丢关联（#2655、#2629、#3329）。这里没有数据库，每次 `board sync` 从 git 和 gh 重新推导，板子不可能和仓库对不上。

vibe-kanban 替你起 agent 进程，每家 CLI 改一次输出格式就要适配一次（三十多条适配 issue）。这里不起进程，任何能读写文件的 agent 第一天就能用。

vibe-kanban 从 v0.1.9 起要登录才能看板（#2687）。这里是仓库里的一个 `board/` 文件夹，离线、内网、多机同步都靠 git。

它的现状：Bloop 于 2026 年 4 月关停，云端 5 月 10 日下线，官网域名 6 月过期，最后一个能本地跑完整看板的版本是 `npx vibe-kanban@0.1.43`。本项目不是它的 fork，没有共用代码，名字里带 vibe-kanban 是为了让找它替代品的人能找到这里。

Coming from vibe-kanban: a project is a repo here, a task is a markdown card, a workspace/attempt is a branch plus a worktree, and attempt status is the card's derived fields and evidence lines. Three differences, each matching a recurring issue there: no database, so the board cannot drift from git (#2655, #2629, #3329); no agent runner, so nothing to adapt per CLI; no login, the board is a folder in your repo. Bloop shut down in April 2026, cloud went dark May 10, the domain expired in June; the last fully local version is `npx vibe-kanban@0.1.43`. This is not a fork and shares no code.

## 中文

carl-vibe-kanban 是一层协议，不是一个服务。每张任务卡是一个 markdown 文件，放在某个仓库的 `board/tasks/` 下，frontmatter 分成派生区（git/PR 状态，工具写）和人工区（next_step、evidence，人写）。多个仓库、多个对话、多个 agent 共用同一套卡片格式，`board` CLI 负责扫描、判断、渲染，不负责替你做决定。

工作方式是对话产生分支，分支落地成卡片，卡片状态由 git 和 PR 事实推导，不需要手工同步。你可以完全不用它：不装 skill、不跑 `board sync`，仓库照常工作，`board/` 目录也可以整个删除，不影响任何 git 历史或代码。

日常三条命令：

```bash
board sync --all                     # 刷新所有仓库的卡片派生字段，顺带增量扫描对话
board render --all                   # 生成汇总页 index.html
board sessions ls --all --pinned     # 列出置顶对话：分支、可关/别关/无线索
```

协议字段表：

| 字段 | 区域 | 说明 |
|---|---|---|
| `id` / `branch` / `created` | 派生 | 卡片标识，创建时写入不再变 |
| `status` / `stage` / `pr` / `pr_state` | 派生 | 由 git/gh 事实推导，`sync` 时重算 |
| `flags` / `conflicts_with` | 派生 | 脏文件、未 push、与其他卡片冲突等信号 |
| `agent` | 人工 | 派给了哪个 agent，dispatch --agent 写入，也可手改 |
| `title` | 人工 | 卡片标题 |
| `next_step` | 人工 | 下一步该做什么，`board next` 写 |
| `evidence` | 人工 | 验证证据（链接或路径），`board evidence` 追加 |
| `status_pinned` | 人工 | 锁定 status，`sync` 不再覆盖 |

致谢：方法论借鉴了 [Backlog.md](https://github.com/MrLesk/Backlog.md)（markdown 任务卡 + frontmatter 派生字段的思路）和 [Beads](https://github.com/steveyegge/beads)（依赖/阻塞关系与派生状态的建模方式）。

## English

carl-vibe-kanban is a protocol, not a service. Each task card is a markdown file under a repo's `board/tasks/`, with frontmatter split into a derived zone (git/PR facts, machine-written) and a manual zone (`next_step`, `evidence`, human-written). Many repos, conversations, and agents share the same card format; the `board` CLI scans, judges, and renders — it never decides for you.

Conversations produce branches, branches land as cards, and card status is derived from git and PR facts without manual syncing. You can ignore it entirely: skip the skill install, never run `board sync`, and the repo works exactly as before. Deleting `board/` entirely touches no git history or code.

Three daily commands:

```bash
board sync --all                     # refresh derived fields across every repo, incremental session scan included
board render --all                   # generate the summary index.html
board sessions ls --all --pinned     # list pinned sessions: branches, can-close/keep/no-clue
```

See the field table above — it applies identically in English; `status`/`stage`/`pr` are derived, `title`/`next_step`/`evidence` are manual.

Credits: the approach borrows from [Backlog.md](https://github.com/MrLesk/Backlog.md) (markdown cards with derived frontmatter) and [Beads](https://github.com/steveyegge/beads) (modeling dependencies and derived status).
