// Pulled out of server.ts (MAJOR 2, validator finding) so the ordering
// guarantee behind the /api/clients seq guard fix is directly unit-testable
// without importing server.ts itself — that module calls Bun.serve() and
// orchestrator.boot() at module load time, so importing it from a test would
// start a real listener as a side effect. This file has none.
//
// The fix: `readSeq` MUST be called BEFORE `scan()` starts, never after it
// resolves — stamping after resolution guarantees the fallback response
// outranks any SSE broadcast minted while that same scan was still in flight
// (the client guards are strict `seq < lastRowSeq`, so a stale response could
// then never be dropped). Snapshotting first means an uncontended poll still
// gets a seq equal to "whatever the counter was when the poll started" (an
// equal seq still applies, since the guard is strict `<`), while any
// broadcast that completes DURING the scan bumps the counter to something
// strictly higher — so it correctly outranks this response once it lands.
export async function snapshotThenScan<T>(readSeq: () => number, scan: () => Promise<T>): Promise<{ seq: number; result: T }> {
	const seq = readSeq();
	const result = await scan();
	return { seq, result };
}
