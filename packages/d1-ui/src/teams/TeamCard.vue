<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import '../components/tokens.css';
import { EXPLORER_HOST, type ExplorerHost } from '../host';
import { cachedTeam, type TeamDetail } from './teamsApi';
import TeamTile from './TeamTile.vue';

// The members card of a team: wrap whatever names the team (a chip, a row, a name) in <TeamCard :team-id>, and a small popover opens on mouse
// hover, keyboard focus and tap. It lists the first six members (managers first, as the endpoint sorts them; a manager badge; "no login" for
// a person who cannot sign in yet), "and N more", and Open team (the team's page). Escape or leaving closes it; a tap on the trigger keeps it
// open until the next tap, Escape or a tap outside. The team is read once per page (the cache in teamsApi) the first time the card opens.
//
// The popover is position: fixed, placed from the trigger's box and kept on screen, so a dialog's or a panel's overflow does not clip it.
const props = defineProps<{ teamId: string }>();

const SHOWN = 6;
const HOVER_DELAY_MS = 150;
const LEAVE_DELAY_MS = 120;

const injected = inject(EXPLORER_HOST);
if (!injected) throw new Error('TeamCard needs an ExplorerHost: render it inside ExplorerView');
const host: ExplorerHost = injected;

const uid = `d1-team-card-${Math.random().toString(36).slice(2, 8)}`;
const root = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const open = ref(false);
const pinned = ref(false);
const detail = ref<TeamDetail | null>(null);
const failed = ref('');
const loading = ref(false);
const pos = ref({ left: 0, top: 0 });
let timer: ReturnType<typeof setTimeout> | null = null;
let mute = false;

const team = computed(() => detail.value?.team ?? null);
const members = computed(() => detail.value?.members ?? []);
const shown = computed(() => members.value.slice(0, SHOWN));
const more = computed(() => Math.max(0, members.value.length - SHOWN));

function clearTimer() {
	if (timer) clearTimeout(timer);
	timer = null;
}

// The team is read through the page cache; a failed read is not cached, so the next opening retries. A card whose team changes starts again.
async function load() {
	if (detail.value || loading.value) return;
	const asked = props.teamId;
	loading.value = true;
	failed.value = '';
	try {
		const d = await cachedTeam(host.api, asked);
		if (asked === props.teamId) detail.value = d;
	} catch (e: any) {
		if (asked === props.teamId) failed.value = e?.message || 'Could not read the team.';
	} finally {
		if (asked === props.teamId) loading.value = false;
	}
}
watch(
	() => props.teamId,
	() => {
		detail.value = null;
		failed.value = '';
		loading.value = false;
		if (open.value) void load();
	},
);

// Under the trigger, left-aligned with it, and moved to stay inside the window (above the trigger when there is no room below).
function place() {
	const trigger = root.value?.getBoundingClientRect();
	const card = pop.value?.getBoundingClientRect();
	if (!trigger) return;
	const w = card?.width || 280;
	const h = card?.height || 160;
	const margin = 8;
	const left = Math.min(Math.max(margin, trigger.left), Math.max(margin, window.innerWidth - w - margin));
	const below = trigger.bottom + 6;
	const top = below + h + margin > window.innerHeight && trigger.top - h - 6 >= margin ? trigger.top - h - 6 : below;
	pos.value = { left, top };
}

function onDocKey(e: KeyboardEvent) {
	if (e.key !== 'Escape') return;
	// capture phase: this Escape closes the card only, not the dialog or panel the card sits in
	e.stopPropagation();
	e.preventDefault();
	close();
	// focus was inside the card (Open team): give it back to the trigger, without that focus reopening the card
	if (pop.value?.contains(document.activeElement)) {
		mute = true;
		root.value?.querySelector<HTMLElement>('button, a, input, [tabindex]')?.focus();
		mute = false;
	}
}
function onDocPointer(e: PointerEvent) {
	const t = e.target as Node | null;
	if (t && (root.value?.contains(t) || pop.value?.contains(t))) return;
	close();
}
function onScroll() {
	if (open.value) place();
}

async function show(pin = false) {
	clearTimer();
	if (pin) pinned.value = true;
	if (!open.value) {
		open.value = true;
		place();
		document.addEventListener('keydown', onDocKey, true);
		document.addEventListener('pointerdown', onDocPointer, true);
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', onScroll);
	}
	void load();
	await nextTick();
	place(); // again with the card's real size
}

function close() {
	clearTimer();
	pinned.value = false;
	if (!open.value) return;
	open.value = false;
	document.removeEventListener('keydown', onDocKey, true);
	document.removeEventListener('pointerdown', onDocPointer, true);
	window.removeEventListener('scroll', onScroll, true);
	window.removeEventListener('resize', onScroll);
}

function later(fn: () => void, ms: number) {
	clearTimer();
	timer = setTimeout(fn, ms);
}

// Hover is for a mouse only: a touch also fires pointer enter, and must not open-then-close the card on the same tap.
const isMouse = (e: PointerEvent) => e.pointerType === 'mouse';
function onEnter(e: PointerEvent) {
	if (isMouse(e)) later(() => void show(), HOVER_DELAY_MS);
}
function onLeave(e: PointerEvent) {
	if (!isMouse(e)) return;
	if (!open.value) clearTimer();
	else later(close, LEAVE_DELAY_MS);
}
function onFocusIn() {
	if (!mute) void show();
}
function onFocusOut(e: FocusEvent) {
	const to = e.relatedTarget as Node | null;
	if (to && (root.value?.contains(to) || pop.value?.contains(to))) return;
	close();
}
// A click (a tap, or Enter on a focused button) pins the card open; the next one closes it.
function onClick() {
	if (open.value && pinned.value) close();
	else void show(true);
}

function openTeam() {
	close();
	host.navigate(`/teams/${encodeURIComponent(props.teamId)}`);
}

onBeforeUnmount(close);
</script>

<template>
	<span ref="root" class="d1-team-card" @pointerenter="onEnter" @pointerleave="onLeave" @focusin="onFocusIn" @focusout="onFocusOut" @click="onClick">
		<slot />
		<div
			v-if="open"
			:id="uid"
			ref="pop"
			class="d1-kit pop"
			role="group"
			:aria-label="team ? `Team ${team.name}` : 'Team'"
			:style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
			@pointerenter="(e: PointerEvent) => isMouse(e) && clearTimer()"
			@pointerleave="onLeave"
			@click.stop
		>
			<p v-if="failed" class="msg err" role="alert">{{ failed }}</p>
			<p v-else-if="!team" class="msg" role="status">Loading…</p>
			<template v-else>
				<header class="head">
					<TeamTile :team="team" size="md" />
					<span class="titles">
						<span class="nm">{{ team.name }}</span>
						<span class="sub">{{ members.length }} member{{ members.length === 1 ? '' : 's' }}</span>
					</span>
				</header>
				<p v-if="team.description" class="desc">{{ team.description }}</p>
				<ul class="people" aria-label="Members">
					<li v-for="m in shown" :key="m.person_id" class="who">
						<span class="n">{{ m.full_name || 'Unnamed person' }}</span>
						<span v-if="m.is_manager" class="badge">manager</span>
						<span v-if="!m.can_sign_in" class="tag">no login</span>
					</li>
					<li v-if="!members.length" class="who quiet">No members yet.</li>
				</ul>
				<p v-if="more" class="more">and {{ more }} more</p>
				<button type="button" class="open" @click="openTeam">Open team</button>
			</template>
		</div>
	</span>
</template>

<style scoped>
.d1-team-card { display: inline-flex; min-width: 0; max-width: 100%; }
.pop {
	position: fixed; z-index: 10000; box-sizing: border-box; width: min(280px, calc(100vw - 16px)); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-surface); color: var(--theme--foreground); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
	font-size: var(--fs-md, 13px); font-weight: 400; text-align: left; white-space: normal; cursor: default;
}
.head { display: flex; align-items: center; gap: 10px; }
.titles { min-width: 0; display: flex; flex-direction: column; }
.nm { font-weight: 700; overflow-wrap: anywhere; }
.sub { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.desc { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); overflow-wrap: anywhere; }
.people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.who { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; }
.n { overflow-wrap: anywhere; }
.badge {
	padding: 0 6px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-accent, var(--theme--primary));
	border: 1px solid color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 45%, transparent);
}
.tag { font-size: var(--fs-xs, 11px); color: var(--d1-warn); }
.quiet, .more, .msg { margin: 0; color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
.err { color: var(--d1-bad); }
.open {
	align-self: flex-start; height: 30px; padding: 0 12px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.open:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.open:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
