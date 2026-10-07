// Pre-flight checklist for the Record page's Start button (R4). Pure: everything it needs comes in
// as `PreflightInput`, so the rules are unit-tested here and the workspace only gathers inputs.
//
// What blocks Start is unchanged and lives elsewhere (the alarm-test gate, the pre-Start disk
// confirm, the NI-DAQ sample-rate limit). The checklist is advice: it says what will go wrong
// BEFORE the cut instead of after it. The one item that asks for an explicit decision is a missing
// Sample ("Start anyway"): an offline cut can be linked to a Sample later, so it is a warning, not
// a block.

import { RAW_BYTES_PER_SAMPLE, RAW_COLUMNS, SUB_NAMES } from './liveClient';

export type PreflightLevel = 'ok' | 'info' | 'warn' | 'fail' | 'skip';
export type PreflightId = 'sample' | 'auth' | 'amp' | 'tacho' | 'disk' | 'channels';

/** Where "Show me" points: a `data-focus` id on this page, or on another route (`?focus=`). */
export interface PreflightFocus { id: string; route?: string }

export interface PreflightItem {
	id: PreflightId;
	label: string;
	level: PreflightLevel;
	/** One plain sentence: what was found and, when it is not ok, what it means. */
	detail: string;
	/** Present when "Show me" has somewhere to go. */
	focus?: PreflightFocus;
}

/** The NI-DAQ page's channel as the checklist needs it (a subset of nidaqApi.Channel). */
export interface ChannelLike { name: string; role?: string; physical: string | null; source?: string }

/** The Record page's channel text as a list: split on newlines or commas, trimmed, blanks dropped
 *  (what Start sends as `nidaq_channels`). */
export function parseChannelList(text: string): string[] {
	return text.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

/** Whether Start sends a list the backend will take literally, so the saved channel model is NOT
 *  what the Channels chip should speak for. Not custom: empty, the default placeholder list, or
 *  the saved model's own physical list (what first-boot autoassign writes into the Record page on
 *  a real rig, so it never equals the default). Only a hand-edited list is custom. Order counts,
 *  as it does for the backend: it is the column order. */
export function isCustomChannelList(text: string, defaults: readonly string[], model: ChannelLike[] | null): boolean {
	const chans = parseChannelList(text);
	if (chans.length === 0) return false;
	const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
	if (same(chans, defaults)) return false;
	if (model) {
		const modelList = model.filter((c) => c.physical && c.source !== 'virtual').map((c) => String(c.physical).trim());
		if (modelList.length > 0 && same(chans, modelList)) return false;
	}
	return true;
}

export interface AmpReading {
	reachable: boolean;
	/** The amp's operation mode as reported ('MEASURE', 'RESET', ...), null when it didn't say. */
	mode: string | null;
	mock?: boolean;
}

export interface PreflightInput {
	source: 'sim' | 'replay' | 'nidaq';
	sampleSet: boolean;
	/** 'server' = a Directus token to upload with, 'offline' = a known user without one. */
	session: 'server' | 'offline' | 'none';
	/** null = not read yet (or the read failed): shown as "not checked", never as a failure. */
	amp: AmpReading | null;
	/** Whether the backend has reported the tacho for this run. Always null before Start today:
	 *  the recorder only measures it once samples flow. */
	tachoOk: boolean | null;
	/** Free space on the capture drive, null = not read yet. */
	diskFreeGb: number | null;
	sampleRate: number;
	/** The saved NI-DAQ channel list, null = not read yet. */
	channels: ChannelLike[] | null;
	/** The Record page's own channel list is not the default one, so Start sends it and the backend
	 *  ignores the saved channel model: checking the model would answer for a different list. */
	channelsCustom?: boolean;
}

/** The recorder force-stops a cut below this much free space (backend session.DISK_STOP_GB), so
 *  that last gigabyte is not recording room. */
export const DISK_RESERVE_GB = 1;
export const RUNWAY_FAIL_MIN = 5;
export const RUNWAY_WARN_MIN = 30;

/** Minutes of recording the free space holds at this rate, or null when it can't be told. */
export function diskRunwayMinutes(freeGb: number | null, sampleRate: number, columns = RAW_COLUMNS): number | null {
	if (freeGb == null || !Number.isFinite(freeGb) || freeGb < 0) return null;
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
	const usableBytes = Math.max(0, freeGb - DISK_RESERVE_GB) * 1e9;
	return usableBytes / (sampleRate * columns * RAW_BYTES_PER_SAMPLE) / 60;
}

export function formatRunway(minutes: number): string {
	if (minutes < 1) return '<1 min';
	if (minutes < 120) return `${Math.round(minutes)} min`;
	const hours = minutes / 60;
	if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
	return `${Math.round(hours / 24)} days`;
}

/**
 * Problems with the saved NI-DAQ channel list that would make a cut wrong or refuse to start.
 * `fail` ones stop the backend (rotating dyno, one input wired to two channels); `warn` ones
 * start anyway on a placeholder input (a core channel with no physical input assigned).
 */
export function channelConfigIssues(channels: ChannelLike[]): { fail: string[]; warn: string[] } {
	const fail: string[] = [];
	const warn: string[] = [];
	if (channels.some((c) => c.name === 'Mz' || c.role === 'Mz')) {
		fail.push('a rotating-dyno layout cannot be recorded yet');
	}
	const seen = new Map<string, string>();
	for (const c of channels) {
		if (!c.physical || c.source === 'virtual') continue;
		const first = seen.get(c.physical);
		if (first) fail.push(`${c.physical} is wired to both ${first} and ${c.name}`);
		else seen.set(c.physical, c.name);
	}
	const unbound = SUB_NAMES.filter((n) => !channels.find((c) => c.name === n)?.physical);
	if (unbound.length === SUB_NAMES.length) warn.push('no inputs are assigned yet');
	else if (unbound.length) warn.push(`no input assigned to ${unbound.join(', ')}`);
	return { fail, warn };
}

export function computePreflight(i: PreflightInput): PreflightItem[] {
	if (i.source === 'replay') return [];
	const items: PreflightItem[] = [];

	items.push(i.sampleSet
		? { id: 'sample', label: 'Sample', level: 'ok', detail: 'A Sample is set.' }
		: {
			id: 'sample', label: 'Sample', level: 'warn', focus: { id: 'sample' },
			detail: 'No Sample is set. The cut can still be recorded and linked to a Sample later, but it cannot be uploaded until it is.',
		});

	if (i.session === 'server') items.push({ id: 'auth', label: 'Signed in', level: 'ok', detail: 'Signed in.' });
	else if (i.session === 'offline') {
		items.push({ id: 'auth', label: 'Offline session', level: 'info', detail: 'Signed in offline: the cut is saved on this PC and uploaded after you sign in again.' });
	} else {
		items.push({ id: 'auth', label: 'Signed in', level: 'warn', detail: 'Not signed in. The cut records fine, but it cannot be uploaded until you sign in.' });
	}

	if (i.source === 'nidaq') {
		items.push(ampItem(i.amp));
		items.push(i.tachoOk === true
			? { id: 'tacho', label: 'Tacho', level: 'ok', detail: 'Tacho pulses seen.' }
			: i.tachoOk === false
				? { id: 'tacho', label: 'Tacho', level: 'warn', detail: 'No tacho pulses seen. RPM will read 0 until they arrive.' }
				: {
					id: 'tacho', label: 'Tacho', level: 'skip',
					detail: 'Not checked: the recorder only sees the tacho once samples are flowing, and raises the Tacho alarm if it stays silent.',
				});
	}

	items.push(diskItem(i.diskFreeGb, i.sampleRate));

	if (i.source === 'nidaq') items.push(channelsItem(i.channels, !!i.channelsCustom));

	return items;
}

function ampItem(amp: AmpReading | null): PreflightItem {
	const focus = { id: 'labamp-url', route: '/labamp' };
	if (!amp) return { id: 'amp', label: 'Lab Amp', level: 'skip', detail: 'Not checked yet.' };
	const tag = amp.mock ? ' (mock amp)' : '';
	if (!amp.reachable) {
		return {
			id: 'amp', label: 'Lab Amp', level: 'warn', focus,
			detail: 'The Lab Amp is not reachable. Start still works, but without its ranges the cut uses the NI-DAQ channel gains if the channel model has them, and is otherwise recorded in volts, not newtons. Nothing can reset or range the amp.',
		};
	}
	if (amp.mode === 'MEASURE') return { id: 'amp', label: 'Lab Amp', level: 'ok', detail: `Connected, in MEASURE${tag}.` };
	return {
		id: 'amp', label: 'Lab Amp', level: 'ok',
		detail: `Connected${amp.mode ? `, in ${amp.mode}` : ''}${tag}. Start resets it and switches it to MEASURE.`,
	};
}

function diskItem(freeGb: number | null, rate: number): PreflightItem {
	const focus = { id: 'sample-rate' };
	const minutes = diskRunwayMinutes(freeGb, rate);
	if (minutes == null) return { id: 'disk', label: 'Disk', level: 'skip', detail: 'Free space not read yet.' };
	const where = `${(freeGb as number).toFixed(1)} GB free, about ${formatRunway(minutes)} at ${Math.round(rate).toLocaleString()} Hz x ${RAW_COLUMNS} channels`;
	if (minutes < RUNWAY_FAIL_MIN) {
		return { id: 'disk', label: 'Disk', level: 'fail', focus, detail: `${where}. Free some space or lower the sample rate.` };
	}
	if (minutes < RUNWAY_WARN_MIN) {
		return { id: 'disk', label: 'Disk', level: 'warn', focus, detail: `${where}. Enough for a short cut only.` };
	}
	return { id: 'disk', label: 'Disk', level: 'ok', detail: `${where}.` };
}

function channelsItem(channels: ChannelLike[] | null, custom: boolean): PreflightItem {
	const focus = { id: 'nidaq-channels', route: '/nidaq' };
	if (custom) {
		return {
			id: 'channels', label: 'Channels', level: 'skip',
			detail: 'Not checked: this Start sends the custom channel list from the Record page, not the saved channel model.',
		};
	}
	if (!channels) return { id: 'channels', label: 'Channels', level: 'skip', detail: 'Channel configuration not read yet.' };
	const { fail, warn } = channelConfigIssues(channels);
	if (fail.length) return { id: 'channels', label: 'Channels', level: 'fail', focus, detail: `Channel configuration problem: ${fail.join('; ')}.` };
	if (warn.length) {
		return {
			id: 'channels', label: 'Channels', level: 'warn', focus,
			detail: `Channel configuration is incomplete: ${warn.join('; ')}. Start falls back to the default input for each.`,
		};
	}
	return { id: 'channels', label: 'Channels', level: 'ok', detail: 'All force channels and the tacho have an input.' };
}

/** Whether the next Start needs the operator's explicit "Start anyway" (a Sample is missing). */
export function needsSampleConfirm(items: readonly PreflightItem[]): boolean {
	return items.some((it) => it.id === 'sample' && it.level === 'warn');
}

/** The items worth a line of their own under the chips: anything that is not simply fine. */
export function attentionItems(items: readonly PreflightItem[]): PreflightItem[] {
	return items.filter((it) => it.level === 'warn' || it.level === 'fail');
}
