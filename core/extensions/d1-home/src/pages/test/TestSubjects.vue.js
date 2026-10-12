/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { RecordLink, Section, StatusBadge, asRecord, humanise, testSubjectCount } from '@d1/ui';
const props = defineProps();
const samples = computed(() => {
    const out = [...props.subjects.samples];
    const direct = asRecord(props.sample);
    if (direct && !out.some((s) => s.sample_id === direct.sample_id))
        out.unshift(direct);
    return out;
});
const hiddenCount = computed(() => Math.max(props.subjects.hidden, props.sampleHidden ? 1 : 0));
// The row count is the kit's (the page's "On this page" entry uses the same function).
const total = computed(() => testSubjectCount(props.sample, props.subjects, !!props.sampleHidden));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: "Subject",
    count: (__VLS_ctx.total),
    empty: (__VLS_ctx.total === 0),
    emptyText: "No sample or other subject is recorded for this test.",
}));
const __VLS_2 = __VLS_1({
    title: "Subject",
    count: (__VLS_ctx.total),
    empty: (__VLS_ctx.total === 0),
    emptyText: "No sample or other subject is recorded for this test.",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
    ...{ class: "rows" },
});
for (const [s] of __VLS_getVForSourceType((__VLS_ctx.samples))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
        key: (s.sample_id),
        ...{ class: "row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "role" },
    });
    const __VLS_5 = {}.RecordLink;
    /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        collection: "physical_samples",
        id: (s.sample_id),
        ...{ class: "code" },
    }));
    const __VLS_7 = __VLS_6({
        collection: "physical_samples",
        id: (s.sample_id),
        ...{ class: "code" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    __VLS_8.slots.default;
    (s.sample_code || 'Sample');
    var __VLS_8;
    if (s.nickname) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "muted" },
        });
        (s.nickname);
    }
    if (s.form) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "muted" },
        });
        (s.form);
    }
    const __VLS_9 = {}.StatusBadge;
    /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
        kind: "sample",
        value: (s.current_status),
    }));
    const __VLS_11 = __VLS_10({
        kind: "sample",
        value: (s.current_status),
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
}
for (const [o] of __VLS_getVForSourceType((__VLS_ctx.subjects.others))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
        key: (o.collection + o.item),
        ...{ class: "row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "role" },
    });
    (__VLS_ctx.humanise(o.collection.replace(/s$/, '')));
    const __VLS_13 = {}.RecordLink;
    /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
    // @ts-ignore
    const __VLS_14 = __VLS_asFunctionalComponent(__VLS_13, new __VLS_13({
        collection: (o.collection),
        id: (o.item),
        ...{ class: "code" },
    }));
    const __VLS_15 = __VLS_14({
        collection: (o.collection),
        id: (o.item),
        ...{ class: "code" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_14));
    __VLS_16.slots.default;
    (o.label || o.item.slice(0, 8));
    var __VLS_16;
}
if (__VLS_ctx.hiddenCount) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
        ...{ class: "row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "role" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "muted" },
    });
    (__VLS_ctx.hiddenCount === 1 ? '1 subject' : `${__VLS_ctx.hiddenCount} subjects`);
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['rows']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['role']} */ ;
/** @type {__VLS_StyleScopedClasses['code']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['role']} */ ;
/** @type {__VLS_StyleScopedClasses['code']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['role']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RecordLink: RecordLink,
            Section: Section,
            StatusBadge: StatusBadge,
            humanise: humanise,
            samples: samples,
            hiddenCount: hiddenCount,
            total: total,
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
