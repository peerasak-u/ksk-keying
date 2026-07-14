// Stage-grader registry — the single lookup table stage-grade.ts drives.
//
// Every stage is registered NOW, each importing its own grader module. A
// Phase-2 agent implementing (say) the link grader edits ONLY
// specs/link-stage.ts — never this file and never the driver — so parallel
// Phase-2 work on different stages can't conflict here.

import { categorizeStageGrader } from "./categorize-stage";
import { groupStageGrader } from "./group-stage";
import { interpretStageGrader } from "./interpret-stage";
import { linkStageGrader } from "./link-stage";
import { segmentStageGrader } from "./segment-stage";
import type { StageGrader } from "./stage-grader";

export const STAGE_GRADERS: Record<string, StageGrader> = {
	segment: segmentStageGrader,
	interpret: interpretStageGrader,
	link: linkStageGrader,
	group: groupStageGrader,
	categorize: categorizeStageGrader,
};

export function getStageGrader(stage: string): StageGrader | undefined {
	return STAGE_GRADERS[stage];
}
