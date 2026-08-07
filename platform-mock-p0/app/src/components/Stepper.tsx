// Connected-timeline stepper — plain CSS shapes + one inline SVG
// checkmark, no glyphs/emoji. The track between two steps is "filled"
// once the step it leaves is done, so the line visually reflects
// progress up to the current step, not past it.
import { Fragment } from "react";
import { StepperCheckIcon } from "./Icons";

export function Stepper({ phases, phaseIndex }: { phases: string[]; phaseIndex: number }) {
	return (
		<div className="stepper">
			{phases.map((label, i) => {
				const state = i < phaseIndex ? "done" : i === phaseIndex ? "current" : "upcoming";
				return (
					<Fragment key={i}>
						<div className="stepper-step">
							<div className={"stepper-dot " + state} title={label}>
								{state === "done" ? <StepperCheckIcon /> : null}
							</div>
						</div>
						{i < phases.length - 1 ? (
							<div className={"stepper-line" + (i < phaseIndex ? " filled" : "")}></div>
						) : null}
					</Fragment>
				);
			})}
		</div>
	);
}
