<script setup lang="ts">
import { computed } from 'vue';
import type { FoundFile } from './inboxApi';
import { factsDiff } from './factsDiff';

// The facts of the two compared files under the stage (spec 2026-10-20-inbox-file-viewer-design.md decision 5): one row per fact, the label and the two values;
// a row whose values differ is tinted in the warning tone, so what changed between the two images stands out. Plain text, read from what the crawler stored.
const props = defineProps<{ a: FoundFile; b: FoundFile }>();
const rows = computed(() => factsDiff(props.a, props.b));
const differing = computed(() => rows.value.filter((r) => r.differs).length);
</script>

<template>
	<section class="diff" aria-label="What differs between the two files" data-test="facts-diff">
		<table v-if="rows.length">
			<caption class="cap">{{ differing ? `${differing} of ${rows.length} facts differ` : 'The facts are the same' }}</caption>
			<thead>
				<tr><th scope="col">Fact</th><th scope="col">A</th><th scope="col">B</th></tr>
			</thead>
			<tbody>
				<tr v-for="r in rows" :key="r.key" :class="{ differs: r.differs }" :data-row="r.key" :data-differs="r.differs ? 'true' : 'false'">
					<th scope="row">{{ r.label }}</th>
					<td data-col="a">{{ r.a ?? '—' }}</td>
					<td data-col="b">{{ r.b ?? '—' }}</td>
				</tr>
			</tbody>
		</table>
		<p v-else class="none" data-test="diff-none">Neither file has facts the crawler could read.</p>
	</section>
</template>

<style scoped>
.diff { min-width: 0; overflow-x: auto; border: 1px solid var(--d1-line); border-radius: var(--d1-radius, 12px); background: var(--d1-surface, var(--theme--background)); box-shadow: var(--d1-shadow); }
table { width: 100%; border-collapse: collapse; font-size: var(--fs-md, 13px); }
.cap { padding: 8px 12px; text-align: left; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
th, td { padding: 6px 12px; text-align: left; vertical-align: top; border-top: 1px solid var(--d1-line); overflow-wrap: anywhere; }
thead th { font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); background: var(--d1-tile); }
tbody th { width: 28%; font-weight: 600; color: var(--d1-dim); }
td { font-variant-numeric: tabular-nums; }
tr.differs th, tr.differs td { background: color-mix(in srgb, var(--d1-warn) 14%, transparent); }
tr.differs td { color: var(--theme--foreground); font-weight: 650; }
.none { margin: 0; padding: 10px 12px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
</style>
