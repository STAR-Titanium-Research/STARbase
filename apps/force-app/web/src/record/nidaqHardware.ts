// What the attached NI-DAQ hardware can do, shared by the Record page's options form (which edits
// the source and sample rate) and its footer (which owns Start). Module-level so both read one
// answer instead of each fetching its own, and so it survives the panel remounting.
import { reactive } from 'vue';

export interface NidaqDevicesReply {
	simulated?: boolean;
	runtime_available?: boolean;
	hardware_present?: boolean;
	nimax_simulated?: boolean;
}

export const nidaqHardware = reactive({
	/** /nidaq/devices has answered at least once. Until then nothing is disabled — unknown is not
	 *  the same as absent, and the backend may simply be starting up. */
	checked: false,
	hardwarePresent: false,
	runtimeAvailable: false,
	nimaxSimulated: false,
	/** #46/#84: the highest rate the assigned channels' modules can sample at, or null when there
	 *  is no real limit to check (simulated hardware, no DAQmx runtime). */
	maxRateHz: null as number | null,
});

/** Why NI-DAQ can't be picked as the recording source, or null when it can (#86). Only an
 *  explicit answer disables it: a reply from an older backend without the new fields does not. */
export function nidaqUnavailableReason(d: NidaqDevicesReply | null | undefined): string | null {
	if (!d || d.hardware_present === undefined) return null;
	if (d.hardware_present) return null;
	return d.runtime_available
		? 'No NI-DAQ device found. Connect and power the chassis (or add a simulated device in NI MAX), then check again on the NI-DAQ page.'
		: 'The NI-DAQmx driver isn\'t installed on this computer, so there is nothing to record from. Use Simulated, or record on the acquisition PC.';
}

/** Fold a /nidaq/devices reply into the shared state. The NI-DAQ page calls this with each reply it
 *  loads, so "check again on the NI-DAQ page" (see nidaqUnavailableReason) is true: opening or
 *  refreshing that page re-reads the hardware and the Record page's NI-DAQ button follows. */
export function applyNidaqDevices(d: NidaqDevicesReply): void {
	if (d.hardware_present === undefined) return; // older backend: say nothing rather than guess
	nidaqHardware.hardwarePresent = !!d.hardware_present;
	nidaqHardware.runtimeAvailable = !!d.runtime_available;
	nidaqHardware.nimaxSimulated = !!d.nimax_simulated;
	nidaqHardware.checked = true;
}

export async function checkNidaqPresence(baseUrl: string): Promise<void> {
	try {
		const res = await fetch(`${baseUrl}/nidaq/devices`);
		if (!res.ok) return;
		applyNidaqDevices(await res.json());
	} catch { /* backend unreachable — leave it unknown */ }
}

export async function checkMaxSampleRate(baseUrl: string, channels: string[]): Promise<void> {
	if (!channels.length) { nidaqHardware.maxRateHz = null; return; }
	try {
		const res = await fetch(`${baseUrl}/nidaq/max_rate?channels=${encodeURIComponent(channels.join(','))}`);
		nidaqHardware.maxRateHz = res.ok ? (await res.json()).max_rate_hz : null;
	} catch { nidaqHardware.maxRateHz = null; }
}
