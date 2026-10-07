// LabAmp page state that outlives the page (#109). The page used to hold status/config/sensors in
// component refs and refetch all three, one after another, on every mount -- so each visit showed
// "No channel data" until the amp answered. This keeps the last-known snapshot at module level
// (shown at once on the next visit) and refreshes it in the background.
import { createSwr } from '../ui/swr';
import { labamp, type LabAmpConfig, type LabAmpStatus, type SensorRow } from '../record/labampApi';

export interface LabAmpSnapshot {
	status: LabAmpStatus;
	config: LabAmpConfig;
	sensors: SensorRow[];
}

type LabAmpReads = Pick<typeof labamp, 'status' | 'getConfig' | 'sensors'>;

export async function loadSnapshot(api: LabAmpReads): Promise<LabAmpSnapshot> {
	// Status and config don't depend on each other, so they go out together. Sensors still waits on
	// status: asking an unreachable amp for its sensors only adds a timeout to the refresh.
	const [status, config] = await Promise.all([api.status(), api.getConfig()]);
	const sensors = status.reachable ? (await api.sensors()).sensors : [];
	return { status, config, sensors };
}

export const labampState = createSwr<LabAmpSnapshot>(() => loadSnapshot(labamp));
