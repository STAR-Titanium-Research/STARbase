import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import DataThumb from './DataThumb.vue';
import HoverCard from './HoverCard.vue';
import MapRail from './MapRail.vue';
import WireTip from './WireTip.vue';
import { buildGraph } from './model/buildGraph';
import { connectionsOf } from './model/connections';
import { groupsOf, mkData, mkLineage, mkOp, mkSample } from './model/fixtures';
import { recordInfo, type RecordInfo } from './model/recordInfo';
import { MAP_VIEW, socketHandlers, type MapActions } from './nodes/actions';
import RecordNode from './nodes/RecordNode.vue';
import ContainerNode from './nodes/ContainerNode.vue';
import type { ContainerNode as ContainerData, ProcessData, RecordNode as RecordData } from './model/types';

vi.mock('@vue-flow/core', async (orig) => ({
  ...(await orig<typeof import('@vue-flow/core')>()),
  Handle: defineComponent({
    props: { id: String, type: String, position: String },
    setup: (p) => () => h('span', { class: 'sock', 'data-id': p.id }),
  }),
}));

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const VButton = defineComponent({ props: { to: String }, setup: (p, { slots }) => () => h(p.to ? 'a' : 'button', { class: 'v-button', href: p.to }, slots.default?.()) });

async function render(component: Component, props: Record<string, unknown>, provide?: (app: ReturnType<typeof createSSRApp>) => void): Promise<string> {
  const app = createSSRApp(component, props);
  app.component('v-icon', VIcon);
  app.component('v-button', VButton);
  provide?.(app);
  return renderToString(app);
}
/** The opening tag of the first button whose text is `label`. */
const buttonTag = (html: string, label: string): string =>
  [...html.matchAll(/<button[^>]*>.*?<\/button>/gs)].map((m) => m[0]).find((b) => text(b).trim() === label)?.match(/<button[^>]*>/)?.[0] ?? '';
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const DAY = '2026-09-01T09:00:00Z';
const data: ProcessData = mkData({
  samples: [mkSample('p', { code: 'S-1', form: 'round_bar', status: 'in_progress', facts: { Mass: '12 g', Diameter: '10 mm', Length: '40 mm' } }), mkSample('a', { code: 'S-1-A' })],
  operations: [mkOp({ id: 'o1', code: 'OP-1', methodName: 'Cut', category: 'machining', sampleId: 'p', outputSampleId: 'a', date: DAY, status: 'done' })],
  lineage: [mkLineage('p', 'a')],
});
const graph = buildGraph(data, groupsOf(data), { slots: () => [] });
const info = (id: string): RecordInfo => recordInfo(data, graph, id)!;
const op = graph.nodes.find((n): n is ContainerData => n.type === 'container')!;

const railProps = (over: Record<string, unknown> = {}) => ({
  info: info('s:p'),
  onMap: true,
  connections: connectionsOf(graph, 's:p'),
  presentKinds: ['equipment', 'settings'],
  hiddenKinds: new Set(['settings']),
  probable: true,
  reach: 2,
  ...over,
});

describe('MapRail', () => {
  it('shows the identity, facts, Open record to the record page, Expand and Centre', async () => {
    const html = await render(MapRail, railProps());
    expect(text(html)).toContain('S-1');
    expect(text(html)).toContain('Round bar');
    expect(text(html)).toContain('Mass');
    expect(html).toContain('href="/home/samples/p"');
    expect(text(html)).toContain('Open record');
    expect(text(html)).toContain('Expand');
    expect(text(html)).toContain('Centre');
  });

  it('offers Mark done only for a card that can be marked done (a planned operation or test)', async () => {
    expect(text(await render(MapRail, railProps()))).not.toContain('Mark done');
    expect(text(await render(MapRail, railProps({ canMarkDone: true })))).toContain('Mark done');
  });

  it('offers Back to planned only for a done card, and asks for it', async () => {
    expect(text(await render(MapRail, railProps()))).not.toContain('Back to planned');
    const html = await render(MapRail, railProps({ canMarkPlanned: true }));
    expect(text(html)).toContain('Back to planned');
  });

  it('draws the sample drawing for a sample, and none for a record with no form', async () => {
    expect(await render(MapRail, railProps())).toContain('d1-geometry');
    expect(await render(MapRail, railProps({ info: info(op.id) }))).not.toContain('d1-geometry');
  });

  describe('Process map of the selected record', () => {
    const as = (collection: string, id: string, code: string): RecordInfo => ({ ...info('s:p'), ref: { collection, id, code }, code });
    const label = 'Process map of ';

    it('is offered for a record whose collection opens a map, linking to its own focus', async () => {
      const html = await render(MapRail, railProps({ info: as('equipment', 'e1', 'Mill'), focus: { collection: 'physical_samples', id: 'p' } }));
      expect(text(html)).toContain(`${label}Mill`);
      expect(html).toContain('/map?focus=equipment:e1');
    });

    it('is offered for another sample or step than the focus', async () => {
      expect(text(await render(MapRail, railProps({ focus: { collection: 'physical_samples', id: 'other' } })))).toContain(`${label}S-1`);
    });

    it('with no code falls back to the kind word', async () => {
      const html = await render(MapRail, railProps({ info: as('equipment', 'e1', ''), focus: { collection: 'physical_samples', id: 'p' } }));
      expect(text(html)).toContain(`${label}Sample`);
    });

    it('is not offered when the record already is the focus', async () => {
      expect(text(await render(MapRail, railProps({ focus: { collection: 'physical_samples', id: 'p' } })))).not.toContain(label);
    });

    it('is not offered for people, files or a collection the map cannot open', async () => {
      for (const [collection, id] of [['people', 'x'], ['directus_users', 'u'], ['directus_files', 'f'], ['force_file', 'a/b.mat'], ['nope', 'n']]) {
        expect(text(await render(MapRail, railProps({ info: as(collection, id, 'X') })))).not.toContain(label);
      }
    });

    describe('a batch is not a record you can map', () => {
      const cuts = mkData({
        samples: [mkSample('p'), ...[0, 1, 2, 3].map((i) => mkSample(`c${i}`))],
        operations: [0, 1, 2, 3].map((i) =>
          mkOp({ id: `cut${i}`, code: `CUT-${i}`, sampleId: 'p', outputSampleId: `c${i}`, date: DAY, methodName: 'Sectioned', category: 'machining', equipmentId: 'eq1' }),
        ),
      });
      const batchInfo = (probable: boolean, extra: Partial<ProcessData> = {}): RecordInfo => {
        const d = { ...cuts, ...extra };
        const g = buildGraph(d, groupsOf(d, probable), { slots: () => [] });
        const node = g.nodes.find((n): n is ContainerData => n.type === 'container')!;
        return recordInfo(d, g, node.id)!;
      };

      it('is not offered for a probable batch (its title is no code)', async () => {
        const batch = batchInfo(true);
        expect(batch.code).toBe('Probable batch · Sectioned');
        expect(text(await render(MapRail, railProps({ info: batch })))).not.toContain(label);
      });

      it('is not offered for a recorded batch either', async () => {
        const recorded = batchInfo(false, { operations: cuts.operations.map((o) => ({ ...o, batchId: 'B1' })), batchCodes: { B1: 'B-0007' } });
        expect(recorded.code).toBe('B-0007');
        expect(text(await render(MapRail, railProps({ info: recorded })))).not.toContain(label);
      });

      it('is offered for a single-row container, by the operation\'s code', async () => {
        const html = await render(MapRail, railProps({ info: info(op.id), focus: { collection: 'physical_samples', id: 'p' } }));
        expect(text(html)).toContain(`${label}OP-1`);
        expect(html).toContain('/map?focus=manufacturing_operations:o1');
      });
    });

    it('the label cannot overflow the rail: it is clipped with an ellipsis and the whole text is the link\'s title', async () => {
      const html = await render(MapRail, railProps({ info: as('equipment', 'e1', 'A-very-long-machine-code-that-does-not-fit-the-rail'), focus: { collection: 'physical_samples', id: 'p' } }));
      expect(html).toMatch(/<a[^>]*class="[^"]*pm-maplink[^"]*"[^>]*title="Process map of A-very-long-machine-code-that-does-not-fit-the-rail"/);
      expect(html).toMatch(/<span class="pm-maplabel"[^>]*>Process map of A-very/);
    });
  });

  it('Open record of a kind with no record page falls back to the Data Studio form', async () => {
    const lot: RecordInfo = { ...info('s:p'), kind: 'equipment', ref: { collection: 'equipment', id: 'e1', code: 'Mill' }, code: 'Mill' };
    expect(await render(MapRail, railProps({ info: lot }))).toContain('href="/content/equipment/e1"');
  });

  it('Open record follows the own address of the record, and is not drawn when there is none (I4)', async () => {
    const force: RecordInfo = { ...info('s:p'), kind: 'data_file', ref: { collection: 'force_file', id: 'a/b.mat', code: 'b.mat' }, code: 'b.mat', open: '/d1-force-dashboard?operation=o1' };
    const html = await render(MapRail, railProps({ info: force }));
    expect(html).toContain('href="/d1-force-dashboard?operation=o1"');
    expect(html).not.toContain('/content/force_file');
    const none = await render(MapRail, railProps({ info: { ...force, open: null } }));
    expect(text(none)).not.toContain('Open record');
    expect(text(none)).toContain('Expand');
  });

  it('Expand and Centre are only offered for a card on the map', async () => {
    const html = await render(MapRail, railProps({ onMap: false }));
    expect(text(html)).not.toContain('Expand');
    expect(text(html)).not.toContain('Centre');
  });

  it('a draft card is not a record: no Open record, no Process map of it, no Expand (Centre stays)', async () => {
    const base = info('s:p');
    const draft: RecordInfo = { ...base, ref: { ...base.ref, id: 'draft:n1' } };
    const html = await render(MapRail, railProps({ info: draft, focus: { collection: 'physical_samples', id: 'other' } }));
    expect(text(html)).not.toContain('Open record');
    expect(text(html)).not.toContain('Process map of');
    expect(text(html)).not.toContain('Expand');
    expect(text(html)).toContain('Centre');
  });

  it('marks the Connections rows a hovered socket touches', async () => {
    const html = await render(MapRail, railProps({ highlight: new Set([op.id]) }));
    expect(buttonTag(html, 'OP-1 Cut')).toContain('class="hi conn"');
    expect(buttonTag(await render(MapRail, railProps()), 'OP-1 Cut')).toContain('class="conn"');
  });

  it('lists Connections by group', async () => {
    const html = await render(MapRail, railProps());
    expect(text(html)).toContain('Went on to');
    expect(text(html)).toContain('OP-1');
  });

  it('Show: a chip per kind present, Settings, Probable batches; hidden ones are not pressed', async () => {
    const html = await render(MapRail, railProps());
    expect(text(html)).toContain('Machine');
    expect(text(html)).toContain('Settings');
    expect(text(html)).toContain('Probable batches');
    expect(buttonTag(html, 'Settings')).toMatch(/aria-pressed="false"/);
    expect(buttonTag(html, 'Settings')).toMatch(/\boff\b/);
    expect(buttonTag(html, 'Machine')).toMatch(/aria-pressed="true"/);
    expect(buttonTag(html, 'Probable batches')).toMatch(/aria-pressed="true"/);
  });

  it('Reach: 1, 2, 3, Whole history with the current one checked', async () => {
    const html = await render(MapRail, railProps({ reach: 'all' }));
    expect(text(html)).toContain('Whole history');
    expect(buttonTag(html, 'Whole history')).toMatch(/aria-checked="true"/);
    expect(buttonTag(html, '2')).toMatch(/aria-checked="false"/);
  });

  it('Reach: when the card cap drew fewer steps than were asked for, the drawn ones are checked and the rail says so (M1)', async () => {
    const html = await render(MapRail, railProps({ reach: 'all', drawnReach: 2 }));
    expect(buttonTag(html, '2')).toMatch(/aria-checked="true"/);
    expect(buttonTag(html, 'Whole history')).toMatch(/aria-checked="false"/);
    expect(text(html)).toContain('Showing 2 steps');
    expect(text(html)).toContain('whole history');
    expect(text(html)).toContain('300 cards');
    const one = text(await render(MapRail, railProps({ reach: 3, drawnReach: 1 })));
    expect(one).toContain('Showing 1 step');
    expect(one).toContain('3 steps');
    // nothing clamped: no note, the asked-for one is checked
    const plain = await render(MapRail, railProps({ reach: 3, drawnReach: 3 }));
    expect(text(plain)).not.toContain('Showing');
    expect(buttonTag(plain, '3')).toMatch(/aria-checked="true"/);
  });

  it('says so when nothing is selected', async () => {
    expect(text(await render(MapRail, railProps({ info: null, connections: {} })))).toContain('Select a record on the map');
  });
});

describe('HoverCard', () => {
  const target = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }) } as unknown as HTMLElement;

  it('is the rail identity block with facts, counts and a hint, and is hidden from assistive tech', async () => {
    const html = await render(HoverCard, { info: info('s:p'), target, canvas: target });
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/tabindex/);
    expect(text(html)).toContain('S-1');
    expect(text(html)).toContain('Mass');
    expect(text(html)).toMatch(/1 operations/);
    expect(text(html)).toContain('Click to select');
    expect(html).toContain('d1-geometry');
  });

  it('shows the data thumbnail when the operation has data', async () => {
    const html = await render(HoverCard, { info: info(op.id), preview: { kind: 'force', imageFileId: 'f1', plotterPath: '/d1-force-dashboard?operation=o1' }, target, canvas: target });
    expect(html).toMatch(/\/assets\/f1\?/);
    expect(text(html)).toContain('Force data');
  });

  it('has no data block for a record without data', async () => {
    const html = await render(HoverCard, { info: info(op.id), preview: { kind: 'none', plotterPath: '' }, target, canvas: target });
    expect(html).not.toContain('dthumb');
  });
});

describe('HoverCard, a material', () => {
  const target = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }) } as unknown as HTMLElement;
  const mdata = mkData({ samples: [mkSample('p', { materialRef: { collection: 'materials', id: 'm1', code: 'AA', label: 'Ti-6Al-4V Grade 5' } })] });
  const mgraph = buildGraph(mdata, groupsOf(mdata), { slots: () => [] });
  const minfo = recordInfo(mdata, mgraph, 'm:p')!;
  const elements = [{ symbol: 'Ti', weight_percent: 89.5 }, { symbol: 'Al', weight_percent: 6 }, { symbol: 'V', weight_percent: 4 }];

  it('with elements: the full name, the nominal composition as a list and the composition bar', async () => {
    for (const component of [HoverCard, MapRail]) {
      const html = await render(component, component === HoverCard ? { info: minfo, composition: elements, target, canvas: target } : railProps({ info: minfo, connections: {}, composition: elements }));
      expect(text(html)).toContain('Ti-6Al-4V Grade 5');
      expect(text(html)).toMatch(/nominal/i);
      expect(html).toContain('d1-composition');
      expect(html).toContain('role="img"');
      expect(text(html)).toMatch(/Ti(?:\s|&nbsp;)+89\.5 wt%/);
      expect(text(html)).toMatch(/Al(?:\s|&nbsp;)+6\.0 wt%/);
    }
  });

  it('without a composition (none yet, none recorded, or refused): the name only, no plot', async () => {
    for (const composition of [undefined, null, []]) {
      const html = await render(HoverCard, { info: minfo, composition, target, canvas: target });
      expect(text(html)).toContain('Ti-6Al-4V Grade 5');
      expect(html).not.toContain('d1-composition');
      expect(text(html)).not.toMatch(/nominal/i);
    }
  });

  it('elements with no weight are named in a caption under the bar, not drawn in it', async () => {
    const html = await render(HoverCard, { info: minfo, composition: [...elements, { symbol: 'Si', weight_percent: null }, { symbol: 'Mn' }], target, canvas: target });
    expect(html).toContain('d1-composition');
    expect(text(html)).toContain('Also: Si, Mn (no wt%)');
    const all = await render(HoverCard, { info: minfo, composition: elements, target, canvas: target });
    expect(text(all)).not.toContain('Also:');
  });

  it('a record that is not a material shows no composition, whatever it is given', async () => {
    const html = await render(HoverCard, { info: info('s:p'), composition: elements, target, canvas: target });
    expect(html).not.toContain('d1-composition');
  });
});

describe('DataThumb', () => {
  it('a force figure is a small asset image, never a data file', async () => {
    const html = await render(DataThumb, { preview: { kind: 'force', imageFileId: 'fz1', plotterPath: '/d1-force-dashboard?operation=o1' }, link: true });
    const src = /src="([^"]+)"/.exec(html)![1];
    expect(src).toMatch(/\/assets\/fz1\?/);
    expect(src).toMatch(/format=webp/);
    expect(text(html)).toContain('Open in Force dashboard');
  });

  it('FAST run data has words and a plotter link, no image', async () => {
    const html = await render(DataThumb, { preview: { kind: 'fast', plotterPath: '/d1-fast-dashboard?operation=o1' }, link: true });
    expect(html).not.toContain('<img');
    expect(text(html)).toContain('FAST run data');
    expect(text(html)).toContain('Open in FAST plotter');
  });

  it('Conform run data has its words, a plotter link and the window trace as a small drawing', async () => {
    const thumb = {
      startMs: 0,
      endMs: 60000,
      series: [
        { key: 'wheel_speed_rpm', label: 'Wheel speed', unit: 'rpm', min: 0, max: 5, values: [0, 2.5, null, 5] },
        { key: 'tooling1_c', label: 'Tooling 1', unit: '°C', min: 100, max: 200, values: [100, 150, 200] },
      ],
    };
    const html = await render(DataThumb, { preview: { kind: 'conform', plotterPath: '/d1-conform-dashboard?operation=o1', thumb }, link: true });
    expect(text(html)).toContain('Conform run data');
    expect(text(html)).toContain('Open in Conform plotter');
    expect(html).not.toContain('<img');
    expect(html).toContain('aria-label="Conform run window: Wheel speed and Tooling 1"');
    // the gap breaks the speed line into two pieces; Tooling 1 is one line
    expect(html.match(/<polyline/g)).toHaveLength(3);
  });

  it('Conform run data without a trace (no window yet, or a log this person cannot read) is the words and the link only', async () => {
    const html = await render(DataThumb, { preview: { kind: 'conform', plotterPath: '/d1-conform-dashboard?operation=o1' }, link: true });
    expect(text(html)).toContain('Conform run data');
    expect(html).not.toContain('<svg');
  });

  it('draws nothing for none, or while the answer is still on its way', async () => {
    expect(await render(DataThumb, { preview: { kind: 'none', plotterPath: '' } })).not.toContain('dthumb');
    expect(await render(DataThumb, {})).not.toContain('dthumb');
  });
});

describe('WireTip', () => {
  it('lists its lines and shows only when there are some', async () => {
    const on = await render(WireTip, { lines: ['S-1 · Sample', 'from OP-1'], canvas: null, hint: 'Ctrl/⌘+click to go to OP-1' });
    expect(on).toMatch(/class="wire-tip show"/);
    expect(text(on)).toContain('S-1 · Sample');
    expect(text(on)).toContain('Ctrl/⌘+click to go to OP-1');
    expect(await render(WireTip, { lines: null, canvas: null })).not.toMatch(/wire-tip show/);
  });
});

describe('hidden records (D21)', () => {
  const view = (hiddenSides: Map<string, Set<'in' | 'out'>>) => (app: ReturnType<typeof createSSRApp>) => {
    app.provide(MAP_VIEW, { direction: ref<'RIGHT' | 'DOWN'>('RIGHT'), moreOpen: ref(new Set<string>()), selectedRef: ref(null), hiddenSides: ref(hiddenSides) });
  };
  const root = graph.nodes.find((n): n is RecordData => n.type === 'record' && n.id === 's:p')!;

  it('a card with no socket on that side still shows the "some records hidden" pill', async () => {
    expect(root.ins).toEqual([]); // a root sample: nothing comes in
    const html = await render(RecordNode, { id: root.id, data: root }, view(new Map([[root.id, new Set(['in' as const])]])));
    expect(html).toMatch(/class="hid[^"]*\bin\b[^"]*"/);
    expect(text(html)).toContain('some records hidden');
  });

  it('a container carries it too, on the side it names; a node with no marker has none', async () => {
    const html = await render(ContainerNode, { id: op.id, data: op }, view(new Map([[op.id, new Set(['out' as const])]])));
    expect(html).toMatch(/class="hid[^"]*\bout\b[^"]*"/);
    expect(await render(RecordNode, { id: root.id, data: root }, view(new Map()))).not.toContain('some records hidden');
  });
});

describe('socket hover', () => {
  it('a socket reports itself on enter and leaves on leave', () => {
    const calls: unknown[][] = [];
    const a = { hover: (...x: unknown[]) => calls.push(x) } as unknown as MapActions;
    const on = socketHandlers(a, () => 's:p:out:0');
    const el = {} as HTMLElement;
    on.enter({ currentTarget: el });
    on.leave();
    expect(calls).toEqual([['s:p:out:0', el], [null]]);
  });
});
