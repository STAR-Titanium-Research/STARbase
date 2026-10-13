import { defineModule } from '@directus/extensions-sdk';
import EditFramePage from './EditFramePage.vue';

// The form-only record page that STARbase frames (spec §3.4). Step 0 (spec §9, check b) showed that a
// module page without <private-view> renders with no module bar or navigation. Hidden from the module
// bar: it is only ever opened by URL, /admin/d1-edit/<collection>/<id>.
export default defineModule({
	id: 'd1-edit',
	name: 'Edit (STARbase)',
	icon: 'edit_note',
	hidden: true,
	routes: [{ path: ':collection/:id', component: EditFramePage, props: true }],
});
