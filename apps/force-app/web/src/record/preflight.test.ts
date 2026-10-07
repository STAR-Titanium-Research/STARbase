import { describe, expect, it } from 'vitest';
import {
	attentionItems, channelConfigIssues, computePreflight, diskRunwayMinutes, formatRunway, isCustomChannelList, needsSampleConfirm,
	type ChannelLike, type PreflightInput, type PreflightItem,
} from './preflight';

const CORE = ['Fx1', 'Fx2', 'Fy1', 'Fy2', 'Fz1', 'Fz2', 'Fz3', 'Fz4', 'Tacho'];
const goodChannels = (): ChannelLike[] => CORE.map((name, i) => ({ name, physical: `cDAQ1Mod${1 + Math.floor(i / 4)}/ai${i % 4}`, source: 'hardware' }));

function input(over: Partial<PreflightInput> = {}): PreflightInput {
	return {
		source: 'nidaq', sampleSet: true, session: 'server',
		amp: { reachable: true, mode: 'RESET' }, tachoOk: null,
		diskFreeGb: 200, sampleRate: 25000, channels: goodChannels(),
		...over,
	};
}
const byId = (items: PreflightItem[], id: string) => items.find((it) => it.id === id)!;

describe('diskRunwayMinutes', () => {
	it('is free space minus the recorder\'s 1 GB stop floor, over sample rate x 10 columns x 4 bytes', () => {
		// 25 kHz x 10 x 4 B = 1 MB/s; 61 GB free -> 60 GB usable -> 60 000 s = 1000 min.
		expect(diskRunwayMinutes(61, 25000)).toBeCloseTo(1000, 6);
		expect(diskRunwayMinutes(1, 25000)).toBe(0);
		expect(diskRunwayMinutes(0.2, 25000)).toBe(0);
	});
	it('is unknown (null) when the disk or the rate is unknown', () => {
		expect(diskRunwayMinutes(null, 25000)).toBeNull();
		expect(diskRunwayMinutes(-1, 25000)).toBeNull();
		expect(diskRunwayMinutes(NaN, 25000)).toBeNull();
		expect(diskRunwayMinutes(50, 0)).toBeNull();
	});
	it('a higher rate shortens it in proportion', () => {
		expect(diskRunwayMinutes(61, 50000)).toBeCloseTo(500, 6);
	});
});

describe('formatRunway', () => {
	it('reads in minutes, then hours, then days', () => {
		expect(formatRunway(0.2)).toBe('<1 min');
		expect(formatRunway(42.4)).toBe('42 min');
		expect(formatRunway(300)).toBe('5.0 h');
		expect(formatRunway(1000)).toBe('17 h');
		expect(formatRunway(60 * 24 * 5)).toBe('5 days');
	});
});

describe('channelConfigIssues', () => {
	it('a full config has none', () => {
		expect(channelConfigIssues(goodChannels())).toEqual({ fail: [], warn: [] });
	});
	it('refuses a rotating-dyno layout', () => {
		const ch = [...goodChannels(), { name: 'Mz', role: 'Mz', physical: 'cDAQ1Mod3/ai3' }];
		expect(channelConfigIssues(ch).fail[0]).toMatch(/rotating/);
	});
	it('fails when one input feeds two channels', () => {
		const ch = goodChannels();
		ch[1].physical = ch[0].physical;
		expect(channelConfigIssues(ch).fail[0]).toMatch(/wired to both Fx1 and Fx2/);
	});
	it('ignores virtual channels and warns about unbound core channels', () => {
		const ch = goodChannels();
		ch[8].physical = null; // Tacho
		ch.push({ name: 'Sum', physical: null, source: 'virtual' });
		expect(channelConfigIssues(ch)).toEqual({ fail: [], warn: ['no input assigned to Tacho'] });
		expect(channelConfigIssues([]).warn).toEqual(['no inputs are assigned yet']);
	});
});

describe('computePreflight', () => {
	it('is empty for replay: nothing is recorded', () => {
		expect(computePreflight(input({ source: 'replay' }))).toEqual([]);
	});

	it('NI-DAQ with everything in order: six items, none needing attention', () => {
		const items = computePreflight(input());
		expect(items.map((it) => it.id)).toEqual(['sample', 'auth', 'amp', 'tacho', 'disk', 'channels']);
		expect(attentionItems(items)).toEqual([]);
		expect(needsSampleConfirm(items)).toBe(false);
	});

	it('simulated has no amp, tacho or channel items', () => {
		expect(computePreflight(input({ source: 'sim' })).map((it) => it.id)).toEqual(['sample', 'auth', 'disk']);
	});

	describe('Sample', () => {
		it('missing is a warning with a Show me, and needs the explicit Start anyway', () => {
			const items = computePreflight(input({ sampleSet: false }));
			const s = byId(items, 'sample');
			expect(s.level).toBe('warn');
			expect(s.focus).toEqual({ id: 'sample' });
			expect(s.detail).toMatch(/linked to a Sample later/);
			expect(needsSampleConfirm(items)).toBe(true);
		});
		it('applies to the simulator too', () => {
			expect(needsSampleConfirm(computePreflight(input({ source: 'sim', sampleSet: false })))).toBe(true);
		});
	});

	describe('session', () => {
		it('offline is a note, not a warning: the cut is saved and uploaded later', () => {
			const a = byId(computePreflight(input({ session: 'offline' })), 'auth');
			expect(a.level).toBe('info');
			expect(a.detail).toMatch(/uploaded after you sign in/);
		});
		it('no session at all warns', () => {
			expect(byId(computePreflight(input({ session: 'none' })), 'auth').level).toBe('warn');
		});
	});

	describe('Lab Amp', () => {
		it('unread is "not checked", never a failure', () => {
			expect(byId(computePreflight(input({ amp: null })), 'amp').level).toBe('skip');
		});
		it('unreachable warns and points at the amp page', () => {
			const a = byId(computePreflight(input({ amp: { reachable: false, mode: null } })), 'amp');
			expect(a.level).toBe('warn');
			expect(a.focus).toEqual({ id: 'labamp-url', route: '/labamp' });
		});
		it('in MEASURE is simply fine', () => {
			const a = byId(computePreflight(input({ amp: { reachable: true, mode: 'MEASURE' } })), 'amp');
			expect(a).toMatchObject({ level: 'ok', detail: 'Connected, in MEASURE.' });
		});
		it('in RESET is fine too: Start resets it and sets MEASURE itself', () => {
			const a = byId(computePreflight(input()), 'amp');
			expect(a.level).toBe('ok');
			expect(a.detail).toMatch(/Start resets it and switches it to MEASURE/);
		});
		it('says when the amp is the mock', () => {
			const a = byId(computePreflight(input({ amp: { reachable: true, mode: 'MEASURE', mock: true } })), 'amp');
			expect(a.detail).toMatch(/mock amp/);
		});
	});

	describe('tacho', () => {
		it('is skipped, and says why, while the backend has not reported it', () => {
			const t = byId(computePreflight(input({ tachoOk: null })), 'tacho');
			expect(t.level).toBe('skip');
			expect(t.detail).toMatch(/only sees the tacho once samples are flowing/);
		});
		it('uses what the backend reported when it has', () => {
			expect(byId(computePreflight(input({ tachoOk: true })), 'tacho').level).toBe('ok');
			expect(byId(computePreflight(input({ tachoOk: false })), 'tacho').level).toBe('warn');
		});
	});

	describe('disk runway', () => {
		it('shows free space and "~N min at this rate"', () => {
			const d = byId(computePreflight(input({ diskFreeGb: 61 })), 'disk');
			expect(d.level).toBe('ok');
			expect(d.detail).toBe('61.0 GB free, about 17 h at 25,000 Hz x 10 channels.');
		});
		it('warns under 30 minutes and fails under 5, with a Show me to the sample rate', () => {
			// 1 MB/s: 1 + 1.8 GB -> 30 min; 1 + 1.7 GB -> 28 min.
			const warn = byId(computePreflight(input({ diskFreeGb: 2.7 })), 'disk');
			expect(warn.level).toBe('warn');
			expect(warn.detail).toMatch(/about 28 min/);
			const fail = byId(computePreflight(input({ diskFreeGb: 1.2 })), 'disk');
			expect(fail.level).toBe('fail');
			expect(fail.focus).toEqual({ id: 'sample-rate' });
		});
		it('a higher sample rate turns the same disk into a warning', () => {
			expect(byId(computePreflight(input({ diskFreeGb: 100, sampleRate: 25000 })), 'disk').level).toBe('ok');
			expect(byId(computePreflight(input({ diskFreeGb: 100, sampleRate: 3_000_000 })), 'disk').level).toBe('warn');
		});
		it('unread disk is "not read yet", not a failure', () => {
			expect(byId(computePreflight(input({ diskFreeGb: null })), 'disk').level).toBe('skip');
		});
	});

	describe('channel config', () => {
		it('unread is skipped', () => {
			expect(byId(computePreflight(input({ channels: null })), 'channels').level).toBe('skip');
		});
		it('a duplicate input fails and points at the NI-DAQ page', () => {
			const ch = goodChannels();
			ch[3].physical = ch[2].physical;
			const c = byId(computePreflight(input({ channels: ch })), 'channels');
			expect(c.level).toBe('fail');
			expect(c.focus).toEqual({ id: 'nidaq-channels', route: '/nidaq' });
		});
		it('a custom Record-page list is not checked against the saved model', () => {
			const ch = goodChannels();
			ch[3].physical = ch[2].physical;   // would fail
			const c = byId(computePreflight(input({ channels: ch, channelsCustom: true })), 'channels');
			expect(c.level).toBe('skip');
			expect(c.detail).toMatch(/custom channel list/);
		});
		it('an unassigned core channel warns', () => {
			const ch = goodChannels();
			ch[0].physical = null;
			expect(byId(computePreflight(input({ channels: ch })), 'channels').level).toBe('warn');
		});
	});

	it('attentionItems lists the warnings and failures only', () => {
		const items = computePreflight(input({ sampleSet: false, session: 'offline', diskFreeGb: 1.1, amp: null }));
		expect(attentionItems(items).map((it) => `${it.id}:${it.level}`)).toEqual(['sample:warn', 'disk:fail']);
	});
});

describe('isCustomChannelList', () => {
	const defaults = ['cDAQ1Mod1/ai0', 'cDAQ1Mod1/ai1'];
	const model = [
		{ name: 'Fx1', physical: 'Dev1/ai0' }, { name: 'Fx2', physical: 'Dev1/ai1' },
		{ name: 'Fy1', physical: null }, { name: 'V', physical: null, source: 'virtual' },
		{ name: 'Tacho', physical: 'Dev1/ai2' },
	];

	it('empty and the default list are not custom', () => {
		expect(isCustomChannelList('', defaults, null)).toBe(false);
		expect(isCustomChannelList(' \n ', defaults, model)).toBe(false);
		expect(isCustomChannelList('cDAQ1Mod1/ai0\ncDAQ1Mod1/ai1', defaults, null)).toBe(false);
	});

	it('the saved model\'s physical list is not custom, whatever the whitespace or separator', () => {
		expect(isCustomChannelList('Dev1/ai0\nDev1/ai1\nDev1/ai2', defaults, model)).toBe(false);
		expect(isCustomChannelList(' Dev1/ai0, Dev1/ai1 ,Dev1/ai2\n', defaults, model)).toBe(false);
	});

	it('a hand-edited list is custom, including the model list reordered or extended', () => {
		expect(isCustomChannelList('Dev1/ai1\nDev1/ai0\nDev1/ai2', defaults, model)).toBe(true);
		expect(isCustomChannelList('Dev1/ai0\nDev1/ai1\nDev1/ai2\nDev1/ai3', defaults, model)).toBe(true);
		expect(isCustomChannelList('Dev1/ai0\nDev1/ai1', defaults, model)).toBe(true);
	});

	it('before the model has been read, anything but the default is custom', () => {
		expect(isCustomChannelList('Dev1/ai0\nDev1/ai1\nDev1/ai2', defaults, null)).toBe(true);
		expect(isCustomChannelList('Dev1/ai0', defaults, [])).toBe(true);
	});
});
