declare module "node:path" {
	export function basename(path: string): string;
	export function dirname(path: string): string;
	export function extname(path: string): string;
	export function join(...paths: string[]): string;
	export function relative(from: string, to: string): string;
	export function resolve(...paths: string[]): string;
}

declare module "node:fs" {
	export function copyFileSync(src: string, dest: string, mode?: number): void;
	export function existsSync(path: string): boolean;
	export function mkdirSync(
		path: string,
		options?: { recursive?: boolean },
	): void;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function readFileSync(
		path: string,
		options?: { encoding: "utf8"; flag?: string },
	): string;
	export function readFileSync(path: string): {
		toString(encoding: "base64"): string;
	};
	export function readdirSync(path: string): string[];
	export function renameSync(oldPath: string, newPath: string): void;
	export function rmSync(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): void;
	export function statSync(path: string): {
		isFile(): boolean;
		isDirectory(): boolean;
	};
	export function symlinkSync(target: string, path: string): void;
	export function writeFileSync(path: string, data: string): void;
}

declare module "node:child_process" {
	export function spawn(
		command: string,
		args?: string[],
	): {
		stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
		stderr: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
		on(event: "error", listener: (error: Error) => void): void;
		on(event: "close", listener: (code: number | null) => void): void;
	};
	export function spawnSync(
		command: string,
		args?: string[],
		options?: { encoding?: "utf8"; stdio?: "inherit" | "pipe" | "ignore" },
	): {
		status: number | null;
		stdout: string;
		stderr: string;
		error?: Error;
	};
}

declare const Bun: {
	argv: string[];
	sleep(ms: number): Promise<void>;
};

declare const process: {
	cwd(): string;
	env: Record<string, string | undefined>;
	exit(code?: number): never;
};
