// Open dialogs, oldest first. Every open v-dialog listens for Esc on the document, so without this every
// dialog on screen would handle one keypress; only the top one (the last opened) acts.
const stack: symbol[] = [];

export function pushDialog(id: symbol): void {
	if (!stack.includes(id)) stack.push(id);
}
export function popDialog(id: symbol): void {
	const i = stack.indexOf(id);
	if (i >= 0) stack.splice(i, 1);
}
export function isTopDialog(id: symbol): boolean {
	return stack[stack.length - 1] === id;
}
export function openDialogCount(): number {
	return stack.length;
}

// Put focus back on what opened the dialog, if it is still on the page.
export function restoreFocus(opener: { isConnected: boolean; focus(): void } | null): void {
	if (opener?.isConnected) opener.focus();
}

// The Esc listener for one dialog: it acts (and swallows the key) only while that dialog is on top.
export function escHandler(id: symbol, onEsc: () => void): (e: { key: string; stopPropagation(): void }) => void {
	return (e) => {
		if (e.key !== 'Escape' || !isTopDialog(id)) return;
		e.stopPropagation();
		onEsc();
	};
}
