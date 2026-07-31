// Native-dependency probing for the review app.
//
// Deliberately a near-duplicate of .claude/skills/ksk-keying/scripts/platform.ts
// rather than an import: that directory is the SHIPPED SKILL, installed on its
// own into a customer's workspace (see CLAUDE.md), and must never take a
// dependency on console/. Two ~20-line copies is the cheaper mistake.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const IS_WINDOWS = process.platform === "win32";

const availability = new Map<string, boolean>();

/**
 * Is `cmd` resolvable on PATH? Cached, because the answer cannot change while
 * the server is up and the dashboard would otherwise re-probe per PDF.
 *
 * `which` does not exist on native Windows — that is WSL/Git Bash only —
 * so we use `where`, which shares its exit-code contract (0 found, non-zero
 * not). Only the status is read; `where` prints every match where `which`
 * prints one, so their stdout is not interchangeable.
 */
export function commandAvailable(cmd: string): boolean {
	const cached = availability.get(cmd);
	if (cached !== undefined) return cached;
	const finder = IS_WINDOWS ? "where" : "which";
	let found = false;
	try {
		found = spawnSync(finder, [cmd], { encoding: "utf8" }).status === 0;
	} catch {
		found = false;
	}
	availability.set(cmd, found);
	return found;
}

// Poppler binaries the pipeline needs. pdfinfo alone is what the dashboard's
// month-size estimate uses; the other three are required once a run starts.
export const POPPLER_BINARIES = ["pdfinfo", "pdftoppm", "pdfimages", "pdftotext"] as const;

export function popplerInstallHint(): string {
	if (IS_WINDOWS)
		return (
			"install Poppler for Windows (`winget install oschwartz10612.Poppler`, or unzip a " +
			"poppler-windows release) and add its Library\\bin folder to PATH, then reopen PowerShell"
		);
	if (process.platform === "darwin") return "install poppler (`brew install poppler`)";
	return "install poppler (e.g. `apt-get install poppler-utils`)";
}

export type PreflightEntry = { name: string; ok: boolean; detail: string };

/**
 * What the operator is missing, checked once at boot.
 *
 * Reports rather than exits — except for the caller's own judgement on
 * `claude`, without which no stage can run at all. The point is that a Windows
 * operator learns about a missing poppler from one startup line, instead of
 * from a dashboard that quietly counts every PDF month as a single page and an
 * ETA built on that number.
 */
export function preflight(): PreflightEntry[] {
	const entries: PreflightEntry[] = [];

	// An override is only good news if it actually points at something
	// spawnable. Reporting "ok" for a KSK_CLAUDE_BIN with a typo in it would
	// send the operator hunting everywhere except the one line that is wrong.
	const claudeBin = process.env.KSK_CLAUDE_BIN;
	if (claudeBin) {
		const exists = existsSync(claudeBin);
		const shim = IS_WINDOWS && !claudeBin.toLowerCase().endsWith(".exe");
		entries.push({
			name: "claude",
			ok: exists && !shim,
			detail: !exists
				? `KSK_CLAUDE_BIN=${claudeBin} does not exist`
				: shim
					? `KSK_CLAUDE_BIN=${claudeBin} is not an .exe — Windows cannot spawn a shim directly`
					: `${claudeBin} (KSK_CLAUDE_BIN)`,
		});
	} else {
		const found = commandAvailable("claude");
		entries.push({
			name: "claude",
			ok: found,
			detail: found
				? "on PATH"
				: IS_WINDOWS
					? "not found — install with `irm https://claude.ai/install.ps1 | iex`, or set KSK_CLAUDE_BIN"
					: "not found — see https://code.claude.com/docs/en/setup, or set KSK_CLAUDE_BIN",
		});
	}

	const missingPoppler = POPPLER_BINARIES.filter((binary) => !commandAvailable(binary));
	entries.push({
		name: "poppler",
		ok: missingPoppler.length === 0,
		detail: missingPoppler.length === 0
			? `${POPPLER_BINARIES.length}/${POPPLER_BINARIES.length} present`
			: `missing ${missingPoppler.join(", ")} — ${popplerInstallHint()}`,
	});

	if (IS_WINDOWS) {
		// Long paths: client artifacts nest deeply under a Thai-named Dropbox
		// root, and the classic 260-char MAX_PATH is not generous there. Probed,
		// never set — and a locked-down machine that refuses the read reports
		// "unknown" rather than crashing the server at boot.
		let longPaths: string | null = null;
		try {
			const result = spawnSync(
				"reg",
				["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"],
				{ encoding: "utf8" },
			);
			if (result.status === 0) longPaths = /0x1\b/.test(result.stdout || "") ? "enabled" : "disabled";
		} catch {
			longPaths = null;
		}
		entries.push({
			name: "long paths",
			ok: longPaths === "enabled",
			detail:
				longPaths === "enabled"
					? "enabled"
					: longPaths === "disabled"
						? "disabled — deep client artifact paths may fail; set LongPathsEnabled=1 (admin) and reboot"
						: "unknown (registry not readable)",
		});
	}

	return entries;
}

/** One block on stdout, so a misconfigured host is obvious before first use. */
export function logPreflight(entries: PreflightEntry[] = preflight()): void {
	for (const entry of entries) {
		console.log(`  ${entry.ok ? "ok  " : "MISS"} ${entry.name}: ${entry.detail}`);
	}
}
