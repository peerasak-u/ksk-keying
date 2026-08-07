// Where every screen lives, and the two navigations that carry state with them.
//
// The legacy mock switched pages by toggling `.active` on eleven sibling divs
// and remembering `returnTo` in a global. Here each page is a real route with
// its own URL, and `returnTo` survives as the one thing routing cannot express:
// "the screen a project/run was opened FROM", so both back buttons land where
// somebody actually came from rather than on a guess.
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ui, returnTo } from "./state/ui";

export const paths = {
	login: "/login",
	myWork: "/",
	overview: "/overview",
	customers: "/customers",
	customerDetail: (id: string) => "/customers/" + encodeURIComponent(id),
	monthBoard: "/month-board",
	notifications: "/notifications",
	people: "/people",
	jobTypes: "/job-types",
	projectDetail: (id: string) => "/projects/" + encodeURIComponent(id),
	runReview: (id: string, pi: number, key: string, no: number) =>
		"/projects/" + encodeURIComponent(id) + "/runs/" + pi + "/" + encodeURIComponent(key) + "/" + no,
};

/** project-detail deliberately doesn't light a nav item — it is reached from
 *  three different places, so whichever item was already lit stays lit. */
export const NAV_HIGHLIGHT: Record<string, string | null> = {
	"my-work": "my-work", overview: "overview", customers: "customers", "customer-detail": "customers",
	"month-board": "month-board", "project-detail": null, "run-review": null, "job-types": "job-types",
	notifications: "notifications", people: "people",
};

export const PAGE_TITLES: Record<string, string> = {
	"my-work": "งานของฉัน", overview: "ภาพรวมสำนักงาน", customers: "ลูกค้า", "customer-detail": "รายละเอียดลูกค้า",
	"month-board": "ปฏิทินงานประจำเดือน", "project-detail": "รายละเอียดโปรเจกต์", "run-review": "ตรวจทานผลการรัน",
	"job-types": "ประเภทงาน", notifications: "การแจ้งเตือน", people: "พนักงานและทีม",
};

/** Which of the eleven screens a URL is, for the nav highlight and the title. */
export function pageKeyFor(pathname: string): string {
	if (pathname === paths.myWork) return "my-work";
	if (pathname.startsWith("/customers/")) return "customer-detail";
	if (pathname.startsWith("/projects/") && pathname.indexOf("/runs/") !== -1) return "run-review";
	if (pathname.startsWith("/projects/")) return "project-detail";
	const key = pathname.replace(/^\//, "");
	return PAGE_TITLES[key] ? key : "my-work";
}

// pi/gi are optional (round 9): when a screen points at ONE specific Gate
// — an outstanding customer document, a figure on the overview — it opens
// that Gate's row expanded instead of dropping the user on the project and
// making them find it again.
export function useOpenProject() {
	const navigate = useNavigate();
	const location = useLocation();
	return useCallback(
		(id: string, pi?: number, gi?: number) => {
			returnTo.page = location.pathname;
			returnTo.args = null;
			// Otherwise: always open on the Phase the project is actually in, with
			// no row left expanded from whatever project was looked at before.
			ui.openPhaseIndex = typeof pi === "number" ? pi : null;
			ui.openGateKey = typeof pi === "number" && typeof gi === "number" ? pi + ":" + gi : null;
			navigate(paths.projectDetail(id));
		},
		[navigate, location.pathname],
	);
}

/** Leaving a run review for the project it belongs to. Deliberately NOT
 *  useOpenProject: the run was opened FROM the project, so `returnTo` still
 *  holds the screen the project itself came from and must survive — the legacy
 *  closeRunReview() navigated without touching it. */
export function useCloseRunReview() {
	const navigate = useNavigate();
	return useCallback(
		(id: string, pi: number) => {
			ui.openPhaseIndex = pi;
			ui.openGateKey = null;
			navigate(paths.projectDetail(id));
		},
		[navigate],
	);
}

/** The way back from a project or a run — never a dead end. */
export function useGoBack() {
	const navigate = useNavigate();
	return useCallback(() => {
		navigate(returnTo.page || paths.myWork);
	}, [navigate]);
}

export function useOpenRunReview() {
	const navigate = useNavigate();
	const location = useLocation();
	return useCallback(
		(projectId: string, pi: number, wfKey: string, no: number) => {
			ui.runItemIndex = 0;
			ui.runFilterBucket = "all";
			ui.runFilterAttention = false;
			ui.runZoom = 1;
			ui.runHistoryOpen = false;
			ui.runExIndex = 0;
			ui.runExFilter = "all";
			returnTo.page = location.pathname;
			returnTo.args = null;
			navigate(paths.runReview(projectId, pi, wfKey, no));
		},
		[navigate, location.pathname],
	);
}
