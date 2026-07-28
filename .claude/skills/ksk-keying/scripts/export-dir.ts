// Recognizes the folder a client keeps their *finished* PEAK import files in.
//
// This one predicate guards a hard rule (CLAUDE.md → "never peek at
// answer-keys/"): those workbooks are the answer to the very question the
// pipeline is being asked, so they must never be copied into a sample client
// folder, and must never be handed to segmentation as source documents.
//
// The name is not standardized — every client folder spells it differently.
// Observed across the seven (พร้อมทดสอบ)_* clients:
//
//   "File PEAK import"   (216, 345, 352)
//   "File Peak Import"   (336)          — same words, different case
//   "เตรียมไฟล์นำเข้า"        (218)
//   "STM ไฟล์นำเข้า"       (281)
//   "ไฟล์นำเข้า Peak"      (339)
//
// so an exact-string match against any one of them silently lets the other
// four through. Match on the two stable signals instead: the English "peak"
// + "import" word pair in either order, or the Thai compound "ไฟล์นำเข้า"
// (literally "import file").
//
// Deliberately NOT matched: bare "นำเข้า". On its own that word means
// imported *goods*, so a genuine source folder like "เอกสารนำเข้า" (import
// documents) would be excluded from the run — dropping real client
// documents, the opposite failure. Requiring the "ไฟล์" prefix keeps the
// predicate on file-export folders.
const THAI_IMPORT_FILE = "ไฟล์นำเข้า";

export function isExportDir(name: string): boolean {
	const norm = name.toLowerCase().replace(/\s+/g, " ").trim();
	if (norm.includes(THAI_IMPORT_FILE)) return true;
	return norm.includes("peak") && norm.includes("import");
}

// A path is tainted if ANY of its segments is an export dir — the workbooks
// sit in subfolders ("File Peak Import/รายได้/*.xlsx"), so checking only the
// leaf or only the top level would miss them.
export function containsExportDir(relPath: string): boolean {
	return relPath
		.split("/")
		.filter(Boolean)
		.some((seg) => isExportDir(seg));
}

// Not every export workbook lives in an export folder. Client 218 keeps two —
// "PEAK_ImportJournal ฝาก 01-04.xlsx" and its ถอน twin — loose inside
// statement/, alongside the bank statement PDF they were produced from. A
// folder-only rule copies those straight into the sample as source material.
//
// PEAK's own exports are named after the sheet they import into
// (PEAK_ImportExpense / PEAK_ImportReceipt / PEAK_ImportJournal), sometimes
// with a Thai suffix appended by hand. Match the peak+import pair in the file
// stem, restricted to the Excel family — a PDF or an image is a scan of a
// real document, never a PEAK export, so it stays source material even if
// someone names it oddly.
const EXCEL_EXT = /\.(xlsx|xlsm|xls)$/i;

// Client 281 files theirs by hand under the SOURCE folders — e.g.
// "รายได้/ไฟล์นำเข้า รายรับ หจก.รุ่งเรืองก่อสร้าง03-69.xlsx" — with no "PEAK"
// anywhere in the name. So the file rule needs the same two signals the
// folder rule uses, for the same reason: an export is identified by being
// called an import file, in either language.
export function isExportFile(name: string): boolean {
	if (!EXCEL_EXT.test(name)) return false;
	const stem = name.replace(EXCEL_EXT, "").toLowerCase();
	if (stem.includes(THAI_IMPORT_FILE)) return true;
	return stem.includes("peak") && stem.includes("import");
}

// The single question both the copier and its verifier ask of one file.
//
// Note the Excel gate applies to the FOLDER rule too, not just the filename
// rule. Client 281 names its bank-statement folder "STM ไฟล์นำเข้า" and keeps
// the source statement PDFs in it alongside the PEAK journals — excluding the
// whole folder would throw away the very documents the run has to read. A PEAK
// export is always a workbook; a PDF or an image is always a scan of a real
// document, whatever folder it was filed under. Checked against the five
// already-split clients: all 103 answer-key files are .xlsx, no exceptions.
//
// This is a NAME-based test and names can lie — 339 keeps byte-identical
// copies of its exports under รายได้/ and STM/ with innocent names like
// "รายได้.xlsx". Catching those needs content comparison against the known
// exports, which is the copier's second pass (see prepare-sample.ts).
export function isAnswerKeyPath(relPath: string): boolean {
	const segments = relPath.split("/").filter(Boolean);
	const name = segments[segments.length - 1] ?? "";
	if (!EXCEL_EXT.test(name)) return false;
	return containsExportDir(relPath) || isExportFile(name);
}
