<script setup lang="ts">
// A rail hover menu (explorer-sidebar-b2 spec, decision 7): the panel beside a rail icon. It opens
// level with the icon, just right of the rail, 224px wide and at most 480px tall (it scrolls inside).
// Its first row is the section's header (icon, name, chevron): a click expands the sidebar with that
// section open. Under it the section's pages, the same rows as the expanded accordion (sub-headings,
// saved views, pin buttons). With `pins` and no section it is the rail's "+n" overflow list instead.
//
// It is not teleported: it stays a DOM descendant of its icon's wrapper, so the pointer moving from
// the icon into the menu never leaves the pair. It only reports (`expand`, `close`); the rail decides.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import NavIcon from './NavIcon.vue';
import SidebarRow from './SidebarRow.vue';
import { pinKey } from './sidebarModel';
import type { PinRef, ResolvedPin, SidebarLink, SidebarSection, SidebarView } from './sidebarModel';
import { placeMenu, scrollMovedAnchor } from './railMenu';
import { viewAsRow } from './sidebarRows';
import { useSidebarData } from './useSidebarData';

const props = defineProps<{
	section: SidebarSection | null;
	pins?: ResolvedPin[];
	// The icon's wrapper, in viewport pixels: its top and the rail's right edge place the menu.
	anchor: DOMRect | null;
}>();
// `close(true)` is Esc (focus goes back to the icon); a click on a page or a window change closes without it.
const emit = defineEmits<{ (e: 'expand', sectionId: string | null): void; (e: 'close', refocus: boolean): void }>();

const { isCurrent, pins: pinState } = useSidebarData();
const pinsReady = computed(() => pinState.loaded.value);

const title = computed(() => props.section?.label ?? 'Pinned');
const icon = computed(() => props.section?.icon ?? 'pin');
const noun = computed(() => (props.section ? props.section.label : 'Pinned pages'));

const menu = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0, maxHeight: 480 });

function place() {
	const a = props.anchor;
	if (!a) return;
	pos.value = placeMenu({
		anchorTop: a.top,
		edge: a.right,
		menuHeight: menu.value?.offsetHeight ?? 0,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
	});
}

const togglePin = (ref_: PinRef | null) => {
	if (ref_ && pinsReady.value) void pinState.toggle(ref_);
};
const linkKey = (l: SidebarLink) => l.to;
const viewKey = (v: SidebarView) => `view:${v.id}`;

// Fixed to the window, so it would be left behind by a scroll that moves its icon, or by a resize.
function onWindowChange(e: Event) {
	if (e.type === 'scroll') {
		if (menu.value?.contains(e.target as Node)) return;
		// The icon's wrapper is the menu's parent; a scroll that left it in place (focus revealing the
		// icon in a scrolled rail) keeps the menu open.
		const wrapper = menu.value?.parentElement;
		if (wrapper && props.anchor && !scrollMovedAnchor(props.anchor.top, wrapper.getBoundingClientRect().top + 2)) return;
	}
	emit('close', false);
}
function onKeydown(e: KeyboardEvent) {
	if (e.key !== 'Escape') return;
	e.stopPropagation();
	emit('close', true);
}
// Choosing a page closes the menu; a pin button or the empty space does not.
function onClick(e: MouseEvent) {
	if ((e.target as Element).closest('a.link')) emit('close', false);
}

onMounted(async () => {
	place();
	await nextTick();
	place();
	window.addEventListener('resize', onWindowChange);
	window.addEventListener('scroll', onWindowChange, true);
});
onBeforeUnmount(() => {
	window.removeEventListener('resize', onWindowChange);
	window.removeEventListener('scroll', onWindowChange, true);
});
watch(() => props.anchor, place);
</script>

<template>
	<div
		ref="menu"
		class="hover-menu"
		role="group"
		:aria-label="noun"
		:style="{ left: `${pos.left}px`, top: `${pos.top}px`, maxHeight: `${pos.maxHeight}px` }"
		@keydown="onKeydown"
		@click="onClick"
	>
		<button type="button" class="head" :aria-label="`${title}: expand the sidebar`" @click="emit('expand', section?.id ?? null)">
			<NavIcon :name="icon" />
			<span class="name">{{ title }}</span>
			<NavIcon name="chevron-right" :size="14" class="chev" />
		</button>

		<div class="body">
			<template v-if="section">
				<template v-for="g in section.groups" :key="g.id">
					<h3 v-if="g.label" class="sub">{{ g.label }}</h3>
					<ul class="rows">
						<li v-for="link in g.links" :key="linkKey(link)">
							<SidebarRow
								:item="link"
								variant="section"
								plain
								:pinned="!!link.pin && pinState.isPinned(link.pin)"
								:current="isCurrent(link.to)"
								:pins-ready="pinsReady"
								@toggle-pin="togglePin(link.pin)"
								@dragstart="$event.preventDefault()"
							/>
							<ul v-if="link.views.length" class="rows" :aria-label="`${link.label} saved views`">
								<li v-for="view in link.views" :key="viewKey(view)">
									<SidebarRow
										:item="viewAsRow(link, view)"
										variant="section"
										plain
										nested
										:pinned="pinState.isPinned(view.pin)"
										:current="isCurrent(view.to)"
										:pins-ready="pinsReady"
										@toggle-pin="togglePin(view.pin)"
										@dragstart="$event.preventDefault()"
									/>
								</li>
							</ul>
						</li>
					</ul>
				</template>
			</template>
			<ul v-else class="rows">
				<li v-for="p in pins ?? []" :key="pinKey(p.ref)">
					<SidebarRow
						:item="p"
						variant="section"
						plain
						:pinned="true"
						:current="isCurrent(p.to)"
						:pins-ready="pinsReady"
						@toggle-pin="togglePin(p.ref)"
						@dragstart="$event.preventDefault()"
					/>
				</li>
			</ul>
		</div>
	</div>
</template>

<style scoped>
.hover-menu {
	position: fixed;
	z-index: 50;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	width: 224px;
	overflow: hidden;
	border: 1px solid #2a3644;
	border-left: 0;
	border-radius: 0 8px 8px 0;
	background: var(--d1-side-ground);
	color: var(--d1-side-text);
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
	font: inherit;
	font-size: var(--fs-md, 13px);
	line-height: 1.4;
	text-align: left;
}
.head {
	display: flex;
	flex: none;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 40px;
	padding: 0 10px;
	border: 0;
	border-bottom: 1px solid #2a3644;
	background: #1a232d;
	color: #fff;
	font: inherit;
	font-weight: 600;
	text-align: left;
	cursor: pointer;
}
.head:hover { background: var(--d1-side-current); }
.head:focus-visible { outline: 2px solid var(--d1-side-bar); outline-offset: -2px; }
.head :deep(.d1-nav-icon) { color: var(--d1-side-dim); }
.name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { margin-left: auto; }

.body { min-height: 0; overflow-y: auto; padding: 4px 6px 6px; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li { position: relative; }
.sub {
	display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; padding: 0 8px;
	font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--d1-side-sub);
}
.sub::after { content: ''; flex: 1 1 auto; height: 1px; background: var(--d1-side-hairline); }
</style>
