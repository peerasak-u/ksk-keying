// The one piece of React state the whole app shares.
//
// The office data itself lives in ./stores as plain mutable objects (see the
// note there). What React needs on top of that is only: who is signed in, a
// repaint signal for when something in those stores was mutated, and the two
// app-level overlays the legacy mock also kept outside every screen — the
// dialog and the toast.
//
// `bump()` is that repaint signal. An action mutates the store exactly as the
// single-file mock did, then calls bump(); every screen re-reads the store and
// re-renders. That keeps the port a restructuring rather than a rewrite of the
// data model into immutable updates.
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

export interface ModalSpec {
	title: string;
	sub?: string;
	render: () => { body: ReactNode; actions: ReactNode };
	onClose?: () => void;
}

interface AppContextValue {
	/** Repaint counter — read it in a component to subscribe to store mutations. */
	version: number;
	bump: () => void;
	currentUserName: string | null;
	setCurrentUserName: (name: string | null) => void;
	toast: string | null;
	showToast: (msg: string) => void;
	modal: ModalSpec | null;
	openModal: (spec: ModalSpec) => void;
	closeModal: () => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
	const [version, setVersion] = useState(0);
	const [currentUserName, setCurrentUserName] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [modal, setModal] = useState<ModalSpec | null>(null);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const bump = useCallback(() => setVersion((v) => v + 1), []);

	const showToast = useCallback((msg: string) => {
		setToast(msg);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(null), 2600);
	}, []);

	// Closing never saves and never mutates anything — every caller does its
	// writing in its own submit handler before asking for the close.
	const closeModal = useCallback(() => {
		setModal((current) => {
			if (current && current.onClose) current.onClose();
			return null;
		});
	}, []);

	const value = useMemo<AppContextValue>(
		() => ({
			version,
			bump,
			currentUserName,
			setCurrentUserName,
			toast,
			showToast,
			modal,
			openModal: setModal,
			closeModal,
		}),
		[version, bump, currentUserName, toast, showToast, modal, closeModal],
	);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
	const v = useContext(Ctx);
	if (!v) throw new Error("useApp() outside <AppProvider>");
	return v;
}
