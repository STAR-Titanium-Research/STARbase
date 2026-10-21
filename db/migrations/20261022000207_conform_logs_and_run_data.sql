-- migrate:up
-- Conform runs, part 2 of 3: `conform_logs` and `conform_run_data`, the run-window overlap guard and their access rules
-- (docs/superpowers/specs/2026-10-21-conform-runs-design.md, "Conform logs and run data"; ADR-0024; plan task A2). Part 1 is
-- the previous migration (the `conform` category), part 3 the form layout.
--
-- A Conform log is the machine's 1 Hz CSV of one session, uploaded once, processed in the browser and stored normalised
-- (the "Conform Logs" folder of Directus Files). Several Conform runs can share one log: each run (conform_run_data, one per
-- operation) owns a run window of the log, with the summary and steps worked out over that window.
--
--   conform_logs      one row per uploaded file: the file, machine, first/last row time, row count, channel catalogue,
--                     whole-log energy totals and the power constants used.
--   conform_run_data  one row per Conform operation: its log, window [window_start, window_end), status, summary, steps.
--                     Deleting the operation deletes this row; deleting the log sets log_id to NULL.
--
-- No overlapping windows. A BEFORE INSERT OR UPDATE trigger refuses a window that overlaps another run's window on the same
-- log, with the message `run window overlaps <operation_code>` (the other operation's pass_code, or its id when it has none),
-- and a window that is not inside [log_start, log_end] (`run window lies outside the log`). A trigger rather than an
-- exclusion constraint, so no btree_gist extension is needed. Windows are half-open [start, end): two windows that touch do
-- not overlap; gaps between windows are allowed; a window may end exactly at the last row's time. Concurrent writers on one
-- log take a transaction advisory lock on the log id, so two runs cannot both claim the same stretch. A window with only one
-- end set, or a run without a log, is not checked (the browser sets both ends together).
--
-- Cross-cutting rows, as every business table gets them (fast_run_data, migration 84, is the model):
--   * audit triggers (121) and optimistic concurrency, `version` + updated_at (010/122);
--   * the Ask-the-database role: SELECT (132) and row security (168): a run is visible to the role when its operation is, and a
--     log when some run of it is;
--   * Lab Member rows (141, 166) and the Lab Viewer read rows (185), from scripts/access_rules.json (`gen_access_rules.py
--     --values --only conform_run_data,conform_logs`, `--viewer-values`):
--       conform_run_data: read = a reader of the operation; create for every member (as machining_force_analysis); update and
--         delete = whoever may edit the operation.
--       conform_logs: read = a reader of ANY run whose log_id is that log, or the member who uploaded it; create for every
--         member (a user who can create operations can insert logs; the system columns are not writable); delete = the
--         uploader (the browser removes the log row, then the file, when an upload fails half-way). No update: a log is never
--         changed after upload. A log shared by runs with different readers shows its whole file to each of them; the run
--         records stay private (accepted by the maintainer; docs/adr/0011-row-level-visibility.md).
--     created_by is stamped by Directus (special user-created, as in 124/177): a member can read and delete the log they just
--     uploaded even before a run is linked to it.
--   * Directus: hidden collections grouped under manufacturing_methods, field rows for every column, the O2M aliases
--     manufacturing_operations.conform_run and conform_logs.runs.
-- conform_logs.directus_files_id is NOT NULL and the foreign key does not cascade: a log row has to be deleted before its file.
-- Directus caches permissions and schema: restart Directus after applying.
SET LOCAL lock_timeout = '10s';

CREATE TABLE conform_logs (
    log_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    directus_files_id UUID NOT NULL REFERENCES directus_files (id),
    equipment_id      UUID REFERENCES equipment (equipment_id) ON DELETE SET NULL,
    source_filename   TEXT NOT NULL,
    log_start         TIMESTAMPTZ NOT NULL,
    log_end           TIMESTAMPTZ NOT NULL,
    n_rows            INTEGER NOT NULL,
    duration_s        NUMERIC NOT NULL,
    series            JSONB NOT NULL,
    totals            JSONB NOT NULL,
    constants         JSONB NOT NULL,
    created_by        UUID REFERENCES directus_users (id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT conform_logs_window_check CHECK (log_end >= log_start),
    CONSTRAINT conform_logs_n_rows_check CHECK (n_rows > 0)
);

CREATE INDEX idx_conform_logs_directus_files_id ON conform_logs (directus_files_id);
CREATE INDEX idx_conform_logs_equipment_log_start ON conform_logs (equipment_id, log_start);

COMMENT ON TABLE conform_logs IS
    'One uploaded Conform machine log (a 1 Hz CSV of ~24 channels), processed in the browser and stored normalised in Directus Files. Several Conform runs can share one log, each through its run window in conform_run_data.';
COMMENT ON COLUMN conform_logs.log_id IS 'Primary key.';
COMMENT ON COLUMN conform_logs.directus_files_id IS 'The normalised CSV in Directus Files ("Conform Logs" folder): time_s, every kept channel, then the four derived power channels. The file is deleted only after its log row.';
COMMENT ON COLUMN conform_logs.equipment_id IS 'The machine the log was recorded on (the Conform machine); NULL when unknown or the machine was deleted.';
COMMENT ON COLUMN conform_logs.source_filename IS 'Name of the file as it was uploaded.';
COMMENT ON COLUMN conform_logs.log_start IS 'Time of the first row of the log, UTC.';
COMMENT ON COLUMN conform_logs.log_end IS 'Time of the last row of the log, UTC.';
COMMENT ON COLUMN conform_logs.n_rows IS 'Number of data rows (one per second).';
COMMENT ON COLUMN conform_logs.duration_s IS 'Last row time minus first row time, seconds.';
COMMENT ON COLUMN conform_logs.series IS 'Channel catalogue, a JSON array of {key, label, unit, group, min, max, flat?}; the plotter reads it with the CSV. flat marks a temperature channel that never leaves 1 degree C of its first value (possibly disconnected).';
COMMENT ON COLUMN conform_logs.totals IS 'Whole-log figures: duration_s, energy_kwh {motor, ips, cooling, total}, avg_demand_kw and missing (power components whose source channel is absent from the log).';
COMMENT ON COLUMN conform_logs.constants IS 'The power constants used to derive the power channels (voltage_v, cos_phi_motor, k_ips, cos_phi_cooling, version). A run summary or log older than the code''s constants version is offered a recompute.';
COMMENT ON COLUMN conform_logs.created_by IS 'Directus user who uploaded the log (set by Directus).';
COMMENT ON COLUMN conform_logs.created_at IS 'When the log was uploaded.';
COMMENT ON COLUMN conform_logs.updated_at IS 'Last update time, maintained by the occ_conform_logs trigger.';
COMMENT ON COLUMN conform_logs.version IS 'Optimistic-concurrency counter, incremented by the occ_conform_logs trigger.';

CREATE TABLE conform_run_data (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id  UUID NOT NULL UNIQUE REFERENCES manufacturing_operations (operation_id) ON DELETE CASCADE,
    log_id        UUID REFERENCES conform_logs (log_id) ON DELETE SET NULL,
    window_start  TIMESTAMPTZ,
    window_end    TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'no_log',
    summary       JSONB,
    steps         JSONB,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    version       INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT conform_run_data_status_check CHECK (status IN ('no_log', 'no_window', 'done', 'error')),
    CONSTRAINT conform_run_data_window_check CHECK (window_start IS NULL OR window_end IS NULL OR window_start < window_end)
);

CREATE INDEX idx_conform_run_data_log_id ON conform_run_data (log_id);

COMMENT ON TABLE conform_run_data IS
    'The machine-log part of one Conform run (one row per Conform operation): which log, the run window of that log, and the summary, energy and steps worked out over that window only. Written by the browser.';
COMMENT ON COLUMN conform_run_data.id IS 'Primary key.';
COMMENT ON COLUMN conform_run_data.operation_id IS 'The Conform operation. One row per operation; deleting the operation deletes this row.';
COMMENT ON COLUMN conform_run_data.log_id IS 'The Conform log this run is a window of; NULL until a log is linked (or after the log was deleted).';
COMMENT ON COLUMN conform_run_data.window_start IS 'Start of the run window, UTC, inclusive. NULL while no window is set.';
COMMENT ON COLUMN conform_run_data.window_end IS 'End of the run window, UTC, exclusive (it may equal the last row time of the log). Windows of runs sharing a log never overlap.';
COMMENT ON COLUMN conform_run_data.status IS 'no_log until a log is linked; no_window while a log is linked but the window is empty; done once the summary is computed; error with error_message when processing failed. Written by the browser.';
COMMENT ON COLUMN conform_run_data.summary IS 'Per-run summary over the run window: duration_s, extruding_s, means and peaks, ips_setpoint_c, energy_kwh {motor, ips, cooling, total}, avg_demand_kw, n_rows, gaps, missing, version.';
COMMENT ON COLUMN conform_run_data.steps IS 'The steps of the run, a JSON array of {start, end, duration_s, ips_setpoint_c, wheel_speed_rpm, wheel/tooling temperature ranges, mean_torque_pct, energy_kwh}: stretches of at least 60 s at one (IPS setpoint, wheel speed demand) pair.';
COMMENT ON COLUMN conform_run_data.error_message IS 'Why processing failed, when status is error.';
COMMENT ON COLUMN conform_run_data.created_at IS 'When the row was created.';
COMMENT ON COLUMN conform_run_data.updated_at IS 'Last update time, maintained by the occ_conform_run_data trigger.';
COMMENT ON COLUMN conform_run_data.version IS 'Optimistic-concurrency counter, incremented by the occ_conform_run_data trigger.';

-- The overlap guard.
CREATE FUNCTION conform_run_data_window_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_start TIMESTAMPTZ;
    v_end   TIMESTAMPTZ;
    v_other TEXT;
BEGIN
    IF NEW.log_id IS NULL OR NEW.window_start IS NULL OR NEW.window_end IS NULL THEN
        RETURN NEW;
    END IF;
    -- One writer at a time per log: two runs cannot both claim the same stretch.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('conform_run_data_window:' || NEW.log_id::text, 0));

    SELECT l.log_start, l.log_end INTO v_start, v_end FROM public.conform_logs l WHERE l.log_id = NEW.log_id;
    IF NEW.window_start < v_start OR NEW.window_end > v_end THEN
        RAISE EXCEPTION 'run window lies outside the log' USING ERRCODE = 'check_violation';
    END IF;

    -- Half-open windows: [a, b) and [c, d) overlap when a < d and c < b.
    SELECT coalesce(mo.pass_code::text, mo.operation_id::text) INTO v_other
    FROM public.conform_run_data o
    JOIN public.manufacturing_operations mo ON mo.operation_id = o.operation_id
    WHERE o.log_id = NEW.log_id AND o.id <> NEW.id
      AND o.window_start IS NOT NULL AND o.window_end IS NOT NULL
      AND o.window_start < NEW.window_end AND NEW.window_start < o.window_end
    ORDER BY o.window_start
    LIMIT 1;
    IF v_other IS NOT NULL THEN
        RAISE EXCEPTION 'run window overlaps %', v_other USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION conform_run_data_window_guard() IS
    'BEFORE INSERT / UPDATE on conform_run_data: refuses a run window that lies outside its log (run window lies outside the log) or overlaps another run''s window on the same log (run window overlaps <operation_code>). Half-open windows [start, end); a run without a log or without both window ends is not checked; writers on one log are serialised by an advisory lock.';

CREATE TRIGGER conform_run_data_window_guard
    BEFORE INSERT OR UPDATE ON conform_run_data
    FOR EACH ROW EXECUTE FUNCTION conform_run_data_window_guard();
COMMENT ON TRIGGER conform_run_data_window_guard ON conform_run_data IS
    'Refuses a run window outside its log or overlapping another run of the same log (half-open windows).';

CREATE TRIGGER occ_conform_logs
    BEFORE UPDATE ON conform_logs
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();
CREATE TRIGGER audit_conform_logs
    AFTER INSERT OR UPDATE OR DELETE ON conform_logs
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
CREATE TRIGGER occ_conform_run_data
    BEFORE UPDATE ON conform_run_data
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();
CREATE TRIGGER audit_conform_run_data
    AFTER INSERT OR UPDATE OR DELETE ON conform_run_data
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
COMMENT ON TRIGGER occ_conform_logs ON conform_logs IS 'Optimistic concurrency: bumps version and updated_at on every update.';
COMMENT ON TRIGGER audit_conform_logs ON conform_logs IS 'Writes every insert, update and delete to audit_logs.';
COMMENT ON TRIGGER occ_conform_run_data ON conform_run_data IS 'Optimistic concurrency: bumps version and updated_at on every update.';
COMMENT ON TRIGGER audit_conform_run_data ON conform_run_data IS 'Writes every insert, update and delete to audit_logs.';

-- The Ask-the-database role: SELECT, and row security that follows the operation (migration 168's pattern). A run is visible
-- when its operation is; a log when some run of it is (an unlinked log is hidden: fail closed). Without the role (a database
-- restored without the cluster's roles) there is nothing to grant or restrict.
DO $do$
DECLARE
    r record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'd1_llm_readonly') THEN
        RAISE NOTICE 'role d1_llm_readonly does not exist: no grants or row security policies created (migration 207)';
        RETURN;
    END IF;
    GRANT SELECT ON conform_logs, conform_run_data TO d1_llm_readonly;
    FOR r IN SELECT * FROM (VALUES
        ('conform_run_data', $e$operation_id IN (SELECT operation_id FROM manufacturing_operations)$e$),
        ('conform_logs',     $e$log_id IN (SELECT log_id FROM conform_run_data)$e$)
    ) AS v (tbl, expr)
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);
        EXECUTE format('DROP POLICY IF EXISTS a1a_open ON public.%I', r.tbl);
        EXECUTE format('CREATE POLICY a1a_open ON public.%I AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)', r.tbl);
        EXECUTE format('DROP POLICY IF EXISTS a1a_llm_hide ON public.%I', r.tbl);
        EXECUTE format('CREATE POLICY a1a_llm_hide ON public.%I AS RESTRICTIVE FOR SELECT TO d1_llm_readonly USING (%s)', r.tbl, r.expr);
        EXECUTE format('COMMENT ON POLICY a1a_open ON public.%I IS %L', r.tbl,
            'A1a (migration 168 pattern): permissive, every command, every role: row security only restricts d1_llm_readonly, through a1a_llm_hide.');
        EXECUTE format('COMMENT ON POLICY a1a_llm_hide ON public.%I IS %L', r.tbl,
            'A1a (migration 168 pattern): the Ask-the-database role sees a Conform run only when its operation is visible to it, and a Conform log only when a visible run uses it.');
    END LOOP;
END
$do$;

-- Directus: hidden collections grouped under manufacturing_methods (like fast_run_data), a field row for every column.
INSERT INTO directus_collections (collection, icon, note, display_template, hidden, "group", sort)
VALUES ('conform_logs', 'show_chart', 'One uploaded Conform machine log (normalised CSV, channel catalogue, whole-log energy)',
        '{{source_filename}}', true, 'manufacturing_methods', 11),
       ('conform_run_data', 'insights', 'Conform run: its log, run window, summary and steps',
        '{{operation_id}} — {{status}}', true, 'manufacturing_methods', 12)
ON CONFLICT (collection) DO NOTHING;

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json, v.readonly, v.hidden, v.sort, v.width,
       v.translations::json, v.note
FROM (VALUES
    ('conform_logs', 'log_id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', NULL, NULL),
    ('conform_logs', 'source_filename', NULL, 'input', NULL, NULL, NULL, true, false, 2, 'half', NULL, NULL),
    ('conform_logs', 'directus_files_id', 'file', 'file', NULL, 'file', NULL, true, false, 3, 'half', NULL, NULL),
    ('conform_logs', 'equipment_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{equipment_name}}","enableCreate":false}', 'related-values', '{"template":"{{equipment_name}}"}', true, false, 4, 'half', NULL, NULL),
    ('conform_logs', 'log_start', NULL, 'datetime', NULL, 'datetime', NULL, true, false, 5, 'half', NULL, NULL),
    ('conform_logs', 'log_end', NULL, 'datetime', NULL, 'datetime', NULL, true, false, 6, 'half', NULL, NULL),
    ('conform_logs', 'n_rows', NULL, 'input', NULL, 'raw', NULL, true, false, 7, 'half', NULL, NULL),
    ('conform_logs', 'duration_s', NULL, 'input', NULL, 'raw', NULL, true, false, 8, 'half', NULL, NULL),
    ('conform_logs', 'series', 'cast-json', 'input-code', NULL, 'raw', NULL, true, true, 20, 'full', NULL, NULL),
    ('conform_logs', 'totals', 'cast-json', 'input-code', NULL, 'raw', NULL, true, true, 21, 'full', NULL, NULL),
    ('conform_logs', 'constants', 'cast-json', 'input-code', NULL, 'raw', NULL, true, true, 22, 'full', NULL, NULL),
    ('conform_logs', 'created_by', 'user-created', 'select-dropdown-m2o', '{"template":"{{first_name}} {{last_name}}"}', 'user', NULL, true, true, 30, 'half', NULL, NULL),
    ('conform_logs', 'created_at', NULL, 'datetime', NULL, 'datetime', NULL, true, true, 31, 'half', NULL, NULL),
    ('conform_logs', 'updated_at', NULL, 'datetime', NULL, 'datetime', NULL, true, true, 32, 'half', NULL, NULL),
    ('conform_logs', 'version', NULL, 'input', NULL, 'raw', NULL, true, true, 33, 'half', NULL, NULL),
    ('conform_logs', 'runs', 'o2m', 'list-o2m', '{"template":"{{operation_id}} — {{status}}","enableCreate":false,"enableSelect":false}', 'related-values', '{"template":"{{status}}"}', true, false, 40, 'full', NULL, NULL),
    ('conform_run_data', 'id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', NULL, NULL),
    ('conform_run_data', 'operation_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{pass_code}}","enableCreate":false}', 'related-values', '{"template":"{{pass_code}}"}', false, false, 2, 'half', NULL, NULL),
    ('conform_run_data', 'status', NULL, 'select-dropdown',
        '{"choices":[{"text":"No log","value":"no_log"},{"text":"No window","value":"no_window"},{"text":"Done","value":"done"},{"text":"Error","value":"error"}]}',
        'labels', NULL, false, false, 3, 'half', NULL, NULL),
    ('conform_run_data', 'log_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{source_filename}}","enableCreate":false}', 'related-values', '{"template":"{{source_filename}}"}', false, false, 4, 'half', NULL, NULL),
    ('conform_run_data', 'window_start', NULL, 'datetime', NULL, 'datetime', NULL, false, false, 5, 'half', NULL, NULL),
    ('conform_run_data', 'window_end', NULL, 'datetime', NULL, 'datetime', NULL, false, false, 6, 'half', NULL, NULL),
    ('conform_run_data', 'error_message', NULL, 'input-multiline', NULL, 'raw', NULL, true, false, 7, 'full', NULL, NULL),
    ('conform_run_data', 'summary', 'cast-json', 'input-code', NULL, 'raw', NULL, true, true, 20, 'full', NULL, NULL),
    ('conform_run_data', 'steps', 'cast-json', 'input-code', NULL, 'raw', NULL, true, true, 21, 'full', NULL, NULL),
    ('conform_run_data', 'created_at', NULL, 'datetime', NULL, 'datetime', NULL, true, true, 30, 'half', NULL, NULL),
    ('conform_run_data', 'updated_at', NULL, 'datetime', NULL, 'datetime', NULL, true, true, 31, 'half', NULL, NULL),
    ('conform_run_data', 'version', NULL, 'input', NULL, 'raw', NULL, true, true, 32, 'half', NULL, NULL),
    -- the O2M back-reference on the operation form (migration 208 files it under Related records)
    ('manufacturing_operations', 'conform_run', 'o2m', 'list-o2m', '{"template":"{{status}}","enableCreate":false,"enableSelect":false}', 'related-values', '{"template":"{{status}}"}', false, false, 52, 'full', '[{"language":"en-US","translation":"Conform run"}]', NULL)
) v (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action)
SELECT v.many_collection, v.many_field, v.one_collection, v.one_field, v.one_deselect_action
FROM (VALUES
    ('conform_run_data', 'operation_id', 'manufacturing_operations', 'conform_run', 'delete'),
    ('conform_run_data', 'log_id', 'conform_logs', 'runs', 'nullify'),
    ('conform_logs', 'directus_files_id', 'directus_files', NULL, 'nullify'),
    ('conform_logs', 'equipment_id', 'equipment', NULL, 'nullify'),
    ('conform_logs', 'created_by', 'directus_users', NULL, 'nullify')
) v (many_collection, many_field, one_collection, one_field, one_deselect_action)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

-- Lab Member and Lab Viewer rows: scripts/access_rules.json, snapshot of `gen_access_rules.py --values --only
-- conform_run_data,conform_logs` and `--viewer-values` on 2026-10-21.
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT v.collection, v.action, v.filter::json, v.validation::json, NULL, v.fields, '20000002-0000-0000-0000-000000000002'
FROM (VALUES
    ('conform_run_data', 'create', '{}', '{}', '*'),
    ('conform_run_data', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('conform_run_data', 'update', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('conform_run_data', 'delete', '{"_and":[{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_or":[{"operation_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}},{"_and":[{"operation_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"access":{"role":{"_in":["edit","manage"]}}}}]},{"_and":[{"operation_id":{"restricted":{"_eq":false}}},{"_or":[{"operation_id":{"sample_id":{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"operation_id":{"sample_id":{"co_owners":{"user_id":{"_eq":"$CURRENT_USER"}}}}},{"_and":[{"operation_id":{"sample_id":{"access":{"person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}}}},{"operation_id":{"sample_id":{"access":{"role":{"_in":["edit","manage"]}}}}}]}]}]}]}]}', '{}', '*'),
    ('conform_logs', 'create', '{}', '{}', 'log_id,directus_files_id,equipment_id,source_filename,log_start,log_end,n_rows,duration_s,series,totals,constants'),
    ('conform_logs', 'read', '{"_or":[{"created_by":{"_eq":"$CURRENT_USER"}},{"runs":{"_some":{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*'),
    ('conform_logs', 'delete', '{"created_by":{"_eq":"$CURRENT_USER"}}', '{}', '*')
) v (collection, action, filter, validation, fields)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002' AND p.collection = v.collection AND p.action = v.action
);
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT v.collection, v.action, v.filter::json, v.validation::json, NULL, v.fields, '20000002-0000-0000-0000-000000000003'
FROM (VALUES
    ('conform_run_data', 'read', '{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}', '{}', '*'),
    ('conform_logs', 'read', '{"_or":[{"created_by":{"_eq":"$CURRENT_USER"}},{"runs":{"_some":{"operation_id":{"readers":{"user_id":{"_eq":"$CURRENT_USER"}}}}}}]}', '{}', '*')
) v (collection, action, filter, validation, fields)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000003' AND p.collection = v.collection AND p.action = v.action
);

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- Dropping the tables drops every Conform log record and run window; the uploaded CSV files stay in Directus Files (delete
-- them there if wanted), and the operations keep their rows. The Directus metadata and permission rows go with them.
DELETE FROM directus_permissions WHERE collection IN ('conform_logs', 'conform_run_data');
DELETE FROM directus_relations WHERE many_collection IN ('conform_logs', 'conform_run_data') OR one_collection IN ('conform_logs', 'conform_run_data');
DELETE FROM directus_fields WHERE collection IN ('conform_logs', 'conform_run_data')
   OR (collection = 'manufacturing_operations' AND field = 'conform_run');
DELETE FROM directus_collections WHERE collection IN ('conform_logs', 'conform_run_data');

-- conform_logs' row security policy reads conform_run_data: it goes first.
DROP POLICY IF EXISTS a1a_llm_hide ON conform_logs;
DROP POLICY IF EXISTS a1a_open ON conform_logs;
DROP POLICY IF EXISTS a1a_llm_hide ON conform_run_data;
DROP POLICY IF EXISTS a1a_open ON conform_run_data;
DROP TRIGGER IF EXISTS audit_conform_run_data ON conform_run_data;
DROP TRIGGER IF EXISTS occ_conform_run_data ON conform_run_data;
DROP TRIGGER IF EXISTS conform_run_data_window_guard ON conform_run_data;
DROP TABLE IF EXISTS conform_run_data;
DROP FUNCTION IF EXISTS conform_run_data_window_guard();
DROP TRIGGER IF EXISTS audit_conform_logs ON conform_logs;
DROP TRIGGER IF EXISTS occ_conform_logs ON conform_logs;
DROP TABLE IF EXISTS conform_logs;
