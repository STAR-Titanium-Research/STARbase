import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ConnectTo from './ConnectTo.vue';
import DuplicatePrompt from './DuplicatePrompt.vue';

const VButton = defineComponent({ props: { disabled: Boolean }, setup: (p, { slots }) => () => h('button', { disabled: p.disabled }, slots.default?.()) });
async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp({ render: () => h(component as never, props) });
	app.component('v-button', VButton);
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('ConnectTo', () => {
	const entries = [
		{ id: 'a', label: 'Turning', detail: 'operation', sock: { kind: 'row' as const, id: 'draft:n3', side: 'in' as const } },
		{ id: 'b', label: 'Tensile', detail: 'test', sock: { kind: 'row' as const, id: 'draft:n4', side: 'in' as const } },
	];

	it('is a dialog with a search box and the sockets by code, the first one chosen', async () => {
		const html = await render(ConnectTo, { entries, from: 'PS-001', at: { x: 0, y: 0 } });
		expect(html).toContain('role="dialog"');
		expect(html).toContain('role="combobox"');
		expect(text(html)).toContain('Connect PS-001 to…');
		expect(text(html)).toContain('Turning');
		expect(text(html)).toContain('Tensile');
		expect(html).toMatch(/id="[^"]*-opt-0"[^>]*aria-selected="true"/);
	});

	it('says so when nothing can be connected', async () => {
		expect(text(await render(ConnectTo, { entries: [], from: 'PS-001', at: { x: 0, y: 0 } }))).toContain('Nothing on the canvas can be connected');
	});
});

describe('DuplicatePrompt', () => {
	it('asks how many, starting at 2, with Cancel and Duplicate', async () => {
		const html = await render(DuplicatePrompt, { what: 'this sample' });
		expect(html).toContain('role="dialog"');
		expect(text(html)).toContain('Duplicate this sample how many times?');
		expect(html).toMatch(/type="number"[^>]*min="1"[^>]*max="99"/);
		expect(html).toContain('value="2"');
		expect(text(html)).toContain('Cancel');
		expect(html).not.toContain('role="alert"');
	});
});
