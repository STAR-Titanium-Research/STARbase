<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { Section, type UsageEntry } from '@d1/ui';
import { MAX_SHOWN, SHOWN, useFrequentlyUsed } from './useFrequentlyUsed';
import { pingVisit } from '../usagePing';

// "Frequently used": the pages, quick actions and records this user opens most, as one card with two
// lists side by side (they stack when the card is narrow). Six items each, "Show more" up to fifteen;
// pinned first. Every row has a pin toggle and an x that hides it. A new user, or one with little
// history, sees suggested pages (tagged) until real use fills the list; an x on a suggestion hides it
// in this browser only. The menu holds "Clear my history" behind a confirm step; clearing keeps the
// pins. Only this user's own list is ever shown.
const { pageList, recordList, loading, loadFailed, error, pin, hide, dismissSuggestion, clear } = useFrequentlyUsed();

const expanded = ref({ pages: false, records: false });
const cut = (list: UsageEntry[], which: 'pages' | 'records') => (expanded.value[which] ? list.slice(0, MAX_SHOWN) : list.slice(0, SHOWN));
const shownPages = computed(() => cut(pageList.value, 'pages'));
const shownRecords = computed(() => cut(recordList.value, 'records'));

// The menu is a strip inside the card, not a pop-up: the card clips what hangs outside it. Escape
// closes it and returns to its button; the arrow keys, Home and End move between its buttons.
const menuOpen = ref(false);
const confirming = ref(false);
const menuEl = ref<HTMLElement | null>(null);
const menuBtn = ref<HTMLButtonElement | null>(null);
const menuButtons = () => Array.from(menuEl.value?.querySelectorAll<HTMLElement>('button') ?? []);

async function toggleMenu() {
	menuOpen.value = !menuOpen.value;
	confirming.value = false;
	if (menuOpen.value) {
		await nextTick();
		menuButtons()[0]?.focus();
	}
}
function closeMenu() {
	menuOpen.value = false;
	confirming.value = false;
	menuBtn.value?.focus();
}
async function askConfirm() {
	confirming.value = true;
	await nextTick();
	// The safe choice gets the focus: a stray Enter cancels.
	menuButtons().at(-1)?.focus();
}
function onMenuKey(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.preventDefault();
		closeMenu();
		return;
	}
	const items = menuButtons();
	const at = items.indexOf(document.activeElement as HTMLElement);
	const last = items.length - 1;
	let to = -1;
	if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to = at >= last ? 0 : at + 1;
	else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to = at <= 0 ? last : at - 1;
	else if (e.key === 'Home') to = 0;
	else if (e.key === 'End') to = last;
	if (to >= 0) {
		e.preventDefault();
		items[to]?.focus();
	}
}
// A click anywhere outside the strip and its button closes it (focus is left where the click put it).
function onDocumentClick(e: MouseEvent) {
	if (!menuOpen.value) return;
	const t = e.target as Node | null;
	if (t && (menuEl.value?.contains(t) || menuBtn.value?.contains(t))) return;
	menuOpen.value = false;
	confirming.value = false;
}
onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));

async function confirmClear() {
	closeMenu();
	await clear();
}

// A row that is about to leave the list: focus goes to its neighbour's link (else the list heading),
// not to the page body, so a keyboard user keeps their place.
function keepFocus(ev: Event) {
	const row = (ev.currentTarget as HTMLElement).closest('li');
	const near = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null;
	(near?.querySelector<HTMLElement>('.name') ?? row?.closest('.list')?.querySelector<HTMLElement>('h3'))?.focus();
}
// x on a used item hides it (saved on the server); on a suggestion it only dismisses it here.
function remove(ev: Event, which: 'pages' | 'records', e: UsageEntry) {
	keepFocus(ev);
	if (e.suggested) dismissSuggestion(e);
	else hide(which, e);
}

// Print labels is a server page in a new tab (no route change to ping).
function openedElsewhere(e: UsageEntry) {
	pingVisit('page', e.target);
}
</script>

<template>
	<Section title="Frequently used">
		<template #actions>
			<button
				ref="menuBtn"
				type="button"
				class="menu-btn"
				aria-label="Frequently used menu"
				aria-controls="d1-fu-menu"
				:aria-expanded="menuOpen"
				@click.stop="toggleMenu"
			>
				<span aria-hidden="true">⋯</span>
			</button>
		</template>

		<div v-if="menuOpen" id="d1-fu-menu" ref="menuEl" class="menu" role="toolbar" aria-label="Frequently used options" @keydown="onMenuKey">
			<button v-if="!confirming" type="button" class="text-btn" @click="askConfirm">Clear my history</button>
			<template v-else>
				<span class="confirm-text" role="alert">Clear your history? Pinned items stay.</span>
				<button type="button" class="text-btn danger" @click="confirmClear">Clear</button>
				<button type="button" class="text-btn" @click="closeMenu">Cancel</button>
			</template>
		</div>

		<p v-if="loading" class="d1-note">Loading…</p>
		<p v-else-if="loadFailed" class="d1-note" role="status">Your frequently used list is not available right now.</p>
		<template v-else>
			<p v-if="error" class="d1-note quiet" role="status">{{ error }}</p>
			<div class="cols">
				<section class="list" aria-label="Pages and actions">
					<h3 tabindex="-1">Pages &amp; actions</h3>
					<ul>
						<li v-for="e in shownPages" :key="e.target" class="row">
							<a v-if="e.newTab" class="name" :href="e.to" target="_blank" rel="noopener" @click="openedElsewhere(e)">{{ e.label }}</a>
							<router-link v-else class="name" :to="e.to">{{ e.label }}</router-link>
							<span v-if="e.suggested" class="suggested">Suggested</span>
							<button
								type="button"
								class="icon-btn pin"
								:class="{ on: e.pinned }"
								:aria-label="`Pin ${e.label}`"
								:aria-pressed="e.pinned"
								@click="pin('pages', e)"
							><span aria-hidden="true">📌</span></button>
							<button
								type="button"
								class="icon-btn"
								:aria-label="e.suggested ? `Dismiss suggestion ${e.label}` : `Hide ${e.label} from frequently used`"
								@click="remove($event, 'pages', e)"
							><span aria-hidden="true">×</span></button>
						</li>
					</ul>
					<button
						v-if="pageList.length > SHOWN"
						type="button"
						class="more"
						:aria-expanded="expanded.pages"
						@click="expanded.pages = !expanded.pages"
					>{{ expanded.pages ? 'Show fewer' : 'Show more' }}</button>
				</section>

				<section class="list" aria-label="Records">
					<h3 tabindex="-1">Records</h3>
					<ul v-if="recordList.length">
						<li v-for="e in shownRecords" :key="e.target" class="row">
							<router-link class="name" :to="e.to">{{ e.label }}</router-link>
							<button
								type="button"
								class="icon-btn pin"
								:class="{ on: e.pinned }"
								:aria-label="`Pin ${e.label}`"
								:aria-pressed="e.pinned"
								@click="pin('records', e)"
							><span aria-hidden="true">📌</span></button>
							<button
								type="button"
								class="icon-btn"
								:aria-label="`Hide ${e.label} from frequently used`"
								@click="remove($event, 'records', e)"
							><span aria-hidden="true">×</span></button>
						</li>
					</ul>
					<p v-else class="d1-note">Samples, operations and other records you open or edit will appear here.</p>
					<button
						v-if="recordList.length > SHOWN"
						type="button"
						class="more"
						:aria-expanded="expanded.records"
						@click="expanded.records = !expanded.records"
					>{{ expanded.records ? 'Show fewer' : 'Show more' }}</button>
				</section>
			</div>
		</template>
	</Section>
</template>

<style scoped>
/* Two lists side by side; each needs about 260px, so the card stacks them when it is narrower. */
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 28px; }
.list { min-width: 0; }
h3 { margin: 0 0 6px; font-size: var(--fs-sm); font-weight: 650; color: var(--d1-dim); text-transform: uppercase; letter-spacing: 0.04em; }
h3:focus { outline: none; }
ul { list-style: none; margin: 0; padding: 0; }
.row { display: flex; align-items: center; gap: 4px; min-height: 30px; border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.row:last-child { border-bottom: 0; }
.name {
	flex: 1; min-width: 0; padding: 4px 0; font-size: var(--fs-md); font-weight: 550; text-decoration: none;
	color: var(--d1-accent, var(--theme--primary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.name:hover { text-decoration: underline; }
/* Its own pill: the shared .d1-tag rule is scoped to RecordCard, so it does not reach this card. */
.suggested {
	flex: none; padding: 1px 7px; border-radius: 99px; font-size: var(--fs-xs); font-weight: 650; white-space: nowrap;
	color: var(--d1-dim, var(--theme--foreground-subdued)); background: var(--d1-tile, var(--theme--background-subdued));
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
.icon-btn {
	flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
	font: inherit; font-size: 14px; line-height: 1; cursor: pointer; border: 0; border-radius: 6px; background: transparent;
	color: var(--d1-dim, var(--theme--foreground-subdued));
}
.icon-btn:hover { background: var(--d1-tile, var(--theme--background-subdued)); color: var(--theme--foreground); }
.icon-btn:focus-visible, .name:focus-visible, .more:focus-visible, .text-btn:focus-visible, .menu-btn:focus-visible {
	outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px;
}
/* An unpinned pin is a ghost until the row is hovered or the button focused; a pinned one is lit. */
.pin { filter: grayscale(1); opacity: 0.35; font-size: 12px; }
.row:hover .pin, .pin:focus-visible { opacity: 0.8; }
.pin.on { filter: none; opacity: 1; }
/* No hover on a touch screen: the toggle rests at full strength (still grey until it is on). */
@media (hover: none) { .pin { opacity: 1; } }
.more { margin-top: 6px; padding: 2px 0; font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; border: 0; background: none; color: var(--d1-accent, var(--theme--primary)); }
.more:hover { text-decoration: underline; }
.quiet { margin: 0 0 8px; }
.menu-btn { width: 28px; height: 24px; padding: 0; font-size: 18px; line-height: 1; cursor: pointer; border: 0; border-radius: 6px; background: transparent; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.menu-btn:hover { background: color-mix(in srgb, var(--theme--foreground) 8%, transparent); color: var(--theme--foreground); }
.menu {
	display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 0 0 10px; padding: 6px 10px;
	border-radius: 8px; font-size: var(--fs-sm); background: var(--d1-tile, var(--theme--background-subdued));
}
.confirm-text { color: var(--theme--foreground); }
.text-btn { padding: 2px 0; font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; border: 0; background: none; color: var(--d1-accent, var(--theme--primary)); }
.text-btn:hover { text-decoration: underline; }
.text-btn.danger { color: var(--theme--danger); }
</style>
