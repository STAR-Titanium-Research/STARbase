/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { EditDrawer, useCanUpdate, LIST_CAP, LoadState, NotVisible, PageShell, RecordLayout, RecordRail, Section, Sparkline, dataStudioRoute, projectContents, projectRailFacts, projectStatusLabel, } from '@d1/ui';
import { useProjectData } from './projects/useProjectData';
import CampaignCards from './projects/CampaignCards.vue';
import UnassignedLists from './projects/UnassignedLists.vue';
const props = defineProps();
const { project, loading, notVisible, error, investigators, counts, campaigns, looseSamples, looseOperations, looseTests, activity, equipment, reload, } = useProjectData(toRef(props, 'id'));
const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('projects', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
    reload();
    refreshCanUpdate();
}
const code = computed(() => project.value?.project_code ?? 'Project');
const studioTo = computed(() => dataStudioRoute('projects', props.id));
const active = computed(() => project.value?.is_active !== false);
// The rail's key facts: the old header line and the totals the stat tiles showed. The counts follow
// the project rule (projectScope.ts), so they are text here, not links (see record/projectFacts.ts).
const railFacts = computed(() => projectRailFacts(project.value, investigators.value.data, counts.value.data, counts.value.loading));
// "On this page": the panels in page order. A count is null while its read loads.
const rows = (s) => (s.loading ? null : Math.min(s.data.length, LIST_CAP));
const contents = computed(() => projectContents({
    hasDescription: !!project.value?.description,
    campaigns: rows(campaigns.value),
    samples: rows(looseSamples.value),
    operations: rows(looseOperations.value),
    tests: rows(looseTests.value),
    equipment: equipment.value.loading ? null : equipment.value.data.length,
}));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['project-cols']} */ ;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
/** @type {__VLS_StyleScopedClasses['equipment']} */ ;
// CSS variable injection 
// CSS variable injection end 
/** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
    title: (__VLS_ctx.project?.project_code ? `Project ${__VLS_ctx.project.project_code}` : 'Project'),
}));
const __VLS_1 = __VLS_0({
    title: (__VLS_ctx.project?.project_code ? `Project ${__VLS_ctx.project.project_code}` : 'Project'),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
var __VLS_3 = {};
__VLS_2.slots.default;
const __VLS_4 = {}.PageShell;
/** @type {[typeof __VLS_components.PageShell, typeof __VLS_components.PageShell, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
if (__VLS_ctx.loading && !__VLS_ctx.project) {
    const __VLS_8 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        loading: true,
        loadingText: "Loading project…",
    }));
    const __VLS_10 = __VLS_9({
        loading: true,
        loadingText: "Loading project…",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
}
else if (__VLS_ctx.notVisible) {
    const __VLS_12 = {}.NotVisible;
    /** @type {[typeof __VLS_components.NotVisible, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        what: "project",
    }));
    const __VLS_14 = __VLS_13({
        what: "project",
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
}
else if (__VLS_ctx.error) {
    const __VLS_16 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        error: (__VLS_ctx.error),
    }));
    const __VLS_18 = __VLS_17({
        error: (__VLS_ctx.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
}
else if (__VLS_ctx.project) {
    const __VLS_20 = {}.RecordLayout;
    /** @type {[typeof __VLS_components.RecordLayout, typeof __VLS_components.RecordLayout, ]} */ ;
    // @ts-ignore
    const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
        ...{ style: {} },
    }));
    const __VLS_22 = __VLS_21({
        ...{ style: {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    __VLS_23.slots.default;
    {
        const { crumbs: __VLS_thisSlot } = __VLS_23.slots;
        const __VLS_24 = {}.RouterLink;
        /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
        // @ts-ignore
        const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
            to: "/home",
        }));
        const __VLS_26 = __VLS_25({
            to: "/home",
        }, ...__VLS_functionalComponentArgsRest(__VLS_25));
        __VLS_27.slots.default;
        var __VLS_27;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        const __VLS_28 = {}.RouterLink;
        /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
        // @ts-ignore
        const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
            to: "/home/projects",
        }));
        const __VLS_30 = __VLS_29({
            to: "/home/projects",
        }, ...__VLS_functionalComponentArgsRest(__VLS_29));
        __VLS_31.slots.default;
        var __VLS_31;
    }
    {
        const { rail: __VLS_thisSlot } = __VLS_23.slots;
        const __VLS_32 = {}.RecordRail;
        /** @type {[typeof __VLS_components.RecordRail, typeof __VLS_components.RecordRail, ]} */ ;
        // @ts-ignore
        const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
            kind: "Project",
            code: (__VLS_ctx.code),
            title: (__VLS_ctx.project.project_name),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }));
        const __VLS_34 = __VLS_33({
            kind: "Project",
            code: (__VLS_ctx.code),
            title: (__VLS_ctx.project.project_name),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }, ...__VLS_functionalComponentArgsRest(__VLS_33));
        __VLS_35.slots.default;
        {
            const { 'kind-icon': __VLS_thisSlot } = __VLS_35.slots;
            const __VLS_36 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
                name: "folder_open",
                xSmall: true,
            }));
            const __VLS_38 = __VLS_37({
                name: "folder_open",
                xSmall: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_37));
        }
        {
            const { status: __VLS_thisSlot } = __VLS_35.slots;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "status" },
                ...{ class: ({ active: __VLS_ctx.active }) },
            });
            (__VLS_ctx.projectStatusLabel(__VLS_ctx.project.is_active));
            if (__VLS_ctx.project.export_controlled) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "export" },
                });
            }
        }
        {
            const { actions: __VLS_thisSlot } = __VLS_35.slots;
            if (__VLS_ctx.canUpdate !== false) {
                const __VLS_40 = {}.VButton;
                /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
                // @ts-ignore
                const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
                    ...{ 'onClick': {} },
                    small: true,
                }));
                const __VLS_42 = __VLS_41({
                    ...{ 'onClick': {} },
                    small: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_41));
                let __VLS_44;
                let __VLS_45;
                let __VLS_46;
                const __VLS_47 = {
                    onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading && !__VLS_ctx.project))
                            return;
                        if (!!(__VLS_ctx.notVisible))
                            return;
                        if (!!(__VLS_ctx.error))
                            return;
                        if (!(__VLS_ctx.project))
                            return;
                        if (!(__VLS_ctx.canUpdate !== false))
                            return;
                        __VLS_ctx.editing = true;
                    }
                };
                __VLS_43.slots.default;
                const __VLS_48 = {}.VIcon;
                /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
                // @ts-ignore
                const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
                    name: "edit",
                    small: true,
                    left: true,
                }));
                const __VLS_50 = __VLS_49({
                    name: "edit",
                    small: true,
                    left: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_49));
                var __VLS_43;
            }
            const __VLS_52 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }));
            const __VLS_54 = __VLS_53({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }, ...__VLS_functionalComponentArgsRest(__VLS_53));
            __VLS_55.slots.default;
            const __VLS_56 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
                name: "open_in_new",
                small: true,
                left: true,
            }));
            const __VLS_58 = __VLS_57({
                name: "open_in_new",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_57));
            var __VLS_55;
        }
        {
            const { 'after-facts': __VLS_thisSlot } = __VLS_35.slots;
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "d1-note" },
            });
            if (__VLS_ctx.investigators.error) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                    ...{ class: "d1-note warn" },
                    role: "alert",
                });
                (__VLS_ctx.investigators.error);
            }
            if (__VLS_ctx.counts.error) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                    ...{ class: "d1-note warn" },
                    role: "alert",
                });
                (__VLS_ctx.counts.error);
            }
        }
        var __VLS_35;
    }
    if (__VLS_ctx.project.description) {
        const __VLS_60 = {}.Section;
        /** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
        // @ts-ignore
        const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
            id: "description",
            title: "Description",
        }));
        const __VLS_62 = __VLS_61({
            id: "description",
            title: "Description",
        }, ...__VLS_functionalComponentArgsRest(__VLS_61));
        __VLS_63.slots.default;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "description" },
        });
        (__VLS_ctx.project.description);
        var __VLS_63;
    }
    /** @type {[typeof CampaignCards, ]} */ ;
    // @ts-ignore
    const __VLS_64 = __VLS_asFunctionalComponent(CampaignCards, new CampaignCards({
        campaigns: (__VLS_ctx.campaigns),
        projectId: (__VLS_ctx.id),
    }));
    const __VLS_65 = __VLS_64({
        campaigns: (__VLS_ctx.campaigns),
        projectId: (__VLS_ctx.id),
    }, ...__VLS_functionalComponentArgsRest(__VLS_64));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "d1-cols project-cols" },
    });
    /** @type {[typeof UnassignedLists, ]} */ ;
    // @ts-ignore
    const __VLS_67 = __VLS_asFunctionalComponent(UnassignedLists, new UnassignedLists({
        samples: (__VLS_ctx.looseSamples),
        operations: (__VLS_ctx.looseOperations),
        tests: (__VLS_ctx.looseTests),
        projectId: (__VLS_ctx.id),
    }));
    const __VLS_68 = __VLS_67({
        samples: (__VLS_ctx.looseSamples),
        operations: (__VLS_ctx.looseOperations),
        tests: (__VLS_ctx.looseTests),
        projectId: (__VLS_ctx.id),
    }, ...__VLS_functionalComponentArgsRest(__VLS_67));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "d1-cols project-cols" },
    });
    const __VLS_70 = {}.Section;
    /** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
    // @ts-ignore
    const __VLS_71 = __VLS_asFunctionalComponent(__VLS_70, new __VLS_70({
        id: "activity",
        title: "Activity",
    }));
    const __VLS_72 = __VLS_71({
        id: "activity",
        title: "Activity",
    }, ...__VLS_functionalComponentArgsRest(__VLS_71));
    __VLS_73.slots.default;
    const __VLS_74 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_75 = __VLS_asFunctionalComponent(__VLS_74, new __VLS_74({
        loading: (__VLS_ctx.activity.loading),
        error: (__VLS_ctx.activity.error),
    }));
    const __VLS_76 = __VLS_75({
        loading: (__VLS_ctx.activity.loading),
        error: (__VLS_ctx.activity.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_75));
    __VLS_77.slots.default;
    if (__VLS_ctx.activity.data.data) {
        const __VLS_78 = {}.Sparkline;
        /** @type {[typeof __VLS_components.Sparkline, ]} */ ;
        // @ts-ignore
        const __VLS_79 = __VLS_asFunctionalComponent(__VLS_78, new __VLS_78({
            ops: (__VLS_ctx.activity.data.data.ops),
            tests: (__VLS_ctx.activity.data.data.tests),
            weeks: (__VLS_ctx.activity.data.data.weeks),
            width: (640),
            height: (80),
        }));
        const __VLS_80 = __VLS_79({
            ops: (__VLS_ctx.activity.data.data.ops),
            tests: (__VLS_ctx.activity.data.data.tests),
            weeks: (__VLS_ctx.activity.data.data.weeks),
            width: (640),
            height: (80),
        }, ...__VLS_functionalComponentArgsRest(__VLS_79));
    }
    if (__VLS_ctx.activity.data.truncated) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note warn" },
        });
    }
    var __VLS_77;
    var __VLS_73;
    const __VLS_82 = {}.Section;
    /** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
    // @ts-ignore
    const __VLS_83 = __VLS_asFunctionalComponent(__VLS_82, new __VLS_82({
        id: "equipment",
        title: "Equipment used",
        count: (__VLS_ctx.equipment.loading ? null : __VLS_ctx.equipment.data.length),
        empty: (!__VLS_ctx.equipment.loading && !__VLS_ctx.equipment.error && !__VLS_ctx.equipment.data.length),
        emptyText: "No equipment recorded on this project's operations.",
    }));
    const __VLS_84 = __VLS_83({
        id: "equipment",
        title: "Equipment used",
        count: (__VLS_ctx.equipment.loading ? null : __VLS_ctx.equipment.data.length),
        empty: (!__VLS_ctx.equipment.loading && !__VLS_ctx.equipment.error && !__VLS_ctx.equipment.data.length),
        emptyText: "No equipment recorded on this project's operations.",
    }, ...__VLS_functionalComponentArgsRest(__VLS_83));
    __VLS_85.slots.default;
    const __VLS_86 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_87 = __VLS_asFunctionalComponent(__VLS_86, new __VLS_86({
        loading: (__VLS_ctx.equipment.loading),
        error: (__VLS_ctx.equipment.error),
    }));
    const __VLS_88 = __VLS_87({
        loading: (__VLS_ctx.equipment.loading),
        error: (__VLS_ctx.equipment.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_87));
    __VLS_89.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
        ...{ class: "equipment" },
    });
    for (const [e] of __VLS_getVForSourceType((__VLS_ctx.equipment.data))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
            key: (e.equipment_id),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "e-name" },
        });
        (e.name);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "e-count" },
        });
        (e.operations);
        (e.operations === 1 ? '' : 's');
    }
    var __VLS_89;
    var __VLS_85;
    var __VLS_23;
    const __VLS_90 = {}.EditDrawer;
    /** @type {[typeof __VLS_components.EditDrawer, ]} */ ;
    // @ts-ignore
    const __VLS_91 = __VLS_asFunctionalComponent(__VLS_90, new __VLS_90({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "projects",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
    }));
    const __VLS_92 = __VLS_91({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "projects",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
    }, ...__VLS_functionalComponentArgsRest(__VLS_91));
    let __VLS_94;
    let __VLS_95;
    let __VLS_96;
    const __VLS_97 = {
        onSaved: (__VLS_ctx.onSaved)
    };
    var __VLS_93;
}
var __VLS_7;
var __VLS_2;
/** @type {__VLS_StyleScopedClasses['status']} */ ;
/** @type {__VLS_StyleScopedClasses['export']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['description']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-cols']} */ ;
/** @type {__VLS_StyleScopedClasses['project-cols']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-cols']} */ ;
/** @type {__VLS_StyleScopedClasses['project-cols']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['equipment']} */ ;
/** @type {__VLS_StyleScopedClasses['e-name']} */ ;
/** @type {__VLS_StyleScopedClasses['e-count']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ExplorerView: ExplorerView,
            EditDrawer: EditDrawer,
            LoadState: LoadState,
            NotVisible: NotVisible,
            PageShell: PageShell,
            RecordLayout: RecordLayout,
            RecordRail: RecordRail,
            Section: Section,
            Sparkline: Sparkline,
            projectStatusLabel: projectStatusLabel,
            CampaignCards: CampaignCards,
            UnassignedLists: UnassignedLists,
            project: project,
            loading: loading,
            notVisible: notVisible,
            error: error,
            investigators: investigators,
            counts: counts,
            campaigns: campaigns,
            looseSamples: looseSamples,
            looseOperations: looseOperations,
            looseTests: looseTests,
            activity: activity,
            equipment: equipment,
            editing: editing,
            canUpdate: canUpdate,
            onSaved: onSaved,
            code: code,
            studioTo: studioTo,
            active: active,
            railFacts: railFacts,
            contents: contents,
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
