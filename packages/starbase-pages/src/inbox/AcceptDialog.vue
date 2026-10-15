<script setup lang="ts">
import { computed } from 'vue';
import { acceptConfirmText, skippedText } from './inboxBulk';
import { PAIRS_SHOWN, type AcceptDialog } from './useInbox';

// The confirm of Accept all. It opens on the server's own answer to "what would you link?" (a dry run): the count, where the files go
// ("file to S-0042", the first few), what would be left for the person and why, and whether more matched than one run takes. Confirm stays
// off until that answer is in, and links what was previewed (useInbox.confirmAccept).
const props = defineProps<{ dialog: AcceptDialog; busy: boolean }>();
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>();

const text = computed(() => acceptConfirmText({ count: props.dialog.count, hasMore: props.dialog.hasMore, mayRead: props.dialog.mayRead }));
const left = computed(() => skippedText(props.dialog.skipped));
const more = computed(() => Math.max(0, props.dialog.count - props.dialog.pairs.length));
const ready = computed(() => !props.dialog.loading && !props.dialog.error);
const canConfirm = computed(() => ready.value && props.dialog.count > 0 && !props.busy);
const shown = computed(() => props.dialog.pairs.slice(0, PAIRS_SHOWN));
</script>

<template>
	<v-dialog :model-value="dialog.open" @update:model-value="(v: boolean) => !v && emit('cancel')" @esc="emit('cancel')">
		<v-card class="confirm">
			<v-card-title>Accept all</v-card-title>
			<v-card-text>
				<p v-if="dialog.loading" class="hint" role="status" data-test="accept-checking">Checking which files match…</p>
				<p v-else-if="dialog.error" class="err" role="alert" data-test="accept-error">{{ dialog.error }}</p>
				<template v-else-if="dialog.count < 1">
					<p data-test="accept-confirm">Nothing to link: no found file matches exactly one record you can edit.</p>
					<p v-if="left" class="hint" data-test="accept-left">{{ left }}</p>
				</template>
				<template v-else>
					<p data-test="accept-confirm">{{ text }}</p>
					<template v-if="shown.length">
						<p class="hint">{{ dialog.pairsExact ? 'Where they go:' : 'For example, among the files shown:' }}</p>
						<ul class="pairs" data-test="accept-pairs">
							<li v-for="(p, i) in shown" :key="i"><span class="file">{{ p.file }}</span> <span aria-hidden="true">→</span><span class="sr"> goes to </span> <strong>{{ p.record }}</strong></li>
						</ul>
						<p v-if="more > 0" class="hint">and {{ more }} more</p>
					</template>
					<p v-if="left" class="hint" data-test="accept-left">{{ left }}</p>
				</template>
			</v-card-text>
			<v-card-actions>
				<div class="spacer" />
				<v-button secondary @click="emit('cancel')">Cancel</v-button>
				<v-button :loading="busy" :disabled="!canConfirm" data-test="accept-confirm-button" @click="emit('confirm')">
					Link {{ dialog.count }} found file{{ dialog.count === 1 ? '' : 's' }}
				</v-button>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<style scoped>
.confirm { width: min(520px, calc(100vw - 24px)); }
p { margin: 0 0 8px; line-height: 1.5; }
.hint { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.err { font-size: var(--fs-sm, 12px); color: var(--d1-bad); }
.pairs { margin: 0 0 8px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm, 12px); }
.file { overflow-wrap: anywhere; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.spacer { flex: 1; }
</style>
