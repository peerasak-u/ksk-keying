// The legacy mock's UI globals, still module-level on purpose.
//
// These are the selections a screen keeps BETWEEN visits: the office overview's
// period/team filters, the month board's month, which Phase panel is unfolded on
// the working screen. In the single-file mock they were plain `var`s that
// survived navigation, and they still are — moving them into component state
// would reset them on every navigation, which is a behaviour change, not a
// refactor. Anything that genuinely belongs to one mount lives in useState in
// the page instead.
export const ui = {
	// ---- the project working screen
	openPhaseIndex: null as number | null,
	openGateKey: null as string | null,

	// ---- ภาพรวมสำนักงาน
	overviewOpenSection: "late",
	overviewPeriodKey: "now",
	overviewTeamKey: "all",
	overviewPerson: null as string | null,
	overviewDueWindow: 14,
	expandedLists: {} as Record<string, boolean>,

	// ---- ปฏิทินงานประจำเดือน
	currentMonthIndex: 6,

	// ---- the customer screen
	profileFormOpen: null as string | null,
	pkgFormCustomer: null as string | null,
	pkgFormId: null as string | null,

	// ---- the run review screen
	runItemIndex: 0,
	runFilterBucket: "all",
	runFilterAttention: false,
	runZoom: 1,
	runHistoryOpen: false,
	// Round 15 — the review flow has two steps, in the pipeline's own order:
	// the pages the run proposed to CUT are decided first, and the rest of the
	// review waits behind them.
	runStep: "excluded" as "excluded" | "documents",
	runExIndex: 0,
	runExFilter: "all",

	// ---- the login screen
	otherUsersShown: false,

	// ---- the sidebar frame
	sidebarCollapsed: false,
	mobileSidebarOpen: false,
};

/** Where a run review came from, so its back button is never a dead end. */
export const returnTo = { page: null as string | null, args: null as unknown };
