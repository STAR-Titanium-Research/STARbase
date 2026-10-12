/// <reference types="../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { EXPLORER_HOST, ExplorerNav, Finder, isFinderShortcut, isModalOpen } from '@d1/ui';
import { useExplorerHost } from './explorerHost';
const __VLS_props = defineProps();
provide(EXPLORER_HOST, useExplorerHost());
// The finder dialog: opened by the sidebar's box and by Ctrl K / Cmd K anywhere in the app.
const finderOpen = ref(false);
const openFinder = () => {
    finderOpen.value = true;
};
// A Directus drawer or dialog being open means the user is in the middle of a form: Ctrl K does
// not pull the finder over it. Directus mounts every open drawer and dialog into #dialog-outlet
// (empty otherwise; checked in Directus 11.17), plus any other aria-modal dialog that is not the
// finder. Not `.v-overlay.active` (at narrow widths Directus's own navigation drawer is an "active"
// absolute overlay whenever the nav is shown) and not `.v-dialog .content` (that wrapper is always
// in the DOM).
const MODAL_SELECTOR = '#dialog-outlet > *, [role="dialog"][aria-modal="true"]:not(.d1-finder)';
const overlayOpen = () => isModalOpen(document, MODAL_SELECTOR);
function onKeydown(e) {
    if (!isFinderShortcut(e))
        return;
    // The browser's own Ctrl K (focus the search bar) must not fire, in an input or not.
    e.preventDefault();
    if (finderOpen.value || overlayOpen())
        return;
    openFinder();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
const __VLS_0 = {}.PrivateView;
/** @type {[typeof __VLS_components.PrivateView, typeof __VLS_components.privateView, typeof __VLS_components.PrivateView, typeof __VLS_components.privateView, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: (__VLS_ctx.title),
}));
const __VLS_2 = __VLS_1({
    title: (__VLS_ctx.title),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
{
    const { navigation: __VLS_thisSlot } = __VLS_3.slots;
    const __VLS_5 = {}.ExplorerNav;
    /** @type {[typeof __VLS_components.ExplorerNav, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        ...{ 'onOpenFinder': {} },
        showBrand: (false),
    }));
    const __VLS_7 = __VLS_6({
        ...{ 'onOpenFinder': {} },
        showBrand: (false),
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    let __VLS_9;
    let __VLS_10;
    let __VLS_11;
    const __VLS_12 = {
        onOpenFinder: (__VLS_ctx.openFinder)
    };
    var __VLS_8;
    if (__VLS_ctx.finderOpen) {
        const __VLS_13 = {}.Finder;
        /** @type {[typeof __VLS_components.Finder, ]} */ ;
        // @ts-ignore
        const __VLS_14 = __VLS_asFunctionalComponent(__VLS_13, new __VLS_13({
            ...{ 'onClose': {} },
        }));
        const __VLS_15 = __VLS_14({
            ...{ 'onClose': {} },
        }, ...__VLS_functionalComponentArgsRest(__VLS_14));
        let __VLS_17;
        let __VLS_18;
        let __VLS_19;
        const __VLS_20 = {
            onClose: (...[$event]) => {
                if (!(__VLS_ctx.finderOpen))
                    return;
                __VLS_ctx.finderOpen = false;
            }
        };
        var __VLS_16;
    }
}
for (const [_, name] of __VLS_getVForSourceType((__VLS_ctx.$slots))) {
    {
        const { [__VLS_tryAsConstant(name)]: __VLS_thisSlot } = __VLS_3.slots;
        const [slotProps] = __VLS_getSlotParams(__VLS_thisSlot);
        var __VLS_21 = {
            ...(slotProps || {}),
        };
        var __VLS_22 = __VLS_tryAsConstant(name);
    }
}
var __VLS_3;
// @ts-ignore
var __VLS_23 = __VLS_22, __VLS_24 = __VLS_21;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ExplorerNav: ExplorerNav,
            Finder: Finder,
            finderOpen: finderOpen,
            openFinder: openFinder,
        };
    },
    __typeProps: {},
});
const __VLS_component = (await import('vue')).defineComponent({
    setup() {
        return {};
    },
    __typeProps: {},
});
export default {};
; /* PartiallyEnd: #4569/main.vue */
