// Deterministic Stage-2 work planning.  The segment manifest is evidence, not
// an instruction for an agent to explore the filesystem: this module turns it
// into exact, bounded leaf invocations before Claude is started.
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const INTERPRET_PAGE_CAP = 15;

export type InventoryFile = {
	path: string;
	kind: "pdf" | "image" | "spreadsheet" | "other";
	page_count: number;
	sheets: string[] | null;
};

export type Inventory = { schema?: string; files: InventoryFile[] };

export type Disposition = {
	file: string;
	page?: number | null;
	sheet?: string | null;
	disposition: "used" | "excluded";
	declared_by?: string;
};

export type SegmentSource = {
	file: string;
	pages: [number, number] | null;
	sheets: string[] | null;
};

export type Segment = {
	segment_id: string;
	type: "pdf_range" | "transaction_folder" | "single_file" | "spreadsheet" | string;
	sources: SegmentSource[];
	source_class?: string;
	// Columbo normally emits pages only for a one-source pdf_range. `file` is
	// accepted for the unambiguous multi-source extension, but never guessed.
	sub_ranges?: Array<{ pages: [number, number]; file?: string }>;
};

export type SegmentsManifest = { schema: "ksk_segments.v1"; segments: Segment[] };

export type PageRef = {
	file: string; // exact run-root-relative Inventory path
	page: number;
	sourcePath: string; // exact absolute source path, contained by runRoot
	artifactPath: string; // exact prepared PNG path, contained by preparedPagesRoot
};

export type SheetRef = {
	file: string;
	sheet: string;
	sourcePath: string;
	artifactPath: string; // exact prepared workbook copy; the leaf never discovers it
};

export type InterpretUnit = {
	id: string;
	segmentId: string;
	runRoot: string;
	agent: "ksk-watson" | "ksk-marple";
	pages: PageRef[];
	sheets: SheetRef[];
	resultPath: string;
	fragmentPath: string;
};

export type SkippedSegment = { segmentId: string; reason: string };

export type InterpretPlan = {
	runRoot: string;
	units: InterpretUnit[];
	skipped: SkippedSegment[];
};

export type CreateInterpretPlanOptions = {
	runRoot: string;
	manifest: SegmentsManifest;
	inventory: Inventory;
	dispositions?: { entries?: Disposition[] };
	// prepare.ts currently emits <run>/_pages/<source parent>/<source stem>/page-NNN.png.
	// Keep it injectable so a future deterministic renderer can move this without
	// asking a model to discover a new location.
	preparedPagesRoot?: string;
};

function safeRelativePath(value: string, label: string) {
	if (!value || isAbsolute(value) || value.split(/[\\/]/).some((part) => part === ".." || part === "" && value !== ""))
		throw new Error(`${label} must be a non-empty run-root-relative path without '..': ${JSON.stringify(value)}`);
	return value.replaceAll("\\", "/");
}

function within(root: string, candidate: string, label: string) {
	const absoluteRoot = resolve(root);
	const absoluteCandidate = resolve(candidate);
	if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}${sep}`))
		throw new Error(`${label} escapes its allowed root: ${absoluteCandidate}`);
	return absoluteCandidate;
}

function sourceAbsolute(runRoot: string, file: string) {
	return within(runRoot, join(runRoot, safeRelativePath(file, "manifest source.file")), "manifest source.file");
}

function preparedArtifactPath(preparedPagesRoot: string, file: string, page: number) {
	const normalized = safeRelativePath(file, "manifest source.file");
	const parent = dirname(normalized);
	const stem = basename(normalized, extname(normalized));
	const dir = parent === "." ? join(preparedPagesRoot, stem) : join(preparedPagesRoot, parent, stem);
	// PDFs render to PNG; ready image files are copied without conversion by
	// prepare.ts, so their artifact retains the source extension.
	const artifactExtension = extname(normalized).toLowerCase() === ".pdf" ? ".png" : extname(normalized);
	return within(preparedPagesRoot, join(dir, `page-${String(page).padStart(3, "0")}${artifactExtension}`), "prepared page artifact");
}

function preparedSheetDataPath(preparedPagesRoot: string, file: string, sheet: string) {
	const normalized = safeRelativePath(file, "manifest source.file");
	const parent = dirname(normalized);
	const stem = basename(normalized, extname(normalized));
	const dir = parent === "." ? join(preparedPagesRoot, stem) : join(preparedPagesRoot, parent, stem);
	return within(preparedPagesRoot, join(dir, `sheet-${encodeURIComponent(sheet)}.json`), "prepared spreadsheet sheet artifact");
}

function unitKey(file: string, page: number | null, sheet: string | null) {
	return page != null ? `${file}#p${page}` : sheet != null ? `${file}#s${sheet}` : file;
}

function protectedExclusions(dispositions: Disposition[] | undefined) {
	const units = new Set<string>();
	const files = new Set<string>();
	for (const entry of dispositions ?? []) {
		// Only a prior policy/human declaration may remove work from the Stage-2
		// queue. An agent's old fragment is revalidated by the executor instead.
		if (entry.disposition === "excluded" && (entry.declared_by === "human" || entry.declared_by === "agent_policy")) {
			if (entry.page == null && entry.sheet == null) files.add(entry.file);
			else units.add(unitKey(entry.file, entry.page ?? null, entry.sheet ?? null));
		}
	}
	return { units, files };
}

function sourcePages(source: SegmentSource, inventory: InventoryFile): number[] {
	if (inventory.kind !== "pdf" && inventory.kind !== "image") return [];
	const [start, end] = source.pages ?? [1, inventory.page_count];
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > inventory.page_count)
		throw new Error(`invalid page range ${JSON.stringify(source.pages)} for ${source.file}; inventory has ${inventory.page_count} page(s)`);
	return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function sourceSheets(source: SegmentSource, inventory: InventoryFile): string[] {
	if (inventory.kind !== "spreadsheet") return [];
	const available = inventory.sheets ?? (inventory.page_count === 1 ? ["Sheet1"] : null);
	if (!available) throw new Error(`spreadsheet inventory for ${source.file} has no sheet list`);
	const requested = source.sheets ?? available;
	for (const sheet of requested) if (!available.includes(sheet)) throw new Error(`sheet ${JSON.stringify(sheet)} is not in Inventory for ${source.file}`);
	return requested;
}

function outputPaths(runRoot: string, segmentId: string, suffix: string | null) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segmentId)) throw new Error(`unsafe segment_id ${JSON.stringify(segmentId)}`);
	const segmentsRoot = join(runRoot, "ข้อมูลระบบ", "_segments", segmentId);
	const fragmentsRoot = join(runRoot, "ข้อมูลระบบ", "_pages", "fragments");
	const resultName = suffix ? `interpretation-${suffix}.json` : "interpretation.json";
	const fragmentName = suffix ? `${segmentId}-${suffix}.yaml` : `${segmentId}.yaml`;
	return {
		resultPath: within(segmentsRoot, join(segmentsRoot, resultName), "interpretation output"),
		fragmentPath: within(fragmentsRoot, join(fragmentsRoot, fragmentName), "disposition fragment output"),
	};
}

function chunks<T>(items: T[], limit: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += limit) out.push(items.slice(i, i + limit));
	return out;
}

export function createInterpretPlan(options: CreateInterpretPlanOptions): InterpretPlan {
	const runRoot = resolve(options.runRoot);
	const preparedPagesRoot = resolve(options.preparedPagesRoot ?? join(runRoot, "_pages"));
	if (options.manifest.schema !== "ksk_segments.v1") throw new Error(`expected ksk_segments.v1 manifest, got ${JSON.stringify(options.manifest.schema)}`);
	const inventoryByFile = new Map<string, InventoryFile>();
	for (const file of options.inventory.files) {
		const safe = safeRelativePath(file.path, "inventory file.path");
		if (inventoryByFile.has(safe)) throw new Error(`duplicate Inventory path ${JSON.stringify(safe)}`);
		inventoryByFile.set(safe, { ...file, path: safe });
	}
	const excluded = protectedExclusions(options.dispositions?.entries);
	const isExcluded = (file: string, page: number | null, sheet: string | null) =>
		excluded.files.has(file) || excluded.units.has(unitKey(file, page, sheet));
	const seenSegments = new Set<string>();
	const units: InterpretUnit[] = [];
	const skipped: SkippedSegment[] = [];

	for (const segment of options.manifest.segments) {
		if (seenSegments.has(segment.segment_id)) throw new Error(`duplicate segment_id ${JSON.stringify(segment.segment_id)}`);
		seenSegments.add(segment.segment_id);
		if (!Array.isArray(segment.sources) || segment.sources.length === 0) throw new Error(`segment ${segment.segment_id} has no sources`);
		const visualSources: Array<{ source: SegmentSource; inventory: InventoryFile; file: string; sourcePath: string; pages: number[] }> = [];
		const sheets: SheetRef[] = [];
		for (const source of segment.sources) {
			const file = safeRelativePath(source.file, `source.file in ${segment.segment_id}`);
			const inventory = inventoryByFile.get(file);
			if (!inventory) throw new Error(`segment ${segment.segment_id} references ${JSON.stringify(file)}, absent from Inventory`);
			if (inventory.kind === "other" && !excluded.files.has(file))
				throw new Error(`segment ${segment.segment_id} references unsupported opaque source ${JSON.stringify(file)} without a protected file-level exclusion`);
			const absSource = sourceAbsolute(runRoot, file);
			const sourcePageNumbers = sourcePages(source, inventory);
			if (sourcePageNumbers.length) visualSources.push({ source, inventory, file, sourcePath: absSource, pages: sourcePageNumbers });
			for (const sheet of sourceSheets(source, inventory)) {
				if (!isExcluded(file, null, sheet)) sheets.push({ file, sheet, sourcePath: absSource, artifactPath: preparedSheetDataPath(preparedPagesRoot, file, sheet) });
			}
		}
		let visualWindows: PageRef[][] = [];
		if (visualSources.length) {
			if (segment.sub_ranges?.length) {
				const assigned = new Set<string>();
				for (const subRange of segment.sub_ranges) {
					const candidates = subRange.file
						? visualSources.filter((source) => source.file === safeRelativePath(subRange.file!, `sub_range.file in ${segment.segment_id}`))
						: visualSources.length === 1 ? visualSources : [];
					if (candidates.length !== 1) throw new Error(`sub_range in ${segment.segment_id} must name one visual source when the segment has multiple sources`);
					const source = candidates[0];
					const [start, end] = subRange.pages;
					if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new Error(`invalid sub_range pages in ${segment.segment_id}`);
					const refs = source.pages.filter((page) => page >= start && page <= end && !isExcluded(source.file, page, null)).map((page) => ({ file: source.file, page, sourcePath: source.sourcePath, artifactPath: preparedArtifactPath(preparedPagesRoot, source.file, page) }));
					if (!refs.length && source.pages.some((page) => page >= start && page <= end)) continue; // entirely policy-excluded
					if (!refs.length || refs.length !== end - start + 1 - source.pages.filter((page) => page >= start && page <= end && isExcluded(source.file, page, null)).length)
						throw new Error(`sub_range ${start}-${end} in ${segment.segment_id} lies outside its source range`);
					for (const ref of refs) {
						const key = unitKey(ref.file, ref.page, null);
						if (assigned.has(key)) throw new Error(`sub_ranges overlap at ${key} in ${segment.segment_id}`);
						assigned.add(key);
					}
					visualWindows.push(...chunks(refs, INTERPRET_PAGE_CAP));
				}
				const expected = visualSources.flatMap((source) => source.pages.filter((page) => !isExcluded(source.file, page, null)).map((page) => unitKey(source.file, page, null)));
				for (const key of expected) if (!assigned.has(key)) throw new Error(`sub_ranges leave ${key} uncovered in ${segment.segment_id}`);
			} else {
				const pages = visualSources.flatMap((source) => source.pages.filter((page) => !isExcluded(source.file, page, null)).map((page) => ({ file: source.file, page, sourcePath: source.sourcePath, artifactPath: preparedArtifactPath(preparedPagesRoot, source.file, page) })));
				visualWindows = chunks(pages, INTERPRET_PAGE_CAP);
			}
		}
		const pages = visualWindows.flat();

		if (segment.source_class === "derived_report") {
			if (pages.length || sheets.length) throw new Error(`derived_report ${segment.segment_id} has units without an existing human/agent_policy exclusion`);
			skipped.push({ segmentId: segment.segment_id, reason: "derived_report already excluded by policy" });
			continue;
		}
		if (pages.length && sheets.length) throw new Error(`segment ${segment.segment_id} mixes visual and spreadsheet sources; split it in Stage 1`);
		if (!pages.length && !sheets.length) {
			skipped.push({ segmentId: segment.segment_id, reason: "all units already excluded by human/policy" });
			continue;
		}

		const windows = pages.length ? visualWindows : sheets.map((sheet) => [sheet]);
		for (let index = 0; index < windows.length; index++) {
			const window = windows[index];
			const suffix = windows.length === 1 ? null : `u${String(index + 1).padStart(3, "0")}`;
			const outputs = outputPaths(runRoot, segment.segment_id, suffix);
			units.push({
				id: suffix ? `${segment.segment_id}-${suffix}` : segment.segment_id,
				segmentId: segment.segment_id,
				runRoot,
				agent: pages.length ? "ksk-watson" : "ksk-marple",
				pages: pages.length ? (window as PageRef[]) : [],
				sheets: sheets.length ? (window as SheetRef[]) : [],
				...outputs,
			});
		}
	}

	return { runRoot, units, skipped };
}
