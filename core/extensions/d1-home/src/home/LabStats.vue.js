/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { Section, collectionRoute } from '@d1/ui';
import { go } from './goto';
// The counts that Home always had, a quiet strip under "my work". Every count reads as the signed-in
// user, so since ADR-0011 it is what that user may see (see "What you see" in the Explorer pages
// wiki page for every path), not the lab's total. Lab Admins still see everything.
const api = useApi();
const router = useRouter();
const stats = ref([
    { key: 'samples', label: 'Samples', value: '—', icon: 'science', to: collectionRoute('physical_samples') },
    { key: 'machining', label: 'Machining', value: '—', icon: 'build', to: collectionRoute('manufacturing_operations') },
    { key: 'fast', label: 'FAST', value: '—', icon: 'whatshot', to: '/d1-fast-dashboard' },
    { key: 'tests', label: 'Tests', value: '—', icon: 'biotech', to: collectionRoute('test_sessions') },
    { key: 'projects', label: 'Projects', value: '—', icon: 'folder_open', to: collectionRoute('projects') },
    { key: 'campaigns', label: 'Campaigns', value: '—', icon: 'flag', to: collectionRoute('campaigns') },
]);
function fill(key, patch) {
    const tile = stats.value.find((st) => st.key === key);
    if (tile)
        Object.assign(tile, patch);
}
async function count(collection, filter) {
    try {
        const params = { aggregate: { count: '*' }, limit: 1 };
        if (filter)
            params.filter = filter;
        const res = await api.get(`/items/${collection}`, { params });
        return Number(res.data.data[0].count).toLocaleString('en-GB');
    }
    catch {
        return '—';
    }
}
onMounted(() => {
    // Each tile fills as its own count arrives. Machining and FAST (sintering) are one collection split.
    const reads = [
        ['samples', 'physical_samples'],
        ['machining', 'manufacturing_operations', { process_category: { _neq: 'sintering' } }],
        ['fast', 'manufacturing_operations', { process_category: { _eq: 'sintering' } }],
        ['tests', 'test_sessions'],
        ['projects', 'projects'],
        ['campaigns', 'campaigns'],
    ];
    for (const [key, collection, filter] of reads)
        count(collection, filter).then((value) => fill(key, { value }));
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
/** @type {__VLS_StyleScopedClasses['rule']} */ ;
/** @type {__VLS_StyleScopedClasses['rule']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: "At a glance",
}));
const __VLS_2 = __VLS_1({
    title: "At a glance",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
{
    const { actions: __VLS_thisSlot } = __VLS_3.slots;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "sub" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stats" },
});
for (const [st] of __VLS_getVForSourceType((__VLS_ctx.stats))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.go(__VLS_ctx.router, st.to);
            } },
        key: (st.key),
        ...{ class: "stat" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "s-value" },
    });
    (st.value);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "s-label" },
    });
    const __VLS_5 = {}.VIcon;
    /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        name: (st.icon),
        xSmall: true,
        ...{ class: "s-icon" },
    }));
    const __VLS_7 = __VLS_6({
        name: (st.icon),
        xSmall: true,
        ...{ class: "s-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    (st.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.details, __VLS_intrinsicElements.details)({
    ...{ class: "rule" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.summary, __VLS_intrinsicElements.summary)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['sub']} */ ;
/** @type {__VLS_StyleScopedClasses['stats']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
/** @type {__VLS_StyleScopedClasses['s-value']} */ ;
/** @type {__VLS_StyleScopedClasses['s-label']} */ ;
/** @type {__VLS_StyleScopedClasses['s-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['rule']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Section: Section,
            go: go,
            router: router,
            stats: stats,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
