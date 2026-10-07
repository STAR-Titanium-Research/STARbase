import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

const sent: Array<[string, string]> = [];
const fakeWin = { webContents: { send: (channel: string, arg: string) => sent.push([channel, arg]) } };

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: unknown[]) => ({ template }) },
}));

import { applyMenuBarMode, buildMenu } from './menu';

describe('applyMenuBarMode', () => {
  it('hides the bar but lets Alt reveal it (auto-hide), so Help stays reachable', () => {
    const calls: Array<[string, boolean]> = [];
    applyMenuBarMode({
      setAutoHideMenuBar: (v: boolean) => calls.push(['autoHide', v]),
      setMenuBarVisibility: (v: boolean) => calls.push(['visible', v]),
    });
    expect(calls).toContainEqual(['autoHide', true]);
    expect(calls).toContainEqual(['visible', false]);
  });
});

describe('buildMenu', () => {
  it('the Connectivity Doctor item sends a navigate IPC message to the current window', () => {
    const menu = buildMenu(() => fakeWin as unknown as Electron.BrowserWindow) as unknown as {
      template: Array<{ label: string; submenu: Array<{ label: string; click: () => void }> }>;
    };
    const help = menu.template.find((m) => m.label === 'Help')!;
    const doctor = help.submenu.find((m) => m.label === 'Connectivity Doctor')!;
    doctor.click();
    expect(sent).toEqual([['navigate', '/settings?tab=connectivity']]);
  });

  it('the View Logs item routes to the Logs settings tab', () => {
    sent.length = 0;
    const menu = buildMenu(() => fakeWin as unknown as Electron.BrowserWindow) as unknown as {
      template: Array<{ label: string; submenu: Array<{ label: string; click: () => void }> }>;
    };
    const help = menu.template.find((m) => m.label === 'Help')!;
    help.submenu.find((m) => m.label === 'View Logs')!.click();
    expect(sent).toEqual([['navigate', '/settings?tab=logs']]);
  });

  it('does nothing when there is no current window', () => {
    const menu = buildMenu(() => null) as unknown as {
      template: Array<{ label: string; submenu: Array<{ label: string; click: () => void }> }>;
    };
    const help = menu.template.find((m) => m.label === 'Help')!;
    const doctor = help.submenu.find((m) => m.label === 'Connectivity Doctor')!;
    expect(() => doctor.click()).not.toThrow();
  });

  describe('Help menu items (R13)', () => {
    type Item = { label?: string; type?: string; accelerator?: string; click?: () => void };
    const helpItems = (actions = {}): Item[] => {
      const menu = buildMenu(() => fakeWin as unknown as Electron.BrowserWindow, actions) as unknown as {
        template: Array<{ label: string; submenu: Item[] }>;
      };
      return menu.template.find((m) => m.label === 'Help')!.submenu;
    };

    it('lists the existing links and the new items', () => {
      const labels = helpItems().map((i) => i.label).filter(Boolean);
      expect(labels).toEqual([
        'Connectivity Doctor',
        'View Logs',
        'Report a Bug…',
        'Open Captures Folder',
        'Check for Updates…',
        'About Force App',
      ]);
    });

    it('Report a Bug navigates the renderer to the Report a Bug screen', () => {
      sent.length = 0;
      helpItems().find((i) => i.label === 'Report a Bug…')!.click!();
      expect(sent).toEqual([['navigate', '/settings?tab=report-bug']]);
    });

    it('Check for Updates runs the updater check and shows About, where the result appears', () => {
      sent.length = 0;
      const checkForUpdates = vi.fn();
      helpItems({ checkForUpdates }).find((i) => i.label === 'Check for Updates…')!.click!();
      expect(checkForUpdates).toHaveBeenCalledOnce();
      expect(sent).toEqual([['navigate', '/settings?tab=about']]);
    });

    it('Open Captures Folder calls the handler', () => {
      const openCapturesFolder = vi.fn();
      helpItems({ openCapturesFolder }).find((i) => i.label === 'Open Captures Folder')!.click!();
      expect(openCapturesFolder).toHaveBeenCalledOnce();
    });

    it('does not throw when the handlers are not supplied', () => {
      for (const i of helpItems().filter((x) => x.click)) expect(() => i.click!()).not.toThrow();
    });

    it('has accelerators that are unique and do not collide with reload or dev tools', () => {
      const accels = helpItems().map((i) => i.accelerator).filter(Boolean) as string[];
      expect(accels.length).toBeGreaterThan(0);
      expect(new Set(accels).size).toBe(accels.length);
      expect(accels).not.toContain('CmdOrCtrl+R');
      expect(accels).not.toContain('CmdOrCtrl+Shift+I');
    });
  });
});
