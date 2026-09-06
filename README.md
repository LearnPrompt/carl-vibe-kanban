# agent-board

```bash
git clone https://github.com/LearnPrompt/agent-board.git ~/projects/agent-board && cd ~/projects/agent-board && bash scripts/install.sh && board init
```

## 中文

agent-board 是一层协议，不是一个服务。每张任务卡是一个 markdown 文件，放在某个仓库的 `board/tasks/` 下，frontmatter 分成派生区（git/PR 状态，工具写）和人工区（next_step、evidence，人写）。多个仓库、多个对话、多个 agent 共用同一套卡片格式，`board` CLI 负责扫描、判断、渲染，不负责替你做决定。

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
| `agent` | 派生 | dispatch 时记录派给了哪个 agent |
| `title` | 人工 | 卡片标题 |
| `next_step` | 人工 | 下一步该做什么，`board next` 写 |
| `evidence` | 人工 | 验证证据（链接或路径），`board evidence` 追加 |
| `status_pinned` | 人工 | 锁定 status，`sync` 不再覆盖 |

致谢：方法论借鉴了 [Backlog.md](https://github.com/MrLesk/Backlog.md)（markdown 任务卡 + frontmatter 派生字段的思路）和 [Beads](https://github.com/steveyegge/beads)（依赖/阻塞关系与派生状态的建模方式）。

## English

agent-board is a protocol, not a service. Each task card is a markdown file under a repo's `board/tasks/`, with frontmatter split into a derived zone (git/PR facts, machine-written) and a manual zone (`next_step`, `evidence`, human-written). Many repos, conversations, and agents share the same card format; the `board` CLI scans, judges, and renders — it never decides for you.

Conversations produce branches, branches land as cards, and card status is derived from git and PR facts without manual syncing. You can ignore it entirely: skip the skill install, never run `board sync`, and the repo works exactly as before. Deleting `board/` entirely touches no git history or code.

Three daily commands:

```bash
board sync --all                     # refresh derived fields across every repo, incremental session scan included
board render --all                   # generate the summary index.html
board sessions ls --all --pinned     # list pinned sessions: branches, can-close/keep/no-clue
```

See the field table above — it applies identically in English; `status`/`stage`/`pr` are derived, `title`/`next_step`/`evidence` are manual.

Credits: the approach borrows from [Backlog.md](https://github.com/MrLesk/Backlog.md) (markdown cards with derived frontmatter) and [Beads](https://github.com/steveyegge/beads) (modeling dependencies and derived status).
