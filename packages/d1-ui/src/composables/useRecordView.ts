import { inject, provide, reactive, watch } from 'vue';
import type { InjectionKey } from 'vue';
import { readRecordView, writeRecordView } from '../record/recordView';
import type { RecordView } from '../record/recordView';

// The View rail's settings of a record page, handed down the page: the page calls provideRecordView
// once, and RecordViewRail changes it, RecordLayout (panels), Section (empty sections), PageContents
// (the hidden count) and DataTable (density) read it. Outside such a page nothing is provided and each
// of them keeps its own behaviour.
const KEY: InjectionKey<RecordView> = Symbol('d1-record-view');

/** Called in a page's setup. Starts from what this device remembers for the kind ("sample") and remembers every change. */
export function provideRecordView(kind: string): RecordView {
	const view = reactive<RecordView>(readRecordView(kind));
	watch(view, () => writeRecordView(kind, view));
	provide(KEY, view);
	return view;
}

export function useRecordView(): RecordView | null {
	return inject(KEY, null);
}
