<script setup lang="ts">
import { STATE_LABEL, type InsertState } from '@d1/ui';

// An insert's (or an edge's) state as a small pill: the same colours the stage draws, from the kit's
// --d1-ok / --d1-warn / --d1-dim. The word is always there, so colour is never the only signal.
defineProps<{ state: InsertState }>();
</script>

<template>
	<span class="state" :class="state"><span class="dot" aria-hidden="true" />{{ STATE_LABEL[state] }}</span>
</template>

<style scoped>
.state {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 1px 8px;
	border-radius: 99px;
	font-size: var(--fs-xs, 11px);
	font-weight: 700;
	line-height: 1.6;
	white-space: nowrap;
	color: var(--tone);
	background: color-mix(in srgb, var(--tone) 12%, transparent);
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); }
.fresh { --tone: var(--d1-ok); }
.partly-used { --tone: var(--d1-warn); }
.used { --tone: var(--d1-dim); }
.depleted { --tone: var(--d1-dim); }
.depleted .dot { background: transparent; border: 1.5px solid var(--tone); }
</style>
