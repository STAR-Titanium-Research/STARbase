import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
	errorText, clampStart, countLabels, isPrintableSample, paginateCounts, renderLabelDocument, slotsPerPage, validateTemplate,
	type LabelEntry, type LabelTemplate,
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
	// Labels whose QR modules are too small to scan reliably (see renderLabelDocument).
	qrDense: number;
}

const DEBOUNCE_MS = 150;

export function useLabelDocument(inputs: {
	// The samples with their copy counts (sampleEntries).
	entries: Ref<LabelEntry[]>;
	start: Ref<number>;
	template: Ref<LabelTemplate | null>;
	// The lab contact for the QR's Contact line (label_settings).
	contactEmail: Ref<string | null>;
}) {
	const doc = ref<LabelDoc | null>(null);
	const problems = computed(() => (inputs.template.value ? validateTemplate(inputs.template.value) : []));
	const rendering = ref(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Set when rendering throws (a QR payload too long for a code, a bad value from the editor): the last good
	// document stays on screen and the page says what failed.
	const error = ref('');

	function render(outline: boolean): LabelDoc | null {
		try {
			return renderNow(outline);
		} catch (e) {
			error.value = `The labels could not be drawn: ${errorText(e)}`;
			return null;
		}
	}

	function renderNow(outline: boolean): LabelDoc | null {
		const t = inputs.template.value;
		if (!t || validateTemplate(t).length) return null;
		const pages = paginateCounts(inputs.entries.value, clampStart(inputs.start.value, slotsPerPage(t)), t);
		const out = renderLabelDocument(pages, t, qrModules, { outline, measure: canvasMeasure(), contactEmail: inputs.contactEmail.value });
		return { html: out.html, labels: countLabels(pages, isPrintableSample), pages: pages.length, clipped: out.clipped, invalid: out.invalid, qrDense: out.qrDense };
	}

	function refresh(): void {
		clearTimeout(timer);
		rendering.value = true;
		timer = setTimeout(() => {
			try {
				error.value = '';
				const next = render(true);
				if (next) doc.value = next;
				else if (!inputs.template.value) doc.value = null;
			} finally {
				rendering.value = false;
			}
		}, DEBOUNCE_MS);
	}

	watch([inputs.entries, inputs.start, inputs.template, inputs.contactEmail], refresh, { deep: true, immediate: true });
	onBeforeUnmount(() => clearTimeout(timer));

	// The print variant: no outlines, rendered now from the current inputs.
	const forPrint = (): LabelDoc | null => {
		error.value = '';
		return render(false);
	};

	return { doc, problems, rendering, error, forPrint };
}
