/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { CompositionBar, FactList, LoadState, Section } from '@d1/ui';
const props = defineProps();
const material = computed(() => props.sample.material_id ?? null);
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['mat-name']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    id: "details",
    title: "Material and details",
}));
const __VLS_2 = __VLS_1({
    id: "details",
    title: "Material and details",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "body" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "material" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "mat-name" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "mat-label" },
});
if (__VLS_ctx.material) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
    (__VLS_ctx.material.common_name || __VLS_ctx.material.alloy_code);
    if (__VLS_ctx.material.common_name && __VLS_ctx.material.alloy_code) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "alloy" },
        });
        (__VLS_ctx.material.alloy_code);
    }
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "none" },
    });
}
if (__VLS_ctx.material) {
    const __VLS_5 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        loading: (__VLS_ctx.elementsLoading),
        error: (__VLS_ctx.elementsError),
    }));
    const __VLS_7 = __VLS_6({
        loading: (__VLS_ctx.elementsLoading),
        error: (__VLS_ctx.elementsError),
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    __VLS_8.slots.default;
    const __VLS_9 = {}.CompositionBar;
    /** @type {[typeof __VLS_components.CompositionBar, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
        elements: (__VLS_ctx.elements),
    }));
    const __VLS_11 = __VLS_10({
        elements: (__VLS_ctx.elements),
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
    var __VLS_8;
}
const __VLS_13 = {}.FactList;
/** @type {[typeof __VLS_components.FactList, ]} */ ;
// @ts-ignore
const __VLS_14 = __VLS_asFunctionalComponent(__VLS_13, new __VLS_13({
    facts: (__VLS_ctx.facts),
}));
const __VLS_15 = __VLS_14({
    facts: (__VLS_ctx.facts),
}, ...__VLS_functionalComponentArgsRest(__VLS_14));
if (__VLS_ctx.sample.notes) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "condition" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "mat-label" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "notes" },
    });
    (__VLS_ctx.sample.notes);
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['body']} */ ;
/** @type {__VLS_StyleScopedClasses['material']} */ ;
/** @type {__VLS_StyleScopedClasses['mat-name']} */ ;
/** @type {__VLS_StyleScopedClasses['mat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['alloy']} */ ;
/** @type {__VLS_StyleScopedClasses['none']} */ ;
/** @type {__VLS_StyleScopedClasses['condition']} */ ;
/** @type {__VLS_StyleScopedClasses['mat-label']} */ ;
/** @type {__VLS_StyleScopedClasses['notes']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            CompositionBar: CompositionBar,
            FactList: FactList,
            LoadState: LoadState,
            Section: Section,
            material: material,
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
