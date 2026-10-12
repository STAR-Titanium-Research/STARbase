/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { CampaignProgressBars, CampaignWorkbench, EditDrawer, HiddenLink, useCampaignData, useCanUpdate, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, Section, StatusBadge, campaignCode, campaignContents, campaignRailFacts, dataStudioRoute, } from '@d1/ui';
import { useCampaignRecord } from './campaign/useCampaignRecord';
const props = defineProps();
const { campaign, loading, notVisible, error, hidden, reload } = useCampaignRecord(toRef(props, 'id'));
// The lists, matrix and progress are read once here: the rail shows their counts and bars, the
// workbench (given `data`) draws the panels from the same reads.
// An invisible or failed campaign reads nothing: an empty id makes the composable's load() return early.
const data = useCampaignData(computed(() => (notVisible.value || error.value ? '' : props.id)));
const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('campaigns', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
    reload();
    refreshCanUpdate();
}
const code = computed(() => campaignCode(campaign.value));
// The name is the subtitle only when the code is what the title shows.
const subtitle = computed(() => (campaign.value?.campaign_code ? campaign.value?.name : ''));
const studioTo = computed(() => dataStudioRoute('campaigns', props.id));
// The counts wait for the three reads behind them (null: the rail leaves them out until then).
const settled = computed(() => !data.junction.value.loading && !data.operations.value.loading && !data.tests.value.loading);
const railFacts = computed(() => {
    const c = data.overview.value.counts;
    const counts = settled.value
        ? { samples: c.samples, hiddenSamples: c.hiddenSamples, operations: c.operations, tests: c.tests }
        : null;
    // A count behind a failed read is a dash, not a wrong 0 (samples are built from all three lists).
    const o = data.operations.value.error;
    const t = data.tests.value.error;
    const failed = { samples: !!(data.junction.value.error || o || t), operations: !!o, tests: !!t };
    return campaignRailFacts(campaign.value, hidden.value, counts, failed);
});
// "On this page": the panels in page order. A count is null while its read loads or after it
// failed (never a wrong 0, and never the previous load's rows after a failed reload).
const unknown = (s) => s.loading || !!s.error;
const contents = computed(() => {
    const o = data.overview.value;
    const [j, ops, tests] = [data.junction.value, data.operations.value, data.tests.value];
    return campaignContents({
        hasNotes: !!campaign.value?.notes,
        matrix: unknown(j) || unknown(ops) || unknown(tests) ? null : data.matrix.value.rows.length,
        samples: unknown(j) ? null : o.sampleRows.length,
        tests: unknown(tests) ? null : o.testRows.length,
        operations: unknown(ops) ? null : o.opRows.length,
    });
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
/** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
    title: (__VLS_ctx.campaign?.campaign_code ? `Campaign ${__VLS_ctx.campaign.campaign_code}` : __VLS_ctx.code),
}));
const __VLS_1 = __VLS_0({
    title: (__VLS_ctx.campaign?.campaign_code ? `Campaign ${__VLS_ctx.campaign.campaign_code}` : __VLS_ctx.code),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
var __VLS_3 = {};
__VLS_2.slots.default;
const __VLS_4 = {}.PageShell;
/** @type {[typeof __VLS_components.PageShell, typeof __VLS_components.PageShell, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
if (__VLS_ctx.loading && !__VLS_ctx.campaign) {
    const __VLS_8 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        loading: true,
        loadingText: "Loading campaign…",
    }));
    const __VLS_10 = __VLS_9({
        loading: true,
        loadingText: "Loading campaign…",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
}
else if (__VLS_ctx.notVisible) {
    const __VLS_12 = {}.NotVisible;
    /** @type {[typeof __VLS_components.NotVisible, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        what: "campaign",
    }));
    const __VLS_14 = __VLS_13({
        what: "campaign",
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
else if (__VLS_ctx.campaign) {
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
        if (__VLS_ctx.campaign.project_id) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_28 = {}.RecordLink;
            /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
            // @ts-ignore
            const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
                collection: "projects",
                id: (__VLS_ctx.campaign.project_id.project_id),
            }));
            const __VLS_30 = __VLS_29({
                collection: "projects",
                id: (__VLS_ctx.campaign.project_id.project_id),
            }, ...__VLS_functionalComponentArgsRest(__VLS_29));
            __VLS_31.slots.default;
            (__VLS_ctx.campaign.project_id.project_code ? `Project ${__VLS_ctx.campaign.project_id.project_code}` : __VLS_ctx.campaign.project_id.project_name || 'Project');
            var __VLS_31;
        }
        else if (__VLS_ctx.hidden.project_id) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_32 = {}.HiddenLink;
            /** @type {[typeof __VLS_components.HiddenLink, ]} */ ;
            // @ts-ignore
            const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
                label: "Project",
            }));
            const __VLS_34 = __VLS_33({
                label: "Project",
            }, ...__VLS_functionalComponentArgsRest(__VLS_33));
        }
    }
    {
        const { rail: __VLS_thisSlot } = __VLS_23.slots;
        const __VLS_36 = {}.RecordRail;
        /** @type {[typeof __VLS_components.RecordRail, typeof __VLS_components.RecordRail, ]} */ ;
        // @ts-ignore
        const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
            kind: "Campaign",
            code: (__VLS_ctx.code),
            title: (__VLS_ctx.subtitle),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }));
        const __VLS_38 = __VLS_37({
            kind: "Campaign",
            code: (__VLS_ctx.code),
            title: (__VLS_ctx.subtitle),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }, ...__VLS_functionalComponentArgsRest(__VLS_37));
        __VLS_39.slots.default;
        {
            const { 'kind-icon': __VLS_thisSlot } = __VLS_39.slots;
            const __VLS_40 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
                name: "folder_special",
                xSmall: true,
            }));
            const __VLS_42 = __VLS_41({
                name: "folder_special",
                xSmall: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_41));
        }
        {
            const { status: __VLS_thisSlot } = __VLS_39.slots;
            const __VLS_44 = {}.StatusBadge;
            /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
            // @ts-ignore
            const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
                kind: "campaign",
                value: (__VLS_ctx.campaign.status),
            }));
            const __VLS_46 = __VLS_45({
                kind: "campaign",
                value: (__VLS_ctx.campaign.status),
            }, ...__VLS_functionalComponentArgsRest(__VLS_45));
        }
        {
            const { actions: __VLS_thisSlot } = __VLS_39.slots;
            if (__VLS_ctx.canUpdate !== false) {
                const __VLS_48 = {}.VButton;
                /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
                // @ts-ignore
                const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
                    ...{ 'onClick': {} },
                    small: true,
                }));
                const __VLS_50 = __VLS_49({
                    ...{ 'onClick': {} },
                    small: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_49));
                let __VLS_52;
                let __VLS_53;
                let __VLS_54;
                const __VLS_55 = {
                    onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading && !__VLS_ctx.campaign))
                            return;
                        if (!!(__VLS_ctx.notVisible))
                            return;
                        if (!!(__VLS_ctx.error))
                            return;
                        if (!(__VLS_ctx.campaign))
                            return;
                        if (!(__VLS_ctx.canUpdate !== false))
                            return;
                        __VLS_ctx.editing = true;
                    }
                };
                __VLS_51.slots.default;
                const __VLS_56 = {}.VIcon;
                /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
                // @ts-ignore
                const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
                    name: "edit",
                    small: true,
                    left: true,
                }));
                const __VLS_58 = __VLS_57({
                    name: "edit",
                    small: true,
                    left: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_57));
                var __VLS_51;
            }
            const __VLS_60 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }));
            const __VLS_62 = __VLS_61({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }, ...__VLS_functionalComponentArgsRest(__VLS_61));
            __VLS_63.slots.default;
            const __VLS_64 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
                name: "open_in_new",
                small: true,
                left: true,
            }));
            const __VLS_66 = __VLS_65({
                name: "open_in_new",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_65));
            var __VLS_63;
        }
        {
            const { 'after-facts': __VLS_thisSlot } = __VLS_39.slots;
            const __VLS_68 = {}.CampaignProgressBars;
            /** @type {[typeof __VLS_components.CampaignProgressBars, ]} */ ;
            // @ts-ignore
            const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
                rail: true,
                overview: (__VLS_ctx.data.overview.value),
                forceHidden: (__VLS_ctx.data.analysisUnavailable.value),
                forceFailed: (!!__VLS_ctx.data.analyses.value.error),
            }));
            const __VLS_70 = __VLS_69({
                rail: true,
                overview: (__VLS_ctx.data.overview.value),
                forceHidden: (__VLS_ctx.data.analysisUnavailable.value),
                forceFailed: (!!__VLS_ctx.data.analyses.value.error),
            }, ...__VLS_functionalComponentArgsRest(__VLS_69));
        }
        var __VLS_39;
    }
    if (__VLS_ctx.campaign.notes) {
        const __VLS_72 = {}.Section;
        /** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
        // @ts-ignore
        const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
            id: "notes",
            title: "Notes",
        }));
        const __VLS_74 = __VLS_73({
            id: "notes",
            title: "Notes",
        }, ...__VLS_functionalComponentArgsRest(__VLS_73));
        __VLS_75.slots.default;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "notes" },
        });
        (__VLS_ctx.campaign.notes);
        var __VLS_75;
    }
    const __VLS_76 = {}.CampaignWorkbench;
    /** @type {[typeof __VLS_components.CampaignWorkbench, ]} */ ;
    // @ts-ignore
    const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
        campaignId: (__VLS_ctx.id),
        campaignType: (__VLS_ctx.campaign.campaign_type),
        canUpdate: (__VLS_ctx.canUpdate),
        data: (__VLS_ctx.data),
        showProgress: (false),
        sectionIds: true,
    }));
    const __VLS_78 = __VLS_77({
        campaignId: (__VLS_ctx.id),
        campaignType: (__VLS_ctx.campaign.campaign_type),
        canUpdate: (__VLS_ctx.canUpdate),
        data: (__VLS_ctx.data),
        showProgress: (false),
        sectionIds: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_77));
    var __VLS_23;
    const __VLS_80 = {}.EditDrawer;
    /** @type {[typeof __VLS_components.EditDrawer, ]} */ ;
    // @ts-ignore
    const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "campaigns",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
        hiddenFields: (['campaign_operations']),
    }));
    const __VLS_82 = __VLS_81({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "campaigns",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
        hiddenFields: (['campaign_operations']),
    }, ...__VLS_functionalComponentArgsRest(__VLS_81));
    let __VLS_84;
    let __VLS_85;
    let __VLS_86;
    const __VLS_87 = {
        onSaved: (__VLS_ctx.onSaved)
    };
    var __VLS_83;
}
var __VLS_7;
var __VLS_2;
/** @type {__VLS_StyleScopedClasses['notes']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ExplorerView: ExplorerView,
            CampaignProgressBars: CampaignProgressBars,
            CampaignWorkbench: CampaignWorkbench,
            EditDrawer: EditDrawer,
            HiddenLink: HiddenLink,
            LoadState: LoadState,
            NotVisible: NotVisible,
            PageShell: PageShell,
            RecordLayout: RecordLayout,
            RecordLink: RecordLink,
            RecordRail: RecordRail,
            Section: Section,
            StatusBadge: StatusBadge,
            campaign: campaign,
            loading: loading,
            notVisible: notVisible,
            error: error,
            hidden: hidden,
            data: data,
            editing: editing,
            canUpdate: canUpdate,
            onSaved: onSaved,
            code: code,
            subtitle: subtitle,
            studioTo: studioTo,
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
