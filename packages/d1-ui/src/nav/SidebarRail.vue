<script setup lang="ts">
// The rail (explorer-sidebar-b2 spec, decision 7): the sidebar as a 60px column of icons. From the
// top: the host's mark (`#mark` slot), Find, Home, one icon per pin (with more than 6, five and a
// "+n" button), a short divider, the five section icons and, when `collapsible`, the expand button.
// Every icon has an aria-label; the link and button icons also show a tooltip pill on hover and on
// keyboard focus (useRailTip). A section icon (and "+n") opens a hover menu (NavHoverMenu) instead,
// whose header names it; see useRailMenu.
//
// The data is the same as the expanded sidebar's (useSidebarData), so both modes show the same
// sections and pins. Plain HTML and the kit's tokens: it works unchanged in Directus and STARbase.
import { computed, ref } from 'vue';
import AppLink from '../components/AppLink.vue';
import NavHoverMenu from './NavHoverMenu.vue';
import NavIcon from './NavIcon.vue';
import { pinKey, railPins } from './sidebarModel';
import type { SectionId } from './sidebarModel';
import { HOME_LINK } from './sidebarRows';
import { useRailMenu } from './useRailMenu';
import { useRailTip } from './useRailTip';
import { useSidebarData } from './useSidebarData';

withDefaults(defineProps<{ collapsible?: boolean }>(), { collapsible: false });
defineEmits<{ (e: 'open-finder'): void; (e: 'request-mode', mode: 'expanded' | 'rail', sectionId?: SectionId): void }>();

const { sections, resolved, isCurrent, currentSection } = useSidebarData();
const rail = computed(() => railPins(resolved.value.shown));
const overflowCurrent = computed(() => rail.value.overflow.some((p) => isCurrent(p.to)));

const menus = useRailMenu();
const { tip, tipEvents } = useRailTip();
const OVERFLOW = 'overflow';
const secKey = (id: SectionId) => `sec:${id}`;

// Wrappers by key, so Esc can put focus back on the icon that opened the menu.
const slots = new Map<string, HTMLElement>();
const setSlot = (key: string, el: unknown) => {
	if (el) slots.set(key, el as HTMLElement);
	else slots.delete(key);
};
function closeMenu(key: string, refocus: boolean) {
	menus.close(key);
	if (refocus) menus.focusIcon(slots.get(key));
}
</script>

<template>
	<div class="rail">
		<div v-if="$slots.mark" class="mark"><slot name="mark" /></div>

		<div class="slot" v-on="tipEvents('Find a record', 'Ctrl K')">
			<button type="button" class="icon" aria-haspopup="dialog" aria-label="Find a record (Ctrl K)" @click="$emit('open-finder')">
				<NavIcon name="search" :size="20" />
			</button>
		</div>

		<div class="slot" :class="{ current: isCurrent(HOME_LINK.to) }" v-on="tipEvents('Home')">
			<AppLink class="icon" active-class="" exact-active-class="" :to="HOME_LINK.to" aria-label="Home" :aria-current="isCurrent(HOME_LINK.to) ? 'page' : undefined">
				<NavIcon :name="HOME_LINK.icon" :size="20" />
			</AppLink>
		</div>

		<div
			v-for="p in rail.shown"
			:key="pinKey(p.ref)"
			class="slot"
			:class="{ current: isCurrent(p.to) }"
			v-on="tipEvents(p.hint ? `${p.label} · ${p.hint}` : p.label)"
		>
			<AppLink
				class="icon pin"
				active-class=""
				exact-active-class=""
				:to="p.to"
				:aria-label="p.hint ? `${p.label}, ${p.hint}` : p.label"
				:aria-current="isCurrent(p.to) ? 'page' : undefined"
			>
				<NavIcon :name="p.icon" :size="18" />
			</AppLink>
		</div>

		<div
			v-if="rail.overflow.length"
			:ref="(el) => setSlot(OVERFLOW, el)"
			class="slot"
			:class="{ current: overflowCurrent, open: menus.openKey.value === OVERFLOW }"
			v-on="menus.pairEvents(OVERFLOW)"
		>
			<button
				type="button"
				class="icon pin more"
				aria-haspopup="true"
				:aria-expanded="menus.openKey.value === OVERFLOW"
				:aria-label="`${rail.overflow.length} more pinned pages`"
				@click="menus.onIconClick(OVERFLOW, $event)"
			>
				+{{ rail.overflow.length }}
			</button>
			<NavHoverMenu
				v-if="menus.openKey.value === OVERFLOW"
				:section="null"
				:pins="resolved.shown"
				:anchor="menus.anchor.value"
				@expand="$emit('request-mode', 'expanded')"
				@close="closeMenu(OVERFLOW, $event)"
			/>
		</div>

		<hr class="divider" />

		<div
			v-for="s in sections"
			:key="s.id"
			:ref="(el) => setSlot(secKey(s.id), el)"
			class="slot"
			:class="{ current: currentSection === s.id, open: menus.openKey.value === secKey(s.id) }"
			v-on="menus.pairEvents(secKey(s.id))"
		>
			<button
				type="button"
				class="icon"
				aria-haspopup="true"
				:aria-expanded="menus.openKey.value === secKey(s.id)"
				:aria-label="s.label"
				@click="menus.onIconClick(secKey(s.id), $event)"
			>
				<NavIcon :name="s.icon" :size="20" />
			</button>
			<NavHoverMenu
				v-if="menus.openKey.value === secKey(s.id)"
				:section="s"
				:anchor="menus.anchor.value"
				@expand="$emit('request-mode', 'expanded', s.id)"
				@close="closeMenu(secKey(s.id), $event)"
			/>
		</div>

		<div class="spacer" />

		<div v-if="collapsible" class="slot" v-on="tipEvents('Expand sidebar')">
			<button type="button" class="icon" aria-label="Expand sidebar" @click="$emit('request-mode', 'expanded')">
				<NavIcon name="panel-left-open" :size="20" />
			</button>
		</div>

		<span v-if="tip" class="tip" aria-hidden="true" :style="{ top: `${tip.top}px`, left: `${tip.left}px` }">
			{{ tip.text }}<kbd v-if="tip.kbd">{{ tip.kbd }}</kbd>
		</span>
	</div>
</template>

<style scoped>
.rail { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.mark { display: flex; align-items: center; justify-content: center; min-height: 44px; margin-bottom: 4px; }

/* One slot per icon: the full 60px of the rail, so the pointer going from icon to menu never leaves it. */
.slot { position: relative; display: flex; align-items: center; justify-content: flex-start; padding: 2px 8px; }
/* The current page (or the section holding it): a 3px bar at the rail's edge. */
.slot.current::before {
	content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 2px 2px 0; background: var(--d1-side-bar);
}

.icon {
	display: inline-flex; flex: none; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
	border: 0; border-radius: 9px; background: none; color: var(--d1-side-dim);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; text-decoration: none; cursor: pointer;
}
.icon.pin { width: 40px; height: 36px; margin: 0 2px; }
.icon:hover, .slot.open > .icon { background: var(--d1-side-hover); color: #fff; }
.slot.current > .icon { background: var(--d1-side-current); color: #fff; }
.icon:focus-visible { outline: 2px solid var(--d1-side-bar); outline-offset: -2px; }

/* The tooltip pill (useRailTip): fixed, beside the icon, vertically centred on it. */
.tip {
	position: fixed; z-index: 60; transform: translateY(-50%); padding: 4px 9px; border-radius: 6px;
	background: var(--d1-side-current); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
	font-size: 13px; line-height: 1.3; white-space: nowrap; pointer-events: none;
}
.tip kbd { margin-left: 8px; font: inherit; font-size: 11px; color: var(--d1-side-dim); }

.divider { width: 28px; height: 0; margin: 8px auto; border: 0; border-top: 1px solid var(--d1-side-hairline); }
.spacer { flex: 1 1 auto; min-height: 12px; }
</style>
