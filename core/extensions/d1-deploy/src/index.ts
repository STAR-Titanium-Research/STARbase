import { defineModule } from '@directus/extensions-sdk';
import DeployPage from './DeployPage.vue';

// Shown only to admins. This is convenience: the /d1-deploy endpoint is the real gate.
type MaybeAdmin = { admin_access?: boolean; role?: { admin_access?: boolean } | string | null } | null | undefined;

export default defineModule({
	id: 'd1-deploy',
	name: 'Deploy',
	icon: 'rocket_launch',
	routes: [{ path: '', component: DeployPage }],
	preRegisterCheck(user: unknown) {
		const u = user as MaybeAdmin;
		const role = u?.role;
		return (typeof role === 'object' && role?.admin_access === true) || u?.admin_access === true;
	},
});
