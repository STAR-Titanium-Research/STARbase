<script setup lang="ts">
import { computed } from 'vue';
import { recordRoute } from '../recordRoute';
import { TEST_GLYPH, statusStyle } from '../status';
import RecordLink from '../components/RecordLink.vue';
import type { Matrix, MatrixCell } from './matrix';

// The sample x step matrix of a campaign (see matrix.ts). The sample column is pinned and the grid
// scrolls both ways, so 50+ samples and many steps stay readable. A cell is a link to the operation
// or test it stands for; its tooltip gives the state and any error text.
const props = defineProps<{ matrix: Matrix; forceHidden?: boolean }>();

interface CellView { tone: string; glyph: string; diagTone: string | null; title: string }

const GLYPH: Record<string, string> = { done: '✓', skipped: '–', error: '!', processing: '…', pending: '◷', none: '·' };

function describe(cell: MatrixCell, sampleCode: string | null, columnLabel: string): CellView {
	if (cell.kind === 'test') {
		const st = statusStyle('test', cell.status);
		return {
			tone: st?.tone ?? 'neutral',
			glyph: TEST_GLYPH[cell.status] ?? '·',
			diagTone: null,
			title: `${sampleCode ?? 'Sample'} · ${cell.name}: ${st?.label ?? cell.status}${cell.count > 1 ? ` (worst of ${cell.count})` : ''}`,
		};
	}
	const st = cell.status === 'none' ? null : statusStyle('force', cell.status);
	const diag = cell.diag === 'none' ? null : statusStyle('diag', cell.diag);
	const lines = [`${sampleCode ?? 'Sample'} · ${cell.name}${cell.count > 1 ? ` (+${cell.count - 1} more)` : ''}`];
	lines.push(props.forceHidden ? 'Force analysis: not visible to your role' : `Force analysis: ${st?.label ?? 'no force file'}`);
	if (cell.error) lines.push(`Error: ${cell.error}`);
	if (diag) lines.push(diag.label);
	if (cell.diagError) lines.push(`Diagnostics error: ${cell.diagError}`);
	return {
		tone: st?.tone ?? 'none',
		glyph: GLYPH[cell.status] ?? '·',
		diagTone: diag ? diag.tone : null,
		title: lines.join('\n'),
	};
}

// Computed once per matrix, not per render of every cell.
const views = computed(() =>
	props.matrix.rows.map((row) =>
		props.matrix.columns.map((col) => {
			const cell = row.cells[col.key];
			return cell ? { cell, view: describe(cell, row.sample_code, col.label) } : null;
		}),
	),
);

const LEGEND = [
	{ tone: 'success', glyph: '✓', text: 'Analysed / test processed' },
	{ tone: 'info', glyph: '◷', text: 'Queued' },
	{ tone: 'progress', glyph: '…', text: 'Processing' },
	{ tone: 'danger', glyph: '!', text: 'Error / test failed' },
	{ tone: 'neutral', glyph: '–', text: 'Skipped / test registered' },
	{ tone: 'none', glyph: '·', text: 'Operation without a force file' },
];
</script>

<template>
	<div class="d1-matrix">
		<p v-if="forceHidden" class="note">Force-analysis state is not visible to your role, so operations show no state.</p>
		<p v-if="matrix.unplaced.operations || matrix.unplaced.tests" class="note">
			{{ matrix.unplaced.operations }} operation(s) and {{ matrix.unplaced.tests }} test(s) belong to samples you cannot see, so they have no row.
		</p>
		<div class="scroll">
			<table>
				<thead>
					<tr>
						<th class="corner">Sample</th>
						<th v-for="col in matrix.columns" :key="col.key" :class="['col', col.kind]" :title="`${col.label} ${col.sub}`.trim()">
							<span class="label">{{ col.label }}</span>
							<span class="sub">{{ col.sub }}</span>
						</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="(row, r) in matrix.rows" :key="row.sample_id">
						<th class="sample">
							<RecordLink collection="physical_samples" :id="row.sample_id">{{ row.sample_code || '—' }}</RecordLink>
							<v-icon v-if="row.notInCampaign" name="link_off" x-small class="off" title="Has an operation or test in this campaign but is not in its sample list" />
						</th>
						<td v-for="(entry, c) in views[r]" :key="matrix.columns[c].key">
							<router-link
								v-if="entry"
								:to="recordRoute(entry.cell.collection, entry.cell.id)"
								:class="['cell', `tone--${entry.view.tone}`]"
								:title="entry.view.title"
								:aria-label="entry.view.title"
							>
								{{ entry.view.glyph }}
								<span v-if="entry.cell.count > 1" class="count">{{ entry.cell.count }}</span>
								<span v-if="entry.view.diagTone" :class="['diag', `tone--${entry.view.diagTone}`]" />
							</router-link>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<ul class="legend" aria-label="Legend">
			<li v-for="l in LEGEND" :key="l.text"><span :class="['cell', 'swatch', `tone--${l.tone}`]">{{ l.glyph }}</span>{{ l.text }}</li>
			<li><span class="cell swatch tone--success">✓<span class="diag tone--success" /></span>Corner dot: diagnostics (green built, blue queued, amber building, red error)</li>
			<li><v-icon name="link_off" x-small />Sample not in the campaign's sample list</li>
		</ul>
	</div>
</template>

<style scoped>
.note { margin: 0 0 8px; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.scroll {
	overflow: auto;
	max-height: 70vh;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: 10px;
}
table { border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
th, td { padding: 4px 6px; border-bottom: 1px solid var(--theme--border-color-subdued); background: var(--theme--background); }
thead th { position: sticky; top: 0; z-index: 2; text-align: center; vertical-align: bottom; min-width: 56px; max-width: 110px; }
.col .label { display: block; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col .sub { display: block; font-size: 10.5px; font-weight: 500; color: var(--theme--foreground-subdued); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col.test { border-left: 2px solid var(--theme--border-color); }
.corner, .sample { position: sticky; left: 0; background: var(--theme--background); border-right: 1px solid var(--theme--border-color); text-align: left; white-space: nowrap; }
.corner { z-index: 3; }
.sample { z-index: 1; font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 600; }
.off { margin-left: 4px; color: var(--theme--warning); vertical-align: middle; }
td { text-align: center; }
tbody tr:hover td, tbody tr:hover th.sample { background: var(--theme--background-subdued); }

.cell {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 2px;
	width: 34px;
	height: 26px;
	border-radius: 6px;
	font-weight: 700;
	font-size: 13px;
	text-decoration: none;
	color: var(--d1-fg);
	background: var(--d1-bg);
	border: 1px solid transparent;
}
a.cell:hover { border-color: var(--theme--foreground-subdued); }
a.cell:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 1px; }
.count { font-size: 10px; font-weight: 700; }
.diag { position: absolute; top: 2px; right: 2px; width: 7px; height: 7px; border-radius: 50%; background: var(--d1-fg); box-shadow: 0 0 0 1.5px var(--theme--background); }

.tone--success { --d1-fg: var(--theme--success); --d1-bg: var(--theme--success-background); }
.tone--info { --d1-fg: var(--theme--primary); --d1-bg: var(--theme--primary-background); }
.tone--progress, .tone--warning { --d1-fg: var(--theme--warning); --d1-bg: var(--theme--warning-background); }
.tone--danger { --d1-fg: var(--theme--danger); --d1-bg: var(--theme--danger-background); }
.tone--neutral { --d1-fg: var(--theme--foreground-subdued); --d1-bg: var(--theme--background-normal); }
.cell.tone--none { --d1-fg: var(--theme--foreground-subdued); --d1-bg: transparent; border-color: var(--theme--border-color); border-style: dashed; }

.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; list-style: none; margin: 10px 0 0; padding: 0; font-size: 12px; color: var(--theme--foreground-subdued); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 24px; height: 20px; font-size: 11px; }
</style>
