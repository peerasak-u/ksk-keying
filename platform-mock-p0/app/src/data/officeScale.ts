// The generated office scale, kept verbatim from the legacy mock: 107 more
// customers on top of the six hand-written ones, plus their projects. Every
// value is a function of the index, never random, so the mock renders exactly
// the same numbers on every refresh.
import type { Customer, Project, ProjectSeed } from "../types";
import { membersOf } from "../domain/people";
import { jobTypeByKey } from "../domain/jobTypes";
import { periodLabelFor } from "../domain/dates";

// ================= office scale (round 10) =================
//
// The real office carries 113 customers, and a screen that is comfortable
// with six of them can be useless with a hundred. The six hand-written
// customers above are joined here by 107 generated ones so every list in
// this mock is exercised at the volume it will actually meet: the job-type
// mix mirrors the office's own (รายเดือน 66 / รายปี 41 / งานโปรเจค 4 /
// ที่ปรึกษา 2, plus a handful of one-off งานทะเบียน jobs), and customers are
// spread across the three teams' members.
//
// The names are synthetic — plausible Khon Kaen company names built from
// two word lists, never the client's real customer names, which are not
// this repository's to carry. Everything else about them is shaped like
// the real thing.
//
// Nothing here is random: every value is a function of the customer's own
// index, so the mock renders exactly the same numbers on every refresh —
// a screen whose totals move when you reload cannot be discussed.
export const GEN_PLACE = [
	"ขอนแก่น", "ศรีจันทร์", "กัลปพฤกษ์", "หนองแวง", "บ้านไผ่", "น้ำพอง", "ชุมแพ", "มัญจาคีรี",
	"ภูเวียง", "เมืองพล", "ท่าพระ", "ดอนหัน", "พระลับ", "บึงเนียม", "สาวะถี", "โคกสี",
];
export const GEN_TRADE = [
	"พาณิชย์", "การช่าง", "ก่อสร้าง", "ขนส่ง", "การเกษตร", "เทรดดิ้ง", "อุตสาหกรรม",
	"ซัพพลาย", "เอ็นจิเนียริ่ง", "เซอร์วิส", "ดีเวลลอปเมนท์", "มอเตอร์", "ฟู้ด", "กรุ๊ป",
];
export const GEN_NATURE: Record<string, string> = {
	monthly: "ค้าส่ง–ค้าปลีกในจังหวัด", yearly: "กิจการขนาดเล็ก ปิดงบรายปี",
	consult: "รับบริการที่ปรึกษาการเงินรายเดือน", project: "งานโปรเจคเฉพาะกิจ",
	registry: "งานจดทะเบียนธุรกิจ",
};

export function seedOfficeScale(CUSTOMERS: Record<string, Customer>, PROJECTS: Project[]) {
	// 107 more customers on top of the six above = 113.
	var plan: string[] = [];
	var push = function (key: string, n: number) { for (var i = 0; i < n; i++) plan.push(key); };
	push("monthly", 62);
	push("yearly", 39);
	push("project", 3);
	push("consult", 3);

	var accountingPeople = membersOf("team1").concat(membersOf("team2"));
	var advisoryPeople = membersOf("team3");

	plan.forEach(function (jobKey, i) {
		var id = "c" + (i + 1);
		var place = GEN_PLACE[i % GEN_PLACE.length];
		var trade = GEN_TRADE[Math.floor(i / GEN_PLACE.length) % GEN_TRADE.length];
		var isPartnership = i % 9 === 4;
		var short = place + trade;
		var vat = jobKey === "monthly" ? i % 5 !== 0 : i % 3 === 0;
		CUSTOMERS[id] = {
			code: String(220 + i),
			legalName: (isPartnership ? "ห้างหุ้นส่วนจำกัด " : "บริษัท ") + short + (isPartnership ? "" : " จำกัด"),
			displayName: (isPartnership ? "หจก. " : "บจก. ") + short,
			taxId: "0-0000-00000-00-0 (ตัวอย่าง)",
			businessNature: GEN_NATURE[jobKey],
			status: i % 37 === 11 ? "dormant" : "active",
			lineGroupId: i % 4 === 0 ? "ksk-" + (220 + i) + " (ตัวอย่าง)" : null,
			note: "",
			onboardedAt: (1 + (i % 28)) + " " + ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย."][i % 6] + " 256" + (7 + (i % 2)),
			vatRegistered: vat,
			fiscalYearEnd: i % 13 === 6 ? "30 กันยายน" : "31 ธันวาคม",
			contacts: [
				{ name: "ผู้ประสานงานฝ่ายบัญชี", role: "ฝ่ายบัญชี", phone: "0X-XXX-XXXX", email: null, lineId: null, isPrimary: true },
			],
			// One package per generated customer, mapped to the job type
			// they are actually served on — the recurrence is what puts
			// their next งวด on the schedule.
			packages: [{
				id: "pk-" + id + "-1", jobType: jobKey,
				recurrence: jobKey === "yearly" ? "yearly" : jobKey === "project" ? "oneoff" : "monthly",
				startedAt: jobKey === "yearly" ? "2569-01" : "2568-0" + (1 + (i % 6)),
				endedAt: null, paused: false,
				fee: jobKey === "monthly" ? 3000 + (i % 9) * 500
					: jobKey === "yearly" ? 12000 + (i % 7) * 1500
					: jobKey === "consult" ? 7000 + (i % 5) * 1000
					: 35000 + (i % 4) * 5000,
				note: "", skips: [],
			}],
		};
		// A dormant customer recurs nothing — its package has ended, which
		// is why it has no งวด rather than that being a special case.
		if (CUSTOMERS[id].status === "dormant") {
			CUSTOMERS[id].packages[0].endedAt = "2569-04";
			return;
		}

		var owner = jobKey === "consult" || jobKey === "project"
			? advisoryPeople[i % advisoryPeople.length]
			: accountingPeople[i % accountingPeople.length];

		// The งวด currently being worked: งวดกรกฎาคม, worked during สิงหาคม.
		var phaseIndex = [0, 0, 1, 1, 2, 2, 2, 3, 4][i % 9];
		// Round 20: the document situation is seeded onto the customer-facing
		// Gates that carry it (applyDocSeed), not into a parallel field.
		var docs = ["in", "in", "asked", "in", "none", "in", "asked", "in", "in", "in", "asked", "in"][i % 12];
		var gatesInPhase = jobTypeByKey(jobKey)!.phases[phaseIndex].gates.length;
		var seed: ProjectSeed = { docs: docs, pastDate: "2/8/2569", done: Math.min(gatesInPhase - 1, 1 + (i % 3)) };
		if (i % 7 === 3) seed.awaiting = [seed.done!];
		else if (i % 5 === 1) seed.doing = [seed.done!];
		PROJECTS.push({
			id: id + "-" + jobKey + "-jul", customerId: id, assignee: owner,
			jobType: jobKey, periodLabel: periodLabelFor(jobKey, "2569-07"), monthKey: "2569-07",
			phaseIndex: phaseIndex, seed: seed,
			status: "today", actionLabel: "เปิดเช็กลิสต์",
		});

		// Some งวด before it: closed for most customers, still open (and
		// therefore late) for a minority — this is the office's real
		// shape, and without it "ล่าช้า" and "ปิดแล้ว" are both empty.
		if (i % 6 === 2) {
			PROJECTS.push({
				id: id + "-" + jobKey + "-jun", customerId: id, assignee: owner,
				jobType: jobKey, periodLabel: periodLabelFor(jobKey, "2569-06"), monthKey: "2569-06",
				phaseIndex: i % 3,
				seed: { docs: i % 4 === 1 ? "none" : "asked", pastDate: "12/7/2569", done: 1 },
				status: "today", actionLabel: "เปิดเช็กลิสต์",
			});
		} else if (i % 3 !== 1) {
			PROJECTS.push({
				id: id + "-" + jobKey + "-jun", customerId: id, assignee: owner,
				jobType: jobKey, periodLabel: periodLabelFor(jobKey, "2569-06"), monthKey: "2569-06",
				phaseIndex: jobTypeByKey(jobKey)!.phases.length - 1,
				seed: { docs: "in", pastDate: "10/7/2569", done: 99 },
				status: "on-track", actionLabel: "ดูรายละเอียด",
			});
		}

		// A few customers carry a full year of งวด, so the customer page's
		// 12-period completeness strip has something real to show.
		if (jobKey === "monthly" && i % 17 === 3) {
			["2569-01", "2569-02", "2569-03", "2569-04", "2569-05"].forEach(function (mk, k) {
				var stillOpen = k === 2 && i % 34 === 3;
				PROJECTS.push({
					id: id + "-monthly-" + mk, customerId: id, assignee: owner,
					jobType: "monthly", periodLabel: periodLabelFor("monthly", mk), monthKey: mk,
					phaseIndex: stillOpen ? 2 : 4,
					seed: { docs: stillOpen ? "none" : "in", pastDate: "20/" + (k + 2) + "/2569", done: stillOpen ? 2 : 99 },
					status: stillOpen ? "today" : "on-track",
					actionLabel: stillOpen ? "เปิดเช็กลิสต์" : "ดูรายละเอียด",
				});
			});
		}

		// A handful of one-off registry jobs on top of the recurring work.
		if (i % 23 === 5) {
			CUSTOMERS[id].packages.push({
				id: "pk-" + id + "-2", jobType: "registry", recurrence: "oneoff",
				startedAt: "2569-07", endedAt: null, paused: false, fee: 9500,
				note: "แจ้งแก้ไขข้อมูลทะเบียน", skips: [],
			});
			PROJECTS.push({
				id: id + "-registry-aug", customerId: id, assignee: advisoryPeople[i % advisoryPeople.length],
				jobType: "registry", periodLabel: "แจ้งแก้ไขข้อมูลทะเบียน — เริ่ม " + (1 + (i % 20)) + " กรกฎาคม 2569",
				monthKey: "2569-07", phaseIndex: 1,
				seed: { docs: "asked", pastDate: "26/7/2569", done: 1, awaiting: [1] },
				status: "today", actionLabel: "เปิดเช็กลิสต์",
			});
		}
	});
}
