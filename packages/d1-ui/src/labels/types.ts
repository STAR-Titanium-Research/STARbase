// Types shared by the labels module. No Vue and no Directus imports: this is pure logic.

export type FieldKey = 'sample_code' | 'short_id' | 'nickname' | 'material' | 'date' | 'owner_initials';
export type FieldSize = 'lg' | 'md' | 'sm';
export type Arrangement = 'qr_top' | 'qr_left' | 'text_only';
export type Media = 'sheet' | 'roll';

export const FIELD_KEYS: readonly FieldKey[] = ['sample_code', 'short_id', 'nickname', 'material', 'date', 'owner_initials'];
export const FIELD_SIZES: readonly FieldSize[] = ['lg', 'md', 'sm'];
export const ARRANGEMENTS: readonly Arrangement[] = ['qr_top', 'qr_left', 'text_only'];
export const MEDIA: readonly Media[] = ['sheet', 'roll'];

export interface LabelField {
	key: FieldKey;
	size: FieldSize;
	bold: boolean;
}

// The label_templates table, camelCased, with numbers as numbers. The audit columns are null for a
// template that has not been saved yet.
export interface LabelTemplate {
	id: string | null;
	name: string;
	description: string | null;
	media: Media;
	pageWidthMm: number;
	pageHeightMm: number;
	columns: number;
	rows: number;
	labelWidthMm: number;
	labelHeightMm: number;
	marginTopMm: number;
	marginLeftMm: number;
	gapXMm: number;
	gapYMm: number;
	paddingMm: number;
	arrangement: Arrangement;
	qrSizeMm: number | null;
	fields: LabelField[];
	qrFields: FieldKey[];
	isDefault: boolean;
	userCreated: string | null;
	dateCreated: string | null;
	userUpdated: string | null;
	dateUpdated: string | null;
}

export interface LabelSample {
	id: string;
	code: string;
	shortId: string;
	nickname: string | null;
	material: string | null;
	// YYYY-MM-DD
	date: string | null;
	ownerInitials: string | null;
}

// The value a field shows on the label, or '' when the sample has none.
export function fieldValue(s: LabelSample, key: FieldKey): string {
	switch (key) {
		case 'sample_code':
			return s.code;
		case 'short_id':
			return s.shortId;
		case 'nickname':
			return s.nickname ?? '';
		case 'material':
			return s.material ?? '';
		case 'date':
			return s.date ?? '';
		case 'owner_initials':
			return s.ownerInitials ?? '';
	}
}
