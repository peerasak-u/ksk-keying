// A text field that commits on blur, the way the legacy mock's DOM `onchange`
// did — never on every keystroke, so nothing repaints under the caret while
// somebody is still typing. It stays uncontrolled while focused and takes the
// incoming value back whenever the record changes underneath it (ticking a
// Gate writes วันที่เสร็จ), which the legacy innerHTML rewrite did for free.
import { useEffect, useRef } from "react";

export function BlurInput({
	value,
	onCommit,
	...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onBlur"> & {
	value: string;
	onCommit: (value: string) => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el && document.activeElement !== el && el.value !== value) el.value = value;
	}, [value]);
	return (
		<input
			{...rest}
			type="text"
			ref={ref}
			defaultValue={value}
			onBlur={(e) => onCommit(e.target.value)}
		/>
	);
}
