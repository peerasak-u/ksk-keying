#!/usr/bin/env bash
# Verifies that a clone can actually complete a run. Deliberately NOT part of
# install.sh: the failures this catches are the ones that otherwise surface
# hours into a paid run against a real client month.
#
# Two failure shapes it exists to prevent:
#   * A missing Poppler. pdfinfo/pdftoppm are hard requirements (Stage 0's page
#     census, Stage 2's rendering). Without them a run sets up fine, spends
#     money, and dies mid-pipeline.
#   * A toolchain that imports but cannot resolve its own paths. The scripts
#     compute TOOL_DIR at module load; a bad value does not throw there, it
#     throws later when a prompt file is read. So this ends by actually RUNNING
#     one bundled script and checking it produced its artifact.
#
# Exit 0 = ready. Exit 1 = at least one ERROR. Warnings never fail the run.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ERRORS=0
WARNINGS=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
err()  { printf '  \033[31mERROR\033[0m %s\n' "$*"; ERRORS=$((ERRORS + 1)); }

case "$(uname -s 2>/dev/null || echo unknown)" in
	Darwin) POPPLER_HINT="brew install poppler" ;;
	Linux)  POPPLER_HINT="sudo apt install poppler-utils   (or your distro's equivalent)" ;;
	*)      POPPLER_HINT="winget install oschwartz10612.Poppler   (then reopen the shell)" ;;
esac

echo "==> ksk-keying doctor"

echo "[1/5] tools"
if command -v bun >/dev/null 2>&1; then ok "bun $(bun --version)"; else err "bun not found — https://bun.sh"; fi
# Needed to RUN, not to install, so a clone being prepped for another machine
# is not broken by its absence.
if command -v claude >/dev/null 2>&1; then ok "claude $(claude --version 2>&1 | head -1)"; else warn "claude not found — required to run /ksk-keying (https://code.claude.com)"; fi
for tool in pdfinfo pdftoppm; do
	if command -v "$tool" >/dev/null 2>&1; then
		ok "$tool $("$tool" -v 2>&1 | head -1 | sed 's/^[^0-9]*//')"
	else
		err "$tool not found — Poppler is required by Stage 0 (page census) and Stage 2 (rendering). Install: $POPPLER_HINT"
	fi
done

echo "[2/5] skills"
[[ -f .claude/skills/ksk-keying/SKILL.md ]] && ok "ksk-keying (orchestrator)" || err "missing .claude/skills/ksk-keying/SKILL.md"
# Named explicitly rather than counted: a count silently passes a tree that has
# the right NUMBER of the wrong things, which is how the old `-lt 6` check kept
# passing after a seventh agent was added.
for stage in profile segment interpret link group categorize; do
	[[ -f ".claude/skills/ksk-stage-$stage/SKILL.md" ]] && ok "ksk-stage-$stage" || err "missing .claude/skills/ksk-stage-$stage/SKILL.md"
done

echo "[3/5] agents"
for agent in magnum columbo watson sherlock marple poirot lestrade; do
	[[ -f ".claude/agents/ksk-$agent.md" ]] && ok "ksk-$agent" || err "missing .claude/agents/ksk-$agent.md"
done

echo "[4/5] dependencies"
if [[ -d .claude/skills/ksk-keying/scripts/node_modules ]]; then
	ok "skill scripts deps"
else
	err "skill scripts deps missing — run: bash scripts/install.sh"
fi
if [[ -d console ]]; then
	if [[ -d console/node_modules ]]; then
		ok "console deps"
	else
		err "console deps missing (yaml/xlsx are runtime imports, not just Tailwind) — run: bash scripts/install.sh"
	fi
fi

echo "[5/5] smoke test — a bundled script must run and produce its artifact"
if command -v bun >/dev/null 2>&1 && [[ -d .claude/skills/ksk-keying/scripts/node_modules ]]; then
	TMP="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/ksk-doctor-$$")"
	mkdir -p "$TMP"
	echo "smoke" > "$TMP/sample.txt"
	if bun run --cwd .claude/skills/ksk-keying/scripts inventory -- --json "$TMP" >/dev/null 2>&1 \
		&& [[ -f "$TMP/ข้อมูลระบบ/_pages/inventory.yaml" ]]; then
		ok "inventory ran and wrote ข้อมูลระบบ/_pages/inventory.yaml"
	else
		err "inventory failed to produce its artifact — the bundled scripts cannot resolve their own paths on this host"
	fi
	rm -rf "$TMP"
else
	warn "smoke test skipped (needs bun + installed deps)"
fi

echo ""
if [[ "$ERRORS" -gt 0 ]]; then
	echo "FAILED: $ERRORS error(s), $WARNINGS warning(s). Fix the errors above before running /ksk-keying."
	exit 1
fi
echo "Ready: 0 errors, $WARNINGS warning(s)."
echo "Start Claude Code from this folder and run: /ksk-keying"
