/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { nextTick, onMounted, ref, watch } from 'vue';
import { formatDate } from '@d1/ui';
const props = defineProps();
const strip = ref(null);
// This sample's node, found with a function ref (the nodes are a v-for).
let selfEl = null;
const setSelf = (item, el) => {
    if (item.kind === 'self')
        selfEl = el;
};
function centreOnSelf() {
    const s = strip.value;
    const el = selfEl;
    if (!s || !el || s.scrollWidth <= s.clientWidth)
        return;
    s.scrollLeft = el.offsetLeft - s.clientWidth / 2 + el.clientWidth / 2;
}
onMounted(centreOnSelf);
watch(() => props.items, () => nextTick(centreOnSelf));
const KIND_LABEL = {
    stock: 'Raw stock',
    ancestor: 'Parent',
    operation: 'Operation',
    test: 'Test',
    descendant: 'Child',
    self: 'This sample',
    hidden: '',
};
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['node']} */ ;
/** @type {__VLS_StyleScopedClasses['kind--self']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['kind--self']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['via']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['strip']} */ ;
/** @type {__VLS_StyleScopedClasses['node']} */ ;
/** @type {__VLS_StyleScopedClasses['node']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['kind--self']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['node']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "life" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.ol, __VLS_intrinsicElements.ol)({
    ref: "strip",
    ...{ class: "strip" },
});
/** @type {typeof __VLS_ctx.strip} */ ;
for (const [item] of __VLS_getVForSourceType((__VLS_ctx.items))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
        key: (item.key),
        ref: ((el) => __VLS_ctx.setSelf(item, el)),
        ...{ class: "node" },
        ...{ class: ([`kind--${item.kind}`, { through: item.throughHidden }]) },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span)({
        ...{ class: "dot" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "kind" },
    });
    (__VLS_ctx.KIND_LABEL[item.kind]);
    if (item.to) {
        const __VLS_0 = {}.RouterLink;
        /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
            to: (item.to),
            ...{ class: "label" },
            ...{ class: ({ code: item.isCode }) },
        }));
        const __VLS_2 = __VLS_1({
            to: (item.to),
            ...{ class: "label" },
            ...{ class: ({ code: item.isCode }) },
        }, ...__VLS_functionalComponentArgsRest(__VLS_1));
        __VLS_3.slots.default;
        (item.label);
        var __VLS_3;
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "label" },
            ...{ class: ({ code: item.isCode, plain: item.kind === 'hidden' }) },
        });
        (item.label);
    }
    if (item.sub) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "sub" },
        });
        (item.sub);
    }
    if (item.date) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "date" },
        });
        (__VLS_ctx.formatDate(item.date, 'undated'));
    }
    else if (item.kind === 'operation' || item.kind === 'test') {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "date" },
        });
    }
    if (item.throughHidden) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "via" },
            title: "Every path to this record goes through a sample you do not have permission to read.",
        });
    }
}
/** @type {__VLS_StyleScopedClasses['life']} */ ;
/** @type {__VLS_StyleScopedClasses['strip']} */ ;
/** @type {__VLS_StyleScopedClasses['node']} */ ;
/** @type {__VLS_StyleScopedClasses['dot']} */ ;
/** @type {__VLS_StyleScopedClasses['kind']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['label']} */ ;
/** @type {__VLS_StyleScopedClasses['sub']} */ ;
/** @type {__VLS_StyleScopedClasses['date']} */ ;
/** @type {__VLS_StyleScopedClasses['date']} */ ;
/** @type {__VLS_StyleScopedClasses['via']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            formatDate: formatDate,
            strip: strip,
            setSelf: setSelf,
            KIND_LABEL: KIND_LABEL,
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
