// MAJOR 1 (validator finding): the pure membership-diffing logic behind the
// dashboard's 30s fallback poll reconciliation. Before this, swapRow() could
// only UPDATE a row that already existed in the DOM (`if (!row) return;`),
// and pollClientsFallback only ever iterated months that already resolved to
// a row — so a client-month that appears on disk AFTER page load (a month
// folder syncing in from Dropbox, a run started from a second tab) never got
// a row at all, and a month that disappears never lost its row. There is no
// other refresh affordance anywhere in the UI now that the old 8s
// location.reload() is gone, so a stale row set would sit there forever.
//
// This module has no DOM dependency at all — it just says WHICH relPaths and
// client codes need inserting or removing, given what the payload says
// should exist and what the browser currently has. The actual DOM
// insertion/removal (creating elements from headerHtml/html/noMatchHtml,
// keeping insertion order, calling recomputeStatusUI()/applyFilters() once)
// lives in dashboard.ts's inline reconcileDashboard(), which mirrors this
// exact membership semantics against the real DOM — same relationship as
// elapsedText()/computeElapsedText() (see dashboard.ts's own comment on
// that pairing).
export type ReconcilePayloadMonth = { relPath: string };
export type ReconcilePayloadClient = { clientId: string; months: ReconcilePayloadMonth[] };

export type MembershipDiff = {
	/** relPaths the payload says should exist but the DOM doesn't have a row for yet. */
	insertRelPaths: string[];
	/** relPaths the DOM currently has a row for for that the payload no longer lists. */
	removeRelPaths: string[];
	/** client codes the payload lists that the DOM has no header/no-match-row for yet. */
	insertClientCodes: string[];
	/** client codes the DOM currently has a header/no-match-row for that the payload no longer lists. */
	removeClientCodes: string[];
};

/**
 * Pure set-difference between "what's in the DOM right now" and "what the
 * payload says should be there" — order of the input arrays is preserved in
 * the outputs (insertion order elsewhere is handled by the DOM-side caller,
 * which walks payloadClients in the server's own order).
 */
export function diffDashboardMembership(
	existingRelPaths: string[],
	existingClientCodes: string[],
	payloadClients: ReconcilePayloadClient[],
): MembershipDiff {
	const payloadRelPathSet = new Set<string>();
	const payloadClientCodeSet = new Set<string>();
	for (const client of payloadClients) {
		payloadClientCodeSet.add(client.clientId);
		for (const month of client.months) payloadRelPathSet.add(month.relPath);
	}
	const existingRelPathSet = new Set(existingRelPaths);
	const existingClientCodeSet = new Set(existingClientCodes);

	const insertRelPaths: string[] = [];
	for (const client of payloadClients) {
		for (const month of client.months) {
			if (!existingRelPathSet.has(month.relPath) && !insertRelPaths.includes(month.relPath)) insertRelPaths.push(month.relPath);
		}
	}
	const insertClientCodes: string[] = [];
	for (const client of payloadClients) {
		if (!existingClientCodeSet.has(client.clientId) && !insertClientCodes.includes(client.clientId)) insertClientCodes.push(client.clientId);
	}

	return {
		insertRelPaths,
		removeRelPaths: existingRelPaths.filter((p) => !payloadRelPathSet.has(p)),
		insertClientCodes,
		removeClientCodes: existingClientCodes.filter((c) => !payloadClientCodeSet.has(c)),
	};
}
