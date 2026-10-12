/// <reference types="../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from './ExplorerView.vue';
import { useExplorerHost } from './explorerHost';
import { computed } from 'vue';
import { useStores } from '@directus/extensions-sdk';
import { PageShell } from '@d1/ui';
import QuickActions from './home/QuickActions.vue';
import NeedsAttention from './home/NeedsAttention.vue';
import MyWork from './home/MyWork.vue';
import LabStats from './home/LabStats.vue';
import RecentActivity from './home/RecentActivity.vue';
// Home is "my work" (docs/superpowers/specs/2026-10-06-explorer-pages-design.md, "Home"): a
// greeting, the few things a researcher does every day, what needs attention, my projects,
// campaigns and samples, then the lab-wide strip and recent activity. Each block is its own
// component in ./home/ and loads on its own, so one forbidden collection never blanks Home.
const { useUserStore } = useStores();
const userStore = useUserStore();
const firstName = computed(() => userStore.currentUser?.first_name || 'there');
const greeting = computed(() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
});
const today = computed(() => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }));
// The server's own answer (GET /policies/me/globals), read once for the whole Explorer by the host.
const { isAdmin } = useExplorerHost();
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['hero']} */ ;
// CSS variable injection 
// CSS variable injection end 
/** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
    title: "Home",
}));
const __VLS_1 = __VLS_0({
    title: "Home",
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
var __VLS_3 = {};
__VLS_2.slots.default;
const __VLS_4 = {}.PageShell;
/** @type {[typeof __VLS_components.PageShell, typeof __VLS_components.PageShell, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
    ...{ class: "hero" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h1, __VLS_intrinsicElements.h1)({});
(__VLS_ctx.greeting);
(__VLS_ctx.firstName);
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "hero-sub" },
});
(__VLS_ctx.today);
/** @type {[typeof QuickActions, ]} */ ;
// @ts-ignore
const __VLS_8 = __VLS_asFunctionalComponent(QuickActions, new QuickActions({}));
const __VLS_9 = __VLS_8({}, ...__VLS_functionalComponentArgsRest(__VLS_8));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "d1-cols" },
});
/** @type {[typeof NeedsAttention, ]} */ ;
// @ts-ignore
const __VLS_11 = __VLS_asFunctionalComponent(NeedsAttention, new NeedsAttention({
    isAdmin: (__VLS_ctx.isAdmin),
}));
const __VLS_12 = __VLS_11({
    isAdmin: (__VLS_ctx.isAdmin),
}, ...__VLS_functionalComponentArgsRest(__VLS_11));
/** @type {[typeof LabStats, ]} */ ;
// @ts-ignore
const __VLS_14 = __VLS_asFunctionalComponent(LabStats, new LabStats({}));
const __VLS_15 = __VLS_14({}, ...__VLS_functionalComponentArgsRest(__VLS_14));
/** @type {[typeof MyWork, ]} */ ;
// @ts-ignore
const __VLS_17 = __VLS_asFunctionalComponent(MyWork, new MyWork({}));
const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
/** @type {[typeof RecentActivity, ]} */ ;
// @ts-ignore
const __VLS_20 = __VLS_asFunctionalComponent(RecentActivity, new RecentActivity({}));
const __VLS_21 = __VLS_20({}, ...__VLS_functionalComponentArgsRest(__VLS_20));
var __VLS_7;
var __VLS_2;
/** @type {__VLS_StyleScopedClasses['hero']} */ ;
/** @type {__VLS_StyleScopedClasses['hero-sub']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-cols']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ExplorerView: ExplorerView,
            PageShell: PageShell,
            QuickActions: QuickActions,
            NeedsAttention: NeedsAttention,
            MyWork: MyWork,
            LabStats: LabStats,
            RecentActivity: RecentActivity,
            firstName: firstName,
            greeting: greeting,
            today: today,
            isAdmin: isAdmin,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
