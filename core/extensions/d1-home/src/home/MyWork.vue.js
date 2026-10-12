/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { LoadState, RecordCard, Section, StatusBadge, campaignTypeLabel, formatDate, humanise, projectStatusLabel, recordRoute } from '@d1/ui';
import { CARD_LIMIT, SAMPLE_LIMIT, useMyWork } from './useMyWork';
// Projects where I am PI or investigator, campaigns I own and my newest samples, as cards. Every card is a link to its
// Explorer page; the header of each group links to the full list. The three groups sit side by
// side while there is room, so three empty groups are one row, not three.
const { projects, campaigns, samples, hasPerson, partialProjects, partialSamples } = useMyWork();
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['link']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "my-work" },
});
if (__VLS_ctx.hasPerson === false) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "notice" },
        role: "note",
    });
    const __VLS_0 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        to: "/home/people",
    }));
    const __VLS_2 = __VLS_1({
        to: "/home/people",
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    var __VLS_3;
}
if (__VLS_ctx.partialProjects) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "notice" },
        role: "note",
    });
    (__VLS_ctx.partialProjects);
}
if (__VLS_ctx.partialSamples) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "notice" },
        role: "note",
    });
    (__VLS_ctx.partialSamples);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "d1-cols" },
});
const __VLS_4 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
    title: "My projects (PI or investigator)",
    count: (__VLS_ctx.projects.loading ? null : __VLS_ctx.projects.data.length),
    empty: (!__VLS_ctx.projects.loading && !__VLS_ctx.projects.error && !__VLS_ctx.projects.data.length),
    emptyText: "You are not PI or investigator on any project.",
}));
const __VLS_6 = __VLS_5({
    title: "My projects (PI or investigator)",
    count: (__VLS_ctx.projects.loading ? null : __VLS_ctx.projects.data.length),
    empty: (!__VLS_ctx.projects.loading && !__VLS_ctx.projects.error && !__VLS_ctx.projects.data.length),
    emptyText: "You are not PI or investigator on any project.",
}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
{
    const { actions: __VLS_thisSlot } = __VLS_7.slots;
    const __VLS_8 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        to: "/home/projects",
        ...{ class: "link" },
        title: "All projects you can see",
    }));
    const __VLS_10 = __VLS_9({
        to: "/home/projects",
        ...{ class: "link" },
        title: "All projects you can see",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    __VLS_11.slots.default;
    var __VLS_11;
}
const __VLS_12 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
    loading: (__VLS_ctx.projects.loading),
    error: (__VLS_ctx.projects.error),
}));
const __VLS_14 = __VLS_13({
    loading: (__VLS_ctx.projects.loading),
    error: (__VLS_ctx.projects.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
__VLS_15.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "cards" },
});
for (const [p] of __VLS_getVForSourceType((__VLS_ctx.projects.data))) {
    const __VLS_16 = {}.RecordCard;
    /** @type {[typeof __VLS_components.RecordCard, typeof __VLS_components.RecordCard, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        key: (p.project_id),
        to: (__VLS_ctx.recordRoute('projects', p.project_id)),
        code: (p.project_code),
        name: (p.project_name),
    }));
    const __VLS_18 = __VLS_17({
        key: (p.project_id),
        to: (__VLS_ctx.recordRoute('projects', p.project_id)),
        code: (p.project_code),
        name: (p.project_name),
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    __VLS_19.slots.default;
    {
        const { tag: __VLS_thisSlot } = __VLS_19.slots;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "d1-tag" },
        });
        (__VLS_ctx.projectStatusLabel(p.is_active));
    }
    {
        const { meta: __VLS_thisSlot } = __VLS_19.slots;
        (p.principal_investigator_person?.full_name || 'not set');
    }
    var __VLS_19;
}
if (__VLS_ctx.projects.data.length >= __VLS_ctx.CARD_LIMIT) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note cap" },
    });
    const __VLS_20 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
        to: "/home/projects",
    }));
    const __VLS_22 = __VLS_21({
        to: "/home/projects",
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    __VLS_23.slots.default;
    var __VLS_23;
}
var __VLS_15;
var __VLS_7;
const __VLS_24 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
    title: "Campaigns I own",
    count: (__VLS_ctx.campaigns.loading ? null : __VLS_ctx.campaigns.data.length),
    empty: (!__VLS_ctx.campaigns.loading && !__VLS_ctx.campaigns.error && !__VLS_ctx.campaigns.data.length),
    emptyText: "You do not own any campaign.",
}));
const __VLS_26 = __VLS_25({
    title: "Campaigns I own",
    count: (__VLS_ctx.campaigns.loading ? null : __VLS_ctx.campaigns.data.length),
    empty: (!__VLS_ctx.campaigns.loading && !__VLS_ctx.campaigns.error && !__VLS_ctx.campaigns.data.length),
    emptyText: "You do not own any campaign.",
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
__VLS_27.slots.default;
const __VLS_28 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
    loading: (__VLS_ctx.campaigns.loading),
    error: (__VLS_ctx.campaigns.error),
}));
const __VLS_30 = __VLS_29({
    loading: (__VLS_ctx.campaigns.loading),
    error: (__VLS_ctx.campaigns.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_29));
__VLS_31.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "cards" },
});
for (const [c] of __VLS_getVForSourceType((__VLS_ctx.campaigns.data))) {
    const __VLS_32 = {}.RecordCard;
    /** @type {[typeof __VLS_components.RecordCard, typeof __VLS_components.RecordCard, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        key: (c.campaign_id),
        to: (__VLS_ctx.recordRoute('campaigns', c.campaign_id)),
        code: (c.campaign_code || c.name),
        name: (c.campaign_code ? c.name : null),
    }));
    const __VLS_34 = __VLS_33({
        key: (c.campaign_id),
        to: (__VLS_ctx.recordRoute('campaigns', c.campaign_id)),
        code: (c.campaign_code || c.name),
        name: (c.campaign_code ? c.name : null),
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    __VLS_35.slots.default;
    {
        const { tag: __VLS_thisSlot } = __VLS_35.slots;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "d1-tag" },
        });
        (__VLS_ctx.campaignTypeLabel(c.campaign_type));
    }
    {
        const { meta: __VLS_thisSlot } = __VLS_35.slots;
        if (c.project_id?.project_code) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (c.project_id.project_code);
        }
        if (c.status) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.humanise(c.status));
        }
    }
    var __VLS_35;
}
var __VLS_31;
var __VLS_27;
const __VLS_36 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
    title: "My latest samples",
    count: (__VLS_ctx.samples.loading ? null : __VLS_ctx.samples.data.length),
    empty: (!__VLS_ctx.samples.loading && !__VLS_ctx.samples.error && !__VLS_ctx.samples.data.length),
    emptyText: "No samples are owned by you or co-owned with you yet.",
}));
const __VLS_38 = __VLS_37({
    title: "My latest samples",
    count: (__VLS_ctx.samples.loading ? null : __VLS_ctx.samples.data.length),
    empty: (!__VLS_ctx.samples.loading && !__VLS_ctx.samples.error && !__VLS_ctx.samples.data.length),
    emptyText: "No samples are owned by you or co-owned with you yet.",
}, ...__VLS_functionalComponentArgsRest(__VLS_37));
__VLS_39.slots.default;
{
    const { actions: __VLS_thisSlot } = __VLS_39.slots;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "cap-note" },
    });
    (__VLS_ctx.SAMPLE_LIMIT);
}
const __VLS_40 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
    loading: (__VLS_ctx.samples.loading),
    error: (__VLS_ctx.samples.error),
}));
const __VLS_42 = __VLS_41({
    loading: (__VLS_ctx.samples.loading),
    error: (__VLS_ctx.samples.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_41));
__VLS_43.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "cards" },
});
for (const [s] of __VLS_getVForSourceType((__VLS_ctx.samples.data))) {
    const __VLS_44 = {}.RecordCard;
    /** @type {[typeof __VLS_components.RecordCard, typeof __VLS_components.RecordCard, ]} */ ;
    // @ts-ignore
    const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
        key: (s.sample_id),
        to: (__VLS_ctx.recordRoute('physical_samples', s.sample_id)),
        code: (s.sample_code),
        name: (s.material_id?.common_name || s.form || '—'),
    }));
    const __VLS_46 = __VLS_45({
        key: (s.sample_id),
        to: (__VLS_ctx.recordRoute('physical_samples', s.sample_id)),
        code: (s.sample_code),
        name: (s.material_id?.common_name || s.form || '—'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_45));
    __VLS_47.slots.default;
    {
        const { tag: __VLS_thisSlot } = __VLS_47.slots;
        const __VLS_48 = {}.StatusBadge;
        /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
        // @ts-ignore
        const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
            kind: "sample",
            value: (s.current_status),
        }));
        const __VLS_50 = __VLS_49({
            kind: "sample",
            value: (s.current_status),
        }, ...__VLS_functionalComponentArgsRest(__VLS_49));
    }
    {
        const { meta: __VLS_thisSlot } = __VLS_47.slots;
        (__VLS_ctx.formatDate(s.updated_at, '—'));
    }
    var __VLS_47;
}
var __VLS_43;
var __VLS_39;
/** @type {__VLS_StyleScopedClasses['my-work']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['notice']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-cols']} */ ;
/** @type {__VLS_StyleScopedClasses['link']} */ ;
/** @type {__VLS_StyleScopedClasses['cards']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['cap']} */ ;
/** @type {__VLS_StyleScopedClasses['cards']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['cap-note']} */ ;
/** @type {__VLS_StyleScopedClasses['cards']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            LoadState: LoadState,
            RecordCard: RecordCard,
            Section: Section,
            StatusBadge: StatusBadge,
            campaignTypeLabel: campaignTypeLabel,
            formatDate: formatDate,
            humanise: humanise,
            projectStatusLabel: projectStatusLabel,
            recordRoute: recordRoute,
            CARD_LIMIT: CARD_LIMIT,
            SAMPLE_LIMIT: SAMPLE_LIMIT,
            projects: projects,
            campaigns: campaigns,
            samples: samples,
            hasPerson: hasPerson,
            partialProjects: partialProjects,
            partialSamples: partialSamples,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
