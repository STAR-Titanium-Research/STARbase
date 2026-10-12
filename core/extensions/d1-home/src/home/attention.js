import { failedTests, forceErrorOnMyOperations, forcePendingOperations, hasPassCode, operationLabel, operationSampleLine, ownerlessSamples, recordRoute, } from '@d1/ui';
const opItem = (collection) => (r) => ({
    id: r.operation_id,
    title: operationLabel(r),
    plain: !hasPassCode(r),
    // The label of an uncoded operation already names its sample.
    sub: operationSampleLine(r),
    to: recordRoute(collection, r.operation_id),
});
export const ATTENTION = [
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
