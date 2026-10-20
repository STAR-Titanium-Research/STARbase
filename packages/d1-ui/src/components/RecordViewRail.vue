<script setup lang="ts">
import { computed } from 'vue';
import { useRecordView } from '../composables/useRecordView';
import { ACTIVITY_RANGES, isChanged, recordViewKey, viewSummary } from '../record/recordView';
import type { ActivityRange, EmptySections } from '../record/recordView';
import type { Density } from '../index/listPrefs';
import SegmentedControl from './SegmentedControl.vue';
import ViewRail from './ViewRail.vue';
import ViewRailSection from './ViewRailSection.vue';

// The View rail of a record page: Panels (1 or 2 columns), Table density, Empty sections (show or
// hide), and on a Project the Activity range. It changes the settings the page provided with
// provideRecordView(kind) (composables/useRecordView.ts), which RecordLayout, Section, PageContents and
// DataTable read. Put it in RecordLayout's `view` slot. Closed unless the person opened it (remembered
// per kind, like the settings); the dot on its tab says the view is not the default.
//   kind   what the settings are stored under and named by: "sample" (d1.view.sample, "every sample page")
//   range  also offer the Activity range (a Project's chart)
const props = defineProps<{ kind: string; range?: boolean }>();

const view = useRecordView();
const panels = computed({
	get: () => String(view?.panels ?? 1) as '1' | '2',
	set: (v) => { if (view) view.panels = v === '2' ? 2 : 1; },
});
const PANELS = [{ value: '1', label: '1 column' }, { value: '2', label: '2 columns' }] as const;
const DENSITY = [{ value: 'compact', label: 'Compact' }, { value: 'normal', label: 'Normal' }, { value: 'roomy', label: 'Roomy' }] as const;
const EMPTY = [{ value: 'show', label: 'Show' }, { value: 'hide', label: 'Hide' }] as const;
</script>

<template>
	<ViewRail v-if="view" :storage-key="`${recordViewKey(props.kind)}.open`" :summary="viewSummary(view, !!range)" :modified="isChanged(view)">
		<ViewRailSection label="Panels">
			<SegmentedControl v-model="panels" :options="PANELS" label="Panels" />
		</ViewRailSection>
		<ViewRailSection label="Table density">
			<SegmentedControl :model-value="view.density" :options="DENSITY" label="Table density" @update:model-value="view.density = $event as Density" />
		</ViewRailSection>
		<ViewRailSection label="Empty sections">
			<SegmentedControl :model-value="view.empty" :options="EMPTY" label="Empty sections" @update:model-value="view.empty = $event as EmptySections" />
		</ViewRailSection>
		<ViewRailSection v-if="range" label="Activity range">
			<SegmentedControl :model-value="view.range" :options="ACTIVITY_RANGES" label="Activity range" @update:model-value="view.range = $event as ActivityRange" />
		</ViewRailSection>
		<ViewRailSection>
			<p class="d1-note">Saved for every {{ props.kind }} page on this device.</p>
		</ViewRailSection>
	</ViewRail>
</template>
