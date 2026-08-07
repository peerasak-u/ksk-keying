import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import { seedEverything } from "./state/seed";
import "./styles/index.css";

// Everything the legacy mock's top-level IIFEs did, before the first render.
seedEverything();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{/* HashRouter so the built app is servable as a plain static site from any
		    path — there is no server here to rewrite deep links. */}
		<HashRouter>
			<App />
		</HashRouter>
	</StrictMode>,
);
