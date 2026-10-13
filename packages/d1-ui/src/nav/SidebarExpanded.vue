<script setup lang="ts">
// The expanded sidebar (explorer-sidebar-b2 spec, decisions 1-6): Find, Home, the Pinned list, a
// divider, and the five sections as an accordion. Pins are the person's own, in their order; they
// can be dragged (or moved with Alt+Up / Alt+Down, or from the row's "⋯" menu).
//
// This component owns the interactions (the open section, the drag, the row menu); the rows and the
// menu only report what was asked. The data is shared per host (useSidebarData), so nothing is
// fetched twice. Plain HTML and the kit's tokens: it works unchanged in Directus and in STARbase.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { linkHref, openLinkInNewTab } from '../links';
import NavIcon from './NavIcon.vue';
import NavRowMenu from './NavRowMenu.vue';
import SidebarRow from './SidebarRow.vue';
import { dropIndex, dropResult, moveAmongShown, sameOrder } from './pinDrag';
import { copyLink, rowMenuItems } from './rowMenu';
import { pinnedListCut, pinKey } from './sidebarModel';
import type { PinRef, ResolvedPin, SectionId, SidebarLink, SidebarView } from './sidebarModel';
import { HOME_LINK, viewAsRow } from './sidebarRows';
import { useSidebarData } from './useSidebarData';

withDefaults(defineProps<{ collapsible?: boolean }>(), { collapsible: false });
defineEmits<{ (e: 'open-finder'): void; (e: 'request-mode', mode: 'expanded' | 'rail', sectionId?: SectionId): void }>();

const route = useRoute();
const router = useRouter();
const { sections, resolved, isCurrent, currentSection, loading, error, refresh, pins } = useSidebarData();

const root = ref<HTMLElement | null>(null);
const pinsReady = computed(() => pins.loaded.value);

// ---- Accordion: one section open at a time. The page you are on opens its section when you arrive on
// it (and when the lists first load); after that only clicks open and close sections.
const openId = ref<SectionId | null>(null);
watch(
	() => `${route.fullPath}|${currentSection.value ?? ''}`,
	() => {
		if (currentSection.value) openId.value = currentSection.value;
	},
	{ immediate: true },
);
const toggleSection = (id: SectionId) => {
	openId.value = openId.value === id ? null : id;
};

// ---- Pinned list
const showAll = ref(false);
const cut = computed(() => pinnedListCut(resolved.value.shown, showAll.value));
const overLimit = computed(() => resolved.value.shown.length > pinnedListCut(resolved.value.shown, false).shown.length);

// Rows by menu key, so focus can go back to a row that moved or to the "⋯" button that opened a menu.
const rowRefs = new Map<string, InstanceType<typeof SidebarRow>>();
const setRow = (key: string, el: unknown) => {
	if (el) rowRefs.set(key, el as InstanceType<typeof SidebarRow>);
	else rowRefs.delete(key);
};

// Said to screen readers only (a move has no other feedback for them).
const spoken = ref('');
// Said to everyone, briefly (Copy link has no other feedback).
const flash = ref('');
let flashTimer: ReturnType<typeof setTimeout> | null = null;
function say(text: string) {
	flash.value = text;
	if (flashTimer) clearTimeout(flashTimer);
	flashTimer = setTimeout(() => { flash.value = ''; flashTimer = null; }, 2500);
}
onBeforeUnmount(() => { if (flashTimer) clearTimeout(flashTimer); });

async function movePin(ref_: PinRef, delta: -1 | 1) {
	const next = moveAmongShown(pins.pins.value, resolved.value.shown, ref_, delta);
	if (!next) return;
	const key = pinKey(ref_);
	const label = resolved.value.shown.find((r) => pinKey(r.ref) === key)?.label ?? 'Pin';
	const at = resolved.value.shown.findIndex((r) => pinKey(r.ref) === key) + delta;
	void pins.reorder(next);
	spoken.value = `Moved ${label} to position ${at + 1} of ${resolved.value.shown.length}`;
	// The row's element moves in the DOM, which can drop focus; put it back.
	await nextTick();
	rowRefs.get(`pin:${key}`)?.focusLink();
}

// ---- Drag (HTML5 events). `drag` is the pin being dragged: a row of Pinned (reorder) or of a section (pin).
const drag = ref<PinRef | null>(null);
// Where the drop would land among the rows shown (0 = before the first, the row count = after the last).
const dropAt = ref<number | null>(null);
const pinnedBlock = ref<HTMLElement | null>(null);

const dragIsNew = computed(() => !!drag.value && !pins.isPinned(drag.value));

function startDrag(ref_: PinRef | null, e: DragEvent) {
	if (!ref_ || !pinsReady.value) {
		e.preventDefault();
		return;
	}
	drag.value = { kind: ref_.kind, target: ref_.target };
}
function endDrag() {
	drag.value = null;
	dropAt.value = null;
}

function overRow(index: number, e: DragEvent) {
	if (!drag.value) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	dropAt.value = dropIndex(index, rect.height ? (e.clientY - rect.top) / rect.height : 0);
}
function overBlock(e: DragEvent) {
	if (!drag.value) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	// Anywhere that is not a row (the heading, the empty list, the "Drop here to pin" zone): at the end.
	if (!(e.target as Element).closest('[data-pin-row]')) dropAt.value = cut.value.shown.length;
}
function leaveBlock(e: DragEvent) {
	if (!pinnedBlock.value?.contains(e.relatedTarget as Node | null)) dropAt.value = null;
}

async function drop(e: DragEvent) {
	e.preventDefault();
	const item = drag.value;
	const at = dropAt.value;
	endDrag();
	if (!item || at === null || !pinsReady.value) return;
	const { next, pinFirst } = dropResult(pins.pins.value, resolved.value.shown, item, at);
	if (pinFirst) {
		await pins.toggle(item);
		// The pin failed (the list says so): there is nothing to place.
		if (!pins.isPinned(item)) return;
	}
	if (!sameOrder(next, pins.pins.value)) await pins.reorder(next);
}

// ---- Row menu
interface OpenMenu {
	key: string;
	kind: 'section' | 'pinned';
	to: string;
	ref: PinRef | null;
	label: string;
	anchor: DOMRect;
	edge: number;
	button: () => void;
}
const menu = ref<OpenMenu | null>(null);

function openMenu(key: string, kind: 'section' | 'pinned', item: { to: string; label: string }, ref_: PinRef | null, anchor: DOMRect) {
	// The "⋯" button toggles its own menu.
	if (menu.value?.key === key) {
		menu.value = null;
		return;
	}
	menu.value = {
		key, kind, to: item.to, ref: ref_, label: item.label, anchor,
		// The sidebar's right edge: the menu opens beside it, not over the list.
		edge: root.value?.getBoundingClientRect().right ?? anchor.right,
		button: () => rowRefs.get(key)?.focusMenuButton(),
	};
}

function closeMenu(refocus: boolean) {
	const m = menu.value;
	menu.value = null;
	if (refocus && m) void nextTick(m.button);
}

const menuItems = computed(() => {
	const m = menu.value;
	if (!m) return [];
	const index = m.ref ? resolved.value.shown.findIndex((r) => pinKey(r.ref) === pinKey(m.ref!)) : -1;
	return rowMenuItems({
		kind: m.kind,
		pinned: !!m.ref && pins.isPinned(m.ref),
		canPin: pinsReady.value && !!m.ref,
		index,
		count: resolved.value.shown.length,
	});
});

async function choose(id: string) {
	const m = menu.value;
	if (!m) return;
	closeMenu(true);
	if (id === 'pin' || id === 'unpin') {
		if (m.ref) void pins.toggle(m.ref);
	} else if (id === 'up' || id === 'down') {
		if (m.ref) void movePin(m.ref, id === 'up' ? -1 : 1);
	} else if (id === 'new-tab') {
		openLinkInNewTab(m.to, router);
	} else if (id === 'copy') {
		say((await copyLink(linkHref(m.to, router))) ? 'Link copied' : "Couldn't copy the link");
	}
}

// Another page, a new window size or the list changing under it: the menu would sit beside the wrong row.
watch(() => route.fullPath, () => { menu.value = null; });

const togglePin = (ref_: PinRef | null) => {
	if (ref_ && pinsReady.value) void pins.toggle(ref_);
};

const pinRef = (item: SidebarLink | ResolvedPin): PinRef | null => ('ref' in item ? item.ref : item.pin);
const linkKey = (l: SidebarLink) => l.to;
const viewKey = (v: SidebarView) => `view:${v.id}`;
const sectionCurrent = (id: SectionId) => currentSection.value === id;
</script>

<template>
	<div ref="root" class="side">
		<div class="top">
			<button type="button" class="find" aria-haspopup="dialog" aria-label="Find a record (Ctrl K)" title="Find a record (Ctrl K)" @click="$emit('open-finder')">
				<NavIcon name="search" />
				<span class="find-text">Find a record</span>
				<kbd class="kbd">Ctrl K</kbd>
			</button>
			<button
				v-if="collapsible"
				type="button"
				class="collapse"
				aria-label="Collapse the sidebar"
				title="Collapse the sidebar"
				@click="$emit('request-mode', 'rail')"
			>
				<NavIcon name="panel-left-close" />
			</button>
		</div>

		<SidebarRow :item="HOME_LINK" variant="section" :pinned="false" :current="isCurrent(HOME_LINK.to)" plain />

		<section
			ref="pinnedBlock"
			class="pinned"
			:class="{ dragging: !!drag }"
			aria-labelledby="d1-side-pinned"
			@dragover="overBlock"
			@dragleave="leaveBlock"
			@drop="drop"
		>
			<h2 id="d1-side-pinned" class="sub">Pinned</h2>

			<p v-if="pins.loadFailed.value" class="note" role="status">
				Couldn't load your pins.
				<button type="button" class="retry" @click="pins.refresh()">Retry</button>
			</p>

			<template v-if="pinsReady">
				<ul v-if="cut.shown.length" class="rows" :class="{ 'drop-end': !!drag && dropAt === cut.shown.length }">
					<li
						v-for="(pin, i) in cut.shown"
						:key="pinKey(pin.ref)"
						data-pin-row
						:class="{ 'drop-before': dropAt === i }"
						@dragover="overRow(i, $event)"
					>
						<SidebarRow
							:ref="(el) => setRow(`pin:${pinKey(pin.ref)}`, el)"
							:item="pin"
							variant="pinned"
							:pinned="true"
							:current="isCurrent(pin.to)"
							:dragging="!!drag && pinKey(drag) === pinKey(pin.ref)"
							:menu-open="menu?.key === `pin:${pinKey(pin.ref)}`"
							@toggle-pin="togglePin(pin.ref)"
							@open-menu="openMenu(`pin:${pinKey(pin.ref)}`, 'pinned', pin, pin.ref, $event)"
							@dragstart="startDrag(pin.ref, $event)"
							@dragend="endDrag"
							@move="movePin(pin.ref, $event)"
						/>
					</li>
				</ul>
				<p v-else-if="!drag" class="note empty">Nothing pinned yet. Hover a page and click its pin to keep it here.</p>

				<button v-if="cut.hidden" type="button" class="more" @click="showAll = true">Show all ({{ resolved.shown.length }})</button>
				<button v-else-if="showAll && overLimit" type="button" class="more" @click="showAll = false">Show fewer</button>

				<div v-if="dragIsNew" class="zone" :class="{ over: dropAt === cut.shown.length }">Drop here to pin</div>
			</template>

			<p v-if="pins.notice.value" class="note" role="status" aria-live="polite">{{ pins.notice.value }}</p>
			<p v-else class="sr" role="status" aria-live="polite">{{ spoken }}</p>
		</section>

		<p v-if="flash" class="flash" role="status">{{ flash }}</p>

		<hr class="divider" />

		<div class="accordion">
			<section v-for="s in sections" :key="s.id" class="section">
				<h2 class="head">
					<button
						type="button"
						class="toggle"
						:class="{ bar: openId !== s.id && sectionCurrent(s.id) }"
						:aria-expanded="openId === s.id"
						:aria-controls="`d1-side-sec-${s.id}`"
						@click="toggleSection(s.id)"
					>
						<NavIcon :name="s.icon" />
						<span class="name">{{ s.label }}</span>
						<span v-if="openId !== s.id" class="count">{{ s.count }}</span>
						<NavIcon :name="openId === s.id ? 'chevron-down' : 'chevron-right'" :size="14" class="chev" />
					</button>
				</h2>

				<div v-show="openId === s.id" :id="`d1-side-sec-${s.id}`" class="body">
					<template v-for="g in s.groups" :key="g.id">
						<h3 v-if="g.label" class="sub">{{ g.label }}</h3>
						<ul class="rows">
							<li v-for="link in g.links" :key="linkKey(link)">
								<SidebarRow
									:ref="(el) => setRow(`link:${linkKey(link)}`, el)"
									:item="link"
									variant="section"
									:pinned="!!link.pin && pins.isPinned(link.pin)"
									:current="isCurrent(link.to)"
									:pins-ready="pinsReady"
									:dragging="!!drag && !!link.pin && pinKey(drag) === pinKey(link.pin)"
									:menu-open="menu?.key === `link:${linkKey(link)}`"
									@toggle-pin="togglePin(link.pin)"
									@open-menu="openMenu(`link:${linkKey(link)}`, 'section', link, link.pin, $event)"
									@dragstart="startDrag(link.pin, $event)"
									@dragend="endDrag"
								/>
								<ul v-if="link.views.length" class="rows views" :aria-label="`${link.label} saved views`">
									<li v-for="view in link.views" :key="viewKey(view)">
										<SidebarRow
											:ref="(el) => setRow(`link:${viewKey(view)}`, el)"
											:item="viewAsRow(link, view)"
											variant="section"
											nested
											:pinned="pins.isPinned(view.pin)"
											:current="isCurrent(view.to)"
											:pins-ready="pinsReady"
											:dragging="!!drag && pinKey(drag) === pinKey(view.pin)"
											:menu-open="menu?.key === `link:${viewKey(view)}`"
											@toggle-pin="togglePin(view.pin)"
											@open-menu="openMenu(`link:${viewKey(view)}`, 'section', view, view.pin, $event)"
											@dragstart="startDrag(view.pin, $event)"
											@dragend="endDrag"
										/>
									</li>
								</ul>
							</li>
						</ul>
					</template>
				</div>
			</section>
		</div>

		<p v-if="loading" class="note" role="status">Loading pages…</p>
		<p v-else-if="error" class="note" role="status">
			Couldn't load the list of pages.
			<button type="button" class="retry" @click="refresh">Retry</button>
		</p>

		<NavRowMenu
			:open="!!menu"
			:anchor="menu?.anchor ?? null"
			:edge="menu?.edge"
			:items="menuItems"
			@choose="choose"
			@close="closeMenu"
		/>
	</div>
</template>

<style scoped>
.side { display: flex; flex-direction: column; min-width: 0; }

.top { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.find {
	display: flex; flex: 1 1 auto; align-items: center; gap: 6px; min-width: 0; min-height: 34px; padding: 0 8px;
	border: 1px solid var(--d1-side-hairline); border-radius: 8px; background: transparent; color: var(--d1-side-dim);
	font: inherit; text-align: left; cursor: pointer;
}
.find:hover { background: var(--d1-side-hover); color: #fff; }
.find-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kbd {
	flex: none; padding: 0 4px; border: 1px solid var(--d1-side-hairline); border-radius: 4px;
	font: inherit; font-size: 10px; color: var(--d1-side-sub);
}
.collapse {
	display: inline-flex; flex: none; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0;
	border: 0; border-radius: 8px; background: none; color: var(--d1-side-dim); cursor: pointer;
}
.collapse:hover { background: var(--d1-side-hover); color: #fff; }
.find:focus-visible, .collapse:focus-visible, .toggle:focus-visible, .more:focus-visible, .retry:focus-visible {
	outline: 2px solid var(--d1-side-bar); outline-offset: 1px;
}

/* A sub-heading (Pinned, Admin): 11px spaced capitals, dimmer than the items, a hairline to the edge. */
.sub {
	display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; padding: 0 8px;
	font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--d1-side-sub);
}
.sub::after { content: ''; flex: 1 1 auto; height: 1px; background: var(--d1-side-hairline); }

.rows, .views { list-style: none; margin: 0; padding: 0; }
.rows > li { position: relative; }
/* The drop line, before the row the pointer is over (or after the last). */
.rows > li.drop-before::before,
.rows.drop-end::after {
	content: ''; position: absolute; left: 6px; right: 6px; top: -1px; height: 2px; border-radius: 1px; background: var(--d1-side-bar);
}
.rows.drop-end { position: relative; }
.rows.drop-end::after { top: auto; bottom: -1px; }

.note { margin: 6px 8px 0; font-size: var(--fs-sm, 12px); color: var(--d1-side-dim); }
.note.empty { margin-bottom: 2px; }
.flash { margin: 8px 8px 0; font-size: var(--fs-sm, 12px); color: var(--d1-side-text); }
.retry {
	margin-left: 4px; padding: 0; border: 0; background: none; cursor: pointer;
	font: inherit; font-weight: 600; color: var(--d1-side-bar); text-decoration: underline;
}
.more {
	display: block; width: 100%; min-height: 30px; padding: 0 8px 0 40px; border: 0; border-radius: 7px; background: none;
	font: inherit; font-size: var(--fs-sm, 12px); text-align: left; color: var(--d1-side-dim); cursor: pointer;
}
.more:hover { background: var(--d1-side-hover); color: #fff; }
.zone {
	margin: 6px 4px 0; padding: 10px 8px; border: 1px dashed var(--d1-side-sub); border-radius: 8px;
	font-size: var(--fs-sm, 12px); text-align: center; color: var(--d1-side-dim);
}
.zone.over { border-color: var(--d1-side-bar); color: #fff; }

.divider { width: auto; height: 0; margin: 12px 0 8px; border: 0; border-top: 1px solid var(--d1-side-hairline); }

/* Section headers: 40px, semibold, icon + name + (closed) count + chevron. */
.head { margin: 0; font: inherit; }
.toggle {
	position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 0 8px;
	border: 0; border-radius: 7px; background: none; color: var(--d1-side-text);
	font: inherit; font-weight: 600; text-align: left; cursor: pointer;
}
.toggle:hover { background: var(--d1-side-hover); }
.toggle :deep(.d1-nav-icon) { color: var(--d1-side-dim); }
.toggle[aria-expanded='true'] { color: #fff; }
.name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { font-size: var(--fs-sm, 12px); font-weight: 400; color: var(--d1-side-sub); }
/* The page you are on is in this closed section: the current-page bar on its header. */
.toggle.bar::before {
	content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: var(--d1-side-bar);
}
.body { padding-bottom: 6px; }
.views { padding-left: 0; }

.sr {
	position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
	clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
</style>
