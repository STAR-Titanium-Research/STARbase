import { beforeEach, describe, expect, it } from 'vitest';
import { AlarmController, parseAlarmConfig } from './alarms';

function makeController(): AlarmController {
	const a = new AlarmController();
	a.config.audioEnabled = false; // no AudioContext in the test environment
	return a;
}

describe('AlarmController.evaluateTacho', () => {
	let a: AlarmController;
	beforeEach(() => {
		a = makeController();
	});

	it('raises a latched alarm when the tacho reports no signal', () => {
		a.evaluateTacho(false);
		expect(a.active.map((x) => x.kind)).toContain('tacho');
		expect(a.tripped).toBe(true);
	});

	it('stays quiet while the tacho is reading, or before the first reading', () => {
		a.evaluateTacho(true);
		a.evaluateTacho(null); // null = no chunk processed yet, not a fault
		expect(a.active).toHaveLength(0);
	});

	it('does not raise twice for one continuous outage', () => {
		a.evaluateTacho(false);
		a.evaluateTacho(false);
		a.evaluateTacho(false);
		expect(a.active.filter((x) => x.kind === 'tacho')).toHaveLength(1);
	});

	it('is gated on the high-RPM alarm being enabled', () => {
		// The tacho check exists to protect the RPM alarm's integrity, so it follows that alarm's
		// switch rather than being a fourth thing to turn off.
		a.config.rpmEnabled = false;
		a.evaluateTacho(false);
		expect(a.active).toHaveLength(0);
	});
});

describe('AlarmController.acknowledge', () => {
	it('acknowledging specific keys leaves a different active key tripped', () => {
		// Regression: acknowledge() used to be a single global boolean, so silencing the alarm(s)
		// shown in a confirmation dialog would ALSO silence any alarm that fired while that (now
		// async, non-blocking) dialog was still open and never actually shown to the operator.
		const a = makeController();
		a.evaluate({ Fx: 500, Fy: 0, Fz: 0 }, 0, 1200); // force:Fx trips (threshold 400)
		a.evaluateTacho(false); // fires while the "confirm" dialog for the force alarm is still open
		expect(a.active).toHaveLength(2);

		a.acknowledge(['force:Fx']); // only what the dialog actually showed
		expect(a.tripped).toBe(true); // tacho was never shown or consented to — still alerting
		expect(a.active.map((x) => x.kind)).toContain('tacho');
	});

	it('acknowledging every currently-active key clears tripped', () => {
		const a = makeController();
		a.evaluateTacho(false);
		a.acknowledge(['tacho']);
		expect(a.tripped).toBe(false);
	});

	it('defaults to acknowledging everything currently active when no keys are given', () => {
		const a = makeController();
		a.evaluate({ Fx: 500, Fy: 0, Fz: 0 }, 0, 1200);
		a.evaluateTacho(false);
		a.acknowledge();
		expect(a.tripped).toBe(false);
	});

	it('reset clears prior acknowledgment so a new instance of the same key trips again', () => {
		const a = makeController();
		a.evaluateTacho(false);
		a.acknowledge(['tacho']);
		a.reset();
		a.evaluateTacho(false);
		expect(a.tripped).toBe(true);
	});
});

describe('AlarmController.evaluate', () => {
	it('trips the RPM alarm off a genuinely measured overspeed', () => {
		const a = makeController();
		a.evaluate({ Fx: 0, Fy: 0, Fz: 0 }, 1300, 1200); // limit = 1200 * 1.02 = 1224
		expect(a.active.map((x) => x.kind)).toContain('rpm');
	});

	it('cannot trip on a fabricated reading equal to the configured speed', () => {
		// Regression guard for the backend fault this pairs with: RPM used to be reported as
		// exactly cfg.rpm whenever the tacho produced no pulses. That value is always below the
		// 1.02x limit, so the alarm could never fire no matter how the spindle actually behaved —
		// evaluateTacho is what surfaces that case now.
		const a = makeController();
		a.evaluate({ Fx: 0, Fy: 0, Fz: 0 }, 1200, 1200);
		expect(a.active).toHaveLength(0);
		a.evaluateTacho(false);
		expect(a.active.map((x) => x.kind)).toContain('tacho');
	});
});

describe('R6 early warning', () => {
	it('fires once at the warning level without latching the alarm', () => {
		const a = makeController(); // limit 400 N, warning at 80 % = 320 N
		a.evaluate({ Fx: 100, Fy: 0, Fz: 0 }, 0, 1200);
		expect(a.warnings).toHaveLength(0);
		a.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 0, 1200);
		a.evaluate({ Fx: 350, Fy: 0, Fz: 0 }, 0, 1200);
		expect(a.warnings.map((w) => w.axis)).toEqual(['Fx']); // once, not per frame
		expect(a.active).toHaveLength(0);
		expect(a.tripped).toBe(false); // nothing to acknowledge, no overlay
	});

	it('stays warned-once after a dismiss, and the real alarm still trips afterwards', () => {
		const a = makeController();
		a.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 0, 1200);
		a.dismissWarnings();
		a.evaluate({ Fx: 340, Fy: 0, Fz: 0 }, 0, 1200);
		expect(a.warnings).toHaveLength(0);
		a.evaluate({ Fx: 410, Fy: 0, Fz: 0 }, 0, 1200);
		expect(a.tripped).toBe(true);
	});

	it('is replaced by the alarm on the same axis, and re-arms on reset', () => {
		const a = makeController();
		a.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 0, 1200);
		a.evaluate({ Fx: 410, Fy: 0, Fz: 0 }, 0, 1200);
		expect(a.warnings).toHaveLength(0);
		a.reset();
		a.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 0, 1200);
		expect(a.warnings).toHaveLength(1);
	});

	it('resetWarnings clears the banner and re-arms, but leaves an unacknowledged alarm tripped', () => {
		const a = makeController();
		a.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 0, 1200);
		a.evaluate({ Fx: 0, Fy: 410, Fz: 0 }, 0, 1200); // Fy alarm, unacknowledged
		expect(a.warnings).toHaveLength(1);
		a.resetWarnings();
		expect(a.warnings).toHaveLength(0);
		expect(a.tripped).toBe(true);
		expect(a.active.map((x) => x.key)).toEqual(['force:Fy']);
		a.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 0, 1200); // re-armed for the next cut
		expect(a.warnings.map((w) => w.axis)).toEqual(['Fx']);
	});

	it('follows the configured percentage and can be switched off', () => {
		const a = makeController();
		a.config.warnPercent = 50;
		a.evaluate({ Fx: 0, Fy: 210, Fz: 0 }, 0, 1200);
		expect(a.warnings.map((w) => w.axis)).toEqual(['Fy']);
		const b = makeController();
		b.config.warnEnabled = false;
		b.evaluate({ Fx: 390, Fy: 0, Fz: 0 }, 0, 1200);
		expect(b.warnings).toHaveLength(0);
		const c = makeController();
		c.config.forceEnabled = false; // no force limit, nothing to warn against
		c.evaluate({ Fx: 390, Fy: 0, Fz: 0 }, 0, 1200);
		expect(c.warnings).toHaveLength(0);
	});
});

describe('R6 stop on force alarm', () => {
	it('does nothing by default', () => {
		const a = makeController();
		let n = 0; a.onForceTrip = () => { n++; };
		a.evaluate({ Fx: 500, Fy: 0, Fz: 0 }, 0, 1200);
		expect(n).toBe(0);
	});

	it('calls stop exactly once per trip when enabled, even for several axes and later frames', () => {
		const a = makeController();
		a.config.stopOnForceAlarm = true;
		let n = 0; a.onForceTrip = () => { n++; };
		a.evaluate({ Fx: 500, Fy: 450, Fz: 0 }, 0, 1200);
		a.evaluate({ Fx: 520, Fy: 460, Fz: 0 }, 0, 1200);
		expect(n).toBe(1);
	});

	it('is not triggered by the warning, RPM, tacho, disk or a test alarm', () => {
		const a = makeController();
		a.config.stopOnForceAlarm = true;
		let n = 0; a.onForceTrip = () => { n++; };
		a.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 1300, 1200); // warning + rpm trip
		a.evaluateTacho(false);
		a.evaluateDisk(0);
		a.test();
		expect(n).toBe(0);
	});
});

describe('parseAlarmConfig', () => {
	it('defaults the new settings when absent (old saved configs)', () => {
		const c = parseAlarmConfig(JSON.stringify({ forceThreshold: 250, rpmEnabled: false }));
		expect(c).toMatchObject({ forceThreshold: 250, rpmEnabled: false, warnEnabled: true, warnPercent: 80, stopOnForceAlarm: false, toneVolume: null });
	});

	it('survives corrupt input field by field', () => {
		expect(parseAlarmConfig('not json').warnPercent).toBe(80);
		expect(parseAlarmConfig('[1,2]').forceThreshold).toBe(400);
		const c = parseAlarmConfig(JSON.stringify({ warnPercent: 150, toneVolume: 'loud', stopOnForceAlarm: 'yes', forceThreshold: 'x', warnEnabled: false }));
		expect(c).toMatchObject({ warnPercent: 80, toneVolume: null, stopOnForceAlarm: false, forceThreshold: 400, warnEnabled: false });
		expect(parseAlarmConfig(JSON.stringify({ toneVolume: 60 })).toneVolume).toBe(60);
		expect(parseAlarmConfig(JSON.stringify({ toneVolume: 0 })).toneVolume).toBeNull();
	});
});
