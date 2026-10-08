import fs from 'node:fs';
import path from 'node:path';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const OPEN_POPOUTS_KEY = 'openPopouts';

/** Reads/writes `<userData>/window-state.json` — last-used size/position for the main window and
 * each pop-out kind (keyed by URL pathname, e.g. "/live/force", "/live/frm", "/record"), so
 * reopening a window lands where the operator last put it instead of always resetting to a fixed
 * default. `<userData>` is already per-Windows-user (%LOCALAPPDATA%), so this is per-user for free.
 *
 * Also holds the URLs of the pop-outs that were open when the app last quit (#108), under a key
 * that cannot collide with a pathname key (those all start with "/"). */
export class WindowStateStore {
  private readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'window-state.json');
  }

  private readAll(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  get(key: string): WindowBounds | undefined {
    return this.readAll()[key] as WindowBounds | undefined;
  }

  /** Bounds that could never be a usable placement (see isSaneBounds) are not saved: a window
   * closed while minimised can report an ~-32000 origin or a zero size, and a single such save
   * would send every later window of that kind off-screen (#187). Keeps the previous entry. */
  save(key: string, bounds: WindowBounds): void {
    if (!isSaneBounds(bounds)) return;
    this.write(key, bounds);
  }

  /** Raw, unvalidated: whatever was saved. Callers vet it (see popouts.ts). */
  getOpenPopouts(): unknown {
    return this.readAll()[OPEN_POPOUTS_KEY];
  }

  setOpenPopouts(urls: string[]): void {
    this.write(OPEN_POPOUTS_KEY, urls);
  }

  private write(key: string, value: unknown): void {
    const all = this.readAll();
    all[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2));
    } catch {
      // Best effort — losing remembered window placement is not worth failing over.
    }
  }
}

export interface DisplayArea { x: number; y: number; width: number; height: number }

/** The title-bar strip that must stay reachable: the window's top ~40 px, and at least ~100 px of
 * its width, visible on some display. A window that overlaps a display by a pixel or two (or only
 * by its body, with the title bar above the screen) has nothing the operator can grab to drag it
 * back, so partial overlap is not enough. A window narrower than the minimum needs all of it. */
const TITLE_STRIP_HEIGHT = 40;
const TITLE_STRIP_MIN_VISIBLE_WIDTH = 100;
const TITLE_STRIP_MIN_VISIBLE_HEIGHT = 20;

/** Would a window at these bounds land on a screen the machine currently has, with its title bar
 * reachable?
 *
 * Guards two ways a saved position goes stale: a monitor that has since been undocked (the saved
 * rect sits in coordinates no display covers any more), and the ≈ -32000 origin Windows reports
 * for a minimized window. Either one would otherwise reopen the app somewhere the operator cannot
 * see or reach it. Bounds with no saved x/y are fine — Electron places those itself. An empty
 * display list means we could not enumerate screens, in which case honouring the saved placement
 * beats discarding it. The overlap only needs to be partial (straddling two monitors is
 * legitimate), but the title-bar strip must intersect some display's work area by enough to grab. */
export function isOnSomeDisplay(bounds: WindowBounds, displays: DisplayArea[]): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return true;
  if (displays.length === 0) return true;
  const x = bounds.x;
  const y = bounds.y;
  const stripH = Math.min(TITLE_STRIP_HEIGHT, bounds.height);
  const needW = Math.min(TITLE_STRIP_MIN_VISIBLE_WIDTH, bounds.width);
  const needH = Math.min(TITLE_STRIP_MIN_VISIBLE_HEIGHT, stripH);
  return displays.some((d) => {
    const visW = Math.min(x + bounds.width, d.x + d.width) - Math.max(x, d.x);
    const visH = Math.min(y + stripH, d.y + d.height) - Math.max(y, d.y);
    return visW >= needW && visH >= needH;
  });
}

/** Windows reports an origin of about -32000 (and sometimes a zero size) for a minimised window. */
const MINIMISED_ORIGIN = -30000;
const MIN_WINDOW_SIZE = 200;
const MAX_WINDOW_SIZE = 20000;

/** Window sizes used when nothing usable was saved. */
export const DEFAULT_MAIN_SIZE = { width: 1500, height: 950 };
export const DEFAULT_POPOUT_SIZE = { width: 1400, height: 900 };

/** Is this a usable window size? False for a missing, zero or absurd width or height. */
export function saneSize(width: unknown, height: unknown): boolean {
  const ok = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= MIN_WINDOW_SIZE && v <= MAX_WINDOW_SIZE;
  return ok(width) && ok(height);
}

/** Could these bounds ever be a real placement? False for a missing/zero/absurd size, and for an
 * x or y at or beyond the minimised-window origin (#187). Read and write sides both use it, since
 * window-state.json may already hold a bad entry written by an older version. */
export function isSaneBounds(b: unknown): b is WindowBounds {
  if (!b || typeof b !== 'object') return false;
  const { x, y, width, height } = b as Record<string, unknown>;
  const coordOk = (v: unknown): boolean =>
    v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > MINIMISED_ORIGIN);
  return saneSize(width, height) && coordOk(x) && coordOk(y);
}

/** The size/position options to open a window with (the main window or a pop-out), from what was
 * saved for it. Size is kept when sane; x/y only when the rect also lands on a display the machine
 * has now (an undocked monitor leaves coordinates no screen covers). With no x/y Electron places
 * the window itself, so a stale position degrades to "centred", never to "off-screen" (#187). */
export function placementFor(
  saved: unknown,
  displays: DisplayArea[],
): { x?: number; y?: number; width?: number; height?: number } {
  if (!saved || typeof saved !== 'object') return {};
  const b = saved as WindowBounds;
  // Size alone is usable even when the position is not, so test the size on its own first.
  if (!saneSize(b.width, b.height)) return {};
  // A size saved on a bigger display (2560x1440) must not outgrow the biggest one present now, or
  // Electron centres it at negative coordinates with the title bar off-screen. No displays
  // reported means we cannot tell, so keep the saved size.
  const biggest = displays.reduce<DisplayArea | undefined>(
    (best, d) => (!best || d.width * d.height > best.width * best.height ? d : best), undefined);
  const size = biggest
    ? { width: Math.min(b.width, biggest.width), height: Math.min(b.height, biggest.height) }
    : { width: b.width, height: b.height };
  if (!isSaneBounds(b) || b.x === undefined || b.y === undefined) return size;
  return isOnSomeDisplay({ x: b.x, y: b.y, ...size }, displays) ? { x: b.x, y: b.y, ...size } : size;
}
