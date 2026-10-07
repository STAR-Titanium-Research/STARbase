// #42: the report-a-bug form used to keep its draft in ReportBugSettings.vue's own component-local
// refs, so switching Settings tabs (or popping the window out) — either of which unmounts that
// component — silently wiped whatever the operator had already typed. Module-level state (the same
// pattern router.ts uses for lastNonSettingsRoute) survives remounts; only a successful submit
// clears it.
import { ref } from 'vue';

export const draftKind = ref<'bug' | 'feature'>('bug');
// Several areas can apply to one report (#95): chips, not a single select.
export const draftAreas = ref<string[]>(['general']);
export const MAX_AREAS = 4;
export const draftTitle = ref('');
export const draftDescription = ref('');
export const draftIncludeLogs = ref(true);

export function resetDraft(): void {
	draftKind.value = 'bug';
	draftTitle.value = '';
	draftDescription.value = '';
	draftIncludeLogs.value = true;
	// areas intentionally left as-is: the next report is more likely to be filed from a similar
	// place than to want a fresh route-based guess right after submitting one.
}

/** Toggle one area chip. "General / other" is the catch-all: picking it clears the specific areas
 *  and picking a specific area drops it; never empty; at most MAX_AREAS (the backend's cap). */
export function toggleArea(areas: readonly string[], value: string): string[] {
	if (areas.includes(value)) return areas.length > 1 ? areas.filter((a) => a !== value) : [...areas];
	if (value === 'general') return ['general'];
	const next = [...areas.filter((a) => a !== 'general'), value];
	return next.length > MAX_AREAS ? [...areas] : next;
}
