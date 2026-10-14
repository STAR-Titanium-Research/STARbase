// Debug context for bug reports. installCapture() runs when the app starts (apps/starbase/web
// main.ts), not when the Report page opens: by the time someone reports a problem the interesting
// console output is already behind them. Everything stays in memory until the reporter files a
// report and chooses to attach it.
export const MAX_LINES = 200;
export const MAX_LINE = 1000;
const buffer: string[] = [];
let installed = false;

// One console argument as text: strings as they are, errors with their stack, anything else as JSON.
export function argText(a: unknown): string {
	if (typeof a === 'string') return a;
	if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
	try {
		return JSON.stringify(a) ?? String(a);
	} catch {
		return String(a);
	}
}

export function record(level: string, args: unknown[], now: Date = new Date()): void {
	try {
		const text = args.map(argText).join(' ').slice(0, MAX_LINE);
		buffer.push(`${now.toISOString()} ${level} ${text}`);
		if (buffer.length > MAX_LINES) buffer.shift();
	} catch {
		// capturing a line must never break the app that produced it
	}
}

export function installCapture(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	for (const level of ['warn', 'error'] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			record(level.toUpperCase(), args);
			original(...args);
		};
	}
	window.addEventListener('error', (e) => record('ERROR', [e.error?.stack || e.message]));
	window.addEventListener('unhandledrejection', (e) => {
		const r = e.reason as { stack?: string; message?: string } | undefined;
		record('UNHANDLED', [r?.stack || r?.message || String(e.reason)]);
	});
}

export function getConsoleTail(): string {
	return buffer.join('\n');
}

export function clearCapture(): void {
	buffer.length = 0;
}

// The page's address without its query or hash (filters, ids and tokens can ride there).
export function safeLocation(loc: { origin: string; pathname: string }): string {
	return `${loc.origin}${loc.pathname}`;
}

export function getDiagnostics(): string {
	const nav = navigator;
	return [
		`Browser: ${nav.userAgent}`,
		`Page: ${safeLocation(window.location)}`,
		`Viewport: ${window.innerWidth}x${window.innerHeight} (dpr ${window.devicePixelRatio})`,
		`Language: ${nav.language}`,
		`Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
		`Online: ${nav.onLine}`,
		`Reported at: ${new Date().toISOString()}`,
	].join('\n');
}
