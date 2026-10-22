<script setup lang="ts">
import { computed, ref } from 'vue';
import { AppLink } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { linkCardView, siblingsView } from './linkedModel';
import SiblingThumb from './SiblingThumb.vue';

// The linked record strip (the maintainer's pick C): under the Link card, "Linked to S-0042 · 12 images", a few small pictures of the OTHER images linked to the
// same record (the rest counted, "+5"), and "Compare with…". A click on a picture opens that file; after "Compare with…" the next click starts Compare with it
// instead. It only reports which file was chosen; the sheet and the page decide what opening and comparing do. Nothing shows when the record has no other picture.
const props = defineProps<{
	file: FoundFile;
	/** The other pictures on the record, newest link first (the first few, see SIBLINGS_SHOWN), and how many there are in all. */
	rows: readonly FoundFile[];
	total: number;
}>();
const emit = defineEmits<{
	(e: 'open', candidateId: string): void;
	(e: 'compare', candidateId: string): void;
}>();

const view = computed(() => siblingsView(props.rows, props.total));
const card = computed(() => linkCardView(props.file));
const picking = ref(false);
function pick(f: FoundFile): void {
	if (picking.value) {
		picking.value = false;
		emit('compare', f.candidate_id);
	} else emit('open', f.candidate_id);
}
// Esc while choosing ends the choosing and nothing more (the sheet and the page close on Esc otherwise)
function stopPicking(e: KeyboardEvent): void {
	if (!picking.value) return;
	e.stopPropagation();
	e.preventDefault();
	picking.value = false;
}
</script>

<template>
	<section v-if="view && card" class="siblings" aria-label="Other pictures on the same record" data-test="siblings" @keydown.esc="stopPicking">
		<p class="head" data-test="siblings-head">
			<span class="lead">{{ card.lead }}</span>{{ ' ' }}
			<AppLink v-if="card.route && card.code" :to="card.route" class="rec">{{ card.code }}</AppLink>
			<span v-else class="rec off">{{ card.code ?? 'a record you cannot open' }}</span>
			{{ ' ' }}<span class="count" data-test="siblings-count">· {{ view.countText }}</span>
		</p>
		<ul class="strip" role="list">
			<li v-for="s in view.shown" :key="s.candidate_id"><SiblingThumb :file="s" :picking="picking" @pick="pick" /></li>
			<li v-if="view.more > 0" class="more" data-test="siblings-more"><span role="img" :aria-label="`and ${view.more} more`">+{{ view.more }}</span></li>
		</ul>
		<div class="row">
			<button type="button" class="d1-btn" :aria-pressed="picking" data-test="siblings-compare" @click="picking = !picking">Compare with…</button>
			<span v-if="picking" class="hint" data-test="siblings-hint">Choose a picture to compare this one with.</span>
		</div>
	</section>
</template>

<style scoped>
.siblings {
	box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; min-width: 0;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile, var(--theme--background-subdued)); color: var(--theme--foreground);
	font-size: var(--fs-md, 13px); line-height: 1.45;
}
.head { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.rec { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline dotted; }
.rec.off { font-family: inherit; font-weight: 600; text-decoration: none; color: var(--d1-dim); }
.count { font-weight: 400; color: var(--d1-dim); font-variant-numeric: tabular-nums; }
.strip { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 0; padding: 0; list-style: none; }
.more { padding: 0 4px; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); font-variant-numeric: tabular-nums; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.hint { font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.d1-btn[aria-pressed='true'] { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
</style>
