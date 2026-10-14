// The Force App's machining sub-type list, the Directus dropdown's choices and STARbase's label table are
// one list in three places. This fails when they drift (decision 12 of docs/superpowers/plans/2026-10-14-form-layout.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MACHINING_SUBTYPE_CHOICES } from '@d1/ui/choiceLabels';
import { MACHINING_SUBTYPES } from './subtypes';

interface Choice { text: string; value: string }

// scripts/configure_inline_params.sql sets the field's `options` and `display_options` (the same choices
// twice) in one INSERT. Pull both JSON documents out of that statement.
const SQL = readFileSync(new URL('../../../../../scripts/configure_inline_params.sql', import.meta.url), 'utf8');
function directusChoices(): { options: Choice[]; display: Choice[] } {
	const stmt = SQL.split('\n').find((l) => l.startsWith('INSERT INTO directus_fields') && l.includes("'machining_operation_subtype'"));
	if (!stmt) throw new Error('no INSERT for machining_operation_subtype in configure_inline_params.sql');
	const docs = [...stmt.matchAll(/'(\{"choices":.*?\]\})'/g)].map((m) => JSON.parse(m[1]).choices as Choice[]);
	if (docs.length !== 2) throw new Error(`expected options and display_options, found ${docs.length} choice documents`);
	return { options: docs[0], display: docs[1] };
}

const mine: Choice[] = MACHINING_SUBTYPES.map((c) => ({ text: c.text, value: c.value }));
const directus = directusChoices();

// scripts/configure_form_layout.sql (run last by configure_all.sh, the same block as migration 174) sets the
// choices again; its VALUES row for the field carries one choices document.
const LAYOUT = readFileSync(new URL('../../../../../scripts/configure_form_layout.sql', import.meta.url), 'utf8');
function layoutChoices(): Choice[] {
	const row = LAYOUT.split('\n').find((l) => l.includes("('manufacturing_operations', 'machining_operation_subtype', '[{"));
	if (!row) throw new Error('no choices row for machining_operation_subtype in configure_form_layout.sql');
	return JSON.parse(row.match(/'(\[\{.*?\}\])'/)![1]) as Choice[];
}

describe('machining sub-type list', () => {
	it('is the twelve MT-/MM- codes, none of them blank or repeated', () => {
		expect(mine).toHaveLength(12);
		expect(new Set(mine.map((c) => c.value)).size).toBe(12);
		for (const c of mine) expect(c.value).toMatch(/^M[TM]-[A-Z]$/);
	});

	it('equals the label table STARbase and the PDF use (values, labels, order)', () => {
		expect(mine).toEqual(MACHINING_SUBTYPE_CHOICES);
	});

	it('equals the Directus choices in scripts/configure_inline_params.sql (values, labels, order)', () => {
		expect(directus.options).toEqual(mine);
	});

	it('equals the Directus display choices (the labels display) as well', () => {
		expect(directus.display).toEqual(mine);
	});

	it('equals the choices configure_form_layout.sql (migration 174) sets', () => {
		expect(layoutChoices()).toEqual(mine);
	});
});
