<script setup lang="ts">
import { useRouter } from 'vue-router';
import { go } from './goto';

// The things a researcher does every day, as big buttons. The other Explorer pages and the analysis
// tools are in the sidebar, so they are not repeated here. There is no tile for Ask the database
// (hidden for now, by decision on 2026-10-09) or for the Dashboards module (being retired; its lineage graph is to be rebuilt).
interface Action { label: string; sub: string; icon: string; to: string; }
const main: Action[] = [
	{ label: 'Register a sample', sub: 'Add a new physical sample', icon: 'add_circle', to: '/content/physical_samples/+' },
	{ label: 'Log an operation', sub: 'Record a manufacturing step', icon: 'precision_manufacturing', to: '/content/manufacturing_operations/+' },
	{ label: 'Print labels', sub: 'Sample labels with QR codes', icon: 'label', to: '/home/labels' },
];
const router = useRouter();
</script>

<template>
	<section aria-label="Quick actions">
		<div class="grid actions">
			<button v-for="a in main" :key="a.label" class="card action" @click="go(router, a.to)">
				<span class="chip"><v-icon :name="a.icon" small /></span>
				<span class="a-text">
					<span class="a-label">{{ a.label }}</span>
					<span class="a-sub">{{ a.sub }}</span>
				</span>
			</button>
		</div>
	</section>
</template>

<style scoped>
/* 220px is the narrowest a card can be with its label on one line; below that the grid drops a
   column instead of breaking "Register a sample" over three lines. */
.grid { display: grid; gap: 10px; }
.actions { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.card {
	border: 1px solid var(--d1-line);
	background: var(--d1-surface);
	border-radius: var(--d1-radius);
	box-shadow: var(--d1-shadow);
	cursor: pointer;
	text-align: left;
	transition: border-color 0.12s ease;
	font: inherit;
	color: var(--theme--foreground);
}
.card:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.action { display: flex; align-items: center; gap: 12px; padding: 10px 14px; }
.chip {
	width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto; display: grid; place-items: center;
	background: var(--d1-tint);
	--v-icon-color: var(--d1-accent, var(--theme--primary));
}
.a-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.a-label { font-size: var(--fs-md); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.a-sub { font-size: var(--fs-sm); color: var(--d1-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
