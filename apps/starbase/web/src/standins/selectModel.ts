// <v-select :items="[{ text, value }]">: a native <select> speaks strings, while the values are uuids,
// numbers or codes, so each option is keyed by its index.
export interface SelectItem {
	text: string;
	value: unknown;
}
export const DESELECT = '__deselect__';

export function optionKey(items: SelectItem[], value: unknown): string {
	const i = items.findIndex((it) => it.value === value);
	return i < 0 ? '' : String(i);
}

export function valueFor(items: SelectItem[], key: string): unknown {
	if (key === '' || key === DESELECT) return null;
	const item = items[Number(key)];
	return item ? item.value : null;
}
