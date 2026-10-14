<script setup lang="ts">
import { useRouter } from 'vue-router';
import { go } from './goto';
import { openScan } from '../scan/scanState';
import { pingVisit } from '../usagePing';

// The things a researcher does every day, as buttons in the Home greeting (plus Scan a label). The other Explorer
// pages and the analysis tools are in the sidebar, so they are not repeated here. There is no tile
// for Ask the database (hidden for now, by decision on 2026-10-09) or for the Dashboards module
// (being retired).
// `key` is the action's usage target (core/extensions/d1-usage PAGE_KEYS): opening one counts for the
// Frequently used panel. The two forms are routes, which the router hook also sees (the ping filter
// sends one of the two); Print labels is a route too; Scan a label opens a dialog and is not pinged.
interface Action { key: string; label: string; sub: string; icon: string; to: string; }
const main: Action[] = [
	{ key: 'action:register-sample', label: 'Register a sample', sub: 'Add a new physical sample', icon: 'add_circle', to: '/content/physical_samples/+' },
	{ key: 'action:log-operation', label: 'Log an operation', sub: 'Record a manufacturing step', icon: 'precision_manufacturing', to: '/content/manufacturing_operations/+' },
	{ key: 'action:print-labels', label: 'Print labels', sub: 'Sample labels with QR codes', icon: 'label', to: '/home/labels' },
];
// Not a page: opens the camera dialog (hosted by ExplorerView).
const scan: Action = { key: 'action:scan', label: 'Scan a label', sub: 'Open a sample from its QR code', icon: 'qr_code_scanner', to: '' };
const tiles = [...main, scan];
const router = useRouter();
function choose(a: Action) {
	if (a === scan) return openScan();
	pingVisit('page', a.key);
	go(router, a.to);
}
</script>

<template>
	<nav class="actions" aria-label="Quick actions">
		<button v-for="a in tiles" :key="a.label" class="action" :title="a.sub" @click="choose(a)">
			<v-icon :name="a.icon" small />
			<span>{{ a.label }}</span>
		</button>
	</nav>
</template>

<style scoped>
/* Sits on the greeting's gradient: translucent white buttons, wrapping under the greeting on a narrow screen. */
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.action {
	display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px; cursor: pointer;
	font: inherit; font-size: var(--fs-md); font-weight: 650; white-space: nowrap; color: #fff;
	border: 1px solid rgba(255, 255, 255, 0.45); border-radius: 99px; background: rgba(255, 255, 255, 0.16);
	--v-icon-color: #fff;
	transition: background 0.12s ease, border-color 0.12s ease;
}
.action:hover { background: rgba(255, 255, 255, 0.3); border-color: rgba(255, 255, 255, 0.75); }
.action:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
</style>
