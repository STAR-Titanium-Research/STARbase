-- migrate:up
-- edge_code already ends with the edge letter (e.g. CNMG12-1-1A), so the
-- insert_edges list-o2m template "{{edge_code}} – {{edge_identifier}}" showed
-- it twice: "CNMG12-1-1A – A". edge_code alone is the full label.
UPDATE directus_fields
SET    options = '{"template":"{{edge_code}}","enableCreate":true}'
WHERE  collection = 'cutting_inserts' AND field = 'insert_edges';

-- migrate:down
UPDATE directus_fields
SET    options = '{"template":"{{edge_code}} – {{edge_identifier}}","enableCreate":true}'
WHERE  collection = 'cutting_inserts' AND field = 'insert_edges';
