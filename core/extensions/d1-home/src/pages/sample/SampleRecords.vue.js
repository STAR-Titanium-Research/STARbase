/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { DataTable, LIST_CAP, LoadState, RecordLink, Section, StatusBadge, analysisLink, formatDate, indexRoute, hasPassCode, operationLabel, processLabel, } from '@d1/ui';
const props = defineProps();
const ops = computed(() => props.operations.data.slice(0, LIST_CAP));
const testRows = computed(() => props.tests.data.slice(0, LIST_CAP));
const opsCapped = computed(() => props.operations.data.length > LIST_CAP);
const testsCapped = computed(() => props.tests.data.length > LIST_CAP);
const forThisSample = (collection) => indexRoute(collection, props.sampleCode ? { query: { q: props.sampleCode } } : {});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['action']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    id: "operations",
    title: "Operations",
    count: (__VLS_ctx.operations.loading ? null : __VLS_ctx.ops.length),
    empty: (!__VLS_ctx.operations.loading && !__VLS_ctx.operations.error && !__VLS_ctx.ops.length),
    emptyText: "No operations recorded for this sample.",
}));
const __VLS_2 = __VLS_1({
    id: "operations",
    title: "Operations",
    count: (__VLS_ctx.operations.loading ? null : __VLS_ctx.ops.length),
    empty: (!__VLS_ctx.operations.loading && !__VLS_ctx.operations.error && !__VLS_ctx.ops.length),
    emptyText: "No operations recorded for this sample.",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
__VLS_3.slots.default;
const __VLS_4 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
    loading: (__VLS_ctx.operations.loading),
    error: (__VLS_ctx.operations.error),
}));
const __VLS_6 = __VLS_5({
    loading: (__VLS_ctx.operations.loading),
    error: (__VLS_ctx.operations.error),
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
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
    ...{ class: "fit" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
for (const [o] of __VLS_getVForSourceType((__VLS_ctx.ops))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
        key: (o.operation_id),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
        ...{ class: "fit dim num" },
    });
    (o.operation_sequence ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_12 = {}.RecordLink;
    /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        collection: "manufacturing_operations",
        id: (o.operation_id),
        ...{ class: ({ mono: __VLS_ctx.hasPassCode(o) }) },
    }));
    const __VLS_14 = __VLS_13({
        collection: "manufacturing_operations",
        id: (o.operation_id),
        ...{ class: ({ mono: __VLS_ctx.hasPassCode(o) }) },
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    __VLS_15.slots.default;
    (__VLS_ctx.operationLabel(o));
    var __VLS_15;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (__VLS_ctx.processLabel(o.process_category));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (o.method_id?.method_name ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
        ...{ class: ({ dim: !o.operation_date }) },
    });
    (__VLS_ctx.formatDate(o.operation_date, 'undated'));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (o.equipment_id?.equipment_name ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
        ...{ class: "actions" },
    });
    if (__VLS_ctx.analysisLink(o.operation_id, o.process_category)) {
        const __VLS_16 = {}.RouterLink;
        /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
        // @ts-ignore
        const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
            to: (__VLS_ctx.analysisLink(o.operation_id, o.process_category).to),
            ...{ class: "action" },
        }));
        const __VLS_18 = __VLS_17({
            to: (__VLS_ctx.analysisLink(o.operation_id, o.process_category).to),
            ...{ class: "action" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_17));
        __VLS_19.slots.default;
        (__VLS_ctx.analysisLink(o.operation_id, o.process_category).label);
        var __VLS_19;
    }
}
var __VLS_11;
if (__VLS_ctx.opsCapped) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note cap" },
    });
    (__VLS_ctx.LIST_CAP);
    const __VLS_20 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
        to: (__VLS_ctx.forThisSample('manufacturing_operations')),
    }));
    const __VLS_22 = __VLS_21({
        to: (__VLS_ctx.forThisSample('manufacturing_operations')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    __VLS_23.slots.default;
    (__VLS_ctx.sampleCode ? "See all of this sample's operations" : 'See the full list');
    var __VLS_23;
}
var __VLS_7;
var __VLS_3;
const __VLS_24 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
    id: "tests",
    title: "Tests",
    count: (__VLS_ctx.tests.loading ? null : __VLS_ctx.testRows.length),
    empty: (!__VLS_ctx.tests.loading && !__VLS_ctx.tests.error && !__VLS_ctx.testRows.length),
    emptyText: "No tests recorded for this sample.",
}));
const __VLS_26 = __VLS_25({
    id: "tests",
    title: "Tests",
    count: (__VLS_ctx.tests.loading ? null : __VLS_ctx.testRows.length),
    empty: (!__VLS_ctx.tests.loading && !__VLS_ctx.tests.error && !__VLS_ctx.testRows.length),
    emptyText: "No tests recorded for this sample.",
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
__VLS_27.slots.default;
const __VLS_28 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
    loading: (__VLS_ctx.tests.loading),
    error: (__VLS_ctx.tests.error),
}));
const __VLS_30 = __VLS_29({
    loading: (__VLS_ctx.tests.loading),
    error: (__VLS_ctx.tests.error),
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
__VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
for (const [t] of __VLS_getVForSourceType((__VLS_ctx.testRows))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
        key: (t.session_id),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_36 = {}.RecordLink;
    /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
        collection: "test_sessions",
        id: (t.session_id),
    }));
    const __VLS_38 = __VLS_37({
        collection: "test_sessions",
        id: (t.session_id),
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    __VLS_39.slots.default;
    (t.test_type || 'Test');
    var __VLS_39;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (t.test_category ?? '');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
        ...{ class: ({ dim: !t.session_date }) },
    });
    (__VLS_ctx.formatDate(t.session_date, 'undated'));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    const __VLS_40 = {}.StatusBadge;
    /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        kind: "test",
        value: (t.status),
    }));
    const __VLS_42 = __VLS_41({
        kind: "test",
        value: (t.status),
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({});
    (t.equipment_id?.equipment_name ?? '');
}
var __VLS_35;
if (__VLS_ctx.testsCapped) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note cap" },
    });
    (__VLS_ctx.LIST_CAP);
    const __VLS_44 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        to: (__VLS_ctx.forThisSample('test_sessions')),
    }));
    const __VLS_46 = __VLS_45({
        to: (__VLS_ctx.forThisSample('test_sessions')),
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    __VLS_47.slots.default;
    (__VLS_ctx.sampleCode ? "See all of this sample's tests" : 'See the full list');
    var __VLS_47;
}
var __VLS_31;
var __VLS_27;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['dim']} */ ;
/** @type {__VLS_StyleScopedClasses['num']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['action']} */ ;
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
            analysisLink: analysisLink,
            formatDate: formatDate,
            hasPassCode: hasPassCode,
            operationLabel: operationLabel,
            processLabel: processLabel,
            ops: ops,
            testRows: testRows,
            opsCapped: opsCapped,
            testsCapped: testsCapped,
            forThisSample: forThisSample,
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
