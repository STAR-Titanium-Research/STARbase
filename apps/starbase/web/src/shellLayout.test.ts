import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { shortcutMode, useShellLayout } from './shellLayout';

function setup(width: number, prefs: { sidebarCollapsed?: boolean; autoCollapse?: boolean } = {}) {
	const w = ref(width);
	const p = ref({ sidebarCollapsed: false, autoCollapse: true, ...prefs });
	const setPref = vi.fn();
	return { w, p, setPref, shell: useShellLayout({ width: w, prefs: p, setPref }) };
}

describe('the shell layout choice', () => {
	it('at 1280 px, expanded by default: a 224 px column', () => {
		const { shell } = setup(1280);
		expect(shell.mode.value).toBe('expanded');
		expect(shell.sideWidth.value).toBe('224px');
		expect(shell.overlayOpen.value).toBe(false);
	});

	it('at 1280 px, the saved choice rules: rail is a 60 px column', () => {
		const { shell } = setup(1280, { sidebarCollapsed: true });
		expect(shell.mode.value).toBe('rail');
		expect(shell.sideWidth.value).toBe('60px');
	});

	it('a request for the rail at 1280 px saves it as the sidebarCollapsed preference', () => {
		const { shell, setPref } = setup(1280);
		shell.requestMode('rail');
		expect(setPref).toHaveBeenCalledWith('sidebarCollapsed', true);
		shell.requestMode('expanded');
		expect(setPref).toHaveBeenLastCalledWith('sidebarCollapsed', false);
	});

	it('at 900 px it is a 60 px rail, and expanding opens the overlay without saving anything', () => {
		const { shell, setPref } = setup(900);
		expect(shell.mode.value).toBe('rail');
		expect(shell.sideWidth.value).toBe('60px');
		shell.requestMode('expanded');
		expect(shell.overlayOpen.value).toBe(true);
		expect(shell.sideWidth.value).toBe('60px');
		expect(setPref).not.toHaveBeenCalled();
		shell.requestMode('rail');
		expect(shell.overlayOpen.value).toBe(false);
		expect(setPref).not.toHaveBeenCalled();
	});

	it('growing to 1000 px closes the overlay, and shrinking again does not reopen it', async () => {
		const { shell, w } = setup(900);
		shell.requestMode('expanded');
		w.value = 1000;
		await nextTick();
		expect(shell.overlayOpen.value).toBe(false);
		expect(shell.mode.value).toBe('expanded');
		w.value = 900;
		await nextTick();
		expect(shell.overlayOpen.value).toBe(false);
	});

	it('with automatic collapse off, 900 px follows the saved choice and a request is saved', () => {
		const { shell, setPref } = setup(900, { autoCollapse: false });
		expect(shell.mode.value).toBe('expanded');
		shell.requestMode('rail');
		expect(setPref).toHaveBeenCalledWith('sidebarCollapsed', true);
	});

	it('on a phone nothing is asked of the preferences', () => {
		const { shell, setPref } = setup(600);
		expect(shell.layout.value.phone).toBe(true);
		shell.requestMode('rail');
		shell.requestMode('expanded');
		expect(setPref).not.toHaveBeenCalled();
		expect(shell.overlayOpen.value).toBe(false);
	});

	it('an expand request names the section to open; a collapse forgets it', () => {
		const { shell } = setup(1280, { sidebarCollapsed: true });
		shell.requestMode('expanded', 'inventory');
		expect(shell.openSection.value).toBe('inventory');
		shell.requestMode('rail');
		expect(shell.openSection.value).toBeNull();
	});
});

describe('the [ and ] shortcuts', () => {
	const key = (k: string, target: unknown = { tagName: 'BODY' }, extra: object = {}) =>
		({ key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target, ...extra }) as Parameters<typeof shortcutMode>[0];

	it('[ asks for the rail and ] for the expanded sidebar', () => {
		expect(shortcutMode(key('['), false)).toBe('rail');
		expect(shortcutMode(key(']'), false)).toBe('expanded');
		expect(shortcutMode(key('a'), false)).toBeNull();
	});
	it('is silent in text fields, with a modifier, and with a dialog open', () => {
		for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(shortcutMode(key('[', { tagName }), false)).toBeNull();
		expect(shortcutMode(key('[', { tagName: 'DIV', isContentEditable: true }), false)).toBeNull();
		expect(shortcutMode(key('[', undefined, { ctrlKey: true }), false)).toBeNull();
		expect(shortcutMode(key('[', undefined, { altKey: true }), false)).toBeNull();
		expect(shortcutMode(key('['), true)).toBeNull();
		expect(shortcutMode(key('[', undefined, { defaultPrevented: true }), false)).toBeNull();
	});
});
