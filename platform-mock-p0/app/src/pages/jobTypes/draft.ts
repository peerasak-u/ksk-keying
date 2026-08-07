// The editor's own working copy of a job type.
//
// The legacy editor kept this state in the DOM — the Gate's รหัส/ความถี่/
// หมายเหตุ rode on data- attributes so editing a Phase name could never
// silently throw away the workbook's own columns, and the due rule was read
// back out of three inputs on save. Here that same shape is a plain draft
// object; nothing about what is preserved or how the rule is stored changed.
import type { Gate, JobType, Phase } from "../../types";

export interface GateDraft {
	code: string;
	name: string;
	required: boolean;
	freq: string;
	note: string;
	actor: string;
	review: string;
	dueKind: "" | "dom" | "offset";
	dueDay: number;
	dueMonth: number;
	dueDays: number;
}

export interface PhaseDraft {
	name: string;
	gates: GateDraft[];
	workflows: { key: string; evidence: string[] }[];
	pickerOpen: boolean;
}

export function gateDraft(gate?: Gate): GateDraft {
	const g = gate || ({} as Gate);
	const due = (g.due || {}) as { dayOfMonth?: number; monthOffset?: number; offsetDays?: number };
	const kind: GateDraft["dueKind"] =
		typeof due.dayOfMonth === "number" ? "dom" : typeof due.offsetDays === "number" ? "offset" : "";
	return {
		code: g.code || "",
		name: g.name || "",
		required: g.required !== false,
		freq: g.freq || "",
		note: g.note || "",
		actor: g.actor || "",
		review: g.review || "",
		dueKind: kind,
		dueDay: typeof due.dayOfMonth === "number" ? due.dayOfMonth : 15,
		dueMonth: due.monthOffset || 0,
		dueDays: typeof due.offsetDays === "number" ? due.offsetDays : 10,
	};
}

export function phaseDraft(phase?: Phase): PhaseDraft {
	const ph = phase || ({} as Phase);
	const gates = ph.gates && ph.gates.length ? ph.gates.map(gateDraft) : [gateDraft()];
	return {
		name: ph.name || "",
		gates: gates,
		workflows: (ph.workflows || []).map((a) => ({ key: a.key, evidence: (a.evidence || []).slice() })),
		pickerOpen: false,
	};
}

export function jobTypeDraft(jt?: JobType): PhaseDraft[] {
	return jt ? jt.phases.map(phaseDraft) : [phaseDraft()];
}

/** Read the draft back as the template it is. Returns null when the form is
 *  not complete enough to save. */
export function draftToPhases(phases: PhaseDraft[]): Phase[] | null {
	const out: Phase[] = [];
	let everyPhaseHasGate = true;
	phases.forEach((block) => {
		const phaseName = block.name.trim();
		if (!phaseName) return;
		const gates: Gate[] = [];
		block.gates.forEach((row) => {
			const gateName = row.name.trim();
			if (!gateName) return;
			const gate: Gate = {
				code: row.code || String(out.length + 1) + "." + (gates.length + 1),
				name: gateName,
				required: row.required,
			};
			if (row.freq) gate.freq = row.freq;
			if (row.note) gate.note = row.note;
			if (row.actor) gate.actor = row.actor;
			if (row.review) gate.review = row.review as Gate["review"];
			// The due-date rule, read back as a RULE — never resolved to a date
			// here. The date is derived per project, per งวด.
			if (row.dueKind === "dom") {
				if (row.dueDay >= 1 && row.dueDay <= 31) gate.due = { dayOfMonth: row.dueDay, monthOffset: row.dueMonth || 0 };
			} else if (row.dueKind === "offset") {
				if (row.dueDays >= 1) gate.due = { offsetDays: row.dueDays };
			}
			gates.push(gate);
		});
		if (gates.length === 0) { everyPhaseHasGate = false; return; }
		// Attached workflows, with the evidence Gates the admin toggled.
		const phaseDef: Phase = { name: phaseName, gates: gates };
		if (block.workflows.length) phaseDef.workflows = block.workflows.map((w) => ({ key: w.key, evidence: w.evidence.slice() }));
		out.push(phaseDef);
	});
	if (out.length === 0 || !everyPhaseHasGate) return null;
	return out;
}
