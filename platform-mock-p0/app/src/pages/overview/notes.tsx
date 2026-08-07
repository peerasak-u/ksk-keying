// The one-line annotations a card carries when it is sitting in a list that
// needs to say WHY. Shared by งานของฉัน and the executive view, which is where
// the shapes were first established.
import type { Project } from "../../types";
import { CardNote } from "../../components/ProjectCard";
import { awaitingGates, pendingCustomerGates } from "../../domain/work";
import { monthsBehind } from "../../domain/trail";
import { docSituation } from "../../domain/docs";

export function gateCodeList(items: { gate: { code: string } }[], max: number) {
	const codes = items.slice(0, max).map((a) => a.gate.code);
	return codes.join(", ") + (items.length > max ? " และอีก " + (items.length - max) + " ข้อ" : "");
}

export function lateNote(p: Project) {
	return <CardNote text={"ค้าง " + p.periodLabel + " — เลยรอบทำงานปกติมาแล้ว " + monthsBehind(p) + " เดือน"} />;
}

export function reviewNote(p: Project) {
	const a = awaitingGates(p);
	if (!a.length) return null;
	return (
		<CardNote
			text={"รอ " + a[0].at.name + " (" + a[0].at.rungLabel + ") เซ็นสอบทาน " + a.length + " เกท (" + gateCodeList(a, 3) + ")"}
		/>
	);
}

export function customerNote(p: Project) {
	const g = pendingCustomerGates(p);
	const head = docSituation(p).text;
	if (!g.length) return <CardNote text={head} />;
	return (
		<CardNote
			text={head + " · ค้างจากลูกค้า " + g.length + " รายการ: " + g[0].gate.name +
				(g.length > 1 ? " (และอีก " + (g.length - 1) + " รายการ)" : "")}
		/>
	);
}
