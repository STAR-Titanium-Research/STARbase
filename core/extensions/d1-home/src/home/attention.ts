import {
	failedTests, forceErrorOnMyOperations, forcePendingOperations, hasPassCode, operationLabel, operationSampleLine, recordRoute,
} from '@d1/ui';

// The "Needs attention" tiles: what each one counts, which filter selects the records, and how a
// matching record is shown. The filters are the ones in packages/d1-ui/src/mine.ts, so the
// counts equal the same filters typed into the Data Studio:
//   - force analysis in `error` on my operations: operations I own with a force file in error;
//   - failed test sessions: test_sessions.status = 'failed' (the Data Studio "Failed" bookmark);
//   - operations with force files still pending (queued, not yet analysed);
//
// Ownerless samples are not here: an admin sees them, with campaigns and operations, in the Ownerless
// records panel (home/AdminPanels.vue), so the same fact is not shown twice.

export interface AttentionItem {
	id: string;
	title: string;
	sub: string;
	to: string;
	/** The title describes the record instead of being its code (an operation without a pass code): not set in monospace. */
	plain?: boolean;
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
	title: operationLabel(r),
	plain: !hasPassCode(r),
	// The label of an uncoded operation already names its sample.
	sub: operationSampleLine(r),
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
		fields: ['operation_id', 'pass_code', 'operation_sequence', 'sample_id.sample_code'],
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
		fields: ['operation_id', 'pass_code', 'operation_sequence', 'sample_id.sample_code'],
		sort: ['-operation_date'],
		toItem: opItem('manufacturing_operations'),
	},
];

export const ATTENTION_LIST_LIMIT = 10;
