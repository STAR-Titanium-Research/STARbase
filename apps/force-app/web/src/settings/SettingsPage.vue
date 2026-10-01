<script setup lang="ts">
// App settings with sub-tabs for things that don't need surfacing on the working pages.
import { ref } from 'vue';
import { useRoute } from 'vue-router';
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
</script>

<template>
	<div class="settings">
		<header class="head"><h1>Settings</h1></header>
		<div class="body" :class="{ wide: active === 'logs' }">
			<nav class="subtabs">
				<button v-for="t in tabs" :key="t.id" class="subtab" :class="{ on: active === t.id }" @click="active = t.id as any">
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
</template>

<style scoped>
.settings { min-height: 100vh; background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg)); }
.head { padding: 20px 26px 12px; border-bottom: 1px solid var(--border); }
.head h1 { margin: 0; font-size: var(--fs-2xl); letter-spacing: -0.01em; }
/* Form-shaped panes read better narrow; the log viewer needs the width, so the cap is
   lifted for that tab only. */
.body { display: flex; gap: 24px; padding: 22px 26px; max-width: 1000px; }
.body.wide { max-width: 1500px; }
.subtabs { display: flex; flex-direction: column; gap: 4px; width: 190px; flex-shrink: 0; }
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
	.subtabs { flex-direction: row; width: 100%; overflow-x: auto; gap: 6px; padding-bottom: 2px; }
	.subtab { flex-shrink: 0; }
}
</style>
