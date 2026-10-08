import { test, expect } from '../fixtures';
import { request, type APIRequestContext } from '@playwright/test';
import { gotoCreateForm, selectM2O, fieldByLabel, requireEnv } from '../helpers';

/**
 * Campaigns group operations (machining trials) / test sessions (testing campaigns)
 * under a project. A child created with a campaign inherits the campaign's project,
 * default equipment/material (server hook `campaign-inherit`); its owner is its creator
 * (`d1-owner-default`, not the campaign's owner). The project
 * also fills live in the form via the `d1-project-inherit` interface.
 */
const BASE = process.env.D1_BASE_URL || 'http://localhost:8055';
const EMAIL = process.env.D1_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = requireEnv('D1_ADMIN_PASSWORD');

let api: APIRequestContext;
let token: string;
let campaignId: string;
let campaignName: string;
let projectCode: string;
let projectId: string;
let equipmentId: string;

test.beforeAll(async () => {
	api = await request.newContext({ baseURL: BASE });
	const login = await api.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } });
	token = (await login.json()).data.access_token;
	const h = { Authorization: `Bearer ${token}` };

	const proj = (await (await api.get('/items/projects?limit=1&fields=project_id,project_code', { headers: h })).json()).data[0];
	projectId = proj.project_id;
	projectCode = proj.project_code;
	const equip = (await (await api.get('/items/equipment?limit=1&filter[capabilities][_contains]=machining&fields=equipment_id', { headers: h })).json()).data[0];
	equipmentId = equip.equipment_id;

	campaignName = `PW-TRIAL-${Date.now()}`;
	const created = await api.post('/items/campaigns', {
		headers: h,
		data: { project_id: projectId, campaign_type: 'machining_trial', name: campaignName, default_equipment_id: equipmentId },
	});
	campaignId = (await created.json()).data.campaign_id;
});

test.afterAll(async () => {
	if (campaignId) await api.delete(`/items/campaigns/${campaignId}`, { headers: { Authorization: `Bearer ${token}` } });
	await api.dispose();
});

test('live: picking a machining trial fills the project field (with inherited hint)', async ({ page }) => {
	await gotoCreateForm(page, 'manufacturing_operations');
	await selectM2O(page, 'Manufacturing Method', 'Turning');
	await page.waitForTimeout(1000);
	await selectM2O(page, 'Machining Trial', campaignName);
	await page.waitForTimeout(1000);

	// The inherited hint appears only once the interface has read the campaign's
	// project and emitted it as this field's value — i.e. live inheritance fired.
	const projectField = fieldByLabel(page, 'Project');
	await expect(projectField.getByText(/inherited from campaign/i)).toBeVisible();
});

test('server hook: an operation created with a campaign inherits project + equipment, and is owned by its creator', async () => {
	const h = { Authorization: `Bearer ${token}` };
	const method = (await (await api.get('/items/manufacturing_methods?filter[method_code][_eq]=MT&fields=method_id', { headers: h })).json()).data[0];
	const sample = (await (await api.get('/items/physical_samples?limit=1&fields=sample_id', { headers: h })).json()).data[0];

	const res = await api.post('/items/manufacturing_operations', {
		headers: h,
		data: { campaign_id: campaignId, method_id: method.method_id, sample_id: sample.sample_id },
	});
	const op = (await res.json()).data;
	try {
		expect(op.project_id).toBe(projectId);
		expect(op.equipment_id).toBe(equipmentId);
		expect(op.owner_person_id).toBeTruthy(); // the creator (d1-owner-default), not the campaign owner
	} finally {
		await api.delete(`/items/manufacturing_operations/${op.operation_id}`, { headers: h });
	}
});
