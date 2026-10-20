import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h, ref } from 'vue';
import type { Ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { providePagePin, usePagePin, type PinTarget } from './pagePin';

// A page (provides) above its frame (injects), as in STARbase: page > ExplorerView > PlainFrame.
let injected: Ref<PinTarget | null> | null = null;
const Frame = defineComponent({
	setup() {
		const pin = usePagePin();
		injected = pin;
		return () => h('header', pin.value ? `${pin.value.kind}:${pin.value.target}` : 'no pin');
	},
});

async function render(provided: Ref<PinTarget | null> | 'none') {
	const Page = defineComponent({
		setup() {
			if (provided !== 'none') providePagePin(provided);
			return () => h('div', [h(Frame)]);
		},
	});
	return renderToString(createSSRApp(Page));
}

describe('usePagePin', () => {
	it('hands the frame the target the page provided', async () => {
		expect(await render(ref({ kind: 'record', target: 'physical_samples:s1' }))).toContain('record:physical_samples:s1');
	});

	it('holds null when the page provided null, or nothing', async () => {
		expect(await render(ref(null))).toContain('no pin');
		expect(await render('none')).toContain('no pin');
		expect(injected?.value).toBeNull();
	});

	it('is the page\'s own ref, so a target that changes (a saved view opens) reaches the frame', async () => {
		const target = ref<PinTarget | null>({ kind: 'page', target: 'samples' });
		await render(target);
		target.value = { kind: 'view', target: '4' };
		expect(injected?.value).toEqual({ kind: 'view', target: '4' });
	});
});
