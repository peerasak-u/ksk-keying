import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so `bun run build` output can be served from any static path.
export default defineConfig({
	base: "./",
	plugins: [react()],
});
