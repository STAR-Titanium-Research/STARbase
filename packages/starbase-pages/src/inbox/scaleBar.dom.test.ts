// @vitest-environment happy-dom
// The scale bar's drawn rule is exactly the labelled share of the picture: the bar is a border-box with 6px of padding each side, so its width is the fraction
// of the picture plus those 12px, and the rule inside (the bar's content box) is then fraction x the picture's width.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, type App } from 'vue';
import ScaleBar from './ScaleBar.vue';

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = '';
});

function mountBar(fraction: number, label: string): HTMLElement {
	app?.unmount();
	const el = document.createElement('div');
	document.body.appendChild(el);
	app = createApp({ render: () => h(ScaleBar, { bar: { fraction, label }, 'data-test': 'bar' }) });
	app.mount(el);
	return el.querySelector<HTMLElement>('[data-test="bar"]')!;
}

describe('ScaleBar', () => {
	it('is wide enough that its rule is exactly fraction x 100% of the picture (the bar\'s 12px of padding is added to the width)', () => {
		const bar = mountBar(0.2, '20 µm');
		expect(bar.style.width).toBe('calc(20% + 12px)');
		expect(bar.textContent).toContain('20 µm');
		expect(bar.querySelector('[data-test="scalebar-rule"]')).not.toBeNull();
		const wide = mountBar(0.125, '500 nm');
		expect(wide.style.width).toBe('calc(12.5% + 12px)');
	});
});
