<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { NavIcon, Section, moveAmongShown, pinKey, usePinDrag, useSidebarData, type PinRef } from '@d1/ui';
import SaveNote from './SaveNote.vue';
import { unavailableLabel } from './pinLabels';
import type { Saves } from './useSaves';

// Settings → Pinned: the pins as the sidebar resolves them (the same data), in order, with up and down
// buttons, drag and Remove; the ones that no longer resolve under "No longer available"; and Reset to
// defaults behind a confirm. Every change goes through the shared usePins state, so the sidebar moves
// with it. A failed change is undone by usePins; the "Couldn't save" line here has Retry.
const props = defineProps<{ saves: Saves }>();
const { resolved, loading, error, pins } = useSidebarData();
const shown = computed(() => resolved.value.shown);
// Until the nav has loaded every pin would look unavailable; say nothing about them before then.
const navReady = computed(() => !loading.value && !error.value);
const unavailable = computed(() => (navReady.value ? resolved.value.unavailable : []));
const ready = computed(() => pins.loaded.value);

const listBlock = ref<HTMLElement | null>(null);
const spoken = ref('');

// usePins does not throw: it undoes a failed change and puts its notice up. Clear the notice first, so
// one still showing from an earlier failure is not mistaken for this change's.
function save(job: () => Promise<void>): void {
	void props.saves.run('pins', async () => {
		pins.notice.value = null;
		await job();
		return pins.notice.value === null;
	});
}

async function move(pin: PinRef, delta: -1 | 1, label: string): Promise<void> {
	const next = moveAmongShown(pins.pins.value, shown.value, pin, delta);
	if (!next) return;
	const at = shown.value.findIndex((r) => pinKey(r.ref) === pinKey(pin)) + delta;
	save(() => pins.reorder(next));
	spoken.value = `Moved ${label} to position ${at + 1} of ${shown.value.length}`;
	// The row moves in the DOM, which can drop focus: put it back (on the other button at either end).
	await nextTick();
	const row = [...(listBlock.value?.querySelectorAll<HTMLElement>('[data-pin-row]') ?? [])].find((el) => el.dataset.pin === pinKey(pin));
	const want = row?.querySelector<HTMLButtonElement>(`[data-move="${delta === -1 ? 'up' : 'down'}"]`);
	(want && !want.disabled ? want : row?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
}

const remove = (pin: PinRef): void => save(() => pins.toggle(pin));

const { drag, dropAt, pinnedBlock, startDrag, endDrag, overRow, overBlock, leaveBlock, drop } = usePinDrag({
	pins,
	shown,
	rowCount: () => shown.value.length,
	ready: () => ready.value,
});
function onDrop(e: DragEvent): void {
	// usePinDrag saves through usePins directly; tell Settings whether it stuck, as for the buttons.
	save(() => drop(e));
}

const confirmReset = ref(false);
function reset(): void {
	confirmReset.value = false;
	save(() => pins.resetPins());
}
</script>

<template>
	<Section title="Pinned">
		<div ref="pinnedBlock" class="st-rows">
			<p v-if="pins.loadFailed.value" class="st-failed" role="status">
				Couldn't load your pins.
				<button type="button" class="st-link" @click="pins.refresh()">Retry</button>
			</p>

			<div ref="listBlock" @dragover="overBlock" @dragleave="leaveBlock" @drop="onDrop">
				<ul v-if="shown.length" class="pin-list" :class="{ 'drop-end': !!drag && dropAt === shown.length }" aria-label="Pinned pages">
					<li
						v-for="(pin, i) in shown"
						:key="pinKey(pin.ref)"
						data-pin-row
						:data-pin="pinKey(pin.ref)"
						class="pin"
						:class="{ dragging: !!drag && pinKey(drag) === pinKey(pin.ref), 'drop-before': dropAt === i }"
						draggable="true"
						@dragstart="startDrag(pin.ref, $event)"
						@dragend="endDrag"
						@dragover="overRow(i, $event)"
					>
						<NavIcon :name="pin.icon" :size="16" />
						<span class="name">{{ pin.label }}<span v-if="pin.hint" class="hint"> · {{ pin.hint }}</span></span>
						<button type="button" class="st-btn" data-move="up" :aria-label="`Move ${pin.label} up`" title="Move up" :disabled="i === 0 || !ready" @click="move(pin.ref, -1, pin.label)">
							<NavIcon name="arrow-up" :size="14" />
						</button>
						<button type="button" class="st-btn" data-move="down" :aria-label="`Move ${pin.label} down`" title="Move down" :disabled="i === shown.length - 1 || !ready" @click="move(pin.ref, 1, pin.label)">
							<NavIcon name="arrow-down" :size="14" />
						</button>
						<button type="button" class="st-btn" :aria-label="`Remove ${pin.label}`" :disabled="!ready" @click="remove(pin.ref)">Remove</button>
					</li>
				</ul>
				<p v-else-if="ready && !pins.loadFailed.value" class="st-hint">Nothing pinned yet. Pin a page from its header to keep it in the sidebar.</p>
			</div>
			<p class="st-sr" role="status" aria-live="polite">{{ spoken }}</p>

			<div v-if="unavailable.length" class="gone">
				<h3 class="st-title">No longer available</h3>
				<p class="st-hint">You can't see these any more, or they were removed. They are hidden from the sidebar.</p>
				<ul class="pin-list">
					<li v-for="pin in unavailable" :key="pinKey(pin)" class="pin muted" :data-pin="pinKey(pin)">
						<span class="name">{{ unavailableLabel(pin) }}</span>
						<button type="button" class="st-btn" :aria-label="`Remove ${unavailableLabel(pin)}`" :disabled="!ready" @click="remove(pin)">Remove</button>
					</li>
				</ul>
			</div>

			<div class="st-row">
				<button type="button" class="st-btn" :disabled="!ready" @click="confirmReset = true">Reset to defaults</button>
				<SaveNote :saves="saves" save-key="pins" />
			</div>
		</div>

		<v-dialog v-model="confirmReset" @esc="confirmReset = false">
			<v-card>
				<v-card-title>Reset to defaults</v-card-title>
				<v-card-text>Replace your pins with Samples and Projects?</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmReset = false">Cancel</v-button>
					<v-button kind="danger" @click="reset">Reset</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</Section>
</template>

<style scoped>
.pin-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; position: relative; }
.pin {
	position: relative;
	display: flex; align-items: center; gap: 8px; padding: 6px 8px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued)); border-radius: 8px;
	background: var(--d1-tile, var(--theme--background-subdued));
}
.pin[draggable='true'] { cursor: grab; }
.pin.dragging { opacity: 0.5; }
.pin.muted { color: var(--d1-dim, var(--theme--foreground-subdued)); background: transparent; }
.name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.hint { color: var(--d1-dim, var(--theme--foreground-subdued)); }
.pin .st-btn { min-height: 28px; padding: 0 8px; display: inline-flex; align-items: center; }
.pin.drop-before::before,
.pin-list.drop-end::after {
	content: ''; position: absolute; left: 0; right: 0; top: -4px; height: 2px; border-radius: 1px; background: var(--d1-accent, var(--theme--primary));
}
.pin-list.drop-end::after { top: auto; bottom: -4px; }
.gone { display: flex; flex-direction: column; gap: 6px; }
h3.st-title { font-size: var(--fs-md, 13px); }
</style>
