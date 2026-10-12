// Label printing logic: templates, geometry, text fitting, the QR payload and the HTML renderer.
// Pure functions only (no Vue, no Directus), so every part is unit-tested.
export { FIELD_KEYS, QR_KEYS, FIELD_SIZES, ARRANGEMENTS, MEDIA } from './types';
export type { QrKey, FieldKey, FieldSize, Arrangement, Media, LabelField, LabelTemplate, LabelSample } from './types';
export { toLabelSample, isPrintableSample } from './sample';
export { templateFromRow, validateTemplate } from './template';
export { slotPositions, paginate, paginateCounts } from './geometry';
export type { Slot, PaginateOptions, CountedSample } from './geometry';
export { fitText, SIZE_PT, MIN_PT } from './fit';
export type { FittedText } from './fit';
export { buildQrPayload, parseQrPayload, effectiveQrKeys, QR_HEADER } from './qrPayload';
export type { ParsedQrPayload } from './qrPayload';
export { renderLabelDocument } from './render';
export type { QrModules } from './qrSvg';
export type { Measure } from './fit';
export type { RenderOptions, RenderedLabels } from './render';
export {
	LABEL_SAMPLE_FIELDS, MAX_COPIES, MEMBER_COLUMNS, parseSelectionQuery, parseCodes, pickerFilter, clampCopies, clampStart, slotsPerPage,
	countLabels, summaryText, classifyTemplates, pickTemplate, canEditTemplate, blankTemplate, copyAsNew, draftOf, templatePayload,
	saveErrorText, moveField, sampleEntries,
} from './page';
export type { BrokenTemplate, LabelEntry } from './page';
