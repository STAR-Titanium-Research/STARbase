/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from '../ExplorerView.vue';
import { computed, ref } from 'vue';
import { useStores } from '@directus/extensions-sdk';
import { LoadState, PageShell, filterProjects, projectRole } from '@d1/ui';
import { PROJECT_CAP, useProjectsIndex } from './projects/useProjectsIndex';
import ProjectCard from './projects/ProjectCard.vue';
// Projects index: every project the signed-in user can read, as cards with the people, dates,
// counts and a sparkline of operations and tests per week. Design:
// docs/superpowers/specs/2026-10-06-explorer-pages-design.md ("Projects index").
const { useUserStore } = useStores();
const userId = computed(() => useUserStore().currentUser?.id ?? null);
const { projects, loading, error, campaignCounts, sampleCounts, campaignCountsError, sampleCountsError, activity, activityError, truncated, rolesError } = useProjectsIndex();
const role = ref('all');
const status = ref('all');
const query = ref('');
const visible = computed(() => filterProjects(projects.value, { role: role.value, status: status.value, query: query.value }, userId.value));
const countOrNull = (m, failed, id) => (failed ? null : (m.get(id) ?? 0));
const roleOptions = [
    { value: 'all', label: 'All projects I can see' },
    { value: 'any', label: 'I am PI or investigator' },
    { value: 'pi', label: 'I am PI' },
    { value: 'investigator', label: 'I am investigator' },
];
const statusOptions = [
    { value: 'all', label: 'Any status' },
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
];
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
// CSS variable injection 
// CSS variable injection end 
/** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
    title: "Projects",
}));
const __VLS_1 = __VLS_0({
    title: "Projects",
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
var __VLS_3 = {};
__VLS_2.slots.default;
const __VLS_4 = {}.PageShell;
/** @type {[typeof __VLS_components.PageShell, typeof __VLS_components.PageShell, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.nav, __VLS_intrinsicElements.nav)({
    ...{ class: "d1-crumbs" },
});
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
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "filters" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "field search" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
    type: "search",
    placeholder: "Code or name",
    'aria-label': "Search projects by code or name",
});
(__VLS_ctx.query);
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "field" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.role),
    'aria-label': "Filter by my role",
});
for (const [o] of __VLS_getVForSourceType((__VLS_ctx.roleOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (o.value),
        value: (o.value),
    });
    (o.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
    ...{ class: "field" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.select, __VLS_intrinsicElements.select)({
    value: (__VLS_ctx.status),
    'aria-label': "Filter by status",
});
for (const [o] of __VLS_getVForSourceType((__VLS_ctx.statusOptions))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.option, __VLS_intrinsicElements.option)({
        key: (o.value),
        value: (o.value),
    });
    (o.label);
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.span)({
    ...{ class: "spacer" },
});
const __VLS_12 = {}.VButton;
/** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
// @ts-ignore
const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
    small: true,
    secondary: true,
    to: "/content/projects/+",
}));
const __VLS_14 = __VLS_13({
    small: true,
    secondary: true,
    to: "/content/projects/+",
}, ...__VLS_functionalComponentArgsRest(__VLS_13));
__VLS_15.slots.default;
const __VLS_16 = {}.VIcon;
/** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
// @ts-ignore
const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
    name: "add",
    small: true,
    left: true,
}));
const __VLS_18 = __VLS_17({
    name: "add",
    small: true,
    left: true,
}, ...__VLS_functionalComponentArgsRest(__VLS_17));
var __VLS_15;
if (__VLS_ctx.loading && !__VLS_ctx.projects.length) {
    const __VLS_20 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
        loading: true,
        loadingText: "Loading projects…",
    }));
    const __VLS_22 = __VLS_21({
        loading: true,
        loadingText: "Loading projects…",
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
}
else if (__VLS_ctx.error) {
    const __VLS_24 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
        error: (__VLS_ctx.error),
    }));
    const __VLS_26 = __VLS_25({
        error: (__VLS_ctx.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_25));
}
else if (!__VLS_ctx.projects.length) {
    const __VLS_28 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
        empty: true,
        emptyText: "No projects visible to you yet. If you expected some, you may not have been added as PI or investigator.",
    }));
    const __VLS_30 = __VLS_29({
        empty: true,
        emptyText: "No projects visible to you yet. If you expected some, you may not have been added as PI or investigator.",
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
}
else {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note" },
    });
    (__VLS_ctx.visible.length);
    (__VLS_ctx.projects.length);
    if (__VLS_ctx.projects.length >= __VLS_ctx.PROJECT_CAP) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        (__VLS_ctx.PROJECT_CAP);
    }
    if (__VLS_ctx.role !== 'all' && !__VLS_ctx.userId) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note warn" },
        });
    }
    if (__VLS_ctx.campaignCountsError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note warn" },
            role: "alert",
        });
        (__VLS_ctx.campaignCountsError);
    }
    if (__VLS_ctx.sampleCountsError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note warn" },
            role: "alert",
        });
        (__VLS_ctx.sampleCountsError);
    }
    if (__VLS_ctx.activityError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note warn" },
            role: "alert",
        });
        (__VLS_ctx.activityError);
    }
    if (__VLS_ctx.rolesError) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note warn" },
            role: "alert",
        });
        (__VLS_ctx.rolesError);
    }
    if (__VLS_ctx.truncated) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note warn" },
        });
    }
    if (!__VLS_ctx.visible.length) {
        const __VLS_32 = {}.LoadState;
        /** @type {[typeof __VLS_components.LoadState, ]} */ ;
        // @ts-ignore
        const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
            empty: true,
            emptyText: "No project matches these filters.",
        }));
        const __VLS_34 = __VLS_33({
            empty: true,
            emptyText: "No project matches these filters.",
        }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "grid" },
        });
        for (const [p] of __VLS_getVForSourceType((__VLS_ctx.visible))) {
            /** @type {[typeof ProjectCard, ]} */ ;
            // @ts-ignore
            const __VLS_36 = __VLS_asFunctionalComponent(ProjectCard, new ProjectCard({
                key: (p.project_id),
                project: (p),
                role: (__VLS_ctx.projectRole(p, __VLS_ctx.userId)),
                campaigns: (__VLS_ctx.countOrNull(__VLS_ctx.campaignCounts, __VLS_ctx.campaignCountsError, p.project_id)),
                samples: (__VLS_ctx.countOrNull(__VLS_ctx.sampleCounts, __VLS_ctx.sampleCountsError, p.project_id)),
                activity: (__VLS_ctx.activity.get(p.project_id) ?? null),
            }));
            const __VLS_37 = __VLS_36({
                key: (p.project_id),
                project: (p),
                role: (__VLS_ctx.projectRole(p, __VLS_ctx.userId)),
                campaigns: (__VLS_ctx.countOrNull(__VLS_ctx.campaignCounts, __VLS_ctx.campaignCountsError, p.project_id)),
                samples: (__VLS_ctx.countOrNull(__VLS_ctx.sampleCounts, __VLS_ctx.sampleCountsError, p.project_id)),
                activity: (__VLS_ctx.activity.get(p.project_id) ?? null),
            }, ...__VLS_functionalComponentArgsRest(__VLS_36));
        }
    }
}
var __VLS_7;
var __VLS_2;
/** @type {__VLS_StyleScopedClasses['d1-crumbs']} */ ;
/** @type {__VLS_StyleScopedClasses['filters']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['search']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['field']} */ ;
/** @type {__VLS_StyleScopedClasses['spacer']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['grid']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ExplorerView: ExplorerView,
            LoadState: LoadState,
            PageShell: PageShell,
            projectRole: projectRole,
            PROJECT_CAP: PROJECT_CAP,
            ProjectCard: ProjectCard,
            userId: userId,
            projects: projects,
            loading: loading,
            error: error,
            campaignCounts: campaignCounts,
            sampleCounts: sampleCounts,
            campaignCountsError: campaignCountsError,
            sampleCountsError: sampleCountsError,
            activity: activity,
            activityError: activityError,
            truncated: truncated,
            rolesError: rolesError,
            role: role,
            status: status,
            query: query,
            visible: visible,
            countOrNull: countOrNull,
            roleOptions: roleOptions,
            statusOptions: statusOptions,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
