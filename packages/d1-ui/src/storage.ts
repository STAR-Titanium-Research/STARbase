// localStorage for per-device preferences (the View rail's open state and settings): null where there is none
// (a server render, a test) or where reading the property itself throws (blocked site data). Every read and
// write through it is still wrapped in try/catch by the caller.
export function browserStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}
