<script setup lang="ts">
/*
 * Tab 1, Cut parameters: what this capture used (spiral feed and diameters, pulses per revolution, sample
 * rate: they draw the fingerprint), the plot model (what-if, plot only) and the operation record as
 * specified (editable; saved together with the crop by "Save changes"). One-line label | value rows.
 */
import FixedNumberInput from './FixedNumberInput.vue';
import { fmtFixed } from './fixedNumber';
import { useForceCtx } from './forceCtx';

const { detail, liveOn, editFeed, editDiam, editInnerDiam, editPpr, editRate, editRateKHz, srcCut, srcMeta, near, numDiffers, numOrNull, addsInfoOverOp, fmtCutTime, fmtOrDash,
	speedMode, editRpm, editVc, resetLive, cutModified, seedCutFromDetail, seedMetaFromDetail, metaDirty,
	editOpSubtype, editOpCuttingSpeed, editOpFeedMmPerRev, editOpAxialDoc, editOpWorkpieceDiam, editOperatorName, editOpNewEdge, editOpCoolant, editOutcomeNotes,
	moreRows, captureOpen } = useForceCtx();
const MODELS = [{ key: 'measured', label: 'Measured', title: 'The measured spindle speed (tacho)' }, { key: 'rpm', label: 'Const RPM', title: 'A constant spindle speed' }, { key: 'vc', label: 'Const Vc', title: 'A constant surface speed' }];
</script>

<template>
	<div class="fp-title"><b>Cut parameters</b><span class="fp-dim">draws the fingerprint</span><span class="grow"></span><button v-if="cutModified" class="fp-link" @click="seedCutFromDetail">Reset</button></div>
	<!-- Spiral feed / Ø: the capture's own geometry (machining_force_analysis), not the operation's specified feed / Ø below. A field is outlined when it differs from what the operation was loaded with. -->
	<div class="fp-pg"><span>Spiral feed</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editFeed" step="0.01" min="0" :class="{ modified: !near(editFeed, srcCut.feed) }" /><span class="unit">mm/rev</span></span></span></div>
	<div class="fp-pg"><span>Spiral Ø</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editDiam" step="1" min="0" :class="{ modified: !near(editDiam, srcCut.diam) }" /><span class="unit">mm</span></span></span></div>
	<div class="fp-pg"><span>Inner Ø</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editInnerDiam" step="1" min="0" title="Donut/diaphragm inner diameter — the spiral stops here. 0 = solid disc." :class="{ modified: !near(editInnerDiam, srcCut.inner) }" /><span class="unit">mm</span></span></span></div>
	<div class="fp-pg"><span>Pulses/rev</span><span class="v"><input v-model.number="editPpr" type="number" step="1" min="1" aria-label="Pulses per revolution" :class="{ modified: !near(editPpr, srcCut.ppr) }" /></span></div>
	<!-- The capture's own copy of these two only shows when it carries information: the operation record has no value, or the two disagree (a data problem worth seeing). -->
	<div v-if="addsInfoOverOp(detail.surface_speed, srcMeta.cuttingSpeed)" class="fp-pg"><span>Surface speed <span class="fp-dim">(capture)</span></span><span class="v"><span class="unit-box mismatch"><input :value="fmtFixed(detail.surface_speed)" type="text" readonly aria-label="Surface speed of the capture" /><span class="unit">m/min</span></span></span></div>
	<div v-if="addsInfoOverOp(detail.depth_of_cut, srcMeta.axialDoc)" class="fp-pg"><span>Depth of cut <span class="fp-dim">(capture)</span></span><span class="v"><span class="unit-box mismatch"><input :value="fmtFixed(detail.depth_of_cut)" type="text" readonly aria-label="Depth of cut of the capture" /><span class="unit">mm</span></span></span></div>
	<div class="fp-pg"><span>Sample rate</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editRateKHz" step="0.1" min="0.1" :class="{ modified: !near(editRate, srcCut.rate) }" /><span class="unit">kHz</span></span></span></div>
	<div class="fp-pg"><span>Cut time</span><span class="v"><input :value="fmtCutTime(detail)" type="text" disabled aria-label="Cut time" /></span></div>

	<template v-if="liveOn">
		<div class="fp-pg model"><span>Plot model</span>
			<span class="v"><span class="fp-seg" role="group" aria-label="Spindle speed model">
				<button v-for="m in MODELS" :key="m.key" :aria-pressed="speedMode === m.key" :title="m.title" @click="speedMode = m.key">{{ m.label }}</button>
			</span></span>
		</div>
		<div v-if="speedMode === 'rpm'" class="fp-pg"><span>Spindle speed</span><span class="v"><span class="unit-box"><input v-model.number="editRpm" type="number" step="10" min="1" aria-label="RPM" /><span class="unit">rpm</span></span></span></div>
		<div v-if="speedMode === 'vc'" class="fp-pg"><span>Surface speed</span><span class="v"><span class="unit-box"><input v-model.number="editVc" type="number" step="1" min="1" aria-label="Vc" /><span class="unit">m/min</span></span></span></div>
		<div class="note"><span class="fp-dim">what-if, plot only</span><button class="fp-link" @click="resetLive">Reset plot</button></div>
	</template>

	<!-- Editable operation record (manufacturing_operations): combined with any pending crop edit into one "Save changes" summary. Sequence and Operation code are shown for context but are not editable: the code is built by the database from the fields around it, and Sequence is the key archive .mat filenames are matched to an operation by, so hand-editing either would silently desync that link. -->
	<div class="fp-title sec"><b>Operation record</b><span class="fp-dim">as specified</span><span class="grow"></span><button v-if="metaDirty" class="fp-link" @click="seedMetaFromDetail">Reset</button></div>
	<div class="fp-pg"><span>Subtype</span><span class="v"><input v-model="editOpSubtype" type="text" aria-label="Subtype" :class="{ modified: editOpSubtype !== srcMeta.subtype }" /></span></div>
	<div class="fp-pg"><span>Sequence</span><span class="v"><input :value="fmtOrDash(srcMeta.sequence)" type="text" disabled aria-label="Sequence" title="Derived — matches the archive .mat filename this operation was linked from. Not editable here." /></span></div>
	<div class="fp-pg"><span>Cutting speed Vc</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editOpCuttingSpeed" step="0.1" min="0" :class="{ modified: numDiffers(numOrNull(editOpCuttingSpeed), srcMeta.cuttingSpeed) }" /><span class="unit">m/min</span></span></span></div>
	<div class="fp-pg"><span>Feed</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editOpFeedMmPerRev" step="0.001" min="0" :class="{ modified: numDiffers(numOrNull(editOpFeedMmPerRev), srcMeta.feedMmPerRev) }" /><span class="unit">mm/rev</span></span></span></div>
	<div class="fp-pg"><span>Depth of cut</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editOpAxialDoc" step="0.01" min="0" :class="{ modified: numDiffers(numOrNull(editOpAxialDoc), srcMeta.axialDoc) }" /><span class="unit">mm</span></span></span></div>
	<!-- The operation's recorded stock diameter: not the "Spiral Ø" above (a geometry override for the spiral). The Doctor's diameter backfill writes here. -->
	<div class="fp-pg"><span>Workpiece Ø</span><span class="v"><span class="unit-box"><FixedNumberInput v-model="editOpWorkpieceDiam" step="0.1" min="0" :class="{ modified: numDiffers(numOrNull(editOpWorkpieceDiam), srcMeta.workpieceDiam) }" /><span class="unit">mm</span></span></span></div>
	<div class="fp-pg"><span>Operator</span><span class="v"><input v-model="editOperatorName" type="text" aria-label="Operator" :class="{ modified: editOperatorName !== srcMeta.operator }" /></span></div>
	<div class="fp-pg"><span>New edge</span><span class="v"><input v-model="editOpNewEdge" class="tog" type="checkbox" aria-label="New edge" /></span></div>
	<div class="fp-pg"><span>Coolant</span><span class="v"><input v-model="editOpCoolant" class="tog" type="checkbox" aria-label="Coolant" /></span></div>
	<div class="fp-pg"><span>Operation code</span><span class="v"><input :value="fmtOrDash(srcMeta.passCode)" type="text" disabled aria-label="Operation code" title="Built by the database from the operation's fields; it updates when you save. Not editable here." /></span></div>
	<div class="fp-pg notes"><span>Notes</span><span class="v"><textarea v-model="editOutcomeNotes" rows="2" aria-label="Notes" :class="{ modified: editOutcomeNotes !== srcMeta.outcomeNotes }"></textarea></span></div>

	<!-- the sample, operation and capture details that are not always visible above -->
	<button class="more" :aria-expanded="captureOpen" @click="captureOpen = !captureOpen">
		<v-icon :name="captureOpen ? 'expand_more' : 'chevron_right'" x-small /> Sample and capture details
	</button>
	<template v-if="captureOpen"><div v-for="m in moreRows" :key="m[0]" class="fp-pg"><span>{{ m[0] }}</span><span class="v">{{ m[1] }}</span></div></template>
</template>

<style scoped>
.sec { margin-top: 14px; }
.model .v { flex-basis: auto; }
.note { display: flex; justify-content: space-between; margin: 2px 0 0; font-size: var(--fs-xs, 11px); }
.notes { align-items: flex-start; padding: 4px 0; }
.notes > :first-child { padding-top: 4px; }
.more { display: flex; align-items: center; gap: 4px; width: 100%; margin-top: 10px; padding: 6px 0; text-align: left; background: none; border: 0; border-top: 1px solid var(--fp-line); cursor: pointer; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 650; color: var(--fp-dim); }
.more:hover { color: var(--theme--foreground); }
.more:focus-visible { outline: 2px solid var(--fp-accent); outline-offset: 1px; }
</style>
