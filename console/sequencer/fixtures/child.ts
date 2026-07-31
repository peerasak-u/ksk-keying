// Cross-platform process-supervision test fixture.
//
// process-supervisor.test.ts and engine.test.ts used to spawn ["sh", "-c", "..."]
// strings built from POSIX shell built-ins (setsid, $!, wait, printf, env -u).
// Two problems with that:
//   (a) macOS ships no `setsid` BINARY — only the setsid() SYSCALL, which
//       `Bun.spawn({ detached: true })` already calls under the hood. Every
//       fixture that shelled out to the binary silently diverged from what the
//       test expected (the backgrounded command failed with ENOENT and the
//       shell moved on) instead of exercising the real escape it was named for.
//   (b) native Windows has no sh.exe at all, so every fixture site would
//       ENOENT outright.
//
// This file replaces every such fixture with a small TypeScript program, run
// as `bun run child.ts <mode> [args...]`, that reproduces the exact same
// OS-level shapes — a same-group orphaned descendant, a session-escaped
// descendant, a descendant that also scrubs its ownership token while holding
// the inherited output pipe open, continuous/bounded output, a plain hang —
// using only APIs Bun exposes on every platform.
//
// Keep this file's *observable* behaviour (what it prints, how many bytes, when
// it exits, whether a descendant holds the output pipe open) in lock-step with
// the tests that assert against it — see each test's own comment for which
// mode it drives and why.

const IS_WINDOWS = process.platform === "win32";
// Mirrors process-supervisor.ts's own OWNERSHIP_ENV constant. Not imported from
// there on purpose — this fixture must stand on its own (it is also exec'd as a
// bare subprocess, not just imported), and the two must literally agree on the
// env var name for the "untrackable descendant" modes to mean what they say.
const OWNERSHIP_ENV = "KSK_SUPERVISED_TOKEN";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Busy-spin forever, burning CPU and producing no output. A "while :; do :; done" analog. */
function spinForever(): never {
	for (;;) {
		// Deliberately empty and synchronous: proves the supervisor's SIGTERM /
		// SIGKILL reach a genuinely CPU-bound process, not just one that is
		// cooperatively polling a timer. Signal delivery is kernel-level and does
		// not require this loop to yield (verified empirically on this machine).
	}
}

/** Plain, non-busy sleep for `seconds`, then a clean exit(0). A "sleep N" analog. */
async function sleepSeconds(seconds: number): Promise<never> {
	await sleep(seconds * 1_000);
	process.exit(0);
}

/** Print "x" forever, ~every 10ms, never exiting. Drives the "chatty but stuck" tests. */
async function streamForever(): Promise<never> {
	for (;;) {
		process.stdout.write("x");
		await sleep(10);
	}
}

/** Print exactly `n` bytes, then a clean exit(0). Drives the output-cap/truncation test. */
function bytesThenExit(n: number): never {
	process.stdout.write("x".repeat(n));
	process.exit(0);
}

type SpawnNestedOptions = {
	/**
	 * true: the nested process calls setsid() (via Bun's `detached`), giving it
	 * its own session/process group — a REAL escape, the same primitive the
	 * absent `setsid` binary would have used. false: it stays a plain child in
	 * this process's own group, reachable by the same -pgid signal as this
	 * process itself (the "orphan" shape).
	 */
	detached: boolean;
	/** Whether the nested process keeps the ownership token it would otherwise inherit. */
	keepToken: boolean;
	/**
	 * "inherit" lets the nested process hold the SAME stdout/stderr pipe this
	 * process was given — that pipe then cannot reach EOF until the nested
	 * process also closes it (the no-redirect shape). "ignore" detaches it
	 * immediately, the `>/dev/null 2>&1` analog.
	 */
	stdio: "inherit" | "ignore";
};

/** Spawn another instance of this same file as a child process, per `opts`. */
function spawnNested(args: string[], opts: SpawnNestedOptions) {
	const env: Record<string, string | undefined> = { ...process.env };
	if (!opts.keepToken) delete env[OWNERSHIP_ENV];
	return Bun.spawn([process.execPath, "run", import.meta.path, ...args], {
		env,
		stdin: "ignore",
		stdout: opts.stdio,
		stderr: opts.stdio,
		// Same rationale as process-supervisor.ts's own top-level spawn: setsid()
		// on POSIX genuinely moves the nested process to a new session/process
		// group, which is the real OS-level "escape" these fixtures need. There is
		// no process-group concept on Windows, so detaching there buys nothing —
		// see process-supervisor.ts's IS_WINDOWS comment for why it would instead
		// just sever the console link.
		detached: opts.detached && !IS_WINDOWS,
		windowsHide: true,
	});
}

const [, , mode, ...rest] = process.argv;

switch (mode) {
	case "exit": {
		process.exit(Number(rest[0] ?? "0"));
		break;
	}

	case "spin": {
		spinForever();
		break;
	}

	case "sleep": {
		await sleepSeconds(Number(rest[0]));
		break;
	}

	case "stream": {
		await streamForever();
		break;
	}

	case "bytes": {
		bytesThenExit(Number(rest[0]));
		break;
	}

	// Same-group descendant: never detached, so the supervisor's ordinary
	// -pgid signal reaches it exactly like the direct child. This is the
	// portable baseline every platform must honour, escape or not — it backs
	// every "orphaned CPU/sleeping child" test.
	case "orphan-exit":
	case "orphan-wait": {
		const grandchild = spawnNested(rest, { detached: false, keepToken: true, stdio: "inherit" });
		console.log(String(grandchild.pid));
		if (mode === "orphan-wait") await grandchild.exited;
		process.exit(0);
		break;
	}

	// Genuinely escapes this process's session/group (real setsid(), not the
	// absent `setsid` binary) but keeps its ownership token and does not hold
	// the pipe open. Only the Linux-only /proc token scan (taggedProcessIds in
	// process-supervisor.ts) can still reach a process that has left the
	// session entirely — see the tests using this mode for how each platform's
	// guarantee is asserted.
	case "escape-exit":
	case "escape-wait": {
		const grandchild = spawnNested(rest, { detached: true, keepToken: true, stdio: "ignore" });
		console.log(String(grandchild.pid));
		if (mode === "escape-wait") await new Promise<never>(() => {}); // blocks like a bare `wait`
		process.exit(0);
		break;
	}

	// Escapes AND scrubs its own ownership token AND keeps holding this
	// process's stdout/stderr pipe open — untrackable by any mechanism this
	// supervisor has, on any platform. Matches the old
	// `setsid env -u KSK_SUPERVISED_TOKEN sleep N & echo spawned; exit 0`.
	// The grandchild's pid is logged to STDERR (never stdout, so it can't be
	// mistaken for part of the "untrackable" contract under test) purely so the
	// test can best-effort SIGKILL it during teardown instead of leaking a real
	// process — production code gets no such backdoor.
	case "escape-untrackable-exit": {
		const seconds = rest[0];
		const grandchild = spawnNested(["sleep", seconds], { detached: true, keepToken: false, stdio: "inherit" });
		console.error(`gc-pid=${grandchild.pid}`);
		console.log("spawned");
		process.exit(0);
		break;
	}

	// Same untrackable escape, but the direct child ALSO stays busy in the
	// foreground (no "spawned" echo) — proves the wall deadline bounds the
	// direct child even though an unreachable descendant is holding the pipe
	// open the whole time. Matches the old
	// `setsid env -u KSK_SUPERVISED_TOKEN sleep N & sleep N`.
	case "escape-untrackable-fg": {
		const seconds = Number(rest[0]);
		const grandchild = spawnNested(["sleep", String(seconds)], { detached: true, keepToken: false, stdio: "inherit" });
		console.error(`gc-pid=${grandchild.pid}`);
		await sleep(seconds * 1_000);
		process.exit(0);
		break;
	}

	default: {
		console.error(`fixtures/child.ts: unknown mode "${mode}"`);
		process.exit(1);
	}
}
