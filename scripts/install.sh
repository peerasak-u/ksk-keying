#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> ksk-keying install"

if ! command -v bun >/dev/null 2>&1; then
	echo "ERROR: Bun is required. Install from https://bun.sh then re-run:"
	echo "  bash scripts/install.sh"
	exit 1
fi

if [[ ! -f .claude/skills/ksk-keying/SKILL.md ]]; then
	echo "ERROR: Missing .claude/skills/ksk-keying/SKILL.md"
	exit 1
fi

AGENT_COUNT="$(find .claude/agents -maxdepth 1 -name 'ksk-*.md' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$AGENT_COUNT" -lt 6 ]]; then
	echo "ERROR: Expected 6 ksk-* agents in .claude/agents/ (found $AGENT_COUNT)"
	exit 1
fi

echo "==> Installing Bun dependencies (.claude/skills/ksk-keying/scripts)"
(cd .claude/skills/ksk-keying/scripts && bun install)

echo ""
echo "Done. Start Claude Code from this folder:"
echo "  cd \"$ROOT\""
echo "  claude"
echo ""
echo "Then run: /ksk-keying"