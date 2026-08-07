import type { ReactNode } from "react";
import type { Project } from "../../types";
import { ProjectCard } from "../../components/ProjectCard";
import { customerName } from "../../domain/projects";
import { projectLate } from "../../domain/trail";

/** Late first, then by customer name — the order every list on the executive
 *  screen uses, so a project sits in the same place wherever it appears. */
export function projectRows(list: Project[], annotate?: (p: Project) => ReactNode) {
	return list
		.slice()
		.sort((a, b) => {
			if (projectLate(a) !== projectLate(b)) return projectLate(a) ? -1 : 1;
			return customerName(a.customerId).localeCompare(customerName(b.customerId), "th");
		})
		.map((p) => <ProjectCard key={p.id} p={p} annotation={annotate ? annotate(p) : null} compact />);
}
