// Directus hook: campaign-inherit
//
// Campaigns (machining trials / testing campaigns) group children under a project
// and carry defaults. When a child is created with a campaign set, it inherits the
// campaign's project, default equipment and (for operations) default material so
// the user doesn't re-enter them. Ownership is NOT inherited: the owner defaults to
// the logged-in user (d1-owner-default); inheriting it is an explicit
// "same as parent" choice in the form (d1-owner-picker).

const CHILD_COLLECTIONS = new Set(['manufacturing_operations', 'test_sessions']);

const isBlank = (v) => v === undefined || v === null || v === '';

export default ({ filter }) => {
  filter('items.create', async (payload, meta, context) => {
    const collection = meta?.collection;
    const db = context?.database;
    if (!db || !payload) return payload;

    if (CHILD_COLLECTIONS.has(collection) && !isBlank(payload.campaign_id)) {
      const campaign = await db('campaigns')
        .where('campaign_id', payload.campaign_id)
        .select('project_id', 'default_equipment_id', 'default_material_id')
        .first();
      if (campaign) {
        if (isBlank(payload.project_id) && campaign.project_id) payload.project_id = campaign.project_id;
        if (isBlank(payload.equipment_id) && campaign.default_equipment_id) {
          payload.equipment_id = campaign.default_equipment_id;
        }
        // Only manufacturing_operations carries a material column.
        if (collection === 'manufacturing_operations'
          && isBlank(payload.material_id) && campaign.default_material_id) {
          payload.material_id = campaign.default_material_id;
        }
      }
    }

    return payload;
  });
};
