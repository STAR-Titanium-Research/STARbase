/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { LIST_CAP, LoadState, ProgressBar, RecordCard, Section, campaignTypeLabel, formatDate, humanise, indexRoute, recordRoute, } from '@d1/ui';
import { computed } from 'vue';
const props = defineProps();
// The full list opens narrowed to this project (the Campaigns page has a Project filter).
const allCampaigns = computed(() => indexRoute('campaigns', props.projectId ? { query: { 'f.project_id': props.projectId } } : {}));
const rows = computed(() => props.campaigns.data.slice(0, LIST_CAP));
const capped = computed(() => props.campaigns.data.length > LIST_CAP);
const dates = (c) => {
    const a = formatDate(c.start_date);
    const b = formatDate(c.end_date);
    return a && b ? `${a} to ${b}` : a ? `From ${a}` : b ? `Until ${b}` : '';
};
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
    id: "campaigns",
    title: "Campaigns",
    count: (__VLS_ctx.campaigns.loading ? null : __VLS_ctx.rows.length),
    empty: (!__VLS_ctx.campaigns.loading && !__VLS_ctx.campaigns.error && !__VLS_ctx.rows.length),
    emptyText: "No campaigns in this project.",
}));
const __VLS_2 = __VLS_1({
    id: "campaigns",
    title: "Campaigns",
    count: (__VLS_ctx.campaigns.loading ? null : __VLS_ctx.rows.length),
    empty: (!__VLS_ctx.campaigns.loading && !__VLS_ctx.campaigns.error && !__VLS_ctx.rows.length),
    emptyText: "No campaigns in this project.",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
const __VLS_5 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
    loading: (__VLS_ctx.campaigns.loading),
    error: (__VLS_ctx.campaigns.error),
}));
const __VLS_7 = __VLS_6({
    loading: (__VLS_ctx.campaigns.loading),
    error: (__VLS_ctx.campaigns.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_6));
__VLS_8.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "grid" },
});
for (const [c] of __VLS_getVForSourceType((__VLS_ctx.rows))) {
    const __VLS_9 = {}.RecordCard;
    /** @type {[typeof __VLS_components.RecordCard, typeof __VLS_components.RecordCard, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
        key: (c.campaign_id),
        to: (__VLS_ctx.recordRoute('campaigns', c.campaign_id)),
        code: (c.campaign_code || c.name),
        name: (c.campaign_code ? c.name : null),
    }));
    const __VLS_11 = __VLS_10({
        key: (c.campaign_id),
        to: (__VLS_ctx.recordRoute('campaigns', c.campaign_id)),
        code: (c.campaign_code || c.name),
        name: (c.campaign_code ? c.name : null),
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
    __VLS_12.slots.default;
    {
        const { tag: __VLS_thisSlot } = __VLS_12.slots;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "d1-tag" },
        });
        (__VLS_ctx.campaignTypeLabel(c.campaign_type));
    }
    {
        const { meta: __VLS_thisSlot } = __VLS_12.slots;
        if (c.status) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.humanise(c.status));
        }
        if (c.owner_person_id?.full_name) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (c.owner_person_id.full_name);
        }
        if (__VLS_ctx.dates(c)) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.dates(c));
        }
    }
    if (c.stats) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "d1-counts" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
        (c.stats.samples);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
        (c.stats.operations);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
        (c.stats.tests);
        if (c.stats.progress.kind === 'bar' && c.stats.progress.total) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "progress" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "p-label" },
            });
            (c.stats.progress.label);
            const __VLS_13 = {}.ProgressBar;
            /** @type {[typeof __VLS_components.ProgressBar, ]} */ ;
            // @ts-ignore
            const __VLS_14 = __VLS_asFunctionalComponent(__VLS_13, new __VLS_13({
                value: (c.stats.progress.done),
                max: (c.stats.progress.total),
            }));
            const __VLS_15 = __VLS_14({
                value: (c.stats.progress.done),
                max: (c.stats.progress.total),
            }, ...__VLS_functionalComponentArgsRest(__VLS_14));
        }
        else if (c.stats.progress.kind === 'unavailable') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "no-progress" },
            });
            (c.stats.progress.label);
            (c.stats.progress.reason === 'truncated' ? 'too many records' : 'no access to the data');
        }
        else if (c.stats.progress.kind === 'bar') {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "no-progress" },
            });
            (c.campaign_type === 'testing_campaign' ? 'tests' : 'machining operations');
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "no-progress" },
        });
    }
    var __VLS_12;
}
if (__VLS_ctx.capped) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note cap" },
    });
    (__VLS_ctx.LIST_CAP);
    const __VLS_17 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_18 = __VLS_asFunctionalComponent(__VLS_17, new __VLS_17({
        to: (__VLS_ctx.allCampaigns),
    }));
    const __VLS_19 = __VLS_18({
        to: (__VLS_ctx.allCampaigns),
    }, ...__VLS_functionalComponentArgsRest(__VLS_18));
    __VLS_20.slots.default;
    (__VLS_ctx.projectId ? "See all of this project's campaigns" : 'See the full list');
    var __VLS_20;
}
var __VLS_8;
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-counts']} */ ;
/** @type {__VLS_StyleScopedClasses['progress']} */ ;
/** @type {__VLS_StyleScopedClasses['p-label']} */ ;
/** @type {__VLS_StyleScopedClasses['no-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['no-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['no-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['cap']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            LIST_CAP: LIST_CAP,
            LoadState: LoadState,
            ProgressBar: ProgressBar,
            RecordCard: RecordCard,
            Section: Section,
            campaignTypeLabel: campaignTypeLabel,
            humanise: humanise,
            recordRoute: recordRoute,
            allCampaigns: allCampaigns,
            rows: rows,
            capped: capped,
            dates: dates,
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
