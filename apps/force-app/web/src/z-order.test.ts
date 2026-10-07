// The safety-alarm banner must stay clickable while any dialog is open: stop-on-alarm opens the
// save dialog with the tone still looping. z-index lives in scoped SFC styles, so this reads them
// from source and pins the ordering rather than rendering (jsdom has no layout/stacking).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function z(file: string, selector: string): number {
	const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
	const esc = selector.replace(/\./g, '\\.');
	const m = new RegExp(`${esc}\\s*\\{[^}]*?z-index:\\s*(\\d+)`).exec(src);
	if (!m) throw new Error(`no z-index found for ${selector} in ${file}`);
	return Number(m[1]);
}

describe('overlay stacking', () => {
	const alarm = z('./record/RecordPage.vue', '.alarm-overlay');
	it('the alarm banner is above every dialog backdrop', () => {
		expect(alarm).toBeGreaterThan(z('./record/panels/SaveCutDialog.vue', '.scd-backdrop'));
		expect(alarm).toBeGreaterThan(z('./settings/EditCaptureMetadataDialog.vue', '.ecm-backdrop'));
		expect(alarm).toBeGreaterThan(z('./nidaq/VirtualChannelBuilder.vue', '.vcb-backdrop'));
		expect(alarm).toBeGreaterThan(z('./AppShell.vue', '.rec-banner'));
	});
	it('the confirm prompt it launches (Silence) is still above the banner', () => {
		expect(z('./ui/ConfirmDialog.vue', '.cd-backdrop')).toBeGreaterThan(alarm);
	});
	it('the offline banner stays above the alarm banner, which is pushed below it', () => {
		const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
		expect(z('./App.vue', '.offline-banner')).toBeGreaterThan(alarm);
		expect(read('./record/RecordPage.vue')).toMatch(/\.alarm-overlay\s*\{[^}]*top:\s*var\(--offline-banner-h/);
		expect(read('./App.vue')).toContain("setProperty('--offline-banner-h'");
	});
});
