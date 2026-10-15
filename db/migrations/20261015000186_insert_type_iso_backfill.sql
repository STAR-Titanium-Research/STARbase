-- migrate:up
-- insert_types.iso_designation was empty on every live row: the ISO code only lived at the start of type_code ("CNMG 12 04 08-SM H13A"), so the
-- tooling pages could not tell a CNMG from a square. The pages now read type_code as a fallback; this fills the column so it means what its label says.
--
--   * iso_designation gets the designation proper (shape, clearance, tolerance, type, size, thickness, nose radius), without the chipbreaker and grade.
--     Only empty values are filled, and only when type_code starts like an ISO 1832 insert (a milling code such as R390-11 T3 08M-MM does not).
--   * TCMT is a one-sided triangle with 3 cutting edges; the live types said 6 (maintainer decision 2026-10-15). TCMW is left as it is.

UPDATE insert_types
   SET iso_designation = substring(type_code FROM '^([CDSTVWR][A-GNPO][A-Z][A-Z] ?[0-9]{2} ?[0-9T][0-9](?: ?(?:[0-9]{2}|M0))?)')
 WHERE (iso_designation IS NULL OR btrim(iso_designation) = '')
   AND type_code ~ '^[CDSTVWR][A-GNPO][A-Z][A-Z] ?[0-9]{2} ?[0-9T][0-9]';

UPDATE insert_types SET edge_count = 3 WHERE type_code ILIKE 'TCMT%' AND edge_count = 6;

-- migrate:down
UPDATE insert_types SET edge_count = 6 WHERE type_code ILIKE 'TCMT%' AND edge_count = 3;

UPDATE insert_types
   SET iso_designation = NULL
 WHERE iso_designation = substring(type_code FROM '^([CDSTVWR][A-GNPO][A-Z][A-Z] ?[0-9]{2} ?[0-9T][0-9](?: ?(?:[0-9]{2}|M0))?)');
