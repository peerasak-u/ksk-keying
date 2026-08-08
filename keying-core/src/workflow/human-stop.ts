// §3.6 — the stop conditions as a closed set, and §3.7's rule that a stop is
// never silent.
//
// [C-36]: `condition` is a closed three-value enumeration in the API contract,
// and Core carries a person-facing Thai `message` and `remedy` for each. The
// policy file (`.claude/skills/ksk-keying/references/decision-policy.md` → Stop
// rules) is the source of the RULE, but a policy file is not a wire contract: a
// platform cannot switch exhaustively on a set that is only implied. Adding a
// fourth blocker is therefore a deliberate two-part change — one row in this
// table, one deploy — instead of a silent widening.
//
// The strings below are §3.6's own table, verbatim. They are written for an
// accountant, not an engineer: each says what to go and fix, and none of them
// names a stage, an exit code, or a file the pipeline owns.
import type { Logger } from "../observability/logger";

export const STOP_CONDITIONS = ["no_coa_source", "unreadable_required_source", "no_rule_ambiguity"] as const;

export type StopCondition = (typeof STOP_CONDITIONS)[number];

export function isStopCondition(value: string): value is StopCondition {
	return (STOP_CONDITIONS as readonly string[]).includes(value);
}

/** The raw entry as `ข้อมูลระบบ/_pages/human-stop.yaml` carries it and as the
 * sequencer persists it (`logic.ts:65-70`). `stage`, `unit` and `reason` are
 * the artifact's own bytes and are echoed untouched. */
export type RawHumanStopEntry = {
	stage: string;
	unit: string | null;
	condition: string;
	reason: string;
};

/** What `humanStop[]` carries on the wire (§1.7, §3.6). `condition`,
 * `conditionRaw`, `message` and `remedy` are Core's, derived on read. */
export type HumanStopEntry = {
	stage: string;
	unit: string | null;
	/** `null` when the YAML's value is not one of the three — [C-37]. */
	condition: StopCondition | null;
	/** The YAML's value, verbatim, always. */
	conditionRaw: string;
	reason: string;
	message: string;
	remedy: string;
};

type PersonFacing = { message: string; remedy: string };

const TEXT: Record<StopCondition, PersonFacing> = {
	no_coa_source: {
		message: "ยังไม่มีผังบัญชีของลูกค้ารายนี้ ระบบจึงลงบัญชีให้ไม่ได้เลย",
		remedy:
			"วางไฟล์ coa.csv หรือไฟล์ผังบัญชี (.xlsx/.xls) ไว้ในโฟลเดอร์ของลูกค้า — ระดับลูกค้า ไม่ใช่ระดับเดือน — แล้วเก็บ human-stop.yaml และสั่งรันใหม่",
	},
	unreadable_required_source: {
		message: "เปิดไฟล์ «<unit>» ไม่ได้ หรือไฟล์หายไป จึงตรวจเอกสารใบนี้ต่อไม่ได้",
		remedy:
			"หาไฟล์ตัวจริงมาวางทับที่เดิม (สแกนใหม่ หรือขอจากลูกค้า) ถ้าเอกสารใบนี้ไม่ต้องลงบัญชีจริง ๆ ให้เอาออกจากโฟลเดอร์เดือนนั้น แล้วเก็บ human-stop.yaml และสั่งรันใหม่",
	},
	no_rule_ambiguity: {
		message: "รายการนี้ลงบัญชีได้สองทางที่ขัดกัน และนโยบายยังไม่ได้ตัดสินว่าให้ยึดทางไหน",
		remedy:
			"อ่านเหตุผลที่ระบบเขียนไว้ เลือกแนวทาง แล้วบันทึกเป็นข้อตกลงของลูกค้ารายนี้ใน CLIENT.md (หัวข้อ conventions) — ถ้าเป็นเรื่องที่ใช้กับทุกลูกค้า ให้แก้ที่ decision-policy.md — แล้วเก็บ human-stop.yaml และสั่งรันใหม่",
	},
};

/** [C-37]'s fallback pair. The person still gets the stage's own `reason` —
 * the part written for this specific incident — plus an instruction that ends
 * with somebody being told the contract has drifted. */
function fallbackText(conditionRaw: string): PersonFacing {
	return {
		message: `งานนี้หยุดรอคน ด้วยเหตุผลที่ระบบรุ่นนี้ยังไม่รู้จัก (${conditionRaw})`,
		remedy: `อ่านข้อความในช่อง «เหตุผล» ซึ่งเป็นสิ่งที่ขั้นตอนนั้นเขียนไว้เอง จัดการต้นเหตุตามนั้น แล้วแจ้งผู้ดูแลระบบว่าพบเงื่อนไขใหม่ «${conditionRaw}» เพื่อเพิ่มเข้าสัญญา`,
	};
}

/** `<unit>` is substituted verbatim (Thai filenames included) at read time. A
 * client-wide condition has `unit: null`; the placeholder then has nothing to
 * name, so it is dropped rather than printed as the literal word "null". */
function substituteUnit(text: string, unit: string | null): string {
	return text.replaceAll("<unit>", unit ?? "");
}

export type EnrichContext = {
	logger?: Logger;
	/** Carried onto §3.7's log line so an operator can join it to the run. */
	jobId?: string;
	workspaceRelPath?: string;
};

/** Enrich one raw entry. Never rejects, never drops: [C-37]'s whole point is
 * that an unrecognised condition is surfaced as unrecognised, because
 * "visibility of the stop never depends on Core understanding it". */
export function enrichHumanStopEntry(raw: RawHumanStopEntry, context: EnrichContext = {}): HumanStopEntry {
	const conditionRaw = raw.condition;
	const known = isStopCondition(conditionRaw);
	const text = known ? TEXT[conditionRaw] : fallbackText(conditionRaw);

	if (!known) {
		// §3.7's third row: one `warn` line an operator can grep the moment the
		// platform starts showing the fallback. Plan §18's redaction rules apply
		// unchanged — `unit` is workspace-relative, `reason` is the stage's own
		// sentence, and nothing is added to it.
		context.logger?.warn("run.human_stop.unknown_condition", {
			jobId: context.jobId ?? null,
			workspaceRelPath: context.workspaceRelPath ?? null,
			stage: raw.stage,
			unit: raw.unit,
			conditionRaw,
		});
	}

	return {
		stage: raw.stage,
		unit: raw.unit,
		condition: known ? conditionRaw : null,
		conditionRaw,
		reason: raw.reason,
		message: substituteUnit(text.message, raw.unit),
		remedy: substituteUnit(text.remedy, raw.unit),
	};
}

export function enrichHumanStopEntries(raw: RawHumanStopEntry[], context: EnrichContext = {}): HumanStopEntry[] {
	return raw.map((entry) => enrichHumanStopEntry(entry, context));
}

/** Normalise whatever `run-state.yaml` carried into the raw entry shape. A
 * malformed member is coerced rather than thrown away — dropping an entry would
 * turn a hard blocker into silence, which is the one outcome the Stop-rules
 * design exists to prevent ([C-37]'s rationale). */
export function parseRawHumanStopEntries(value: unknown): RawHumanStopEntry[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => {
		const entry = (item ?? {}) as Record<string, unknown>;
		return {
			stage: typeof entry.stage === "string" ? entry.stage : "",
			unit: typeof entry.unit === "string" ? entry.unit : null,
			condition: typeof entry.condition === "string" ? entry.condition : "",
			reason: typeof entry.reason === "string" ? entry.reason : "",
		};
	});
}

/** §1.7's `failReason`: "the last log line, or the joined human-stop conditions
 * when there are any" — the same derivation as `reasonText()`
 * (`console/app/dashboard.ts:86-93`). It is a LOG-shaped string: a screen shows
 * `humanStop[].message` to a person, never this. */
export function joinStopConditions(entries: RawHumanStopEntry[]): string {
	return entries.map((entry) => `${entry.condition}: ${entry.reason}`).join(" | ");
}
