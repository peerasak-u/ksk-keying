// The notification surface (round 17). Only events that already exist in this
// mock produce one, and a person only ever sees the ones addressed to them —
// switch demo users on the login screen and the list is genuinely different.
import type { ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { NOTIFS } from "../state/stores";
import { useApp } from "../state/AppContext";
import { showToast } from "../state/session";
import { CappedList } from "../components/CappedList";
import {
	CheckCircleIcon,
	CpuIcon,
	NotifDocIcon,
	NotifPeriodIcon,
	NotifReviewIcon,
	NotifSentBackIcon,
} from "../components/Icons";
import { NOTIF_KINDS, notifsFor } from "../domain/notifications";
import { personCaption } from "../domain/people";
import { paths, useOpenProject, useOpenRunReview } from "../navigation";

const NOTIF_ICONS: Record<string, () => ReactElement> = {
	review: NotifReviewIcon,
	sentback: NotifSentBackIcon,
	period: NotifPeriodIcon,
	run: CpuIcon,
	doc: NotifDocIcon,
};

export function NotificationsPage() {
	const { currentUserName, bump, version } = useApp();
	void version;
	const navigate = useNavigate();
	const openProject = useOpenProject();
	const openRunReview = useOpenRunReview();
	const name = currentUserName!;
	const list = notifsFor(name);
	const unread = list.filter((n) => !n.read).length;

	function openNotification(id: number) {
		const n = NOTIFS.filter((x) => x.id === id)[0];
		if (!n) return;
		n.read = true;
		const t = n.target;
		if (!t) { bump(); return; }
		if (t.page === "project") {
			openProject(t.id!, typeof t.pi === "number" ? t.pi : undefined, typeof t.gi === "number" ? t.gi : undefined);
			return;
		}
		// openRunReview() records its own way back, and its back button lands on
		// the Phase checklist the run belongs to — so this is never a dead end.
		if (t.page === "run") { openRunReview(t.id!, t.pi!, t.key!, t.no!); return; }
		bump();
		navigate(paths.myWork);
	}

	function markAllNotifsRead() {
		notifsFor(name).forEach((n) => { n.read = true; });
		showToast("ทำเครื่องหมายว่าอ่านแล้วทั้งหมด");
		bump();
	}

	return (
		<>
			<div className="page-header">
				<h2>การแจ้งเตือน</h2>
				<p className="page-sub">
					{"เฉพาะเรื่องที่เกี่ยวกับคุณ (" + name + " · " + personCaption(name) + ") — " +
						(list.length === 0 ? "ยังไม่มีการแจ้งเตือน" : list.length + " รายการ · ยังไม่ได้อ่าน " + unread)}
				</p>
			</div>
			<div className="notif-toolbar">
				{unread === 0 ? null : (
					<button type="button" className="btn btn-ghost" onClick={markAllNotifsRead}>ทำเครื่องหมายว่าอ่านแล้วทั้งหมด</button>
				)}
			</div>
			<div>
				{list.length === 0 ? (
					<div className="all-clear"><CheckCircleIcon />ยังไม่มีอะไรที่ต้องแจ้งคุณ — งานที่ส่งต่อมาถึงคุณจะขึ้นที่นี่</div>
				) : (
					<CappedList
						listKey={"notifs-" + name}
						rows={list.map((n) => {
							const Icon = NOTIF_ICONS[n.kind] || NOTIF_ICONS.doc;
							return (
								<div key={n.id} className={"contact-row notif-row" + (n.read ? "" : " unread")} onClick={() => openNotification(n.id)}>
									<span className={"notif-dot" + (n.read ? " read" : "")}></span>
									<span className="item-icon"><Icon /></span>
									<div className="contact-main">
										<span className="notif-title">{n.title}</span>
										<span className="notif-context">{NOTIF_KINDS[n.kind] + (n.context ? " · " + n.context : "")}</span>
									</div>
									<span className="notif-when">{n.at}</span>
								</div>
							);
						})}
						emptyText=""
						cap={12}
						wrapClass={null}
						unit="รายการ"
					/>
				)}
			</div>
		</>
	);
}
