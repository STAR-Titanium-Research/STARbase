/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { FactList, LoadState, Section, detailsCount } from '@d1/ui';
const props = defineProps();
const settled = computed(() => !props.paramsLoading && !props.paramsError);
const empty = computed(() => settled.value && !props.facts.length && !props.notes);
const count = computed(() => detailsCount(props.facts.length, !!props.notes, !!props.paramsLoading, props.paramsError));
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
    id: "details",
    title: "Details",
    count: (__VLS_ctx.count),
    empty: (__VLS_ctx.empty),
    emptyText: (__VLS_ctx.emptyText),
}));
const __VLS_2 = __VLS_1({
    id: "details",
    title: "Details",
    count: (__VLS_ctx.count),
    empty: (__VLS_ctx.empty),
    emptyText: (__VLS_ctx.emptyText),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
const __VLS_5 = {}.FactList;
/** @type {[typeof __VLS_components.FactList, ]} */ ;
// @ts-ignore
const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
    facts: (__VLS_ctx.facts),
}));
const __VLS_7 = __VLS_6({
    facts: (__VLS_ctx.facts),
}, ...__VLS_functionalComponentArgsRest(__VLS_6));
if (__VLS_ctx.notes) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "notes" },
    });
    (__VLS_ctx.notes);
}
if (__VLS_ctx.paramsLoading || __VLS_ctx.paramsError) {
    const __VLS_9 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
        ...{ class: "params-state" },
        loading: (__VLS_ctx.paramsLoading),
        error: (__VLS_ctx.paramsError),
        loadingText: "Loading parameters…",
    }));
    const __VLS_11 = __VLS_10({
        ...{ class: "params-state" },
        loading: (__VLS_ctx.paramsLoading),
        error: (__VLS_ctx.paramsError),
        loadingText: "Loading parameters…",
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['notes']} */ ;
/** @type {__VLS_StyleScopedClasses['params-state']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            FactList: FactList,
            LoadState: LoadState,
            Section: Section,
            empty: empty,
            count: count,
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
