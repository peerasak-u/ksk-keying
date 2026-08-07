// Plan §18: "Emit structured JSON logs to stdout with `jobId`,
// `workspaceRelPath`, request ID, idempotency key hash/reference, status,
// stage, and event version", and "Never log Claude credentials, full document
// contents, or arbitrary source paths outside the logical workspace reference."
//
// One line per event, JSON, to stdout. Deliberately tiny: a log library would
// be the second thing in this package with an opinion about process lifetime,
// and there is nothing here a JSON.stringify does not do.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
	/** A logger that stamps every line with the same fields — a request id, a
	 * jobId — so a call site does not have to remember them. */
	child(fields: LogFields): Logger;
};

export type LogSink = (line: string) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LoggerOptions = {
	level?: LogLevel;
	sink?: LogSink;
	/** Injected rather than read from the clock, so a test can pin it. */
	now?: () => string;
	base?: LogFields;
};

export function createLogger(options: LoggerOptions = {}): Logger {
	const level = options.level ?? "info";
	const sink = options.sink ?? ((line: string) => console.log(line));
	const now = options.now ?? (() => new Date().toISOString());
	const base = options.base ?? {};

	function emit(entryLevel: LogLevel, event: string, fields: LogFields = {}): void {
		if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
		sink(JSON.stringify({ ts: now(), level: entryLevel, event, ...base, ...fields }));
	}

	return {
		debug: (event, fields) => emit("debug", event, fields),
		info: (event, fields) => emit("info", event, fields),
		warn: (event, fields) => emit("warn", event, fields),
		error: (event, fields) => emit("error", event, fields),
		child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
	};
}

/** For tests and for the composition root's quiet mode. */
export const silentLogger: Logger = createLogger({ sink: () => {}, level: "error" });
