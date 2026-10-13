import type { Directive } from 'vue';

// Stand-in for Directus's v-tooltip (v-tooltip="'Copy file path'", v-tooltip.bottom="…"): the text is
// the element's title, and its accessible name too unless it has one of its own. Placement modifiers are
// accepted and ignored.
export interface TooltipTarget {
	dataset: Record<string, string | undefined>;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	hasAttribute(name: string): boolean;
}

export function applyTooltip(el: TooltipTarget, value: unknown): void {
	const text = value === null || value === undefined || value === false ? '' : String(value);
	const ours = el.dataset.sbTip === '1';
	if (!text) {
		el.removeAttribute('title');
		if (ours) {
			el.removeAttribute('aria-label');
			delete el.dataset.sbTip;
		}
		return;
	}
	el.setAttribute('title', text);
	if (ours || !el.hasAttribute('aria-label')) {
		el.setAttribute('aria-label', text);
		el.dataset.sbTip = '1';
	}
}

export const vTooltip: Directive<HTMLElement, unknown> = {
	mounted: (el, binding) => applyTooltip(el, binding.value),
	updated: (el, binding) => applyTooltip(el, binding.value),
	getSSRProps: (binding) => (binding.value ? { title: String(binding.value) } : {}),
};
