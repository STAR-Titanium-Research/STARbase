// Shared plumbing for the typed recorder-backend clients (labampApi, nidaqApi).
import { getConfig } from './config';

// Read at call time, not captured: Settings > Connectivity can retarget the recorder at runtime.
export function recorderBase(): string { return getConfig().recorderUrl; }

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

// JSON body of an OK response; otherwise throw with the status and the start of the body text.
export async function readJson<T>(res: Response): Promise<T> {
	if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
	return res.json() as Promise<T>;
}
