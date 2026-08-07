// The domain model the legacy single-file mock carried implicitly, written out.
// Nothing here is new: every field already existed on the seed objects in
// platform-mock-p0/index.html — this file only gives them names.

// ---- Job type -> Phase -> Gate. There is no 4th level.
export type DueRule = { dayOfMonth: number; monthOffset?: number } | { offsetDays: number };

export type ReviewRung = "deputy" | "lead" | "coo";

export interface Gate {
	code: string;
	name: string;
	required: boolean;
	freq?: string;
	note?: string;
	/** Set only where the ball is in the CUSTOMER's court. */
	actor?: string;
	due?: DueRule;
	review?: ReviewRung;
}

export interface PhaseWorkflowAttachment {
	key: string;
	evidence: string[];
}

export interface Phase {
	name: string;
	gates: Gate[];
	workflows?: PhaseWorkflowAttachment[];
}

export interface JobType {
	key: string;
	name: string;
	phases: Phase[];
}

export interface GateRule {
	due?: DueRule;
	review?: ReviewRung;
}

// ---- the office
export type PositionKey = "intern" | "staff" | "deputy" | "lead" | "coo";

export interface Position {
	label: string;
	canReview: boolean;
	canSeeOffice: boolean;
	canEditPermissions: boolean;
}

export interface Team {
	key: string;
	name: string;
	lead: string | null;
	deputy: string | null;
	staff: string[];
	interns: string[];
}

export interface User {
	team: string;
	position: PositionKey;
	initials: string;
}

/** A shadow copy of the roster, so "what if I moved this person" runs the real rule. */
export interface Structure {
	teams: Team[];
	users: Record<string, User>;
}

export interface Reviewer {
	name: string | null;
	rung: PositionKey;
	rungLabel: string;
}

// ---- customers and what they bought
export interface PackageSkip {
	period: string;
	reason: string;
	by: string;
	at: string;
}

export interface CustomerPackage {
	id: string;
	jobType: string;
	recurrence: string;
	startedAt: string;
	endedAt: string | null;
	paused: boolean;
	fee: number;
	note: string;
	skips: PackageSkip[];
}

export interface CustomerContact {
	name: string;
	role: string;
	phone: string | null;
	email: string | null;
	lineId: string | null;
	isPrimary: boolean;
}

export interface Customer {
	code: string;
	legalName: string;
	displayName: string;
	taxId: string | null;
	businessNature: string;
	status: string;
	lineGroupId: string | null;
	note: string;
	onboardedAt: string;
	vatRegistered: boolean;
	fiscalYearEnd: string;
	packages: CustomerPackage[];
	contacts: CustomerContact[];
}

// ---- a project = one client + one job type + one งวด
export interface ProjectSeed {
	docs?: string;
	pastDate?: string;
	done?: number;
	doing?: number[];
	awaiting?: number[];
	notes?: Record<number, string>;
}

/** The per-run ผู้ทำ / ผู้สอบทาน / วันที่เสร็จ / สถานะ / หมายเหตุ record for one Gate.
 *  Exactly the five fill-in columns the office's own tracking sheets have, plus
 *  `noDocs` — which is deliberately NOT a fourth สถานะ (see round 20). */
export interface GateRecord {
	status: string;
	doer: string | null;
	reviewer: string | null;
	doneAt: string | null;
	note: string;
	noDocs: boolean;
}

export interface Project {
	id: string;
	customerId: string;
	assignee: string;
	jobType: string;
	periodLabel: string;
	monthKey: string;
	phaseIndex: number;
	seed?: ProjectSeed;
	status: string;
	actionLabel: string;
	primary?: boolean;
	/** Stamped by the schedule when a งวด is opened through it. */
	openedOn?: Date;
	openedBy?: string;
	openedHow?: string;
	/** The per-project checklist instance, built from the job type template. */
	work?: GateRecord[][];
	/** Cached Phase trail, rebuilt when an admin changes the ladder's length. */
	trail?: PhaseTrail;
}

// ---- automation workflows attached to a Phase
export interface Workflow {
	key: string;
	name: string;
	actor: string;
	desc: string;
	steps: string[];
	result: (d: WorkflowRunData) => string[];
}

export type CoaRow = [string, string, string] | [string, string, string, string];

export interface RunLine {
	desc: string;
	code: string;
	name: string;
	amount: number;
	date: string | null;
	direction: string | null;
	confidence: string;
	needsReview: boolean;
	reason: string;
	[key: string]: unknown;
}

export interface RunFacts {
	[key: string]: string | number | null | undefined;
}

export interface RunGroup {
	id: string;
	label: string;
	party: string;
	docNo: string;
	isBank: boolean;
	pages: number;
	date: string;
	total: number;
	status: string;
	flags: string[];
	lines: RunLine[];
	facts: RunFacts;
	note: string;
	skipped: boolean;
	saved: boolean;
	kept: boolean;
	src: string;
}

export interface RunBucket {
	key: string;
	label: string;
	path: string;
	groups: RunGroup[];
	pages: number;
	attention: number;
}

export interface RunExclusion {
	unit: string;
	file: string;
	page: number;
	reason: string;
	duplicate_of: { file: string; page: number } | null;
	decision: string | null;
}

export interface WorkflowRunData {
	buckets: RunBucket[];
	excluded: RunExclusion[];
	groupCount: number;
	pageCount: number;
	totalUnits: number;
	attention: number;
}

export interface WorkflowRun {
	no: number;
	state: string;
	step: number;
	timer: ReturnType<typeof setTimeout> | null;
	customerId: string;
	monthKey: string;
	periodLabel: string;
	failStep: number;
	failWhy: string | null;
	startedAt: string;
	finishedAt: string | null;
	startedBy?: string;
	data: WorkflowRunData | null;
}

// ---- notifications
export interface Notification {
	id: number;
	to: string;
	kind: string;
	title: string;
	context: string;
	target: NotificationTarget | null;
	at: string;
	read: boolean;
}

export interface NotificationTarget {
	page: string;
	args?: unknown;
	pi?: number;
	gi?: number;
	key?: string;
	no?: number;
	id?: string;
}

// ---- the page router's argument bag
export interface RunReviewArgs {
	id: string;
	pi: number;
	key: string;
	no: number;
}

// ---- the recurring schedule
export interface DueRow {
	customerId: string;
	pkg: CustomerPackage;
	monthKey: string;
	opensOn: Date;
	days: number;
	overdue: boolean;
	skip?: PackageSkip;
}
export interface PausedRow { customerId: string; pkg: CustomerPackage }
export interface ScheduleSnapshot { due: DueRow[]; skipped: DueRow[]; paused: PausedRow[] }

// ---- the Phase trail (round 30c)
export interface TrailPhase { start: Date; end: Date | null; days: number | null }
export interface PhaseTrail {
	n: number;
	opened: Date;
	phases: (TrailPhase | null)[];
	usable: boolean;
	squeezed: boolean;
}
