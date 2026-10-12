<script setup lang="ts">
// The card of a list that has no designed card: an optional picture area (the `thumb` slot, only
// drawn when the page fills it), the code as the row's link (a real link for a record row, a button
// for a row that opens the drawer), a title line, up to four labelled facts, and a footer slot for
// the row's buttons. A click anywhere on the card does what the link does for a mouse.
import type { CardFact } from './cardFacts';
import { isPlainClick } from './cardFacts';

const props = defineProps<{
	link: string;
	mono: boolean;
	sub: string;
	facts: CardFact[];
	/** A record row's address; null for a row that opens the drawer. */
	href: string | null;
}>();
const emit = defineEmits<{ open: [] }>();

// A plain click on the link goes through the host (like every other navigation); a modified one is
// left to the browser. Neither also reaches the card's own handler.
function onLink(e: MouseEvent): void {
	e.stopPropagation();
	if (!props.href) return emit('open');
	if (!isPlainClick(e)) return;
	e.preventDefault();
	emit('open');
}
</script>

<template>
	<article class="card" @click="emit('open')">
		<div v-if="$slots.thumb" class="pic"><slot name="thumb" /></div>
		<div class="body">
			<a v-if="href" class="head" :class="{ mono }" :href="href" :aria-label="link ? undefined : 'Open'" @click="onLink">{{ link || '—' }}</a>
			<button v-else type="button" class="head" :class="{ mono }" :aria-label="link ? undefined : 'Open'" @click="onLink">{{ link || '—' }}</button>
			<span v-if="sub" class="sub">{{ sub }}</span>
			<dl v-if="facts.length" class="facts">
				<div v-for="f in facts" :key="f.label" class="fact">
					<dt>{{ f.label }}</dt>
					<dd>{{ f.value }}</dd>
				</div>
			</dl>
		</div>
		<footer v-if="$slots.footer" class="foot" @click.stop><slot name="footer" /></footer>
	</article>
</template>

<style scoped>
/* After the mockup's card: a full-width picture area on top, a padded body, the row's buttons at the
   foot (pushed down so cards of one row share a height). */
.card {
	display: flex; flex-direction: column; height: 100%; min-width: 0; overflow: hidden;
	border: 1px solid var(--d1-line); border-radius: 12px; background: var(--d1-tile);
	color: var(--theme--foreground); cursor: pointer; transition: border-color 0.12s ease;
}
.card:hover, .card:focus-within { border-color: var(--d1-accent, var(--theme--primary)); }
.pic { height: 120px; display: grid; place-items: center; line-height: 0; overflow: hidden; background: var(--d1-surface); border-bottom: 1px solid var(--d1-line); }
.pic :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.body { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 9px 11px 10px; flex: 1; }
.head {
	align-self: flex-start; max-width: 100%; padding: 0; border: 0; background: none; font: inherit; text-align: left;
	font-size: var(--fs-md, 13px); font-weight: 700; color: inherit; text-decoration: none; cursor: pointer; overflow-wrap: anywhere;
}
.head.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: 12px; }
.head:hover { color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; }
.head:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 3px; }
.sub { font-size: var(--fs-md, 13px); overflow-wrap: anywhere; }
.facts { margin: 2px 0 0; display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: var(--fs-sm, 12px); }
.fact { display: flex; gap: 4px; min-width: 0; max-width: 100%; }
.fact dt { flex: none; color: var(--d1-dim); }
.fact dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.foot:empty { display: none; }
.foot { margin-top: auto; display: flex; flex-wrap: wrap; gap: 4px; padding: 0 11px 10px; cursor: default; }
</style>
