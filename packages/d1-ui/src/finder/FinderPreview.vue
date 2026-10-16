<script setup lang="ts">
import NavIcon from '../nav/NavIcon.vue';
import type { PreviewCard } from './previewCard';
import type { PreviewState } from './usePreview';

// The finder's preview pane: the card of the active record (see previewCard.ts, usePreview.ts). It only draws what it is given, so it can be rendered and
// tested on its own; Finder.vue decides whether it exists. The pane is named by the active option (which the box announces as the arrow keys move), and only
// the facts, which arrive after the row, are a polite live region. It has no buttons or links: the dialog's Tab stops stay as they were, and "Open ↵" is the Enter key's own hint.
defineProps<{ state: PreviewState; card: PreviewCard | null; labelledby?: string }>();
</script>

<template>
	<!-- mousedown.prevent: a click in the pane must not take focus off the box. -->
	<aside class="d1-finder-preview" :aria-labelledby="labelledby" @mousedown.prevent>
		<template v-if="card">
			<header class="top">
				<NavIcon :name="card.icon" :size="20" class="ico" />
				<div class="who">
					<div class="title">{{ card.title }}</div>
					<div class="kind">{{ card.kind }}</div>
				</div>
			</header>
			<p v-if="card.detail" class="detail">{{ card.detail }}</p>
			<p v-if="card.matched" class="matched">Matched in {{ card.matched.field }}<template v-if="card.matched.snippet">: {{ card.matched.snippet }}</template></p>
		</template>
		<!-- Always present, so the facts that arrive later are announced. -->
		<div aria-live="polite">
			<dl v-if="card?.facts.length" class="facts">
				<div v-for="f in card.facts" :key="f.label" class="fact">
					<dt>{{ f.label }}</dt>
					<dd :class="{ mono: f.mono }">{{ f.value }}</dd>
				</div>
			</dl>
		</div>
		<template v-if="card">
			<p v-if="state === 'loading'" class="note">Loading…</p>
			<p v-else-if="state === 'unavailable'" class="note">Preview unavailable</p>
			<footer class="foot">Open ↵</footer>
		</template>
	</aside>
</template>

<style scoped>
.d1-finder-preview {
	flex: 0 0 340px; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px;
	padding: 14px 16px; overflow-y: auto;
	border-left: 1px solid var(--d1-line);
}
.top { display: flex; align-items: center; gap: 10px; }
.ico { color: var(--d1-dim); }
.who { min-width: 0; }
.title { overflow-wrap: anywhere; font-size: var(--fs-lg, 15px); font-weight: 700; }
.kind { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.detail { margin: 0; font-size: var(--fs-md, 13px); overflow-wrap: anywhere; }
.matched { margin: 0; font-size: var(--fs-sm, 12px); font-style: italic; color: var(--d1-dim); overflow-wrap: anywhere; }
.facts { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.fact { display: flex; gap: 10px; font-size: var(--fs-md, 13px); }
.fact dt { flex: 0 0 96px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.fact dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); }
.note { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.foot { margin-top: auto; padding-top: 6px; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
</style>
