<script setup lang="ts">
/*
 * The Metadata doctor panel. Two views over the same diagnose() output: the selected operation's findings with
 * their fixes, and a scan of the whole archive.
 */
import ForcePanel from './ForcePanel.vue';
import { useForceCtx } from './forceCtx';

defineProps<{ canClose?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { doctorScope, doctorOptional, DOCTOR_OPTIONAL, toggleOptionalCheck, detail, doctorActive, doctorDismissedList, fmtOrDash, canAdopt, applyFix, doctorBusy, setDismissed, doctorErr, doctorGroups, rows, selectedRowId, selectOp, sampleOf } = useForceCtx();
</script>

<template>
	<ForcePanel title="Metadata doctor" icon="health_and_safety" :closable="canClose" @close="emit('close')">
		<template #tools>
			<span class="fp-seg" role="group" aria-label="Scope">
				<button :aria-pressed="doctorScope === 'op'" @click="doctorScope = 'op'">This op</button>
				<button :aria-pressed="doctorScope === 'all'" @click="doctorScope = 'all'">All</button>
			</span>
		</template>
		<div class="doc-body">
			<div class="doc-opts">
				<span class="doc-optlabel">Also check</span>
				<label v-for="c in DOCTOR_OPTIONAL" :key="c.id" class="doc-opt">
					<input type="checkbox" :checked="doctorOptional.includes(c.id)" @change="toggleOptionalCheck(c.id)" />
					<span>{{ c.label }}</span>
				</label>
			</div>

			<!-- Selected operation -->
			<template v-if="doctorScope === 'op'">
				<div v-if="!detail" class="fp-empty">Select an operation</div>
				<div v-else-if="!doctorActive.length && !doctorDismissedList.length" class="doc-ok">
					<v-icon name="check_circle" small /> No metadata issues found
				</div>
				<template v-else>
					<div v-for="f in doctorActive" :key="f.id" class="doc-find" :class="f.severity">
						<div class="doc-find-head">
							<span class="doc-sev" :class="f.severity"></span>
							<span class="doc-title">{{ f.title }}</span>
						</div>
						<p class="doc-detail">{{ f.detail }}</p>
						<div v-if="f.matValue != null || f.dbValue != null" class="doc-cmp">
							<span class="doc-side"><em>.mat</em> <b>{{ fmtOrDash(f.matValue) }}</b></span>
							<span class="doc-arrow">vs</span>
							<span class="doc-side"><em>D1</em> <b>{{ fmtOrDash(f.dbValue) }}</b></span>
						</div>
						<div class="doc-acts">
							<!-- Labelled so it is unambiguous which record changes: the .mat is never
							     written (see mat-metadata-migration — fileVersion selects the force
							     matrix parser, so editing legacy metadata corrupts parsing). -->
							<button v-if="canAdopt(f)" class="doc-btn primary" @click="applyFix(f)">
								Use .mat value in D1
							</button>
							<button v-else-if="f.fix === 'crop'" class="doc-btn primary" @click="applyFix(f)">Adjust crop…</button>
							<button v-else-if="f.fix === 'link'" class="doc-btn primary" @click="applyFix(f)">Open record…</button>
							<button class="doc-btn" :disabled="doctorBusy === f.id" @click="setDismissed(f, true)">Not a problem</button>
						</div>
					</div>

					<div v-if="doctorDismissedList.length" class="doc-dismissed">
						<span class="doc-optlabel">Dismissed</span>
						<div v-for="f in doctorDismissedList" :key="f.id" class="doc-dis-row">
							<span class="doc-title">{{ f.title }}</span>
							<button class="doc-btn" :disabled="doctorBusy === f.id" @click="setDismissed(f, false)">Restore</button>
						</div>
					</div>
				</template>
				<div v-if="doctorErr" class="doc-err">{{ doctorErr }}</div>
			</template>

			<!-- Whole archive -->
			<template v-else>
				<div v-if="!doctorGroups.length" class="doc-ok">
					<v-icon name="check_circle" small /> No metadata issues across {{ rows.length }} operations
				</div>
				<div v-for="g in doctorGroups" :key="g.id" class="doc-group">
					<div class="doc-group-head">
						<span class="doc-sev" :class="g.severity"></span>
						<span class="doc-title">{{ g.title }}</span>
						<span class="fp-chip">{{ g.rows.length }}</span>
					</div>
					<!-- data-row-id is the ANALYSIS-row id, which is not 1:1 with the pass_code
					     shown: one operation can have more than one .mat, so two rows can
					     carry the same name. Count on this, never on the label. -->
					<button v-for="r in g.rows" :key="r.id" class="doc-oprow" :data-row-id="r.id"
						:class="{ active: selectedRowId === r.id }" @click="selectOp(r)">
						<span class="fp-code">{{ r.operation_id?.pass_code || sampleOf(r)?.sample_code || r.id }}</span>
					</button>
				</div>
			</template>
		</div>
	</ForcePanel>
</template>

<style scoped>
/* ---- Metadata doctor body */
.doc-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 10px 10px; }
.doc-opts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.doc-optlabel {
	font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #6b7684);
}
.doc-opt { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs, 11px); cursor: pointer; }
.doc-opt input { margin: 0; cursor: pointer; }
.doc-ok { display: flex; align-items: center; gap: 6px; padding: 14px 2px; font-size: var(--fs-sm, 12px); color: #16a34a; }
.doc-find {
	border: 1px solid var(--theme--border-color-subdued, #e7ebf0);
	border-left-width: 3px; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px;
}
.doc-find.error { border-left-color: #dc2626; }
.doc-find.warn { border-left-color: #d97706; }
.doc-find.info { border-left-color: #64748b; }
.doc-find-head { display: flex; align-items: center; gap: 6px; }
.doc-sev { width: 7px; height: 7px; border-radius: 99px; flex: none; }
.doc-sev.error { background: #dc2626; }
.doc-sev.warn { background: #d97706; }
.doc-sev.info { background: #64748b; }
.doc-title { font-size: var(--fs-sm, 12px); font-weight: 600; }
.doc-detail { margin: 4px 0 0; font-size: var(--fs-xs, 11px); line-height: 1.45; color: var(--theme--foreground-subdued, #6b7684); }
.doc-cmp { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: var(--fs-xs, 11px); }
.doc-side em { font-style: normal; font-size: var(--fs-xs, 11px); letter-spacing: 0.01em;
	color: var(--theme--foreground-subdued, #6b7684); margin-right: 4px; }
.doc-side b { font-family: var(--theme--fonts--monospace--font-family, ui-monospace, monospace); }
.doc-arrow { color: var(--theme--foreground-subdued, #6b7684); }
.doc-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.doc-btn {
	border: 1px solid var(--theme--border-color, #d3dae4); background: transparent;
	border-radius: 5px; padding: 3px 9px; font-size: var(--fs-xs, 11px); cursor: pointer;
	color: var(--theme--foreground, #263238);
}
.doc-btn:hover:not(:disabled) { background: var(--theme--background-subdued, #f4f6f8); }
.doc-btn:disabled { opacity: 0.5; cursor: default; }
.doc-btn.primary { border-color: var(--theme--primary, #6644ff); color: var(--theme--primary, #6644ff); font-weight: 600; }
.doc-dismissed { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--theme--border-color-subdued, #e7ebf0); }
.doc-dis-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; opacity: 0.65; }
.doc-err { margin-top: 8px; font-size: var(--fs-xs, 11px); color: #dc2626; }
.doc-group { margin-bottom: 10px; }
.doc-group-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.doc-oprow {
	display: block; width: 100%; text-align: left; border: 0; background: transparent;
	padding: 3px 8px; border-radius: 4px; cursor: pointer;
}
.doc-oprow:hover { background: var(--theme--background-subdued, #f4f6f8); }
.doc-oprow.active { background: color-mix(in srgb, var(--theme--primary, #6644ff) 12%, transparent); }
</style>
