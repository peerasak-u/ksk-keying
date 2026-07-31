#!/usr/bin/env bash
# Dependencies only. Everything that VERIFIES the install lives in doctor.sh —
# run that after this, and any time something starts behaving oddly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> ksk-keying install (dependencies)"

if ! command -v bun >/dev/null 2>&1; then
	echo "ERROR: Bun is required. Install from https://bun.sh then re-run:"
	echo "  bash scripts/install.sh"
	exit 1
fi

echo "--> .claude/skills/ksk-keying/scripts"
(cd .claude/skills/ksk-keying/scripts && bun install)

# The console is dev/ops tooling, not part of the shipped skill (CLAUDE.md's
# deployable set is .claude/skills + .claude/agents only), so a customer install
# legitimately has no console/ at all. When it IS present its deps are not
# optional: `yaml` and `xlsx` are runtime imports of sequencer/
# interpret-executor.ts and app/xlsx-preview.ts, not just the Tailwind CLI —
# skipping this leaves the sequencer to fail at runtime with "Cannot find
# package 'yaml'".
if [[ -d console ]]; then
	echo "--> console"
	(cd console && bun install)
else
	echo "--> console (absent — skipped)"
fi

echo ""
echo "Dependencies installed. Now verify:"
echo "  bash scripts/doctor.sh"
