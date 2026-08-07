// Customers — the list. 113 customers is the real number, so this screen
// needs a way in: one search box over name/รหัส/ผู้รับผิดชอบ, and a capped
// first slice with "ดูทั้งหมด".
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CUSTOMERS } from "../state/stores";
import { CUSTOMER_STATUS_LABEL } from "../data/customers";
import { useApp } from "../state/AppContext";
import { paths } from "../navigation";
import { CappedList } from "../components/CappedList";
import { PlusIcon } from "../components/Icons";
import { jobTypeByKey } from "../domain/jobTypes";
import { projectsForCustomer } from "../domain/projects";
import { customerPackages } from "../domain/schedule";
import { isAwaitingReview, projectFinished, waitingOnCustomer } from "../domain/work";
import { useNewCustomerModal } from "./customer/NewCustomerModal";

export function CustomersPage() {
	const { version } = useApp();
	void version;
	const navigate = useNavigate();
	const openNewCustomer = useNewCustomerModal();
	const [search, setSearch] = useState("");
	const q = search.trim().toLowerCase();

	const ids = Object.keys(CUSTOMERS).filter((id) => {
		if (!q) return true;
		const c = CUSTOMERS[id];
		const people = projectsForCustomer(id).map((p) => p.assignee).join(" ");
		return (c.displayName + " " + c.legalName + " " + c.code + " " + people).toLowerCase().indexOf(q) !== -1;
	});
	// Customers taken on during this session sort to the top, so the one
	// somebody just created is the first thing they see when they come back
	// to this screen rather than being 90 rows down.
	type WithFlag = { addedNow?: boolean };
	ids.sort((a, b) => ((CUSTOMERS[b] as WithFlag).addedNow ? 1 : 0) - ((CUSTOMERS[a] as WithFlag).addedNow ? 1 : 0));

	const rows = ids.map((id) => {
		const c = CUSTOMERS[id];
		const projects = projectsForCustomer(id);
		const blockedCount = projects.filter(isAwaitingReview).length;
		const waitingCount = projects.filter(waitingOnCustomer).length;
		const openCount = projects.filter((p) => !projectFinished(p)).length;
		// One pill per job type this customer is actually being served on —
		// deduplicated. Round 16: read from the customer's ACTIVE PACKAGES
		// rather than from their projects, because a package is what they
		// bought and a project is only one occurrence of it.
		const seenTypes: Record<string, boolean> = {};
		let pillTypes = customerPackages(id).filter((k) => !k.endedAt).map((k) => k.jobType);
		if (!pillTypes.length) pillTypes = projects.map((p) => p.jobType);
		const pills = pillTypes
			.filter((t) => { if (seenTypes[t]) return false; seenTypes[t] = true; return true; })
			.map((t) => <span className="pill job-type-pill" key={t}>{jobTypeByKey(t)!.name}</span>);
		return (
			<div className="customer-row" key={id} onClick={() => navigate(paths.customerDetail(id))}>
				<div className="customer-row-main">
					<span className="customer-row-name">
						{c.displayName} <span className="customer-row-code">#{c.code}</span>
						{c.status !== "active" ? <> <span className="pill pill-waiting">{CUSTOMER_STATUS_LABEL[c.status]}</span></> : null}
						{(c as WithFlag).addedNow ? <> <span className="pill pill-current">รับเข้ามาใหม่</span></> : null}
					</span>
					<div className="customer-row-pills">{pills}</div>
				</div>
				<span className="customer-row-meta">
					{openCount} โปรเจกต์ที่ยังไม่ปิด
					{blockedCount > 0 ? <> <span className="pill pill-blocked">ต้องการการตรวจสอบ {blockedCount}</span></> : null}
					{waitingCount > 0 ? <> <span className="pill pill-waiting">รอเอกสาร {waitingCount}</span></> : null}
				</span>
			</div>
		);
	});

	return (
		<>
			<div className="page-header">
				<h2>ลูกค้า</h2>
				<p className="page-sub">ลูกค้าหนึ่งรายอาจมีมากกว่าหนึ่งโปรเจกต์พร้อมกัน — เช่น งานรายเดือนกับงาน Consult แยกกัน</p>
			</div>
			<div className="field">
				<input
					id="customer-search"
					type="text"
					aria-label="ค้นหาลูกค้า"
					placeholder="ค้นหาชื่อลูกค้า รหัส หรือผู้รับผิดชอบ"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>
			{/* Always just the button — what it opens is a dialog over this screen,
			    so this list never has to make room for a form. */}
			<div id="customer-new-form">
				<button type="button" className="btn btn-ghost btn-with-icon" style={{ marginBottom: "12px" }} onClick={openNewCustomer}>
					<PlusIcon />
					รับลูกค้าใหม่
				</button>
			</div>
			<p className="checklist-legend">
				{q ? "พบ " + ids.length + " ราย จากทั้งหมด " + Object.keys(CUSTOMERS).length + " ราย" : "ลูกค้าทั้งหมด " + ids.length + " ราย"}
			</p>
			<div>
				<CappedList
					listKey={"customers" + (q ? "-q" : "")}
					rows={rows}
					emptyText="ไม่พบลูกค้าที่ตรงกับคำค้น"
					cap={25}
					wrapClass={null}
					unit="ราย"
				/>
			</div>
		</>
	);
}
