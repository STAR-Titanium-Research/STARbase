<script setup lang="ts">
// App settings with sub-tabs for things that don't need surfacing on the working pages.
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import GeneralSettings from './GeneralSettings.vue';
import RecordingSettings from './RecordingSettings.vue';
import AlarmsSettings from './AlarmsSettings.vue';
import ConnectivitySettings from './ConnectivitySettings.vue';
import BackupSettings from './BackupSettings.vue';
import LogsSettings from './LogsSettings.vue';
import CapturesSettings from './CapturesSettings.vue';
import ReportBugSettings from './ReportBugSettings.vue';
import AboutSettings from './AboutSettings.vue';

const tabs = [
	{ id: 'general', label: 'General', icon: 'tune' },
	{ id: 'recording', label: 'Recording', icon: 'fiber_manual_record' },
	{ id: 'alarms', label: 'Safety Alarms', icon: 'warning' },
	{ id: 'connectivity', label: 'Connectivity', icon: 'network_check' },
	{ id: 'backup', label: 'Live Backup', icon: 'cloud_upload' },
	{ id: 'captures', label: 'Local Captures', icon: 'folder' },
	{ id: 'logs', label: 'Logs', icon: 'receipt_long' },
	{ id: 'report-bug', label: 'Report a Bug', icon: 'bug_report' },
	{ id: 'about', label: 'About', icon: 'info' },
];
const VALID_TABS = ['general', 'recording', 'alarms', 'connectivity', 'backup', 'captures', 'logs', 'report-bug', 'about'] as const;
type SettingsTab = (typeof VALID_TABS)[number];

const route = useRoute();
const requestedTab = route.query.tab as string | undefined;
const initialTab: SettingsTab = VALID_TABS.includes(requestedTab as SettingsTab)
	? (requestedTab as SettingsTab)
	: 'general';
const active = ref<SettingsTab>(initialTab);
// A link to another tab (e.g. the Connectivity doctor's "Open Local Captures") navigates to this
// same page with a new ?tab=, which doesn't remount it — follow the query.
watch(() => route.query.tab, (t) => {
	if (VALID_TABS.includes(t as SettingsTab)) active.value = t as SettingsTab;
});
// A tab click writes ?tab= back so the URL (and a later ?focus= link) names the tab on screen.
const router = useRouter();
function selectTab(t: SettingsTab) {
	active.value = t;
	if (route.query.tab !== t) void router.replace({ query: { ...route.query, tab: t } });
}

// The pane scrolls itself (#30): the page is a fixed-height column, so a banner above it can't
// push the document into overflow. A new tab starts at its top -- the previous tab's offset means
// nothing in a different form, and the browser clamping it was the jump the issue describes.
const scrollEl = ref<HTMLElement | null>(null);
watch(active, () => { if (scrollEl.value) scrollEl.value.scrollTop = 0; });
</script>

<template>
	<div class="settings">
		<header class="head"><h1>Settings</h1></header>
		<div ref="scrollEl" class="settings-scroll">
			<div class="body" :class="{ wide: active === 'logs' }">
				<nav class="subtabs">
					<button v-for="t in tabs" :key="t.id" class="subtab" :class="{ on: active === t.id }" @click="selectTab(t.id as SettingsTab)">
						<span class="material-symbols-rounded">{{ t.icon }}</span>{{ t.label }}
					</button>
				</nav>
				<section class="pane">
					<!-- Only General is cached: its "Recording storage" panel re-fetches the drive list on
					     mount, so switching tabs away and back used to show a loading flash every time
					     (#18). The other tabs remount on every switch same as before — most are cheap, and
					     Logs specifically relies on that unmount to stop its poll interval. -->
					<keep-alive include="GeneralSettings">
						<GeneralSettings v-if="active === 'general'" />
					</keep-alive>
					<RecordingSettings v-if="active === 'recording'" />
					<AlarmsSettings v-if="active === 'alarms'" />
					<ConnectivitySettings v-if="active === 'connectivity'" />
					<BackupSettings v-if="active === 'backup'" />
					<CapturesSettings v-if="active === 'captures'" />
					<LogsSettings v-if="active === 'logs'" />
					<ReportBugSettings v-if="active === 'report-bug'" />
					<AboutSettings v-if="active === 'about'" />
				</section>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* A fixed-height column (#30): AppShell gives this route exactly the space under any banner
   (.content.fill), the header stays put and only .settings-scroll scrolls. The old
   min-height: 100vh sat beside the in-flow banners, so every tab overflowed by the banner's height
   and the document scrolled -- clamping, i.e. jumping, on every switch to a shorter tab. */
.settings { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg)); }
.head { flex-shrink: 0; padding: 20px 26px 12px; border-bottom: 1px solid var(--border); }
.head h1 { margin: 0; font-size: var(--fs-2xl); letter-spacing: -0.01em; }
/* Full width, so its scrollbar sits at the window edge like a page's would. The gutter is reserved
   either way, so a tab that overflows doesn't shift sideways against one that doesn't. */
.settings-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
/* Form-shaped panes read better narrow; the log viewer needs the width, so the cap is
   lifted for that tab only. */
.body { display: flex; gap: 24px; padding: 22px 26px; max-width: 1000px; }
.body.wide { max-width: 1500px; }
/* Sticky, so the tab list stays in reach however far down a long tab is scrolled. */
.subtabs { display: flex; flex-direction: column; gap: 4px; width: 190px; flex-shrink: 0; position: sticky; top: 12px; align-self: flex-start; }
.subtab { display: flex; align-items: center; gap: 9px; padding: 10px 12px; font-size: var(--fs-md); color: var(--text-dim); background: transparent; border: 1px solid transparent; border-radius: 9px; cursor: pointer; text-align: left; }
.subtab .material-symbols-rounded { font-size: var(--icon-md); }
.subtab:hover { background: var(--surface); color: var(--text); }
.subtab.on { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 28%, transparent); }
.pane { flex: 1; min-width: 0; }

/* Below this, the fixed 190px sidebar left too little room for .pane and every settings tab's
   content started clipping/overflowing its container. Stacking the sidebar above the pane as a
   horizontally-scrollable tab strip gives the pane the full window width instead. */
@media (max-width: 640px) {
	.body, .body.wide { flex-direction: column; padding: 16px; gap: 14px; }
	.subtabs { position: static; flex-direction: row; width: 100%; overflow-x: auto; gap: 6px; padding-bottom: 2px; }
	.subtab { flex-shrink: 0; }
}
</style>
