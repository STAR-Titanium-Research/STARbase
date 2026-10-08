import {
	failedTests, forceErrorOnMyOperations, forcePendingOperations, ownerlessSamples, recordRoute,
} from '@d1/ui';

// The "Needs attention" tiles: what each one counts, which filter selects the records, and how a
// matching record is shown. The filters are the ones in packages/d1-ui/src/mine.ts, so the
// counts equal the same filters typed into the Data Studio:
//   - force analysis in `error` on my operations: operations I own with a force file in error;
//   - failed test sessions: test_sessions.status = 'failed' (the Data Studio "Failed" bookmark);
//   - operations with force files still pending (queued, not yet analysed);
//   - samples with no owner (owner_person_id empty): admins only, since a member can read only
//     the records they are involved in (ADR-0011) and so never sees an ownerless sample.

export interface AttentionItem {
	id: string;
	title: string;
	sub: string;
	to: string;
}

export interface AttentionDef {
	key: string;
	label: string;
	hint: string;
	icon: string;
	collection: string;
	filter: Record<string, unknown>;
	fields: string[];
	sort: string[];
	adminOnly?: boolean;
	/** Name of an existing Data Studio bookmark on `collection` that applies the same filter. */
	bookmark?: string;
	toItem: (row: any) => AttentionItem;
}

const opItem = (collection: 'manufacturing_operations') => (r: any): AttentionItem => ({
	id: r.operation_id,
	title: r.pass_code || 'Operation',
	sub: r.sample_id?.sample_code ? `Sample ${r.sample_id.sample_code}` : '',
	to: recordRoute(collection, r.operation_id),
});

export const ATTENTION: AttentionDef[] = [
	{
		key: 'force-error',
		label: 'Force analysis errors on my operations',
		hint: 'Operations you own with a force file whose analysis ended in error',
		icon: 'error',
		collection: 'manufacturing_operations',
		filter: forceErrorOnMyOperations,
		fields: ['operation_id', 'pass_code', 'sample_id.sample_code'],
		sort: ['-operation_date'],
		toItem: opItem('manufacturing_operations'),
	},
	{
		key: 'tests-failed',
		label: 'Failed test sessions',
		hint: 'Test sessions you can see with status "failed"',
		icon: 'report',
		collection: 'test_sessions',
		filter: failedTests,
		bookmark: 'Failed',
		fields: ['session_id', 'test_type', 'session_date', 'sample_id.sample_code'],
		sort: ['-session_date'],
		toItem: (r) => ({
			id: r.session_id,
			title: r.test_type || 'Test',
			sub: r.sample_id?.sample_code ? `Sample ${r.sample_id.sample_code}` : '',
			to: recordRoute('test_sessions', r.session_id),
		}),
	},
	{
		key: 'force-pending',
		label: 'Operations with force files still pending',
		hint: 'Operations you can see with at least one force file queued for analysis',
		icon: 'hourglass_top',
		collection: 'manufacturing_operations',
		filter: forcePendingOperations,
		fields: ['operation_id', 'pass_code', 'sample_id.sample_code'],
		sort: ['-operation_date'],
		toItem: opItem('manufacturing_operations'),
	},
	{
		key: 'ownerless',
		label: 'Samples with no owner',
		hint: 'Samples whose owner is empty (admins only)',
		icon: 'person_off',
		collection: 'physical_samples',
		filter: ownerlessSamples,
		fields: ['sample_id', 'sample_code', 'form'],
		sort: ['sample_code'],
		adminOnly: true,
		toItem: (r) => ({
			id: r.sample_id,
			title: r.sample_code || 'Sample',
			sub: r.form ?? '',
			to: recordRoute('physical_samples', r.sample_id),
		}),
	},
];

export const ATTENTION_LIST_LIMIT = 10;
