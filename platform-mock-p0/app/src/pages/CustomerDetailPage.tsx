// ================= the customer screen (rebuilt in round 28c) =================
//
// แบบ จ, the layout the captain chose out of the four in rounds 28 / 28ข:
//
//   the dark block   who this customer is, and the counts that say how they
//                    are doing right now — round 27's own .mw-hero.
//   full width       รอจากฝั่งลูกค้า, because it is the one thing on this
//                    screen nobody in the office can move on their own.
//   left column      the timeline: a live งวด is the card it already was, a
//                    closed งวด the row it already was.
//   right rail       what they bought, and the registry behind it — sticky, so
//                    a phone number can be read without losing the year.
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { CUSTOMERS } from "../state/stores";
import { useApp } from "../state/AppContext";
import { paths, useOpenProject } from "../navigation";
import { ArrowLeftIcon, BuildingIcon, CheckCircleIcon } from "../components/Icons";
import { jobTypeByKey } from "../domain/jobTypes";
import { projectsForCustomer } from "../domain/projects";
import { STATUS_DOING, projectFinished } from "../domain/work";
import { CustomerHero, customerPendingItems } from "./customer/CustomerHero";
import { CustomerTimeline, customerYearCounts, customerYearSub } from "./customer/CustomerTimeline";
import { CustomerPackages, customerPackagesCount } from "./customer/CustomerPackages";
import { CustomerContacts, CustomerProfile } from "./customer/CustomerProfile";

export function CustomerDetailPage() {
	const { id = "" } = useParams();
	const { version } = useApp();
	void version;
	const navigate = useNavigate();
	const openProject = useOpenProject();
	if (!CUSTOMERS[id]) return <Navigate to={paths.customers} replace />;

	const projects = projectsForCustomer(id);
	const active = projects.filter((p) => !projectFinished(p));
	const pending = customerPendingItems(active);
	const c = CUSTOMERS[id];

	return (
		<>
			<button className="back-link" onClick={() => navigate(paths.customers)}>
				<ArrowLeftIcon />
				กลับไปหน้าลูกค้า
			</button>

			<div className="mw-hero cd-hero">
				<CustomerHero id={id} active={active} />
			</div>

			{/* Full width, directly under the header: what the office is waiting
			    on THIS customer for is the one thing on the screen that nobody in
			    the office can move on their own. */}
			<div className="section cd-band">
				<div className="section-head">
					<h3>รอจากฝั่งลูกค้า</h3>
					{/* A count next to an all-clear that already says "nothing" is a
					    zero said twice, so the number only appears when there is one. */}
					<span className="section-count">{pending.length ? pending.length + " รายการ" : ""}</span>
				</div>
				<div>
					{pending.length === 0 ? (
						<div className="all-clear"><CheckCircleIcon />ไม่มีเอกสารหรือการอนุมัติที่ค้างรอจากลูกค้ารายนี้</div>
					) : (
						pending.map((row, i) => {
							const p = row.p, it = row.item;
							return (
								<div className="contact-row pending-row" key={i} onClick={() => openProject(p.id, it.pi, it.gi)}>
									<div className="contact-main">
										<span className="contact-name">
											<span className="pending-gate-code">{it.gate.code}</span> {it.gate.name}
										</span>
										<span className="pending-context">{jobTypeByKey(p.jobType)!.name + " · " + p.periodLabel}</span>
									</div>
									<div className="contact-meta">{it.rec.status === STATUS_DOING ? "กำลังติดตาม" : "ยังไม่เริ่มติดตาม"}</div>
								</div>
							);
						})
					)}
				</div>
			</div>

			<div className="cd-cols">
				<div>
					<div className="mw-lane-head">
						<h3>งวดของลูกค้ารายนี้</h3>
						<span className="n">{customerYearCounts(id)}</span>
					</div>
					<p className="mw-lane-sub">{customerYearSub(id)}</p>
					<div className="cd-rail-list">
						<CustomerTimeline id={id} />
					</div>
				</div>

				<aside className="cd-rail">
					<div className="section">
						<div className="section-head">
							<h3>แพ็กเกจงานที่ซื้อไว้</h3>
							<span className="section-count">{customerPackagesCount(id)}</span>
						</div>
						<div>
							<CustomerPackages id={id} />
						</div>
					</div>

					<div className="permissions-card">
						<div className="permissions-head">
							<BuildingIcon />
							ข้อมูลลูกค้า
						</div>
						<p className="permissions-caption">
							ข้อมูลทะเบียนที่สำนักงานเก็บไว้ต่อลูกค้าหนึ่งราย — ตอนรับลูกค้าใหม่กรอกแค่ชื่อกับผู้ติดต่อ ที่เหลือมาเติมที่นี่เมื่อได้ข้อมูลมา
						</p>
						<div className="kv-list">
							<CustomerProfile id={id} />
						</div>
					</div>

					<div className="section cd-rail-contacts">
						<div className="section-head">
							<h3>ผู้ติดต่อ</h3>
							<span className="section-count">{c.contacts.length ? c.contacts.length + " คน" : ""}</span>
						</div>
						<div>
							<CustomerContacts id={id} />
						</div>
					</div>
				</aside>
			</div>
		</>
	);
}
