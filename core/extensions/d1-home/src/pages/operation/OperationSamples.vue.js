/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { RecordLink, Section, StatusBadge, asRecord } from '@d1/ui';
const props = defineProps();
const rows = computed(() => [
    { role: 'Input', sample: asRecord(props.input), hidden: props.inputHidden || (props.input && !asRecord(props.input)) },
    { role: 'Output', sample: asRecord(props.output), hidden: props.outputHidden || (props.output && !asRecord(props.output)) },
].filter((r) => r.sample || r.hidden));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['role']} */ ;
/** @type {__VLS_StyleScopedClasses['role']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: "Samples in and out",
    count: (__VLS_ctx.rows.length),
    empty: (!__VLS_ctx.rows.length),
    emptyText: "No sample is linked to this operation.",
}));
const __VLS_2 = __VLS_1({
    title: "Samples in and out",
    count: (__VLS_ctx.rows.length),
    empty: (!__VLS_ctx.rows.length),
    emptyText: "No sample is linked to this operation.",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
    ...{ class: "rows" },
});
for (const [r] of __VLS_getVForSourceType((__VLS_ctx.rows))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
        key: (r.role),
        ...{ class: "row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "role" },
        ...{ class: (r.role.toLowerCase()) },
    });
    (r.role);
    if (r.sample) {
        const __VLS_5 = {}.RecordLink;
        /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
        // @ts-ignore
        const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
            collection: "physical_samples",
            id: (r.sample.sample_id),
            ...{ class: "code" },
        }));
        const __VLS_7 = __VLS_6({
            collection: "physical_samples",
            id: (r.sample.sample_id),
            ...{ class: "code" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_6));
        __VLS_8.slots.default;
        (r.sample.sample_code || 'Sample');
        var __VLS_8;
        if (r.sample.nickname) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "muted" },
            });
            (r.sample.nickname);
        }
        if (r.sample.form) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "muted" },
            });
            (r.sample.form);
        }
        const __VLS_9 = {}.StatusBadge;
        /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
        // @ts-ignore
        const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
            kind: "sample",
            value: (r.sample.current_status),
        }));
        const __VLS_11 = __VLS_10({
            kind: "sample",
            value: (r.sample.current_status),
        }, ...__VLS_functionalComponentArgsRest(__VLS_10));
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "muted" },
        });
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "hint" },
});
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['rows']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['role']} */ ;
/** @type {__VLS_StyleScopedClasses['code']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RecordLink: RecordLink,
            Section: Section,
            StatusBadge: StatusBadge,
            rows: rows,
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
