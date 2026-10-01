-- Reference seed data — idempotent (ON CONFLICT DO NOTHING).
-- Load with: psql $DATABASE_URL -f db/seeds/001_reference_data.sql
-- or via: make seed

-- ---------------------------------------------------------------------------
-- ISO material-group classifications
-- ---------------------------------------------------------------------------
INSERT INTO material_iso_classifications (iso_code, description, colour_hex) VALUES
    ('P', 'Steel and cast steel — long continuous chips',        '#0066CC'),
    ('M', 'Stainless steel — long to medium chips',             '#F5C400'),
    ('K', 'Cast iron — short chips',                            '#FF3300'),
    ('N', 'Non-ferrous metals — aluminium, copper alloys',      '#00CC44'),
    ('S', 'Super alloys and titanium — difficult to machine',   '#FF9900'),
    ('H', 'Hardened steel and chilled cast iron',               '#888888')
ON CONFLICT (iso_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Key alloys from the Alloy Codes sheet (representative subset)
-- ---------------------------------------------------------------------------
INSERT INTO materials
    (alloy_code, common_name, iso_code, density_g_per_cm3, export_controlled)
VALUES
    ('AA',   'Ti-6Al-4V Grade 5',               'S', 4.430, FALSE),
    ('AB',   'Ti-6Al-4V Grade 23 (ELI)',        'S', 4.420, FALSE),
    ('AC',   'Commercially Pure Ti Grade 2',     'S', 4.510, FALSE),
    ('BA',   'Inconel 718',                      'S', 8.190, FALSE),
    ('BB',   'Inconel 625',                      'S', 8.440, FALSE),
    ('CA',   'AISI 4340 Steel',                  'P', 7.850, FALSE),
    ('CB',   'AISI 316L Stainless Steel',        'M', 7.990, FALSE),
    ('DA',   'RR1000 Ni Superalloy',             'S', 8.500, TRUE),
    ('EA',   'Al 7075-T6',                       'N', 2.810, FALSE),
    ('H13A', 'AISI H13 Tool Steel',              'P', 7.760, FALSE)
ON CONFLICT (alloy_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Manufacturing methods
-- ---------------------------------------------------------------------------
INSERT INTO manufacturing_methods (method_code, method_name, description) VALUES
    ('MF', 'FAST/SPS Sintering',
     'Field-Assisted Sintering Technique / Spark Plasma Sintering. '
     'Consolidates powder feedstock under combined pressure and pulsed DC current.'),
    ('MO', 'Forging',
     'Hot or cold forging to shape billets under compressive force.'),
    ('MR', 'Rolling',
     'Rolling to reduce cross-section and improve microstructure.'),
    ('MC', 'CNC Turning',
     'Conventional or CNC single-point turning on a lathe.'),
    ('MM', 'CNC Milling',
     'CNC milling (end milling, face milling) on a machining centre.'),
    ('HT', 'Heat Treatment',
     'Annealing, solution treatment, ageing, or stress relief cycles.'),
    ('GR', 'Grinding',
     'Surface or cylindrical grinding for final dimensional accuracy.')
ON CONFLICT (method_code) DO NOTHING;

-- (method_parameters seed removed — table dropped in migration 039)

-- ---------------------------------------------------------------------------
-- Equipment (representative — from Machines sheet, 7 records)
-- ---------------------------------------------------------------------------
-- capabilities decides which operations and tests offer the machine in the Machine picker
-- (see the column COMMENT). Without it none of these would be selectable on a dev stack. Grinding
-- maps to no process category yet, so the grinder has none.
INSERT INTO equipment (equipment_code, equipment_name, equipment_type, capabilities) VALUES
    ('FAST-001',    'FAST/SPS Press Unit 1',    'FAST_Press',      'sintering'),
    ('NLX-2500',    'DMG Mori NLX-2500/700',   'CNC_Lathe',       'machining'),
    ('VF-2',        'Haas VF-2 VMC',            'CNC_Mill',        'machining'),
    ('SEM-001',     'Scanning Electron Microscope', 'SEM',         'nde'),
    ('HARDNESS-001','Vickers Hardness Tester',  'Hardness_Tester', 'destructive'),
    ('FURNACE-001', 'Box Furnace (Heat Treatment)', 'Furnace',     'heat_treatment'),
    ('GRINDER-001', 'Surface Grinder',           'Grinder',        NULL)
ON CONFLICT (equipment_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Insert types (representative subset from Insert Types sheet, 24 rows)
-- ---------------------------------------------------------------------------
INSERT INTO insert_types (type_code, manufacturer, iso_designation, substrate, coating) VALUES
    ('CNMG120408-MF',  'Sandvik',  'CNMG 12 04 08-MF', 'carbide', 'CVD TiCN/Al2O3'),
    ('CNMG120408-PM',  'Sandvik',  'CNMG 12 04 08-PM', 'carbide', 'PVD TiAlN'),
    ('PCBN-H13',       'Sandvik',  NULL,                'PCBN',    NULL),
    ('PCD-N10',        'Kennametal', NULL,              'PCD',     NULL)
ON CONFLICT (type_code) DO NOTHING;
