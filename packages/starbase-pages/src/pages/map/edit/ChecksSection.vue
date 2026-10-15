<script setup lang="ts">
import { computed } from 'vue';
import { Section } from '@d1/ui';
import type { Check } from '@d1/ui';
import { groupChecks } from './checkGroups';

// The rail's Checks section (spec E5, §7.1): what is missing before Create, grouped by card, blocking first (red), then
// warnings. Each entry is a button that selects its card (`select(key)`), so the person lands on what to fix. `labelFor`
// turns a draft key into the card's name ("S-1", "Machining"); the page owns it. Nothing missing is a calm one-liner.
const props = defineProps<{
	checks: Check[];
	labelFor: (key: string) => string;
}>();
const emit = defineEmits<{ select: [key: string] }>();

const groups = computed(() => groupChecks(props.checks));
const blocking = computed(() => props.checks.filter((c) => c.level === 'block').length);
const warnings = computed(() => props.checks.length - blocking.value);
const empty = computed(() => props.checks.length === 0);
const summary = computed(() => {
	const parts: string[] = [];
	if (blocking.value) parts.push(`${blocking.value} ${blocking.value === 1 ? 'thing' : 'things'} missing`);
	if (warnings.value) parts.push(`${warnings.value} ${warnings.value === 1 ? 'warning' : 'warnings'}`);
	return parts.join(', ');
});
// What a screen reader is told when the checks change: one always-mounted region whose text is swapped (a live region that appears
// together with its text is often not announced), so fixing the last blocking check says "Nothing missing".
const announcement = computed(() => summary.value || 'Nothing missing');
</script>

<template>
	<div class="pm-checks-wrap">
	<p class="vh" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</p>
	<Section title="Checks" :count="checks.length" :empty="empty" empty-text="Nothing missing" class="pm-checks">
		<p class="sum" :class="{ bad: blocking > 0 }">{{ summary }}</p>
		<div v-for="g in groups" :key="g.key" class="card" :data-card="g.key">
			<div class="who" :class="{ bad: g.blocking > 0 }">{{ labelFor(g.key) }}</div>
			<ul>
				<li v-for="(c, i) in g.checks" :key="i">
					<button type="button" class="chk" :class="c.level" :data-level="c.level" @click="emit('select', c.key)">
						<span class="mark" aria-hidden="true">{{ c.level === 'block' ? '!' : '·' }}</span>
						<span class="t"><span class="vh">{{ c.level === 'block' ? 'Missing: ' : 'Warning: ' }}</span>{{ c.text }}</span>
					</button>
				</li>
			</ul>
		</div>
	</Section>
	</div>
</template>

<style scoped>
.pm-checks-wrap { position: relative; min-width: 0; }
.sum { margin: 0 0 8px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.sum.bad { color: var(--d1-bad); font-weight: 650; }
.card + .card { margin-top: 10px; }
.who { margin-bottom: 2px; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); overflow-wrap: anywhere; }
.who.bad { color: var(--d1-bad); }
ul { margin: 0; padding: 0; list-style: none; }
.chk {
	display: flex; align-items: baseline; gap: 8px; width: calc(100% + 16px); margin: 0 -8px; padding: 5px 8px;
	border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; font-size: var(--fs-sm, 12px); text-align: left; cursor: pointer;
}
.chk:hover, .chk:focus-visible { background: var(--d1-tile); }
.chk:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.mark { flex: none; width: 14px; text-align: center; font-weight: 800; }
.chk.block .mark, .chk.block .t { color: var(--d1-bad); }
.chk.warn .mark { color: var(--d1-warn); }
.t { min-width: 0; overflow-wrap: anywhere; }
.vh { position: absolute; width: 1px; margin: 0; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
