// The two app-level globals every domain function in the legacy mock reached
// for directly: who is signed in, and the toast.
//
// They stay module-level here for the same reason: `notify()`, `openPeriod()`
// and the Gate actions all need them, and threading a React context through
// every pure domain function would change what those functions are. The
// provider registers the real toast sink at mount; before that (and in tests)
// showToast is a no-op.
export const session = {
	currentUserName: null as string | null,
};

let toastSink: ((msg: string) => void) | null = null;
let repaint: (() => void) | null = null;

export function registerAppBridge(sink: (msg: string) => void, bump: () => void) {
	toastSink = sink;
	repaint = bump;
}

export function showToast(msg: string) {
	if (toastSink) toastSink(msg);
}

/** Ask every screen to re-read the stores. Called by anything that mutates them. */
export function bumpApp() {
	if (repaint) repaint();
}
