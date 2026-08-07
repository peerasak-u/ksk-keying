import { useApp } from "../state/AppContext";

export function Toast() {
	const { toast } = useApp();
	return <div id="toast" className={toast ? "show" : ""}>{toast}</div>;
}
