// Platform-dependent helpers shared by the deterministic scripts.
//
// These exist because the pipeline shells out to native tools (poppler) and
// runs on three very different hosts: the operator's macOS laptop, the Linux
// container on the Pi, and — since the ksk console grew a native-Windows
// target — PowerShell on Windows 10/11. Each one of those disagrees about how
// you ask "is this command installed?".
//
// Keep this module dependency-free and side-effect-free: every script imports
// it at module scope, including ones that must not touch the filesystem.

import { spawnSync } from "node:child_process";

// Is `cmd` resolvable on PATH?
//
// `which` is not a native Windows command — it exists only inside WSL or Git
// Bash, neither of which is guaranteed (or in scope) for a native install.
// `where` is the built-in equivalent and, usefully, shares `which`'s exit-code
// contract: 0 when found, non-zero when not. We deliberately look only at the
// status and never parse stdout, because `where` prints EVERY match while
// `which` prints one — the two outputs are not interchangeable, but their exit
// codes are.
export function commandAvailable(cmd: string): boolean {
	const finder = process.platform === "win32" ? "where" : "which";
	try {
		return spawnSync(finder, [cmd], { encoding: "utf8" }).status === 0;
	} catch {
		// spawnSync throws rather than returning a status if the finder itself
		// cannot be launched. "I could not check" is not "it is installed".
		return false;
	}
}

// The four poppler binaries the pipeline hard-requires: pdfinfo (true page
// counts for the census), pdftoppm (PDF -> PNG rendering), and pdfimages +
// pdftotext (the per-page DPI classifier's cheap path). A missing one is
// always fatal — guessing a page count would let documents vanish silently.
export const POPPLER_BINARIES = ["pdfinfo", "pdftoppm", "pdfimages", "pdftotext"] as const;

// Remediation text for a missing poppler, phrased for whichever host is
// actually running. The previous macOS-only "brew install poppler" was worse
// than unhelpful on Windows: it named a package manager the operator does not
// have, for a machine where the real fix is a PATH entry.
export function popplerInstallHint(): string {
	if (process.platform === "win32")
		return (
			"install Poppler for Windows (e.g. `winget install oschwartz10612.Poppler`, " +
			"or unzip a poppler-windows release) and add its Library\\bin folder to PATH, " +
			"then open a new PowerShell window so the new PATH is picked up"
		);
	if (process.platform === "darwin") return "install poppler (`brew install poppler`)";
	return "install poppler (e.g. `apt-get install poppler-utils`)";
}

// Assert every poppler binary is present, or throw naming the first missing one
// together with a host-appropriate fix.
export function ensurePopplerBinaries(commands: readonly string[] = POPPLER_BINARIES): void {
	for (const command of commands) {
		if (!commandAvailable(command))
			throw new Error(`${command} not found — ${popplerInstallHint()}`);
	}
}
