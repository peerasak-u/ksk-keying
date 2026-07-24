// PROTOTYPE — throwaway. Serves the company/month picker + run dashboard UI
// prototype (wayfinder ticket #32 on map #29): three radically different
// variants of the SAME question, switchable via ?variant=A|B|C, per the
// /prototype skill's UI.md. No real backend, no persistence — mock data in
// mock-data.ts. Deliberately built with plain Bun.serve() + hand-rolled
// templates (no framework) to match ticket #30's decision for the real app.
//
// Usage: bun run console/_prototype_dashboard/serve.ts
// (or: bun run --cwd console proto:dashboard)

import { renderVariantA } from "./variant-a";
import { renderVariantB } from "./variant-b";
import { renderVariantC } from "./variant-c";

const PORT = Number(process.env.PORT ?? 4901);
const HOST = process.env.HOST ?? "0.0.0.0";

const RENDER: Record<string, () => string> = {
	A: renderVariantA,
	B: renderVariantB,
	C: renderVariantC,
};

const server = Bun.serve({
	hostname: HOST,
	port: PORT,
	fetch(req) {
		const url = new URL(req.url);
		const variant = (url.searchParams.get("variant") ?? "A").toUpperCase();
		const render = RENDER[variant] ?? RENDER.A;
		return new Response(render(), { headers: { "content-type": "text/html; charset=utf-8" } });
	},
});

console.log(`prototype dashboard serving on http://${HOST === "0.0.0.0" ? "<LAN-IP>" : HOST}:${server.port} (variants A/B/C via ?variant=)`);
