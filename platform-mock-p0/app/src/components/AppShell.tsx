// screen 2 (the sidebar nav frame) wrapped around whichever page is showing.
//
// The legacy mock kept all eleven screens as sibling divs and toggled `.active`;
// here the frame is a layout route and the page is its <Outlet />. What did not
// change is the frame itself: the collapsible sidebar, the mobile hamburger and
// the per-page width classes on <main>.
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { PAGE_TITLES, pageKeyFor, paths } from "../navigation";
import { useApp } from "../state/AppContext";
import { ui } from "../state/ui";
import { canEditTemplates, canSeeOffice } from "../domain/people";
import { MenuIcon } from "./Icons";

// Pages that only some roles may reach. Hiding the nav link is not
// enough on its own — the router is the place the rule actually holds,
// so a stale link or a direct URL can never land somebody on a screen
// their role does not have.
const PAGE_GUARD: Record<string, (name: string) => boolean> = {
	overview: canSeeOffice,
	"job-types": canEditTemplates,
	// The office's own structure is the same admin capability as its
	// process templates — this screen is for whoever already holds it.
	people: canEditTemplates,
};

export function AppShell() {
	const { currentUserName, showToast, bump, version } = useApp();
	const location = useLocation();
	const page = pageKeyFor(location.pathname);

	// A page a role may not reach bounces to งานของฉัน and says why.
	const guard = PAGE_GUARD[page];
	const denied = !!guard && !!currentUserName && !guard(currentUserName);
	useEffect(() => {
		if (denied) showToast("บทบาทของคุณไม่มีสิทธิ์เข้าหน้านี้");
	}, [denied, showToast]);

	useEffect(() => {
		if (window.innerWidth <= 840 && ui.mobileSidebarOpen) {
			ui.mobileSidebarOpen = false;
			bump();
		}
		// Only on an actual navigation.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [location.pathname]);

	if (!currentUserName) return <Navigate to={paths.login} replace />;
	if (denied) return <Navigate to={paths.myWork} replace />;
	void version;

	// "ประเภทงาน" was the only two-column screen (round 8); งานของฉัน became
	// the second one in round 27, when it grew its two lanes. Round 28c added
	// the customer screen and round 29 the calendar — all four take the same
	// 1080px rather than a width of their own.
	const wide = page === "job-types" || page === "my-work" || page === "customer-detail" || page === "month-board";
	// Round 21 packs teams two across and their people three across, which at
	// .wide's 1080px left too little box per person; round 22 moved พนักงานและทีม
	// to the .widest width the run-review screen already uses.
	const widest = page === "run-review" || page === "people";
	// The review flow's sticky action bar needs the page to be at least
	// viewport-tall, so the bar lands in the same place on both steps.
	const runFlow = page === "run-review";

	const toggleSidebar = () => {
		if (window.innerWidth <= 840) ui.mobileSidebarOpen = !ui.mobileSidebarOpen;
		else ui.sidebarCollapsed = !ui.sidebarCollapsed;
		bump();
	};

	return (
		/* #screen-app is display:none in the stylesheet; the legacy mock's login()
		   set this inline style, and keeping it means that rule stays untouched. */
		<div id="screen-app" style={{ display: "block" }}>
			<div className="shell">
				<Sidebar collapsed={ui.sidebarCollapsed} mobileOpen={ui.mobileSidebarOpen} onToggle={toggleSidebar} />
				<div
					className={"sidebar-backdrop" + (ui.mobileSidebarOpen ? " show" : "")}
					onClick={() => { ui.mobileSidebarOpen = false; bump(); }}
				></div>

				<div className="content-area">
					<header className="topbar-mobile">
						<button
							className="hamburger"
							aria-label="เปิดเมนู"
							onClick={() => { ui.mobileSidebarOpen = true; bump(); }}
						>
							<MenuIcon />
						</button>
						<span className="topbar-mobile-title">{PAGE_TITLES[page] || ""}</span>
					</header>

					<main className={[wide ? "wide" : "", widest ? "widest" : "", runFlow ? "run-flow" : ""].filter(Boolean).join(" ")}>
						{/* The id survives from the legacy markup because two CSS rules
						    still key off it (main.run-flow #page-run-review). */}
						<div className="page active" id={"page-" + page}>
							<Outlet />
						</div>
					</main>
				</div>
			</div>
		</div>
	);
}
