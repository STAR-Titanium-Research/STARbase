<script setup lang="ts">
import { useRouter } from 'vue-router';
import { go } from './goto';

// The things a researcher does every day, as big buttons; everything else stays one click away in
// the "More" row, so no page that used to be on Home becomes unreachable.
interface Action { label: string; sub: string; icon: string; to: string; }
const main: Action[] = [
	{ label: 'Register a sample', sub: 'Add a new physical sample', icon: 'add_circle', to: '/content/physical_samples/+' },
	{ label: 'Log an operation', sub: 'Record a manufacturing step', icon: 'precision_manufacturing', to: '/content/manufacturing_operations/+' },
	{ label: 'Ask the database', sub: 'Chat with your data', icon: 'chat', to: '/ask-db' },
	{ label: 'Print labels', sub: 'Sample labels with QR codes', icon: 'label', to: '/d1-report/labels' },
	{ label: 'Dashboards', sub: 'Explore trends & graphs', icon: 'analytics', to: '/d1-lab-dashboard' },
];
const more: Action[] = [
	{ label: 'Projects', sub: 'All projects you can see', icon: 'folder_open', to: '/home/projects' },
	{ label: 'People', sub: 'Researchers & operators', icon: 'groups', to: '/home/people' },
	{ label: 'Force Analysis', sub: 'Machining force & FRM plots', icon: 'insights', to: '/d1-force-dashboard' },
	{ label: 'FAST Analysis', sub: 'Sintering traces & plots', icon: 'whatshot', to: '/d1-fast-dashboard' },
	{ label: 'Force Crawler', sub: '.mat processing queue', icon: 'dns', to: '/d1-force-crawler' },
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
		<div class="more" role="group" aria-label="More">
			<span class="more-label">More</span>
			<button v-for="a in more" :key="a.label" class="more-btn" :title="a.sub" @click="go(router, a.to)">
				<v-icon :name="a.icon" x-small />{{ a.label }}
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
.card:hover { border-color: var(--theme--primary); }
.action { display: flex; align-items: center; gap: 12px; padding: 10px 14px; }
.chip {
	width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto; display: grid; place-items: center;
	background: var(--d1-tint);
	--v-icon-color: var(--theme--primary);
}
.a-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.a-label { font-size: var(--fs-md); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.a-sub { font-size: var(--fs-sm); color: var(--d1-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.more { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.more-label { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim); margin-right: 4px; }
/* The force app's chip: 26px, a pill, the accent on hover. */
.more-btn {
	display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px;
	font: inherit; font-size: var(--fs-sm); font-weight: 600; line-height: 1;
	border-radius: 99px; cursor: pointer; color: var(--theme--foreground);
	border: 1px solid var(--d1-line); background: var(--d1-surface);
	transition: border-color 0.12s ease;
}
.more-btn:hover { border-color: var(--theme--primary); }
</style>
