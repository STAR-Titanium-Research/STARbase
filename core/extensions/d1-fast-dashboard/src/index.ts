import { defineModule } from '@directus/extensions-sdk';
import DirectusFastDashboard from './DirectusFastDashboard.vue';

// Standalone FAST (spark-plasma sintering) explorer, styled like the FRM force
// dashboard: sample -> operation -> sintering metadata -> a responsive grid of up
// to six multi-series plots of the normalised machine trace. Reads the fast_run_data
// rows (canonical CSV + series catalog) populated by scripts/fast_orchestrator.py.
export default defineModule({
	id: 'd1-fast-dashboard',
	name: 'FAST Analysis',
	icon: 'whatshot',
	routes: [{ path: '', component: DirectusFastDashboard }],
});
