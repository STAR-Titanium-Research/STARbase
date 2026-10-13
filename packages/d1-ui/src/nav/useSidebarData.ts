import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useExplorerHost } from '../host';
import { linkActive } from './navState';
import { resolvePins, sectionForPage, sidebarSections } from './sidebarModel';
import { useExplorerNav } from './useExplorerNav';
import { usePins } from './usePins';

// What the expanded sidebar and the rail both draw: the five sections for what this person can see,
// their pins resolved against them, and which page is current. The state behind it (the nav and the
// pins) is shared per host, so calling this from two components fetches nothing twice.
export function useSidebarData() {
	const host = useExplorerHost();
	const { nav, loading, error, refresh } = useExplorerNav(host);
	const pins = usePins();
	const route = useRoute();

	const sections = computed(() => sidebarSections(nav.value));
	// Pins show once they have loaded; until then the list is empty, so nothing flickers in.
	const resolved = computed(() => resolvePins(pins.pins.value, sections.value, pins.records.value));
	const isCurrent = (to: string): boolean => linkActive(to, route.path, route.query);
	const currentSection = computed(() => sectionForPage(sections.value, route.path, route.query));

	return { sections, resolved, isCurrent, currentSection, loading, error, refresh, pins };
}
