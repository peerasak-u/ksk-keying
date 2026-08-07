// ================= the dialog (round 18) =================
//
// One component, two callers: รับลูกค้าใหม่ on the ลูกค้า screen and
// add/edit-a-person on พนักงานและทีม. Both used to be .inline-form blocks
// that unfolded into the page, which made creating something look like the
// page rearranging itself rather than an act on its own layer.
//
// A caller hands over a spec, not markup-once: `render()` is called again on
// every repaint, so a dialog whose body depends on its own inputs (the person
// dialog's "ถ้าบันทึก:" impact panel runs the REAL reviewerIn() over a shadow
// structure) stays live without the caller re-implementing re-rendering.
import { useEffect, useRef } from "react";
import { useApp } from "../state/AppContext";

export function ModalRoot() {
	const { modal, closeModal, version } = useApp();
	const cardRef = useRef<HTMLDivElement | null>(null);
	const opened = useRef(false);

	// Focus starts inside the dialog, on the first thing there is to fill in
	// rather than on the close button that happens to come first in the markup.
	useEffect(() => {
		if (!modal) { opened.current = false; return; }
		if (opened.current) return;
		opened.current = true;
		const items = focusables(cardRef.current);
		const field = items.filter((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))[0];
		const first = field || items[0];
		if (first) first.focus();
	}, [modal]);

	// A dialog owns the keyboard while it is open: Escape closes it, Tab wraps
	// inside it, and the shortcuts belonging to the screen behind it stay quiet.
	useEffect(() => {
		if (!modal) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); closeModal(); }
			else if (e.key === "Tab") trapTab(e, cardRef.current);
		};
		document.addEventListener("keydown", onKey, true);
		document.body.classList.add("modal-open");
		return () => {
			document.removeEventListener("keydown", onKey, true);
			document.body.classList.remove("modal-open");
		};
	}, [modal, closeModal]);

	if (!modal) return <div id="modal-root"></div>;
	// `version` is read so a store mutation repaints the live body (the person
	// dialog's impact panel depends on it).
	void version;
	const parts = modal.render();
	return (
		<div id="modal-root">
			<div
				className="modal-backdrop"
				onClick={(e) => {
					// Only the backdrop itself — a click that started inside the card
					// and ended on the backdrop must not count as "cancel".
					if (e.target === e.currentTarget) closeModal();
				}}
			>
				<div className="modal" id="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={cardRef}>
					<div className="modal-head">
						<h3 className="modal-title" id="modal-title">
							{modal.title}
							{modal.sub ? <span className="modal-sub">{modal.sub}</span> : null}
						</h3>
						<button type="button" className="modal-close" aria-label="ปิด" onClick={closeModal}>
							<svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
						</button>
					</div>
					<div className="modal-body">{parts.body}</div>
					<div className="modal-actions">{parts.actions}</div>
				</div>
			</div>
		</div>
	);
}

function focusables(card: HTMLElement | null): HTMLElement[] {
	if (!card) return [];
	return Array.prototype.filter.call(
		card.querySelectorAll("input, select, textarea, button, [tabindex]"),
		function (el: HTMLElement) { return !(el as HTMLButtonElement).disabled && el.offsetParent !== null; },
	) as HTMLElement[];
}

// Focus stays in the dialog while it is open — Tab off either end wraps
// back rather than walking into the screen underneath.
function trapTab(e: KeyboardEvent, card: HTMLElement | null) {
	const items = focusables(card);
	if (!items.length) return;
	const first = items[0], last = items[items.length - 1];
	if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
