<script setup lang="ts">
import type { SettingRow } from './semSettings';

// A SEM image's imaging settings as labelled rows (semSettings.ts decides what the rows say): the label, the value with its unit, where it came
// from, a "check this" mark where nothing could vouch for it, and "couldn't read <field>" where a value failed. The Inbox row shows it as it is;
// the record page fills the `after` slot with its edit control.
defineProps<{ rows: SettingRow[] }>();
</script>

<template>
	<dl class="settings" data-test="sem-settings">
		<div v-for="r in rows" :key="r.key" class="setting" :data-field="r.key">
			<dt>{{ r.label }}</dt>
			<dd>
				<template v-if="r.text !== null">
					<span class="value" data-test="setting-value">{{ r.text }}</span>
					<span v-if="r.source" class="source" :class="`src-${r.source.toLowerCase()}`" data-test="setting-source">{{ r.source }}</span>
					<span v-if="r.check" class="check" title="Nothing could confirm this value: look at the image to check it." data-test="setting-check">check this</span>
				</template>
				<span v-else-if="r.failed" class="failed" :title="r.reason ?? undefined" data-test="setting-failed">{{ r.failed }}<template v-if="r.reason">: {{ r.reason }}</template></span>
				<span v-else class="unset" data-test="setting-unset">not set</span>
				<slot name="after" :row="r" />
			</dd>
		</div>
	</dl>
</template>

<style scoped>
.settings { margin: 2px 0 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 1px 12px; font-size: var(--fs-sm, 12px); }
.setting { display: contents; }
dt { color: var(--d1-dim); }
dd { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; overflow-wrap: anywhere; }
.value { color: var(--theme--foreground); }
.source { padding: 0 6px; border-radius: 99px; font-size: var(--fs-xs, 11px); line-height: 1.6; color: var(--d1-dim); background: color-mix(in srgb, var(--d1-dim) 14%, transparent); }
.source.src-manual { color: var(--d1-ok); background: color-mix(in srgb, var(--d1-ok) 14%, transparent); }
.check { padding: 0 6px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 650; line-height: 1.6; color: var(--d1-warn); background: color-mix(in srgb, var(--d1-warn) 14%, transparent); }
.failed { color: var(--d1-warn); }
.unset { color: var(--d1-dim); font-style: italic; }
</style>
