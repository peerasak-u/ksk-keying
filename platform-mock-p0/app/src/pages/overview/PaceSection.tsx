// จังหวะงาน — the two blocks of round 30c, drawn. Both read the same Phase
// trail, and both recompute for whatever งวด and ทีม the screen is filtered to.
import type { ReactNode } from "react";
import type { Project } from "../../types";
import { JOB_TYPES, TEAMS } from "../../state/stores";
import {
	MIN_PHASE_SAMPLE,
	PACE_ORDER_NOTE,
	PHASE_TONES,
	WAIT_BUCKETS,
	paceDays,
	paceInk,
	paceRedInk,
	paceSampleText,
	paceThinText,
	phaseTimingStats,
	teamWaitStats,
	type PhaseCell,
} from "../../domain/pace";
import { customerName } from "../../domain/projects";
import { phaseAgeDays } from "../../domain/trail";
import { projectFinished } from "../../domain/work";
import { scheduleSnapshot } from "../../domain/schedule";
import { useOpenProject } from "../../navigation";

function PaceRow({ n, children }: { n: number; children: ReactNode }) {
	return (
		<div className="pace-row" style={{ gridTemplateColumns: "118px repeat(" + Math.max(1, n) + ",minmax(0,1fr))" }}>
			{children}
		</div>
	);
}

// The COUNT is the checklist's own, so it is always printed. The AGE only
// exists for งวด whose trail is real, so it is printed only when there is
// one — and red is reserved for what the app reserves it for: the งวด that
// has been sitting here longest is a LATE งวด.
function PaceLive({ cell, redInk }: { cell: PhaseCell; redInk: string }) {
	if (!cell.liveN) return <>ตอนนี้ไม่มีงวดค้างอยู่ที่นี่</>;
	return (
		<>
			{"ตอนนี้ " + cell.liveN + " งวด"}
			{cell.oldest ? (
				<>
					{" · "}
					<span style={cell.oldest.late ? { color: redInk } : undefined}>
						{"ค้างนานสุด " + cell.oldest.age + " วัน"}
					</span>
				</>
			) : null}
		</>
	);
}

// ---- the office-wide half: วันเฉลี่ยต่อเฟส, one row per job type ----
// A row's columns are ITS OWN Phases, so a job type with three Phases is a row
// of three that ends where its ladder ends. Tone is share of the row's own
// ladder and never of the whole grid.
function PaceGrid({ scope }: { scope: Project[] }) {
	const stats = phaseTimingStats(scope);
	const present = JOB_TYPES.filter((jt) => stats[jt.key].inScope > 0);
	const rows = present.map((jt) => {
		const b = stats[jt.key];
		const head = (
			<div className="pace-rowhead" key="head">
				<span className="t">{jt.name}</span>
				<span className="s">
					{b.phases.length + " เฟส · " + (b.complete ? "ทั้งงวดราว " + paceDays(b.total) + " วัน · " : "") + paceSampleText(b)}
				</span>
			</div>
		);
		if (!b.known.length) {
			const busy = b.phases.filter((c) => c.liveN);
			return (
				<PaceRow n={1} key={jt.key}>
					{head}
					<div className="pace-span">
						<span>
							{paceThinText(b)}
							{busy.length
								? " — ตอนนี้งานที่ยังไม่ปิดกองอยู่ที่ " + busy.map((c) =>
									"เฟส " + (c.index + 1) + " " + c.liveN + " งวด" + (c.oldest ? " (นานสุด " + c.oldest.age + " วัน)" : "")).join(" · ")
								: ""}
						</span>
					</div>
				</PaceRow>
			);
		}
		return (
			<PaceRow n={b.phases.length} key={jt.key}>
				{head}
				{b.phases.map((c) => {
					const pos = <span className="pos">เฟส {c.index + 1}</span>;
					if (!c.enough) {
						return (
							<div className="pace-cell none" key={c.index}>
								{pos}
								<div className="ph">{c.name}</div>
								<div className="n">{c.n === 0 ? "ยังไม่มีงวดเดินผ่าน" : "ตัวอย่าง " + c.n + " งวด ยังไม่พอ"}</div>
								<div className="live"><PaceLive cell={c} redInk={paceRedInk(false)} /></div>
							</div>
						);
					}
					const r = b.ranked.indexOf(c);
					const tone = b.complete ? PHASE_TONES[r < 0 ? PHASE_TONES.length - 1 : r] : "#f1efec";
					const ink = b.complete ? paceInk(r) : "#44403c";
					return (
						<div className="pace-cell" style={{ background: tone, color: ink }} key={c.index}>
							{pos}
							<div className="ph">{c.name}</div>
							<div className="n">{paceDays(c.avg)} <span>วัน</span></div>
							<div className="live"><PaceLive cell={c} redInk={paceRedInk(b.complete && r >= 0 && r <= 2)} /></div>
						</div>
					);
				})}
			</PaceRow>
		);
	});
	return (
		<div className="pace-block">
			<div className="pace-head">แต่ละเฟสใช้เวลาเท่าไหร่</div>
			<p className="pace-sub">
				ตัวเลขใหญ่คือ<b>วันเฉลี่ยต่อเฟส</b> นับจากวันที่เปิดงวด · สีเข้มคือเฟสที่ช้าที่สุด<b>ของประเภทงานนั้นเอง</b> ไม่ได้เทียบข้ามประเภท ·
				บรรทัดล่างของทุกช่องคือของจริงวันนี้ · แต่ละแถวคือบันไดเฟสของประเภทงานนั้น <b>จำนวนเฟสไม่จำเป็นต้องเท่ากัน</b> แถวจึงจบตรงที่บันไดของมันจบ
			</p>
			{rows.length ? (
				<div style={{ marginTop: "11px" }}>{rows}</div>
			) : (
				<div className="pace-empty">ไม่มีงวดของประเภทงานไหนเลยในงวดและทีมที่เลือกอยู่ — ลองเลือก <b>ตอนนี้</b> หรือ <b>ทั้งสำนักงาน</b></div>
			)}
		</div>
	);
}

// ---- the team half: how long the work sitting there now has waited ----
// Each bar is that team's own 100%, because what is being compared is the
// SHAPE of the wait and not the volume.
function PaceWait({ scope }: { scope: Project[] }) {
	const openProject = useOpenProject();
	const stats = teamWaitStats(scope);
	const present = TEAMS.filter((t) => stats[t.key].inScope > 0);
	const rows = present.map((t) => {
		const b = stats[t.key];
		let body: ReactNode;
		if (!b.measurable) {
			body = <div className="pace-empty" style={{ marginTop: 0 }}>ยังไม่มีงวดของทีมนี้ที่วัดอายุได้ในขอบเขตที่เลือก</div>;
		} else {
			body = (
				<>
					<div className="pace-wait">
						{WAIT_BUCKETS.map((w, i) => {
							const n = b.counts[i];
							if (!n) return null;
							const pct = (n / b.measurable) * 100;
							return (
								<div
									key={i}
									className="pace-wait-seg"
									style={{ width: pct + "%", background: w.tone, color: w.ink }}
									title={w.label + " " + n + " งวด"}
								>
									{pct > 8 ? n : ""}
								</div>
							);
						})}
					</div>
					<div className="pace-keys">
						{WAIT_BUCKETS.map((w, i) => (
							<span key={i}><i style={{ background: w.tone }}></i>{w.label + " " + b.counts[i] + " งวด"}</span>
						))}
					</div>
				</>
			);
		}
		const dur = b.durable.length ? (
			<>
				{"เวลาที่งานอยู่ในมือทีมนี้ต่อเฟส (จากงวดที่ทำจบแล้ว): "}
				{b.durable.map((bk, i) => (
					<span key={bk.name}>{i > 0 ? " · " : ""}{bk.name} <b>{paceDays(bk.avg)} วัน</b></span>
				))}
				{b.thinDur ? <span className="muted"> — อีก {b.thinDur} เฟสตัวอย่างยังไม่ถึง {MIN_PHASE_SAMPLE} งวด จึงไม่แสดง</span> : null}
			</>
		) : (
			<span className="muted">ยังไม่มีเฟสไหนของทีมนี้ที่มีงวดทำจบครบ {MIN_PHASE_SAMPLE} งวด จึงยังไม่แสดงเวลาเฉลี่ย</span>
		);
		const over = b.counts[WAIT_BUCKETS.length - 1];
		return (
			<div className="pace-team" key={t.key}>
				<div className="pace-team-head">
					<span className="t">{t.name}</span>
					<span className="s">{"วัดอายุได้ " + b.measurable + " งวด จาก " + b.open + " งวดที่ยังไม่ปิด"}</span>
					{over ? <span className="s">· ค้างเกิน {WAIT_BUCKETS[WAIT_BUCKETS.length - 2].max} วัน {over} งวด</span> : null}
					{b.late ? <span className="attn">ล่าช้า {b.late} งวด</span> : null}
				</div>
				{body}
				{b.oldest ? (
					<p className="pace-dur">
						งวดที่ค้างนานที่สุดของทีมนี้:{" "}
						<button type="button" className="pace-link" onClick={() => openProject(b.oldest!.p.id)}>
							{customerName(b.oldest.p.customerId) + " · " + b.oldest.p.periodLabel}
						</button>
						{" — "}
						<span className={b.oldest.late ? "pace-late" : undefined}>{b.oldest.age} วัน</span>
						{" ที่เฟส " + b.oldest.phase}
					</p>
				) : null}
				<p className="pace-dur">{dur}</p>
			</div>
		);
	});
	return (
		<div className="pace-block">
			<div className="pace-head">งานที่ค้างอยู่ตอนนี้ รออยู่ในเฟสเดิมมานานแค่ไหน</div>
			<p className="pace-sub">
				แต่ละแท่งคือ 100% ของทีมนั้นเอง — เทียบ<b>รูปร่างของการรอ</b> ไม่ใช่ปริมาณ ยิ่งน้ำหนักเทไปทางขวา แปลว่างานของทีมนั้นค้างอยู่นานขึ้น ·{" "}
				{PACE_ORDER_NOTE}
			</p>
			{rows.length ? <div style={{ marginTop: "6px" }}>{rows}</div> : <div className="pace-empty">ไม่มีทีมไหนมีงวดอยู่ในงวดและทีมที่เลือกอยู่</div>}
		</div>
	);
}

function PaceFoot({ scope }: { scope: Project[] }) {
	let noAge = 0, open = 0;
	scope.forEach((p) => {
		if (projectFinished(p)) return;
		open++;
		if (phaseAgeDays(p) === null) noAge++;
	});
	const snap = scheduleSnapshot();
	return (
		<p className="pace-foot">
			นับจาก<b>วันที่เปิดงวด</b> เป็นต้นไป: เฟสหนึ่งเริ่มวันที่เฟสก่อนหน้าปิด และจบวันที่เกทบังคับของมันปิดครบ ·
			เฉลี่ยเฉพาะเฟสที่มีงวดเดินผ่านครบแล้ว<b>อย่างน้อย {MIN_PHASE_SAMPLE} งวด</b> น้อยกว่านั้นไม่แสดงค่าเฉลี่ย<br />
			<b>งวดที่ยังทำอยู่ไม่ถูกเฉลี่ย</b> เพราะยังไม่รู้ว่าเฟสปัจจุบันจะจบเมื่อไหร่ — นับเฉพาะในบรรทัด “ตอนนี้” ·
			ในขอบเขตที่เลือกอยู่มีงวดที่ยังไม่ปิด {open} งวด และใน {noAge} งวดของจำนวนนั้นเป็นงวดที่เพิ่งเปิด
			จนร่องรอยยังสั้นเกินกว่าจะวัดอายุได้ จึงไม่ถูกนับในส่วนอายุ<br />
			รอบที่ข้ามไว้ {snap.skipped.length} รอบ และแพ็กเกจที่พักการเกิดซ้ำ {snap.paused.length}
			{" แพ็กเกจ ไม่เคยเกิดเป็นงวด จึงไม่มีวันเริ่ม–วันจบ และไม่ถูกนับ · "}
			<b>ไม่แยกตามคนและไม่จัดอันดับ</b> — ตัวเลขทั้งหมดนี้บอกว่างานกองอยู่ที่ไหนและรออยู่นานเท่าไหร่ ไม่ได้บอกว่าใครทำงานดีกว่ากัน
			สีแดงใช้กับงวดที่ล่าช้าเท่านั้น เหมือนทุกหน้าจอในแอป
		</p>
	);
}

export function OverviewPace({ scope }: { scope: Project[] }) {
	return (
		<>
			<p className="ov-note">ทั้งสองส่วนนี้อ่านจากร่องรอยเดียวกัน คือวันที่งวดหนึ่งเข้าและออกจากแต่ละเฟส และคิดใหม่ตามงวดและทีมที่เลือกไว้ด้านบนเสมอ</p>
			<PaceGrid scope={scope} />
			<PaceWait scope={scope} />
			<PaceFoot scope={scope} />
		</>
	);
}
