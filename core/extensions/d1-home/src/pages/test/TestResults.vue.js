/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { DataTable, FactList, Section, TEST_DONE_STATUSES, TEST_STATUS_ORDER, summaryCount, summaryGroups } from '@d1/ui';
const props = defineProps();
const groups = computed(() => summaryGroups(props.stats));
const count = computed(() => summaryCount(groups.value));
// Not finished and not failed: registered, pending_processing, processing and analysing.
const pending = computed(() => !!props.status && props.status !== 'failed' && TEST_STATUS_ORDER.includes(props.status) && !TEST_DONE_STATUSES.includes(props.status));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['group']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: "Results",
    count: (__VLS_ctx.count || null),
    empty: (!__VLS_ctx.groups.length),
    emptyText: (__VLS_ctx.pending ? 'The analysis workers have not produced results yet.' : 'No processed results are recorded for this test.'),
}));
const __VLS_2 = __VLS_1({
    title: "Results",
    count: (__VLS_ctx.count || null),
    empty: (!__VLS_ctx.groups.length),
    emptyText: (__VLS_ctx.pending ? 'The analysis workers have not produced results yet.' : 'No processed results are recorded for this test.'),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
for (const [g] of __VLS_getVForSourceType((__VLS_ctx.groups))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        key: (g.key),
        ...{ class: "group" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
    (g.title);
    const __VLS_5 = {}.FactList;
    /** @type {[typeof __VLS_components.FactList, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        facts: (g.entries.map((e) => ({ label: e.label, value: e.value, unit: e.unit }))),
    }));
    const __VLS_7 = __VLS_6({
        facts: (g.entries.map((e) => ({ label: e.label, value: e.value, unit: e.unit }))),
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    for (const [t] of __VLS_getVForSourceType((g.tables))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            key: (t.label),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({});
        (t.label);
        const __VLS_9 = {}.DataTable;
        /** @type {[typeof __VLS_components.DataTable, typeof __VLS_components.DataTable, ]} */ ;
        // @ts-ignore
        const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
            dense: true,
            fitContent: true,
            figures: true,
        }));
        const __VLS_11 = __VLS_10({
            dense: true,
            fitContent: true,
            figures: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_10));
        __VLS_12.slots.default;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
        for (const [c] of __VLS_getVForSourceType((t.columns))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
                key: (c),
            });
            (c);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
        for (const [row, i] of __VLS_getVForSourceType((t.rows))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
                key: (i),
            });
            for (const [cell, j] of __VLS_getVForSourceType((row))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                    key: (j),
                });
                (cell);
            }
        }
        var __VLS_12;
        if (t.more) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "d1-note more" },
            });
            (t.more);
        }
    }
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['group']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['more']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            DataTable: DataTable,
            FactList: FactList,
            Section: Section,
            groups: groups,
            count: count,
            pending: pending,
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
