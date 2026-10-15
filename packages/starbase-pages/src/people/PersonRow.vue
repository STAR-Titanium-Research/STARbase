<script setup lang="ts">
// One row of the People list: sparse on purpose (who, what kind of work, and for an administrator the account role and last sign-in).
// A warning shows only when something is off. A login without a person is a row of its own with a "Link to a person…" action.
import { computed } from 'vue';
import { lastSeen } from './lastSeen';
import type { PeopleRow } from './peopleQuery';
import { rowNote } from './rowNote';

const props = defineProps<{ row: PeopleRow; admin: boolean; selected: boolean; rowKey: string }>();
const emit = defineEmits<{ (e: 'open', row: PeopleRow): void; (e: 'link', row: PeopleRow): void }>();

const initials = computed(
	() =>
		props.row.full_name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('') || '?',
);
const isLogin = computed(() => props.row.kind === 'login');
const kinds = computed(() => {
	if (isLogin.value) return props.row.login?.email ?? props.row.email ?? '';
	const k: string[] = [];
	if (props.row.is_researcher) k.push('Researcher');
	if (props.row.is_operator) k.push('Operator');
	return k.join(' · ');
});
const note = computed(() => rowNote(props.row));
// The account role (Administrator, Lab Admin, Lab Member), or "No login"; a Suspended login says so beside it.
const accountRole = computed(() => {
	const l = props.row.login;
	if (!l) return 'No login';
	const name = l.role_name ?? 'No account role';
	return l.status === 'suspended' ? `${name} · Suspended` : name;
});
</script>

<template>
	<component
		:is="isLogin ? 'div' : 'button'"
		class="prow"
		:class="{ former: !row.active, on: selected }"
		:data-key="rowKey"
		:type="isLogin ? undefined : 'button'"
		:aria-current="selected ? 'true' : undefined"
		@click="!isLogin && emit('open', row)"
	>
		<span class="av" aria-hidden="true">{{ initials }}</span>
		<span class="main">
			<span class="nm">{{ row.full_name }}<span v-if="!row.active" class="former-tag">Former</span></span>
			<span v-if="kinds" class="sub">{{ kinds }}</span>
		</span>
		<button v-if="isLogin && admin" type="button" class="link" @click="emit('link', row)">Link to a person…</button>
		<template v-if="admin">
			<span v-if="note" class="flag">{{ note }}</span>
			<span v-else class="meta">{{ accountRole }}</span>
			<span class="meta when">{{ lastSeen(row.login?.last_access) }}</span>
		</template>
	</component>
</template>

<style scoped>
.prow { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; font: inherit; color: var(--theme--foreground);
	background: transparent; border: 0; border-top: 1px solid var(--d1-line); padding: 8px 14px; box-sizing: border-box; }
button.prow { cursor: pointer; }
.prow:first-child { border-top: 0; }
button.prow:hover { background: var(--d1-tile); }
.prow.on { background: var(--d1-tint); }
.prow.former { opacity: .62; }
.av { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 auto; font-size: var(--fs-sm); font-weight: 700;
	background: var(--d1-tint); color: var(--d1-accent, var(--theme--primary)); }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.nm { font-weight: 650; font-size: var(--fs-md); display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
.sub { font-size: var(--fs-sm); color: var(--d1-dim); overflow-wrap: anywhere; }
.former-tag { font-size: var(--fs-xs); font-weight: 700; color: var(--d1-bad);
	background: color-mix(in srgb, var(--theme--danger) 14%, transparent); border-radius: 99px; padding: 1px 8px; }
.meta { font-size: var(--fs-sm); color: var(--d1-dim); white-space: nowrap; }
.when { width: 90px; text-align: right; font-variant-numeric: tabular-nums; }
.flag { font-size: var(--fs-sm); font-weight: 600; color: var(--d1-warn); white-space: nowrap; }
.link { border: 0; background: transparent; padding: 2px 4px; font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer;
	color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; white-space: nowrap; }
</style>
