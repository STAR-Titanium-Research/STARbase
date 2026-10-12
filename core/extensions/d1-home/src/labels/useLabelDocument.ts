import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
	clampCopies, clampStart, countLabels, isPrintableSample, paginate, renderLabelDocument, slotsPerPage, validateTemplate,
	type LabelSample, type LabelTemplate,
} from '@d1/ui';
import { canvasMeasure } from './measure';
import { qrModules } from './qr';

// The one label document behind both the preview and the print: the selected samples, spread over the pages
// of the template by the pure @d1/ui logic, rendered to an HTML string. The preview shows it with outlines
// (screen only); the print renders it again without, from the same inputs.
//
// A template with problems (a half-typed number in the editor) renders nothing new: the last good document
// stays on screen and `problems` says what is wrong.

export interface LabelDoc {
	html: string;
	labels: number;
	pages: number;
	clipped: number;
	invalid: number;
}

const DEBOUNCE_MS = 150;

export function useLabelDocument(inputs: {
	samples: Ref<LabelSample[]>;
	copies: Ref<number>;
	start: Ref<number>;
	template: Ref<LabelTemplate | null>;
}) {
	const doc = ref<LabelDoc | null>(null);
	const problems = computed(() => (inputs.template.value ? validateTemplate(inputs.template.value) : []));
	const rendering = ref(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function render(outline: boolean): LabelDoc | null {
		const t = inputs.template.value;
		if (!t || validateTemplate(t).length) return null;
		const pages = paginate(
			inputs.samples.value,
			{ copies: clampCopies(inputs.copies.value), start: clampStart(inputs.start.value, slotsPerPage(t)) },
			t,
		);
		const out = renderLabelDocument(pages, t, qrModules, { outline, measure: canvasMeasure() });
		return { html: out.html, labels: countLabels(pages, isPrintableSample), pages: pages.length, clipped: out.clipped, invalid: out.invalid };
	}

	function refresh(): void {
		clearTimeout(timer);
		rendering.value = true;
		timer = setTimeout(() => {
			const next = render(true);
			if (next) doc.value = next;
			else if (!inputs.template.value) doc.value = null;
			rendering.value = false;
		}, DEBOUNCE_MS);
	}

	watch([inputs.samples, inputs.copies, inputs.start, inputs.template], refresh, { deep: true, immediate: true });
	onBeforeUnmount(() => clearTimeout(timer));

	// The print variant: no outlines, rendered now from the current inputs.
	const forPrint = (): LabelDoc | null => render(false);

	return { doc, problems, rendering, forPrint };
}
