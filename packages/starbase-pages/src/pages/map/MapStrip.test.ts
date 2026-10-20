import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import MapStrip from './MapStrip.vue';
import MapTitleActions from './MapTitleActions.vue';
import { UNAVAILABLE } from './edit/useEditMode';

const VIcon = defineComponent({ props: ['name'], setup: (p) => () => h('i', { class: 'v-icon' }, String(p.name)) });
const VButton = defineComponent({ setup: (_p, { slots }) => () => h('button', slots.default?.()) });

async function render(component: object, props: Record<string, unknown>): Promise<string> {
	const app = createSSRApp(component, props);
	app.component('v-icon', VIcon);
	app.component('v-button', VButton);
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const quiet = () => ({
	edit: { editing: ref(false), drafted: ref(false), failed: ref('') },
	side: { markDone: { error: ref('') }, build: { problem: ref(''), picking: { problem: ref('') } } },
	map: { notice: ref(''), expanding: ref(false), partial: ref(false) },
	canvas: { layoutError: ref('') },
	mapExport: { error: ref(''), notice: ref(''), dismissError: () => undefined },
});

describe('MapStrip', () => {
	it('says nothing when there is nothing to say', async () => {
		expect(text(await render(MapStrip, quiet()))).toBe('');
	});

	it('says what the draft, the map and the export have to report, each in its own banner', async () => {
		const p = quiet();
		p.edit.drafted.value = true;
		p.edit.failed.value = 'Your last changes are not kept yet.';
		p.side.markDone.error.value = 'Mark done failed.';
		p.side.build.problem.value = 'That sample could not be read.';
		p.map.partial.value = true;
		p.canvas.layoutError.value = 'Could not lay out the map: boom';
		p.mapExport.notice.value = 'Exported.';
		const html = await render(MapStrip, p);
		for (const words of ['open to look at only', 'not kept yet', 'Mark done failed', 'could not be read', 'Showing part of this history', 'Could not lay out', 'Exported.']) expect(text(html)).toContain(words);
		expect(html).toMatch(/class="(?:pm-banner pm-bad|pm-bad pm-banner)"[^>]*role="alert"[^>]*>Your last changes/);
	});

	it('the unavailable notice is a status, not an alert', async () => {
		const p = quiet();
		p.edit.failed.value = UNAVAILABLE;
		const html = await render(MapStrip, p);
		expect(html).toMatch(/class="pm-banner"[^>]*role="status"[^>]*>Building processes isn&#39;t available/);
	});

	it('an export error wins over the export notice, and a map notice over "loading more"', async () => {
		const p = quiet();
		p.mapExport.error.value = 'Export failed.';
		p.mapExport.notice.value = 'Exported.';
		p.map.notice.value = 'Could not load more.';
		p.map.expanding.value = true;
		const t = text(await render(MapStrip, p));
		expect(t).toContain('Export failed.');
		expect(t).not.toContain('Exported.');
		expect(t).toContain('Could not load more.');
		expect(t).not.toContain('Loading more');
	});
});

describe('MapTitleActions', () => {
	const props = (over: Record<string, unknown> = {}) => ({
		edit: { editing: ref(false), canBuild: ref(true), param: ref(undefined), done: () => undefined, startEditing: () => undefined },
		mapExport: { exporting: ref(false), exportAs: () => undefined },
		canExport: true,
		...over,
	});

	it('offers Edit when a draft could be started, Done editing while one is open', async () => {
		expect(text(await render(MapTitleActions, props()))).toContain('Edit');
		const open = props();
		open.edit.editing.value = true;
		const t = text(await render(MapTitleActions, open));
		expect(t).toContain('Done editing');
		expect(t).not.toMatch(/\bEdit\b/);
	});

	it('does not offer Edit when building is not possible or the address already asks for it', async () => {
		const no = props();
		no.edit.canBuild.value = false;
		expect(text(await render(MapTitleActions, no))).not.toMatch(/\bEdit\b/);
		const asked = props();
		asked.edit.param.value = 'new' as never;
		expect(text(await render(MapTitleActions, asked))).not.toMatch(/\bEdit\b/);
	});

	it('always has Copy link', async () => {
		expect(text(await render(MapTitleActions, props()))).toContain('Copy link');
	});
});
