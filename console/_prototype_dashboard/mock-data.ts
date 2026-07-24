// PROTOTYPE — throwaway. Mock dataset for the company/month picker + run
// dashboard UI prototype (wayfinder ticket #32 on map #29). Every name,
// number, and timing below is fabricated for this prototype only — no real
// client data. In-memory only, per the prototype skill's "no persistence"
// rule; state resets on server restart.

export type Status =
	| "idle"
	| "queued"
	| "stage-running"
	| "gate-running"
	| "blocked"
	| "env-error"
	| "stopped-for-human"
	| "blocked-for-human"
	| "done";

export type StageId = "profile" | "segment" | "interpret" | "link" | "group" | "categorize" | "final";

export const STAGE_LABEL: Record<StageId, string> = {
	profile: "0 · profile",
	segment: "1 · segment",
	interpret: "2 · interpret",
	link: "3 · link",
	group: "4 · group",
	categorize: "5 · categorize",
	final: "final",
};

export type MonthRun = {
	month: string;
	status: Status;
	stage?: StageId;
	startedAt?: string;
	finishedAt?: string;
	durationMin?: number;
	units?: { total: number; reviewed: number; excluded: number };
	queuePosition?: number;
	reason?: string;
};

export type Client = {
	code: string;
	name: string;
	months: MonthRun[];
};

export const CLIENTS: Client[] = [
	{
		code: "C001",
		name: "บริษัท เอบีซี การบัญชี จำกัด",
		months: [
			{
				month: "มกราคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-02-03T10:12:00Z",
				durationMin: 19,
				units: { total: 44, reviewed: 43, excluded: 1 },
			},
			{
				month: "กุมภาพันธ์",
				status: "done",
				stage: "final",
				finishedAt: "2026-03-04T09:40:00Z",
				durationMin: 22,
				units: { total: 51, reviewed: 49, excluded: 2 },
			},
			{
				month: "มีนาคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-04-02T11:05:00Z",
				durationMin: 17,
				units: { total: 39, reviewed: 38, excluded: 1 },
			},
			{
				month: "เมษายน",
				status: "done",
				stage: "final",
				finishedAt: "2026-05-05T08:55:00Z",
				durationMin: 24,
				units: { total: 58, reviewed: 55, excluded: 3 },
			},
			{ month: "พฤษภาคม", status: "stage-running", stage: "interpret", startedAt: "2026-07-24T09:02:00Z" },
			{ month: "มิถุนายน", status: "idle" },
		],
	},
	{
		code: "C002",
		name: "บริษัท ซันไรส์ เทรดดิ้ง จำกัด",
		months: [
			{
				month: "มกราคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-02-05T13:20:00Z",
				durationMin: 21,
				units: { total: 47, reviewed: 46, excluded: 1 },
			},
			{
				month: "กุมภาพันธ์",
				status: "stopped-for-human",
				stage: "interpret",
				reason: "หน้า 6 ของใบกำกับภาษีอ่านไม่ออก ไม่มีต้นฉบับอื่นแทน",
			},
			{ month: "มีนาคม", status: "idle" },
			{ month: "เมษายน", status: "idle" },
			{ month: "พฤษภาคม", status: "idle" },
			{ month: "มิถุนายน", status: "idle" },
		],
	},
	{
		code: "C003",
		name: "ห้างหุ้นส่วน บางกอก ซัพพลาย",
		months: [
			{
				month: "มกราคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-02-04T10:00:00Z",
				durationMin: 15,
				units: { total: 33, reviewed: 33, excluded: 0 },
			},
			{
				month: "กุมภาพันธ์",
				status: "done",
				stage: "final",
				finishedAt: "2026-03-03T09:30:00Z",
				durationMin: 18,
				units: { total: 40, reviewed: 39, excluded: 1 },
			},
			{
				month: "มีนาคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-04-06T14:10:00Z",
				durationMin: 20,
				units: { total: 45, reviewed: 44, excluded: 1 },
			},
			{
				month: "เมษายน",
				status: "blocked-for-human",
				stage: "link",
				reason: "ลิงก์เอกสารไม่ครบหลังลองใหม่ 3 ครั้ง — ต้องการคนตรวจสอบ",
			},
			{ month: "พฤษภาคม", status: "queued", queuePosition: 1 },
			{ month: "มิถุนายน", status: "idle" },
		],
	},
	{
		code: "C004",
		name: "บริษัท กรีนฟาร์ม เอ็กซ์พอร์ต จำกัด",
		months: [
			{
				month: "มกราคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-02-02T09:00:00Z",
				durationMin: 16,
				units: { total: 30, reviewed: 30, excluded: 0 },
			},
			{
				month: "กุมภาพันธ์",
				status: "done",
				stage: "final",
				finishedAt: "2026-03-02T09:00:00Z",
				durationMin: 17,
				units: { total: 32, reviewed: 32, excluded: 0 },
			},
			{
				month: "มีนาคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-04-01T09:00:00Z",
				durationMin: 15,
				units: { total: 29, reviewed: 29, excluded: 0 },
			},
			{
				month: "เมษายน",
				status: "done",
				stage: "final",
				finishedAt: "2026-05-01T09:00:00Z",
				durationMin: 18,
				units: { total: 34, reviewed: 34, excluded: 0 },
			},
			{
				month: "พฤษภาคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-06-02T09:00:00Z",
				durationMin: 16,
				units: { total: 31, reviewed: 31, excluded: 0 },
			},
			{
				month: "มิถุนายน",
				status: "done",
				stage: "final",
				finishedAt: "2026-07-02T09:00:00Z",
				durationMin: 19,
				units: { total: 36, reviewed: 36, excluded: 0 },
			},
		],
	},
	{
		code: "C005",
		name: "บริษัท เมโทร คอนสตรัคชั่น จำกัด",
		months: [{ month: "มกราคม", status: "queued", queuePosition: 2 }],
	},
	{
		code: "C006",
		name: "บริษัท นิว เจนเนอเรชั่น ดีไซน์ จำกัด",
		months: [
			{
				month: "มกราคม",
				status: "done",
				stage: "final",
				finishedAt: "2026-02-03T09:20:00Z",
				durationMin: 14,
				units: { total: 27, reviewed: 27, excluded: 0 },
			},
			{
				month: "กุมภาพันธ์",
				status: "env-error",
				stage: "segment",
				reason: "แนบไฟล์รอบก่อนล้มเหลว — กำลังลองใหม่ (retry 1/1)",
			},
			{ month: "มีนาคม", status: "idle" },
			{ month: "เมษายน", status: "idle" },
			{ month: "พฤษภาคม", status: "idle" },
			{ month: "มิถุนายน", status: "idle" },
		],
	},
];

export function allRuns() {
	return CLIENTS.flatMap((c) => c.months.map((m) => ({ client: c, run: m })));
}

export function needsAttentionCount() {
	return allRuns().filter((r) => r.run.status === "stopped-for-human" || r.run.status === "blocked-for-human").length;
}
