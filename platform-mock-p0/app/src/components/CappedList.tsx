// Long lists stay usable at 113 customers by showing the first few and
// saying plainly how many are hidden — never by silently truncating.
// One shared expansion register, so the same rule applies on every screen.
import type { ReactNode } from "react";
import { LIST_CAP } from "../domain/due";
import { ui } from "../state/ui";
import { useApp } from "../state/AppContext";
import { CheckCircleIcon } from "./Icons";

export function CappedList({
	listKey,
	rows,
	emptyText,
	cap,
	wrapClass = "task-list",
	unit = "รายการ",
}: {
	listKey: string;
	rows: ReactNode[];
	emptyText: string;
	cap?: number;
	/** null drops the wrapper entirely, as the legacy helper's `null` did. */
	wrapClass?: string | null;
	unit?: string;
}) {
	const { bump } = useApp();
	if (rows.length === 0) {
		return <div className="all-clear"><CheckCircleIcon />{emptyText}</div>;
	}
	const limit = cap || LIST_CAP;
	const showAll = ui.expandedLists[listKey];
	const shown = showAll ? rows : rows.slice(0, limit);
	const inner = shown.map((row, i) => <Row key={i}>{row}</Row>);
	return (
		<>
			{wrapClass ? <div className={wrapClass}>{inner}</div> : inner}
			{!showAll && rows.length > limit ? (
				<button
					type="button"
					className="btn btn-ghost list-more"
					onClick={() => { ui.expandedLists[listKey] = true; bump(); }}
				>
					ดูทั้งหมด {rows.length} {unit}
				</button>
			) : null}
		</>
	);
}

function Row({ children }: { children: ReactNode }) {
	return <>{children}</>;
}
