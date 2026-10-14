<script setup lang="ts">
// The panel beside the People list (a bottom sheet on a narrow screen). This is the shell with its final interface: the head (avatar,
// name, e-mail) and the close button. The sections (login, access, actions) arrive with the next task.
import { computed, onBeforeUnmount, onMounted } from 'vue';
import type { PeopleRow } from './peopleQuery';

const props = defineProps<{
	personId: string;
	rows: PeopleRow[];
	canAdministerAccounts: boolean;
	roles: { id: string; name: string }[];
}>();
const emit = defineEmits<{
	(e: 'close'): void;
	(e: 'changed'): void;
	(e: 'invite', person: PeopleRow): void;
}>();

const person = computed(() => props.rows.find((r) => r.person_id === props.personId) ?? null);
const initials = computed(
	() =>
		(person.value?.full_name ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('') || '?',
);

// Esc closes the panel wherever the focus is (it stays on the row that opened it). While a dialog is open Esc belongs to the dialog.
const onKey = (e: KeyboardEvent) => {
	if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
	emit('close');
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
	<section v-if="person" class="person-panel" :aria-label="person.full_name">
		<header class="head">
			<span class="av" aria-hidden="true">{{ initials }}</span>
			<div class="who">
				<h2 class="nm">{{ person.full_name }}</h2>
				<div v-if="person.email" class="em">{{ person.email }}</div>
			</div>
			<button class="x" type="button" aria-label="Close" @click="emit('close')">&times;</button>
		</header>
	</section>
</template>

<style scoped>
.person-panel { background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius); box-shadow: var(--d1-shadow); }
.head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.av { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 auto; font-weight: 700;
	background: var(--d1-tint); color: var(--d1-accent, var(--theme--primary)); }
.who { flex: 1; min-width: 0; }
.nm { margin: 0; font-size: var(--fs-lg); font-weight: 650; overflow-wrap: anywhere; }
.em { font-size: var(--fs-sm); color: var(--d1-dim); overflow-wrap: anywhere; }
.x { flex: 0 0 auto; width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: var(--d1-dim);
	font-size: 20px; line-height: 1; cursor: pointer; }
.x:hover { background: var(--d1-tile); color: var(--theme--foreground); }
</style>
