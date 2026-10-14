import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import MapSheet from './MapSheet.vue';
import { PHONE_QUERY, controlsPosition, useIsPhone } from './usePhone';

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });

describe('MapSheet (spec D24)', () => {
	it('is collapsed to its header: the record code, a handle button, the rail shut', async () => {
		const app = createSSRApp({ render: () => h(MapSheet, { title: 'S-0412-A' }, { default: () => h('p', { class: 'rail' }, 'the rail') }) });
		app.component('v-icon', VIcon);
		const html = await renderToString(app);
		expect(html).toContain('S-0412-A');
		expect(html).toMatch(/<button type="button" class="head" aria-expanded="false" aria-controls="pm-sheet-body"/);
		expect(html).toMatch(/id="pm-sheet-body"[^>]*style="display:none;?"/); // the rail is in the DOM, shut
		expect(html).toContain('d1-process-map'); // the kind colours reach the rail drawn in it
	});
});

describe('useIsPhone', () => {
	type Listener = (e: { matches: boolean }) => void;
	const fakeQuery = (matches: boolean) => {
		const listeners = new Set<Listener>();
		return {
			matches,
			addEventListener: (_: string, l: Listener) => void listeners.add(l),
			removeEventListener: (_: string, l: Listener) => void listeners.delete(l),
			change: (m: boolean) => listeners.forEach((l) => l({ matches: m })),
		};
	};

	it('asks below 768 px, like the shell', () => expect(PHONE_QUERY).toBe('(max-width: 767px)'));

	it('starts from the query and follows it (a rotated phone)', () => {
		const mq = fakeQuery(true);
		const phone = useIsPhone(mq as never);
		expect(phone.value).toBe(true);
		mq.change(false);
		expect(phone.value).toBe(false);
	});

	it('is false where there is no matchMedia (server rendering)', () => {
		expect(useIsPhone(null).value).toBe(false);
	});
});

describe('controlsPosition', () => {
	it('moves the zoom controls out from under the collapsed bottom sheet on a phone', () => {
		expect(controlsPosition(true)).toBe('top-left');
		expect(controlsPosition(false)).toBe('bottom-left');
	});
});
