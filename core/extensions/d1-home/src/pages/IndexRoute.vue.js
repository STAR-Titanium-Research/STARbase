/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { IndexPage, indexDefBySlug } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
const props = defineProps();
const def = computed(() => indexDefBySlug(props.slug));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
/** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
    title: (__VLS_ctx.def?.title ?? 'No such page'),
}));
const __VLS_1 = __VLS_0({
    title: (__VLS_ctx.def?.title ?? 'No such page'),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
var __VLS_3 = {};
__VLS_2.slots.default;
if (__VLS_ctx.def) {
    const __VLS_4 = {}.IndexPage;
    /** @type {[typeof __VLS_components.IndexPage, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
        key: (__VLS_ctx.def.slug),
        def: (__VLS_ctx.def),
    }));
    const __VLS_6 = __VLS_5({
        key: (__VLS_ctx.def.slug),
        def: (__VLS_ctx.def),
    }, ...__VLS_functionalComponentArgsRest(__VLS_5));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "missing" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    (__VLS_ctx.slug);
    const __VLS_8 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        to: "/home",
    }));
    const __VLS_10 = __VLS_9({
        to: "/home",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    __VLS_11.slots.default;
    var __VLS_11;
}
var __VLS_2;
/** @type {__VLS_StyleScopedClasses['missing']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            IndexPage: IndexPage,
            ExplorerView: ExplorerView,
            def: def,
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
