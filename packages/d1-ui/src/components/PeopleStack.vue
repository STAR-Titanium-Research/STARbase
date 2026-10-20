<script setup lang="ts">
import { computed } from 'vue';
import './tokens.css';
import type { AccessList } from '../access/accessModel';
import { peopleStack } from '../access/peopleStack';

// The people row of the Project page hero: everyone in "Who has access" as overlapping faces (six in full, then up to three fading out),
// the line "Dennis Premoli PI · 2 investigators · 9 more have access", and a "Who has access" button (the page opens AccessDialog on `open`).
// Without the list (the read failed, or has not arrived) it shows the PI alone and no count. Ordering and counts: access/peopleStack.ts.
const props = defineProps<{
	list: AccessList | null;
	/** The project's own PI: the fallback when `list` is null, and a name for an owner row that has none. */
	piName: string;
}>();
defineEmits<{ open: [] }>();

const stack = computed(() => peopleStack(props.list, props.piName));
const name = computed(() => (props.list?.owner?.name || props.piName).trim());
const investigators = computed(() => stack.value.investigators);
const more = computed(() => stack.value.more);
</script>

<template>
	<div class="d1-people">
		<span class="faces" role="list" aria-label="People with access">
			<span
				v-for="f in stack.faces"
				:key="f.key"
				role="listitem"
				class="face"
				:class="{ pi: f.pi, team: f.team }"
				:style="f.opacity < 1 ? { opacity: f.opacity } : undefined"
				:aria-hidden="f.opacity < 1 ? 'true' : undefined"
				:aria-label="f.opacity < 1 ? undefined : f.label"
				:title="f.label"
			><v-icon v-if="f.team" name="groups" x-small /><template v-else>{{ f.initials }}</template></span>
		</span>
		<span v-if="name" class="line">
			<b>{{ name }}</b> PI<template v-if="investigators"> · <b>{{ investigators }}</b> investigator{{ investigators === 1 ? '' : 's' }}</template><template v-if="more"> · <b>{{ more }}</b> more {{ more === 1 ? 'has' : 'have' }} access</template>
		</span>
		<button type="button" class="open" @click="$emit('open')">Who has access</button>
	</div>
</template>

<style scoped>
.d1-people { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-width: 0; }
.faces { display: flex; align-items: center; }
.face {
	flex: none; display: inline-grid; place-items: center; width: 28px; height: 28px; margin-left: -6px; box-sizing: border-box;
	border: 2px solid var(--d1-surface, var(--theme--background)); border-radius: 99px;
	background: var(--theme--background-normal); color: var(--theme--foreground);
	font-size: var(--fs-xs, 11px); font-weight: 700; line-height: 1; user-select: none;
}
.face:first-child { margin-left: 0; }
.face.team { border-radius: 8px; --v-icon-size: 16px; }
.face.pi { background: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); --v-icon-color: var(--d1-on-accent, #fff); }
.line { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.line b { color: var(--theme--foreground); font-weight: 600; }
.open {
	padding: 0; border: 0; background: none; color: var(--d1-accent, var(--theme--primary)); font: inherit; font-size: var(--fs-sm, 12px);
	font-weight: 600; text-decoration: underline; cursor: pointer;
}
.open:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 2px; }
</style>
