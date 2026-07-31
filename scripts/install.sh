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

# console/ has its own package.json (xlsx, yaml). Without this the review app
# dies on boot with `Cannot find package "xlsx"`.
echo "==> Installing Bun dependencies (console)"
(cd console && bun install)

# Native tools the pipeline shells out to. Reported, not installed — both need
# an explicit operator decision about where they live on PATH.
echo ""
echo "==> Native dependencies"
for cmd in pdfinfo pdftoppm pdfimages pdftotext claude; do
	if command -v "$cmd" >/dev/null 2>&1; then
		echo "  ok   $cmd"
	elif [[ "$cmd" == "claude" ]]; then
		echo "  MISS claude — see https://code.claude.com/docs/en/setup"
	else
		echo "  MISS $cmd — install poppler (macOS: brew install poppler; Linux: apt-get install poppler-utils)"
	fi
done

echo ""
echo "Done. Start Claude Code from this folder:"
echo "  cd \"$ROOT\""
echo "  claude"
echo ""
echo "Then run: /ksk-keying"