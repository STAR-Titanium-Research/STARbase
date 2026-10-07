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
	{ label: 'Projects', sub: 'All projects', icon: 'folder_open', to: '/home/projects' },
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
				<span class="chip"><v-icon :name="a.icon" /></span>
				<span class="a-text">
					<span class="a-label">{{ a.label }}</span>
					<span class="a-sub">{{ a.sub }}</span>
				</span>
				<v-icon name="arrow_forward" class="a-go" />
			</button>
		</div>
		<div class="more" role="group" aria-label="More">
			<span class="more-label">More</span>
			<button v-for="a in more" :key="a.label" class="more-btn" :title="a.sub" @click="go(router, a.to)">
				<v-icon :name="a.icon" small />{{ a.label }}
			</button>
		</div>
	</section>
</template>

<style scoped>
.grid { display: grid; gap: 14px; }
.actions { grid-template-columns: repeat(auto-fit, minmax(188px, 1fr)); }
.card {
	border: 1px solid var(--theme--border-color-subdued);
	background: var(--theme--background);
	border-radius: 16px;
	cursor: pointer;
	text-align: left;
	transition: transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease;
	font: inherit;
	color: var(--theme--foreground);
}
.card:hover { transform: translateY(-3px); box-shadow: 0 14px 28px -16px rgba(15, 23, 42, 0.35); border-color: var(--theme--primary); }
.action { display: flex; align-items: center; gap: 14px; padding: 16px 18px; }
.chip {
	width: 42px; height: 42px; border-radius: 12px; flex: 0 0 auto; display: grid; place-items: center;
	background: var(--theme--primary-background);
}
.chip :deep(.v-icon) { --v-icon-color: var(--theme--primary); }
.a-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.a-label { font-size: 15px; font-weight: 650; }
.a-sub { font-size: 12.5px; color: var(--theme--foreground-subdued); margin-top: 1px; }
.a-go { --v-icon-color: var(--theme--foreground-subdued); }
.more { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.more-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; color: var(--theme--foreground-subdued); margin-right: 4px; }
.more-btn {
	display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 13px; font-weight: 600;
	padding: 5px 12px; border-radius: 99px; cursor: pointer; color: var(--theme--foreground);
	border: 1px solid var(--theme--border-color-subdued); background: var(--theme--background);
}
.more-btn:hover { border-color: var(--theme--primary); color: var(--theme--primary); }
</style>
