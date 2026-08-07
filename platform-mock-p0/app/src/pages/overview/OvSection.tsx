// Every section is the same shape: a head that states the question and
// carries its own count as the button that opens it, and a body that is
// the concrete list. Only one is open at a time, so the screen stays a
// page rather than a wall.
import type { ReactNode } from "react";
import { ui } from "../../state/ui";
import { useApp } from "../../state/AppContext";
import { ChevronIcon } from "../../components/Icons";

export function useSetOverviewSection() {
	const { bump } = useApp();
	return (key: string) => {
		ui.overviewOpenSection = ui.overviewOpenSection === key ? "" : key;
		ui.overviewPerson = null;
		bump();
	};
}

export function OvSection({
	sectionKey,
	title,
	sub,
	count,
	tone,
	body,
}: {
	sectionKey: string;
	title: string;
	sub: string;
	count: number;
	tone: string;
	body: () => ReactNode;
}) {
	const setSection = useSetOverviewSection();
	const open = ui.overviewOpenSection === sectionKey;
	return (
		<section className={"ov-section" + (open ? " open" : "")}>
			<button type="button" className="ov-head" onClick={() => setSection(sectionKey)}>
				<span className="ov-head-main">
					<span className="ov-title">{title}</span>
					<span className="ov-sub">{sub}</span>
				</span>
				<span className={"figure ov-count " + (count === 0 ? "figure-zero" : tone)}>
					<span className="figure-n">{count}</span>
				</span>
				<ChevronIcon />
			</button>
			{open ? <div className="ov-body">{body()}</div> : null}
		</section>
	);
}
