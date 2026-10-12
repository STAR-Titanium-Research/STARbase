/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { RecordCard, Sparkline, formatDate, projectStatusLabel, recordRoute } from '@d1/ui';
const props = defineProps();
const to = computed(() => recordRoute('projects', props.project.project_id));
const active = computed(() => props.project.is_active !== false);
const dates = computed(() => {
    const start = formatDate(props.project.start_date);
    const end = formatDate(props.project.end_date);
    if (start && end)
        return `${start} to ${end}`;
    if (start)
        return `From ${start}`;
    if (end)
        return `Until ${end}`;
    return 'No dates set';
});
const show = (n) => (n === null ? '–' : n.toLocaleString('en-GB'));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.RecordCard;
/** @type {[typeof __VLS_components.RecordCard, typeof __VLS_components.RecordCard, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    to: (__VLS_ctx.to),
    code: (__VLS_ctx.project.project_code),
    name: (__VLS_ctx.project.project_name),
    raised: true,
}));
const __VLS_2 = __VLS_1({
    to: (__VLS_ctx.to),
    code: (__VLS_ctx.project.project_code),
    name: (__VLS_ctx.project.project_name),
    raised: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
{
    const { tag: __VLS_thisSlot } = __VLS_3.slots;
    if (__VLS_ctx.role) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "d1-tag" },
        });
        (__VLS_ctx.role === 'pi' ? 'You are PI' : 'You are investigator');
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "status" },
        ...{ class: ({ active: __VLS_ctx.active }) },
    });
    (__VLS_ctx.projectStatusLabel(__VLS_ctx.project.is_active));
}
{
    const { meta: __VLS_thisSlot } = __VLS_3.slots;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.project.principal_investigator_person?.full_name || 'not set');
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (__VLS_ctx.dates);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "d1-counts" },
    title: "Counts only what you can see",
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
(__VLS_ctx.show(__VLS_ctx.campaigns));
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
(__VLS_ctx.show(__VLS_ctx.samples));
if (__VLS_ctx.activity) {
    const __VLS_5 = {}.Sparkline;
    /** @type {[typeof __VLS_components.Sparkline, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        ops: (__VLS_ctx.activity.ops),
        tests: (__VLS_ctx.activity.tests),
        weeks: (__VLS_ctx.activity.weeks),
    }));
    const __VLS_7 = __VLS_6({
        ops: (__VLS_ctx.activity.ops),
        tests: (__VLS_ctx.activity.tests),
        weeks: (__VLS_ctx.activity.weeks),
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "spark-placeholder" },
    });
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['d1-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-counts']} */ ;
/** @type {__VLS_StyleScopedClasses['spark-placeholder']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            RecordCard: RecordCard,
            Sparkline: Sparkline,
            projectStatusLabel: projectStatusLabel,
            to: to,
            active: active,
            dates: dates,
            show: show,
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
