#!/usr/bin/env bash
# Idempotent global install for the `board` CLI.
# 1. Link `board` onto PATH (npm link, falling back to a direct symlink into
#    ~/.npm-global/bin if npm link fails for permission reasons).
# 2. Symlink skills/board into ~/.claude/skills and ~/.codex/skills so both
#    Claude Code and Codex pick it up globally.
# 3. Print `board --help` to confirm it's usable.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

chmod +x "$REPO_DIR/bin/board.mjs"

echo "== linking board CLI =="
if npm link >/tmp/carl-vibe-kanban-install-npmlink.log 2>&1; then
  echo "npm link OK"
else
  echo "npm link failed, falling back to ~/.npm-global/bin symlink"
  mkdir -p "$HOME/.npm-global/bin"
  ln -sf "$REPO_DIR/bin/board.mjs" "$HOME/.npm-global/bin/board"
  echo "linked $HOME/.npm-global/bin/board -> $REPO_DIR/bin/board.mjs"
  case ":$PATH:" in
    *":$HOME/.npm-global/bin:"*) ;;
    *) echo "注意: ~/.npm-global/bin 不在 PATH 里，请自行加入 shell profile" ;;
  esac
fi

echo "== linking skill into Claude Code / Codex =="
link_skill() {
  local target_dir="$1"
  local link_path="$target_dir/board"
  local want="$REPO_DIR/skills/board"
  mkdir -p "$target_dir"
  if [ -L "$link_path" ]; then
    local current
    current="$(readlink "$link_path")"
    if [ "$current" = "$want" ]; then
      echo "skip $link_path (already -> $want)"
      return 0
    else
      echo "ERROR: $link_path 已存在且指向 $current（非 $want），不覆盖" >&2
      return 1
    fi
  elif [ -e "$link_path" ]; then
    echo "ERROR: $link_path 已存在且不是软链，不覆盖" >&2
    return 1
  fi
  ln -s "$want" "$link_path"
  echo "linked $link_path -> $want"
}

link_skill "$HOME/.claude/skills"
link_skill "$HOME/.codex/skills"

echo "== board --help =="
board --help 2>/dev/null | head -5 || node "$REPO_DIR/bin/board.mjs" --help | head -5
