// PROTOTYPE — throwaway. Shared status → label/color mapping so all three
// variants describe the same Status values the same way (a data helper, not
// layout — sharing this doesn't defeat the point of separate variants).

import type { Status } from "./mock-data";

export const STATUS_META: Record<Status, { label: string; fg: string; bg: string; urgent?: boolean }> = {
	idle: { label: "ยังไม่ได้รัน", fg: "#57534e", bg: "#f1efec" },
	queued: { label: "รอคิว", fg: "#92400e", bg: "#fef3c7" },
	"stage-running": { label: "กำลังทำงาน", fg: "#1d4ed8", bg: "#dbeafe" },
	"gate-running": { label: "กำลังตรวจสอบ", fg: "#1d4ed8", bg: "#dbeafe" },
	blocked: { label: "ติดขัด (ลองใหม่อัตโนมัติ)", fg: "#b45309", bg: "#fef3c7" },
	"env-error": { label: "ข้อผิดพลาดชั่วคราว (ลองใหม่)", fg: "#b45309", bg: "#fef3c7" },
	"stopped-for-human": { label: "หยุดรอมนุษย์ตัดสินใจ", fg: "#b91c1c", bg: "#fee2e2", urgent: true },
	"blocked-for-human": { label: "ติดขัด รอคนตรวจสอบ", fg: "#b91c1c", bg: "#fee2e2", urgent: true },
	done: { label: "เสร็จแล้ว", fg: "#15803d", bg: "#dcfce7" },
};
