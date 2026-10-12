/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { DataTable, LIST_CAP, LoadState, RecordLink, Section, StatusBadge, formatDate, hasPassCode, indexRoute, operationLabel, processLabel, } from '@d1/ui';
const props = defineProps();
const forThisProject = (collection) => indexRoute(collection, props.projectId ? { query: { 'f.project_id': props.projectId } } : {});
const seeAll = (what) => (props.projectId ? `See all of this project's ${what}` : 'See the full list');
const cap = (b) => b.data.slice(0, LIST_CAP);
const capped = (b) => b.data.length > LIST_CAP;
const sampleRows = computed(() => cap(props.samples));
const opRows = computed(() => cap(props.operations));
const testRows = computed(() => cap(props.tests));
const isEmpty = (b) => !b.loading && !b.error && !b.data.length;
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    id: "unassigned-samples",
    title: "Samples not in a campaign",
    count: (props.samples.loading ? null : __VLS_ctx.sampleRows.length),
    empty: (__VLS_ctx.isEmpty(props.samples)),
    emptyText: "Every sample of this project that you can see is in a campaign.",
}));
const __VLS_2 = __VLS_1({
    id: "unassigned-samples",
    title: "Samples not in a campaign",
    count: (props.samples.loading ? null : __VLS_ctx.sampleRows.length),
    empty: (__VLS_ctx.isEmpty(props.samples)),
    emptyText: "Every sample of this project that you can see is in a campaign.",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
const __VLS_4 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
    loading: (props.samples.loading),
    error: (props.samples.error),
}));
const __VLS_6 = __VLS_5({
    loading: (props.samples.loading),
    error: (props.samples.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
const __VLS_8 = {}.DataTable;
/** @type {[typeof __VLS_components.DataTable, typeof __VLS_components.DataTable, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({}));
const __VLS_10 = __VLS_9({}, ...__VLS_functionalComponentArgsRest(__VLS_9));
__VLS_11.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
for (const [s] of __VLS_getVForSourceType((__VLS_ctx.sampleRows))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
        key: (s.sample_id),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_12 = {}.RecordLink;
    /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        collection: "physical_samples",
        id: (s.sample_id),
        ...{ class: "mono" },
    }));
    const __VLS_14 = __VLS_13({
        collection: "physical_samples",
        id: (s.sample_id),
        ...{ class: "mono" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    __VLS_15.slots.default;
    (s.sample_code || 'Sample');
    var __VLS_15;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (s.form ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (s.material_id?.common_name ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_16 = {}.StatusBadge;
    /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        kind: "sample",
        value: (s.current_status),
    }));
    const __VLS_18 = __VLS_17({
        kind: "sample",
        value: (s.current_status),
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
}
var __VLS_11;
if (__VLS_ctx.capped(props.samples)) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note cap" },
    });
    (__VLS_ctx.LIST_CAP);
    const __VLS_20 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
        to: (__VLS_ctx.forThisProject('physical_samples')),
    }));
    const __VLS_22 = __VLS_21({
        to: (__VLS_ctx.forThisProject('physical_samples')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    __VLS_23.slots.default;
    (__VLS_ctx.seeAll('samples'));
    var __VLS_23;
}
var __VLS_7;
var __VLS_3;
const __VLS_24 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
    id: "unassigned-operations",
    title: "Operations not in a campaign",
    count: (props.operations.loading ? null : __VLS_ctx.opRows.length),
    empty: (__VLS_ctx.isEmpty(props.operations)),
    emptyText: "Every operation of this project that you can see is in a campaign.",
}));
const __VLS_26 = __VLS_25({
    id: "unassigned-operations",
    title: "Operations not in a campaign",
    count: (props.operations.loading ? null : __VLS_ctx.opRows.length),
    empty: (__VLS_ctx.isEmpty(props.operations)),
    emptyText: "Every operation of this project that you can see is in a campaign.",
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
__VLS_27.slots.default;
const __VLS_28 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
    loading: (props.operations.loading),
    error: (props.operations.error),
}));
const __VLS_30 = __VLS_29({
    loading: (props.operations.loading),
    error: (props.operations.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_29));
__VLS_31.slots.default;
const __VLS_32 = {}.DataTable;
/** @type {[typeof __VLS_components.DataTable, typeof __VLS_components.DataTable, ]} */ ;
// @ts-ignore
const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({}));
const __VLS_34 = __VLS_33({}, ...__VLS_functionalComponentArgsRest(__VLS_33));
__VLS_35.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
for (const [o] of __VLS_getVForSourceType((__VLS_ctx.opRows))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
        key: (o.operation_id),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_36 = {}.RecordLink;
    /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
        collection: "manufacturing_operations",
        id: (o.operation_id),
        ...{ class: ({ mono: __VLS_ctx.hasPassCode(o) }) },
    }));
    const __VLS_38 = __VLS_37({
        collection: "manufacturing_operations",
        id: (o.operation_id),
        ...{ class: ({ mono: __VLS_ctx.hasPassCode(o) }) },
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    __VLS_39.slots.default;
    (__VLS_ctx.operationLabel(o));
    var __VLS_39;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (__VLS_ctx.processLabel(o.process_category));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (o.sample_id?.sample_code ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
        ...{ class: ({ dim: !o.operation_date }) },
    });
    (__VLS_ctx.formatDate(o.operation_date, 'undated'));
}
var __VLS_35;
if (__VLS_ctx.capped(props.operations)) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note cap" },
    });
    (__VLS_ctx.LIST_CAP);
    const __VLS_40 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        to: (__VLS_ctx.forThisProject('manufacturing_operations')),
    }));
    const __VLS_42 = __VLS_41({
        to: (__VLS_ctx.forThisProject('manufacturing_operations')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    __VLS_43.slots.default;
    (__VLS_ctx.seeAll('operations'));
    var __VLS_43;
}
var __VLS_31;
var __VLS_27;
const __VLS_44 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
    id: "unassigned-tests",
    title: "Tests not in a campaign",
    count: (props.tests.loading ? null : __VLS_ctx.testRows.length),
    empty: (__VLS_ctx.isEmpty(props.tests)),
    emptyText: "Every test of this project that you can see is in a campaign.",
}));
const __VLS_46 = __VLS_45({
    id: "unassigned-tests",
    title: "Tests not in a campaign",
    count: (props.tests.loading ? null : __VLS_ctx.testRows.length),
    empty: (__VLS_ctx.isEmpty(props.tests)),
    emptyText: "Every test of this project that you can see is in a campaign.",
}, ...__VLS_functionalComponentArgsRest(__VLS_45));
__VLS_47.slots.default;
const __VLS_48 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
    loading: (props.tests.loading),
    error: (props.tests.error),
}));
const __VLS_50 = __VLS_49({
    loading: (props.tests.loading),
    error: (props.tests.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_49));
__VLS_51.slots.default;
const __VLS_52 = {}.DataTable;
/** @type {[typeof __VLS_components.DataTable, typeof __VLS_components.DataTable, ]} */ ;
// @ts-ignore
const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({}));
const __VLS_54 = __VLS_53({}, ...__VLS_functionalComponentArgsRest(__VLS_53));
__VLS_55.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
for (const [t] of __VLS_getVForSourceType((__VLS_ctx.testRows))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
        key: (t.session_id),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_56 = {}.RecordLink;
    /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
    // @ts-ignore
    const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
        collection: "test_sessions",
        id: (t.session_id),
    }));
    const __VLS_58 = __VLS_57({
        collection: "test_sessions",
        id: (t.session_id),
    }, ...__VLS_functionalComponentArgsRest(__VLS_57));
    __VLS_59.slots.default;
    (t.test_type || 'Test');
    var __VLS_59;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (t.sample_id?.sample_code ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
        ...{ class: ({ dim: !t.session_date }) },
    });
    (__VLS_ctx.formatDate(t.session_date, 'undated'));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_60 = {}.StatusBadge;
    /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
    // @ts-ignore
    const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
        kind: "test",
        value: (t.status),
    }));
    const __VLS_62 = __VLS_61({
        kind: "test",
        value: (t.status),
    }, ...__VLS_functionalComponentArgsRest(__VLS_61));
}
var __VLS_55;
if (__VLS_ctx.capped(props.tests)) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note cap" },
    });
    (__VLS_ctx.LIST_CAP);
    const __VLS_64 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
        to: (__VLS_ctx.forThisProject('test_sessions')),
    }));
    const __VLS_66 = __VLS_65({
        to: (__VLS_ctx.forThisProject('test_sessions')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_65));
    __VLS_67.slots.default;
    (__VLS_ctx.seeAll('tests'));
    var __VLS_67;
}
var __VLS_51;
var __VLS_47;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['cap']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['cap']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['cap']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            DataTable: DataTable,
            LIST_CAP: LIST_CAP,
            LoadState: LoadState,
            RecordLink: RecordLink,
            Section: Section,
            StatusBadge: StatusBadge,
            formatDate: formatDate,
            hasPassCode: hasPassCode,
            operationLabel: operationLabel,
            processLabel: processLabel,
            forThisProject: forThisProject,
            seeAll: seeAll,
            capped: capped,
            sampleRows: sampleRows,
            opRows: opRows,
            testRows: testRows,
            isEmpty: isEmpty,
        };
    },
    __typeProps: {},
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeProps: {},
});
; /* PartiallyEnd: #4569/main.vue */
