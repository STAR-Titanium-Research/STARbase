-- migrate:up
-- Populate nominal composition (wt%) for alloys whose material_alloying_elements rows had
-- no weight_percent, with the source URL recorded in materials.notes.
--
-- Rules:
--   * Value = datasheet nominal; where only a range is published, the midpoint.
--   * Max-only impurity limits (Mn/Si/P/S/Fe-in-Ni-alloys, ...) are NOT recorded as nominal.
--   * The base element is written as 100 - sum(listed elements), so each alloy totals 100
--     and the composition bar shows no separate "balance" segment.
--   * Only NULL weights are filled; existing weights (AA Ti-64, SCMV) are untouched.
--   * Rows already in the DB but not in a source's nominal list (IN25 Co; C45 P,S; AH Cr,Fe;
--     AG12 C,Fe; S6 Al,Mn,Si) are left with NULL weight and NOT deleted - review them.
--   * GE48 and TNM sources quote at.%; wt% here is converted (Ti-48Al-2Cr-2Nb, Ti-43.5Al-4Nb-1Mo-0.1B).
--   * 14YWT: Y2O3 dispersoid (0.25) is not an element row; Fe is balance of Cr+W+Ti.
--   * Not covered (no fetched source / ambiguous): S8, AX, WC, CCMW, pure elements,
--     compounds, placeholders.
--
-- Sources (all accessed 2026-10-14):
--   IN18  https://metals.bibus.com/ch-en/products/itm/nickel-alloy-718/
--   IN25  https://metals.bibus.com/ch-en/products/itm/nickel-alloy-625/
--   4140  https://www.metalsupermarkets.com/grade-guide-4140-steel/
--   174PH https://voestalpine.com/specialtymetals/uk/en/17-4ph-uns-s17400
--   C45   https://materialwelding.com/?p=524362
--   P9    https://materialwelding.com/?p=6696
--   S6    https://metals.bibus.com/my-en/products/itm/nickel-alloy-a286/
--   SS    https://www.voestalpine.com/specialtymetals/uk/en/316l-uns-s31603/
--   AB    https://aubertduval.com/en/products/ti6246-titanium-alloys
--   AC    https://www.aubertduval.com/en/products/ti6242-titanium-alloys/
--   AF    https://www.aubertduval.com/en/products/ti17-titanium-alloys/
--   AG    https://www.samaterials.com/item/tm10741-titanium-alloy-sheet-ti-5al-5mo-5v-3cr-ti5553.html
--   AH    https://dl.asminternational.org/alloy-digest/article/50/7/Ti-116/6427/TIMETAL-834Near-Alpha-Titanium-Alloy
--   AG12  https://powder.samaterials.com/ti-grade-12-titanium-alloy-spherical-powder.html
--   SC    https://www.carpenteradditive.com/aluminum-scalmalloy
--   ZN2   https://www.makeitfrom.com/material-properties/Zamak-2-ASTM-AC43A-Z35541-Mazak-2-Zinc-Alloy
--   RK    https://patents.google.com/patent/US7208116
--   GE48  https://pmc.ncbi.nlm.nih.gov/articles/PMC7560148/
--   TNM   https://www.totalmateria.com/en-US/material/3306234 (formula Ti-43.5Al-4Nb-1Mo-0.1B at.%)
--   14YWT https://www.osti.gov/biblio/993452
--   NITI  https://www.jacques-allemann.com/en/materials/nitinol-niti-f2063%3B159

CREATE TEMP TABLE _comp (alloy_code text, symbol text, wt numeric, is_base boolean DEFAULT false, src text);

INSERT INTO _comp (alloy_code, symbol, wt, is_base, src) VALUES
-- Ni / Fe-Ni superalloys
('IN18','Ni',52.5,false,'https://metals.bibus.com/ch-en/products/itm/nickel-alloy-718/'),
('IN18','Cr',19,false,NULL),('IN18','Nb',5.125,false,NULL),('IN18','Mo',3.05,false,NULL),
('IN18','Ti',0.9,false,NULL),('IN18','Al',0.5,false,NULL),('IN18','Fe',NULL,true,NULL),
('IN25','Cr',21.5,false,'https://metals.bibus.com/ch-en/products/itm/nickel-alloy-625/'),
('IN25','Mo',9,false,NULL),('IN25','Nb',3.65,false,NULL),('IN25','Ni',NULL,true,NULL),
('S6','Ni',25.5,false,'https://metals.bibus.com/my-en/products/itm/nickel-alloy-a286/'),
('S6','Cr',14.75,false,NULL),('S6','Ti',2.125,false,NULL),('S6','Mo',1.25,false,NULL),
('S6','V',0.3,false,NULL),('S6','B',0.006,false,NULL),('S6','Fe',NULL,true,NULL),
('RK','Co',16.5,false,'https://patents.google.com/patent/US7208116'),
('RK','Cr',14.75,false,NULL),('RK','Al',3,false,NULL),('RK','Ti',3.8,false,NULL),
('RK','Mo',4.75,false,NULL),('RK','B',0.018,false,NULL),('RK','Zr',0.06,false,NULL),('RK','Ni',NULL,true,NULL),
-- steels
('4140','C',0.405,false,'https://www.metalsupermarkets.com/grade-guide-4140-steel/'),
('4140','Cr',0.95,false,NULL),('4140','Mn',0.875,false,NULL),('4140','Si',0.225,false,NULL),
('4140','Mo',0.2,false,NULL),('4140','Fe',NULL,true,NULL),
('174PH','Cr',16.25,false,'https://voestalpine.com/specialtymetals/uk/en/17-4ph-uns-s17400'),
('174PH','Ni',4,false,NULL),('174PH','Cu',4,false,NULL),('174PH','Nb',0.3,false,NULL),('174PH','Fe',NULL,true,NULL),
('C45','C',0.465,false,'https://materialwelding.com/?p=524362'),
('C45','Mn',0.75,false,NULL),('C45','Si',0.25,false,NULL),('C45','Fe',NULL,true,NULL),
('P9','C',0.1,false,'https://materialwelding.com/?p=6696'),
('P9','Mn',0.45,false,NULL),('P9','Si',0.35,false,NULL),('P9','Cr',8.75,false,NULL),('P9','Mo',0.95,false,NULL),
('P9','V',0.215,false,NULL),('P9','Nb',0.08,false,NULL),('P9','N',0.05,false,NULL),('P9','Fe',NULL,true,NULL),
('SS','Cr',17,false,'https://www.voestalpine.com/specialtymetals/uk/en/316l-uns-s31603/'),
('SS','Ni',12,false,NULL),('SS','Mo',2.5,false,NULL),('SS','Fe',NULL,true,NULL),
('14YWT','Cr',14,false,'https://www.osti.gov/biblio/993452'),
('14YWT','W',3,false,NULL),('14YWT','Ti',0.4,false,NULL),('14YWT','Fe',NULL,true,NULL),
-- titanium alloys / TiAl / NiTi
('AB','Al',6,false,'https://aubertduval.com/en/products/ti6246-titanium-alloys'),
('AB','Sn',2,false,NULL),('AB','Zr',4,false,NULL),('AB','Mo',6,false,NULL),('AB','Ti',NULL,true,NULL),
('AC','Al',6,false,'https://www.aubertduval.com/en/products/ti6242-titanium-alloys/'),
('AC','Sn',2,false,NULL),('AC','Zr',4,false,NULL),('AC','Mo',2,false,NULL),('AC','Si',0.08,false,NULL),('AC','Ti',NULL,true,NULL),
('AF','Al',5,false,'https://www.aubertduval.com/en/products/ti17-titanium-alloys/'),
('AF','Sn',2,false,NULL),('AF','Zr',2,false,NULL),('AF','Mo',4,false,NULL),('AF','Cr',4,false,NULL),('AF','Ti',NULL,true,NULL),
('AG','Al',5,false,'https://www.samaterials.com/item/tm10741-titanium-alloy-sheet-ti-5al-5mo-5v-3cr-ti5553.html'),
('AG','Mo',5,false,NULL),('AG','V',5,false,NULL),('AG','Cr',3,false,NULL),('AG','Ti',NULL,true,NULL),
('AH','Al',5.8,false,'https://dl.asminternational.org/alloy-digest/article/50/7/Ti-116/6427/TIMETAL-834Near-Alpha-Titanium-Alloy'),
('AH','Sn',4,false,NULL),('AH','Zr',3.5,false,NULL),('AH','Nb',0.7,false,NULL),('AH','Mo',0.5,false,NULL),
('AH','Si',0.35,false,NULL),('AH','C',0.06,false,NULL),('AH','Ti',NULL,true,NULL),
('AG12','Mo',0.3,false,'https://powder.samaterials.com/ti-grade-12-titanium-alloy-spherical-powder.html'),
('AG12','Ni',0.75,false,NULL),('AG12','Ti',NULL,true,NULL),
('GE48','Al',34.2,false,'https://pmc.ncbi.nlm.nih.gov/articles/PMC7560148/'),
('GE48','Cr',2.746,false,NULL),('GE48','Nb',4.907,false,NULL),('GE48','Ti',NULL,true,NULL),
('TNM','Al',28.61,false,'https://www.totalmateria.com/en-US/material/3306234'),
('TNM','Nb',9.06,false,NULL),('TNM','Mo',2.34,false,NULL),('TNM','B',0.026,false,NULL),('TNM','Ti',NULL,true,NULL),
('NITI','Ni',55,false,'https://www.jacques-allemann.com/en/materials/nitinol-niti-f2063%3B159'),
('NITI','Ti',NULL,true,NULL),
-- Al / Zn alloys
('SC','Mg',4.65,false,'https://www.carpenteradditive.com/aluminum-scalmalloy'),
('SC','Sc',0.74,false,NULL),('SC','Zr',0.35,false,NULL),('SC','Mn',0.55,false,NULL),('SC','Al',NULL,true,NULL),
('ZN2','Al',3.9,false,'https://www.makeitfrom.com/material-properties/Zamak-2-ASTM-AC43A-Z35541-Mazak-2-Zinc-Alloy'),
('ZN2','Cu',2.9,false,NULL),('ZN2','Mg',0.04,false,NULL),('ZN2','Zn',NULL,true,NULL);

UPDATE _comp b SET wt = round(100 - (SELECT sum(o.wt) FROM _comp o
                                     WHERE o.alloy_code = b.alloy_code AND NOT o.is_base), 3)
 WHERE b.is_base;

-- Fail loudly on a typo'd alloy code or element symbol.
DO $$
DECLARE missing text;
BEGIN
    SELECT string_agg(DISTINCT c.alloy_code, ',') INTO missing
      FROM _comp c LEFT JOIN materials m ON m.alloy_code = c.alloy_code WHERE m.material_id IS NULL;
    IF missing IS NOT NULL THEN RAISE EXCEPTION 'unknown alloy_code(s): %', missing; END IF;
    SELECT string_agg(DISTINCT c.symbol, ',') INTO missing
      FROM _comp c LEFT JOIN alloying_elements a ON a.symbol = c.symbol WHERE a.symbol IS NULL;
    IF missing IS NOT NULL THEN RAISE EXCEPTION 'unknown element symbol(s): %', missing; END IF;
END $$;

INSERT INTO material_alloying_elements (material_id, symbol, weight_percent)
SELECT m.material_id, c.symbol, c.wt
  FROM _comp c JOIN materials m ON m.alloy_code = c.alloy_code
ON CONFLICT (material_id, symbol) DO UPDATE
   SET weight_percent = EXCLUDED.weight_percent
 WHERE material_alloying_elements.weight_percent IS NULL;

UPDATE materials m
   SET notes = concat_ws(E'\n', nullif(m.notes, ''),
         'Composition (wt%) source: ' || s.src || ' (accessed 2026-10-14). Nominal/midpoint values; base element = balance.')
  FROM (SELECT alloy_code, max(src) AS src FROM _comp GROUP BY alloy_code) s
 WHERE m.alloy_code = s.alloy_code
   AND coalesce(m.notes, '') NOT LIKE '%Composition (wt%) source:%';

DROP TABLE _comp;

-- migrate:down
-- Rows inserted by the up step are not distinguishable from pre-existing ones, so the down
-- step only clears the weights it set and strips the source lines.
UPDATE material_alloying_elements e SET weight_percent = NULL
  FROM materials m
 WHERE m.material_id = e.material_id
   AND m.alloy_code IN ('IN18','IN25','S6','RK','4140','174PH','C45','P9','SS','14YWT','AB','AC','AF','AG',
                        'AH','AG12','GE48','TNM','NITI','SC','ZN2');
UPDATE materials
   SET notes = nullif(regexp_replace(notes, E'\n?Composition \\(wt%\\) source: [^\n]*', '', 'g'), '')
 WHERE notes LIKE '%Composition (wt%) source:%';
