// The closed error-code list of spec §2.3, and the one status-mapping rule of
// §2.2. Thirty codes, nothing outside this table — a client may switch
// exhaustively on ERROR_CODES, so adding a member here is an additive /v1
// change and changing what one means is not.
//
// Every code carries a default Thai message (§1.2 [C-02]: one machine `code`
// plus one Thai `message`; Accept-Language is ignored). Where the spec or the
// existing runtime already fixes the wording, the wording here is that string
// verbatim — the citation is on the line.

export const ERROR_CODES = [
	// 400 — the request is not a valid request
	"validation_failed",
	"invalid_month_key",
	"invalid_month_id",
	"invalid_client_key",
	"invalid_path",
	"invalid_unit",
	"idempotency_key_required",
	"idempotency_key_invalid",
	"unsupported_field",
	// 401 — the caller is not authenticated
	"unauthorized",
	// 404 — well-formed, but names something that does not exist
	"job_not_found",
	"client_not_found",
	"month_folder_not_found",
	"group_not_found",
	"unit_not_found",
	// 409 — well-formed, target exists, current state forbids it
	"run_not_startable",
	"run_not_retryable",
	"run_not_repairable",
	"repair_not_acknowledged",
	"run_not_running",
	"run_busy",
	"stale_version",
	"idempotency_key_conflict",
	"idempotency_key_in_flight",
	"export_not_ready",
	"decision_not_pending",
	// 422 — the named resource's body is unusable
	"artifact_malformed",
	// 503 — Core is up but cannot serve this yet
	"not_ready",
	"halted_fatal_cleanup",
	// 500 — anything unhandled
	"internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** §2.2's mapping rule, applied without exception: the class of failure decides
 * the status, and each code belongs to exactly one class. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
	validation_failed: 400,
	invalid_month_key: 400,
	invalid_month_id: 400,
	invalid_client_key: 400,
	invalid_path: 400,
	invalid_unit: 400,
	idempotency_key_required: 400,
	idempotency_key_invalid: 400,
	unsupported_field: 400,
	unauthorized: 401,
	job_not_found: 404,
	client_not_found: 404,
	month_folder_not_found: 404,
	group_not_found: 404,
	unit_not_found: 404,
	run_not_startable: 409,
	run_not_retryable: 409,
	run_not_repairable: 409,
	repair_not_acknowledged: 409,
	run_not_running: 409,
	run_busy: 409,
	stale_version: 409,
	idempotency_key_conflict: 409,
	idempotency_key_in_flight: 409,
	export_not_ready: 409,
	decision_not_pending: 409,
	artifact_malformed: 422,
	not_ready: 503,
	halted_fatal_cleanup: 503,
	internal_error: 500,
};

/** Default Thai message per code. §2.5: no host path, no credential, no
 * document content, no stack, no SQL — these strings are constants, which is
 * the cheapest way to keep that true. A call site may override the message
 * with a more specific Thai one (e.g. §5.6's two `run_not_startable` variants);
 * it may never override it with something derived from a host path. */
export const ERROR_MESSAGE_TH: Record<ErrorCode, string> = {
	validation_failed: "ข้อมูลที่ส่งมาไม่ถูกต้องตามรูปแบบที่กำหนด",
	invalid_month_key: "รหัสเดือน (monthKey) ไม่ถูกต้อง ต้องเป็นปีพุทธศักราชสี่หลัก-เดือนสองหลัก เช่น 2569-08",
	invalid_month_id: "รหัสเดือน (monthId) ไม่ถูกต้อง ต้องเป็นปีพุทธศักราชสองหลัก-เดือนสองหลัก เช่น 69-08",
	invalid_client_key: "รหัสลูกค้าไม่ถูกต้อง",
	invalid_path: "เส้นทางไฟล์ที่ส่งมาไม่ถูกต้องหรืออยู่นอกพื้นที่ทำงาน",
	invalid_unit: "รหัสหน่วยเอกสาร (unit) ไม่ถูกต้อง",
	idempotency_key_required: "คำสั่งนี้ต้องส่ง Idempotency-Key มาด้วย",
	idempotency_key_invalid: "Idempotency-Key ไม่ถูกต้องตามรูปแบบที่กำหนด",
	unsupported_field: "มีฟิลด์ที่ระบบยังไม่รองรับอยู่ในคำขอนี้",
	unauthorized: "ไม่ได้รับอนุญาตให้เรียกใช้บริการนี้",
	// orchestrator.ts:244,255,278 — the runtime's own wording, kept verbatim.
	job_not_found: "ไม่พบงานนี้",
	client_not_found: "ไม่พบโฟลเดอร์ของลูกค้ารายนี้",
	// Plan §9.2: never fuzzy-match a near miss — the operator renames the folder.
	month_folder_not_found: "ไม่พบโฟลเดอร์เดือนนี้ในโฟลเดอร์ของลูกค้า",
	group_not_found: "ไม่พบกลุ่มเอกสารนี้",
	unit_not_found: "ไม่พบหน่วยเอกสารนี้",
	// orchestrator.ts:227 — "ลูกค้ารายนี้มีการรันค้างอยู่แล้ว ใช้ปุ่มลองใหม่แทน" is the
	// blocked/env-error variant; §5.6 gives "งานนี้เสร็จสมบูรณ์แล้ว" for `done`.
	// Both are supplied per-call; this is the neutral default.
	run_not_startable: "งานนี้ยังเริ่มรันใหม่ไม่ได้ในสถานะปัจจุบัน",
	run_not_retryable: "งานนี้ไม่ได้อยู่ในสถานะที่ลองใหม่ได้", // orchestrator.ts:246
	run_not_repairable: "งานนี้กำลังทำงานอยู่หรืออยู่ในคิว ไม่สามารถซ่อมได้ในขณะนี้", // orchestrator.ts:260
	repair_not_acknowledged: "การสั่งรันใหม่ทั้งชุดจะลบงานตรวจทานที่คนแก้ไว้ทิ้งทั้งหมด ต้องยืนยันก่อนจึงจะทำได้",
	run_not_running: "งานนี้ไม่ได้กำลังทำงานอยู่", // orchestrator.ts:296
	run_busy: "งานนี้กำลังทำงานอยู่หรืออยู่ในคิว จึงยังแก้ไขผลตรวจทานไม่ได้",
	stale_version: "ข้อมูลกลุ่มนี้ถูกแก้ไขไปแล้วหลังจากที่คุณเปิดอ่าน กรุณาโหลดใหม่แล้วลองอีกครั้ง",
	idempotency_key_conflict: "Idempotency-Key นี้ถูกใช้กับคำขอที่ต่างออกไปแล้ว",
	idempotency_key_in_flight: "คำขอเดิมที่ใช้ Idempotency-Key นี้ยังทำงานไม่เสร็จ กรุณาลองใหม่อีกครั้ง",
	export_not_ready: "ยังออกไฟล์ไม่ได้ เพราะงานนี้ยังไม่เสร็จหรือยังไม่มีรายการที่พร้อมส่งออก",
	decision_not_pending: "รายการนี้ไม่ได้อยู่ระหว่างรอคนตัดสินการคัดออก",
	artifact_malformed: "ไฟล์ข้อมูลของงานนี้บนดิสก์ผิดรูปแบบ จึงอ่านต่อไม่ได้",
	not_ready: "ระบบยังเตรียมตัวไม่เสร็จ", // §5.2's 503 body
	// orchestrator.ts:220,242,253 — the runtime's own wording, kept verbatim.
	halted_fatal_cleanup: "ระบบหยุดเพื่อความปลอดภัยหลังเก็บ process ไม่สำเร็จ กรุณา restart app/container",
	// §2.5: internal_error's message is a fixed Thai string and never carries
	// the underlying exception.
	internal_error: "เกิดข้อผิดพลาดภายในระบบ",
};

export function isErrorCode(value: string): value is ErrorCode {
	return (ERROR_CODES as readonly string[]).includes(value);
}
