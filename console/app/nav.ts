// Shared header navigation for the review surfaces.
//
// Every detail page (excluded-review, the 5 document buckets, bank statement)
// is reached FROM the per-month review hub, but each one used to offer only
// "← กลับไปที่ Dashboard" — one link that skipped the level you actually came
// from, so moving between two buckets of the same month meant going all the
// way out and back in. These pages sit two levels deep, so the header says so:
//
//   Dashboard › ตรวจทานเอกสาร › <this page>
//
// The hub itself stays a plain back-link to the dashboard; it IS level one.

export function reviewHubUrl(clientId: string, monthId: string): string {
	return `/clients/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}/review`;
}

/** The two ancestor levels, as links, plus the current page as plain text.
 * `current` is escaped here so callers can pass raw labels. */
export function breadcrumbHtml(clientId: string, monthId: string, current: string): string {
	return `<nav class="crumbs">
		<a href="/">Dashboard</a>
		<span class="crumb-sep">›</span>
		<a href="${reviewHubUrl(clientId, monthId)}">ตรวจทานเอกสาร</a>
		<span class="crumb-sep">›</span>
		<span class="crumb-here">${Bun.escapeHTML(current)}</span>
	</nav>`;
}

/** Drop-in replacement for the old `header a.back` rule. Kept as a string
 * constant because each page inlines its own <style> block — there is no
 * shared stylesheet in this app. */
export const BREADCRUMB_CSS = `
	.crumbs { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.4; flex-wrap: wrap; }
	.crumbs a { color: #a8a29e; text-decoration: none; }
	.crumbs a:hover { color: #fafaf9; text-decoration: underline; }
	.crumb-sep { color: #57534e; }
	.crumb-here { color: #d6d3cd; }
`;
