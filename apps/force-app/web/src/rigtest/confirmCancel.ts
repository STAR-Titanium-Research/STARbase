// Cancel is the one destructive control of a run, so the modal and the minimised bar share the same
// confirmation. The default button is "Keep running" (the dialog focuses it for a warning tone).
import { confirmAction } from '../ui/confirm';
import { rigTest } from './rigTestStore';

export async function confirmAndCancelRun(): Promise<void> {
	const ok = await confirmAction({
		title: 'Cancel the rig test?',
		message: 'The run stops now. Steps not yet done are recorded as cancelled, and the result is posted to the issue.',
		confirmLabel: 'Cancel the test',
		cancelLabel: 'Keep running',
		tone: 'warning',
	});
	if (ok) await rigTest.cancel();
}
