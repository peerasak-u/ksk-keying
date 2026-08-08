// A real workspace on disk for the application and HTTP tests. The point is
// that they read `run-state.yaml`, `ledger.yaml`, `CLIENT.md` and the
// `_doc_groups` tree exactly as the runtime writes them — a fake repository
// would pass while the file layout was wrong.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { RunStatus } from "../workflow/state-machine";

export type Fixture = {
	root: string;
	monthDir(clientKey: string, monthId: string): string;
	addMonth(clientKey: string, monthId: string): void;
	addClientFile(clientKey: string, name: string, content: string): void;
	writeRunState(clientKey: string, monthId: string, options: WriteRunStateOptions): void;
	writeRawRunState(clientKey: string, monthId: string, raw: string): void;
	writeLedgerCounts(clientKey: string, monthId: string, counts: { units: number; reviewed: number; excluded: number }): void;
	addGroup(clientKey: string, monthId: string, bucket: string, groupId: string, options?: AddGroupOptions): void;
	cleanup(): void;
};

export type WriteRunStateOptions = {
	status: RunStatus;
	stageIndex?: number;
	retryCount?: number;
	log?: string[];
	humanStopEntries?: Array<{ stage: string; unit: string | null; condition: string; reason: string }>;
	startedAt?: string;
	updatedAt?: string;
	finishedAt?: string | null;
	stageStartedAt?: string | null;
};

export type AddGroupOptions = {
	/** Pages, only `initial_status` of which the run projection reads. */
	pages?: Array<{ initial_status: "reviewed" | "needs_attention" }>;
	/** true → `review-data.json` is newer than its pristine
	 * `review-data.ai.json` sidecar, which is [C-38]'s definition of an edited
	 * group. */
	humanEdited?: boolean;
	/** true → no `review-data.ai.json` at all, and a `categorize.json` written
	 * BEFORE `review-data.json`. This is the shape every group in the real
	 * workspace has today: built before the pristine sidecar existed. It is the
	 * case that made `categorize.json` an unusable fallback marker, because the
	 * build always writes `review-data.json` after it. */
	preSidecar?: boolean;
};

const SYSTEM_DIR = "ข้อมูลระบบ";

export function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "keying-core-ws-"));

	function monthDir(clientKey: string, monthId: string): string {
		return join(root, clientKey, monthId);
	}

	function pagesDir(clientKey: string, monthId: string): string {
		return join(monthDir(clientKey, monthId), SYSTEM_DIR, "_pages");
	}

	return {
		root,
		monthDir,

		addMonth(clientKey, monthId) {
			mkdirSync(monthDir(clientKey, monthId), { recursive: true });
		},

		addClientFile(clientKey, name, content) {
			mkdirSync(join(root, clientKey), { recursive: true });
			writeFileSync(join(root, clientKey, name), content, "utf8");
		},

		writeRunState(clientKey, monthId, options) {
			const dir = pagesDir(clientKey, monthId);
			mkdirSync(dir, { recursive: true });
			const doc = {
				schema: "ksk_run_state.v1",
				started_at: options.startedAt ?? "2026-08-07T09:14:02.117Z",
				updated_at: options.updatedAt ?? "2026-08-07T10:02:44.310Z",
				finished_at: options.finishedAt ?? null,
				stage_started_at: options.stageStartedAt ?? "2026-08-07T09:41:55.902Z",
				state: {
					stageIndex: options.stageIndex ?? 0,
					status: options.status,
					retryCount: options.retryCount ?? 0,
					lastGateStdout: null,
					humanStopEntries: options.humanStopEntries ?? [],
					log: options.log ?? [],
				},
			};
			writeFileSync(join(dir, "run-state.yaml"), yamlStringify(doc), "utf8");
		},

		writeRawRunState(clientKey, monthId, raw) {
			const dir = pagesDir(clientKey, monthId);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "run-state.yaml"), raw, "utf8");
		},

		writeLedgerCounts(clientKey, monthId, counts) {
			const dir = pagesDir(clientKey, monthId);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "ledger.yaml"), yamlStringify({ schema: "ksk_ledger.v1", counts }), "utf8");
		},

		addGroup(clientKey, monthId, bucket, groupId, options = {}) {
			const dir = join(monthDir(clientKey, monthId), SYSTEM_DIR, "_doc_groups", ...bucket.split("/"), groupId);
			mkdirSync(dir, { recursive: true });
			const data = { schema: "ksk_review_group_data.v1", label: groupId, pages: options.pages ?? [] };
			const reviewPath = join(dir, "review-data.json");
			const sidecarPath = join(dir, "review-data.ai.json");
			const categorizePath = join(dir, "categorize.json");
			writeFileSync(reviewPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
			// mtimes are set explicitly rather than relying on write order, which a
			// coarse-grained filesystem clock can flatten.
			const base = 1_770_000_000;

			if (options.preSidecar) {
				// The real workspace's shape: categorize.json written first, then
				// review-data.json, and no pristine sidecar at all. Reproduced with
				// the same ordering measured on disk — categorize at 15:20:32,
				// review-data at 15:22:28, ~2 minutes later, both by the same build.
				writeFileSync(categorizePath, `${JSON.stringify({ groups: [] }, null, 2)}\n`, "utf8");
				utimesSync(categorizePath, base, base);
				utimesSync(reviewPath, base + 116, base + 116);
				return;
			}

			// build-review-data.ts writes review-data.json first and the pristine
			// sidecar second, so a freshly built group has the sidecar newer.
			writeFileSync(sidecarPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
			utimesSync(reviewPath, base, base);
			utimesSync(sidecarPath, base + 1, base + 1);
			if (options.humanEdited) utimesSync(reviewPath, base + 60, base + 60);
		},

		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
