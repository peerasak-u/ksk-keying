// The live, in-memory office. These are the legacy mock's module-level globals,
// kept mutable on purpose: every screen reads THE SAME list, and an edit made on
// one screen is visible on every other one without anything being copied. There
// is no backend and no persistence — refreshing resets everything to the seed,
// exactly as the single-file mock did.
//
// React never owns this data. Components read it and call bump() from
// ../state/AppContext to repaint; see that file for why.
import type {
	Customer,
	JobType,
	Notification,
	Project,
	Structure,
	Team,
	User,
	WorkflowRun,
} from "../types";
import { buildJobTypes } from "../data/gateRules";
import { CUSTOMER_SEED } from "../data/customers";
import { PROJECT_SEED } from "../data/projects";
import { COO_NAME, COO_TEAM, TEAM_SEED } from "../data/office";

export const JOB_TYPES: JobType[] = buildJobTypes();

export const TEAMS: Team[] = TEAM_SEED;

export const USERS: Record<string, User> = {};
(function buildUsers() {
	var initials = function (n: string) { return n.slice(0, 2); };
	TEAMS.forEach(function (t) {
		var add = function (name: string | null, position: User["position"]) {
			if (!name) return;
			USERS[name] = { team: t.key, position: position, initials: initials(name) };
		};
		add(t.lead, "lead");
		add(t.deputy, "deputy");
		t.staff.forEach(function (n) { add(n, "staff"); });
		t.interns.forEach(function (n) { add(n, "intern"); });
	});
	USERS[COO_NAME] = { team: COO_TEAM, position: "coo", initials: COO_NAME.slice(0, 2) };
})();

/** The roster the real review ladder is computed against. */
export const LIVE_STRUCTURE: Structure = { teams: TEAMS, users: USERS };

export const CUSTOMERS: Record<string, Customer> = CUSTOMER_SEED;

export const PROJECTS: Project[] = PROJECT_SEED;

/** One key holds the run HISTORY for that (project, phase, workflow), oldest first. */
export const WF_RUNS: Record<string, WorkflowRun[]> = {};

export const NOTIFS: Notification[] = [];

/** Mutable counters the legacy mock kept as bare `var`s. */
export const counters = {
	wfRunSeq: 400,
	notifSeq: 0,
};
