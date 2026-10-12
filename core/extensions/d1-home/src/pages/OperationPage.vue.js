/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { EditDrawer, HiddenLink, useCanUpdate, LIST_CAP, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, asRecord, dataStudioRoute, detailFacts, detailsCount, hasPassCode, operationDetailBase, operationHeading, operationKind, operationRailFacts, operationSampleCount, } from '@d1/ui';
import { useOperationData } from './operation/useOperationData';
import OperationSamples from './operation/OperationSamples.vue';
import OperationAnalysis from './operation/OperationAnalysis.vue';
import RecordDetails from './record/RecordDetails.vue';
import SampleFiles from './sample/SampleFiles.vue';
const props = defineProps();
const { operation, loading, notVisible, error, params, force, fast, files, shared, hidden, hiddenKnown, reload } = useOperationData(toRef(props, 'id'));
const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('manufacturing_operations', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
    reload();
    refreshCanUpdate();
}
const op = computed(() => operation.value);
const studioTo = computed(() => dataStudioRoute('manufacturing_operations', props.id));
const project = computed(() => asRecord(op.value?.project_id));
const campaign = computed(() => asRecord(op.value?.campaign_id));
const sample = computed(() => asRecord(op.value?.sample_id) ?? asRecord(op.value?.output_sample_id));
// The pass code, else what the lists call it (input sample and step). The output sample names it
// only when no input is linked at all, and then without a step: the step belongs to the input
// sample. Until the hidden-link read has answered for this operation, a null input may still be a
// hidden one; after that its last answer holds while a reload runs, so a save does not flip the heading.
const code = computed(() => operationHeading(op.value, asRecord(op.value?.output_sample_id)?.sample_code, !hiddenKnown.value || !!hidden.value.data.sample_id));
const isCode = computed(() => hasPassCode(op.value));
const pageTitle = computed(() => {
    if (!op.value)
        return 'Operation';
    return isCode.value ? `Operation ${code.value}` : code.value;
});
// The rail's key facts, and the Details panel: the operation's own values and its parameters, minus
// what the rail already shows.
const railFacts = computed(() => operationRailFacts(op.value, hidden.value.data));
const details = computed(() => detailFacts(operationDetailBase(op.value), params.value.data, railFacts.value));
// Linked Directus files and legacy network-share paths read as one list.
const allFiles = computed(() => [...files.value.data, ...shared.value.data]);
// "On this page": the panels this operation has, in page order. A count is null while it loads.
const contents = computed(() => {
    const o = op.value;
    if (!o)
        return [];
    const entries = [
        { id: 'details', title: 'Details', count: detailsCount(details.value.length, !!o.outcome_notes, params.value.loading, params.value.error) },
        { id: 'samples', title: 'Samples in and out', count: operationSampleCount(o, hidden.value.data) },
    ];
    if (o.process_category === 'machining') {
        entries.push({ id: 'force-analysis', title: 'Force analysis', count: force.value.loading ? null : Math.min(force.value.data.length, LIST_CAP) });
    }
    if (o.process_category === 'sintering') {
        entries.push({ id: 'fast-run', title: 'FAST run', count: fast.value.loading ? null : fast.value.data ? 1 : 0 });
    }
    entries.push({ id: 'files', title: 'Files', count: files.value.loading || shared.value.loading ? null : allFiles.value.length });
    return entries;
});
const openReport = () => window.open(`/d1-report/operation/${encodeURIComponent(props.id)}`, '_blank', 'noopener');
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
// @ts-ignore
const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
    title: (__VLS_ctx.pageTitle),
}));
const __VLS_1 = __VLS_0({
    title: (__VLS_ctx.pageTitle),
}, ...__VLS_functionalComponentArgsRest(__VLS_0));
var __VLS_3 = {};
__VLS_2.slots.default;
const __VLS_4 = {}.PageShell;
/** @type {[typeof __VLS_components.PageShell, typeof __VLS_components.PageShell, ]} */ ;
// @ts-ignore
const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({}));
const __VLS_6 = __VLS_5({}, ...__VLS_functionalComponentArgsRest(__VLS_5));
__VLS_7.slots.default;
if (__VLS_ctx.loading && !__VLS_ctx.op) {
    const __VLS_8 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        loading: true,
        loadingText: "Loading operation…",
    }));
    const __VLS_10 = __VLS_9({
        loading: true,
        loadingText: "Loading operation…",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
}
else if (__VLS_ctx.notVisible) {
    const __VLS_12 = {}.NotVisible;
    /** @type {[typeof __VLS_components.NotVisible, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        what: "operation",
    }));
    const __VLS_14 = __VLS_13({
        what: "operation",
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
else if (__VLS_ctx.op) {
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
        if (__VLS_ctx.project) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_28 = {}.RecordLink;
            /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
            // @ts-ignore
            const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
                collection: "projects",
                id: (__VLS_ctx.project.project_id),
            }));
            const __VLS_30 = __VLS_29({
                collection: "projects",
                id: (__VLS_ctx.project.project_id),
            }, ...__VLS_functionalComponentArgsRest(__VLS_29));
            __VLS_31.slots.default;
            (__VLS_ctx.project.project_code);
            var __VLS_31;
        }
        else if (__VLS_ctx.hidden.data.project_id) {
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
        if (__VLS_ctx.campaign) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_36 = {}.RecordLink;
            /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
            // @ts-ignore
            const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
                collection: "campaigns",
                id: (__VLS_ctx.campaign.campaign_id),
            }));
            const __VLS_38 = __VLS_37({
                collection: "campaigns",
                id: (__VLS_ctx.campaign.campaign_id),
            }, ...__VLS_functionalComponentArgsRest(__VLS_37));
            __VLS_39.slots.default;
            (__VLS_ctx.campaign.campaign_code ? `Campaign ${__VLS_ctx.campaign.campaign_code}` : __VLS_ctx.campaign.name || 'Campaign');
            var __VLS_39;
        }
        else if (__VLS_ctx.hidden.data.campaign_id) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_40 = {}.HiddenLink;
            /** @type {[typeof __VLS_components.HiddenLink, ]} */ ;
            // @ts-ignore
            const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
                label: "Campaign",
            }));
            const __VLS_42 = __VLS_41({
                label: "Campaign",
            }, ...__VLS_functionalComponentArgsRest(__VLS_41));
        }
        if (__VLS_ctx.sample) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_44 = {}.RecordLink;
            /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
            // @ts-ignore
            const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
                collection: "physical_samples",
                id: (__VLS_ctx.sample.sample_id),
            }));
            const __VLS_46 = __VLS_45({
                collection: "physical_samples",
                id: (__VLS_ctx.sample.sample_id),
            }, ...__VLS_functionalComponentArgsRest(__VLS_45));
            __VLS_47.slots.default;
            (__VLS_ctx.sample.sample_code ? `Sample ${__VLS_ctx.sample.sample_code}` : 'Sample');
            var __VLS_47;
        }
    }
    {
        const { rail: __VLS_thisSlot } = __VLS_23.slots;
        const __VLS_48 = {}.RecordRail;
        /** @type {[typeof __VLS_components.RecordRail, typeof __VLS_components.RecordRail, ]} */ ;
        // @ts-ignore
        const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
            kind: (__VLS_ctx.operationKind(__VLS_ctx.op)),
            code: (__VLS_ctx.code),
            plain: (!__VLS_ctx.isCode),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }));
        const __VLS_50 = __VLS_49({
            kind: (__VLS_ctx.operationKind(__VLS_ctx.op)),
            code: (__VLS_ctx.code),
            plain: (!__VLS_ctx.isCode),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }, ...__VLS_functionalComponentArgsRest(__VLS_49));
        __VLS_51.slots.default;
        {
            const { 'kind-icon': __VLS_thisSlot } = __VLS_51.slots;
            const __VLS_52 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
                name: "precision_manufacturing",
                xSmall: true,
            }));
            const __VLS_54 = __VLS_53({
                name: "precision_manufacturing",
                xSmall: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_53));
        }
        {
            const { actions: __VLS_thisSlot } = __VLS_51.slots;
            if (__VLS_ctx.canUpdate !== false) {
                const __VLS_56 = {}.VButton;
                /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
                // @ts-ignore
                const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
                    ...{ 'onClick': {} },
                    small: true,
                }));
                const __VLS_58 = __VLS_57({
                    ...{ 'onClick': {} },
                    small: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_57));
                let __VLS_60;
                let __VLS_61;
                let __VLS_62;
                const __VLS_63 = {
                    onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading && !__VLS_ctx.op))
                            return;
                        if (!!(__VLS_ctx.notVisible))
                            return;
                        if (!!(__VLS_ctx.error))
                            return;
                        if (!(__VLS_ctx.op))
                            return;
                        if (!(__VLS_ctx.canUpdate !== false))
                            return;
                        __VLS_ctx.editing = true;
                    }
                };
                __VLS_59.slots.default;
                const __VLS_64 = {}.VIcon;
                /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
                // @ts-ignore
                const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
                    name: "edit",
                    small: true,
                    left: true,
                }));
                const __VLS_66 = __VLS_65({
                    name: "edit",
                    small: true,
                    left: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_65));
                var __VLS_59;
            }
            const __VLS_68 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
                ...{ 'onClick': {} },
                small: true,
                secondary: true,
            }));
            const __VLS_70 = __VLS_69({
                ...{ 'onClick': {} },
                small: true,
                secondary: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_69));
            let __VLS_72;
            let __VLS_73;
            let __VLS_74;
            const __VLS_75 = {
                onClick: (__VLS_ctx.openReport)
            };
            __VLS_71.slots.default;
            const __VLS_76 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
                name: "picture_as_pdf",
                small: true,
                left: true,
            }));
            const __VLS_78 = __VLS_77({
                name: "picture_as_pdf",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_77));
            var __VLS_71;
            const __VLS_80 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }));
            const __VLS_82 = __VLS_81({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }, ...__VLS_functionalComponentArgsRest(__VLS_81));
            __VLS_83.slots.default;
            const __VLS_84 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
                name: "open_in_new",
                small: true,
                left: true,
            }));
            const __VLS_86 = __VLS_85({
                name: "open_in_new",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_85));
            var __VLS_83;
        }
        var __VLS_51;
    }
    /** @type {[typeof RecordDetails, ]} */ ;
    // @ts-ignore
    const __VLS_88 = __VLS_asFunctionalComponent(RecordDetails, new RecordDetails({
        facts: (__VLS_ctx.details),
        notes: (__VLS_ctx.op.outcome_notes),
        paramsLoading: (__VLS_ctx.params.loading),
        paramsError: (__VLS_ctx.params.error),
        emptyText: (__VLS_ctx.op.process_category ? 'No details or parameters recorded for this operation.' : 'No details recorded, and no process category, so no parameter set applies.'),
    }));
    const __VLS_89 = __VLS_88({
        facts: (__VLS_ctx.details),
        notes: (__VLS_ctx.op.outcome_notes),
        paramsLoading: (__VLS_ctx.params.loading),
        paramsError: (__VLS_ctx.params.error),
        emptyText: (__VLS_ctx.op.process_category ? 'No details or parameters recorded for this operation.' : 'No details recorded, and no process category, so no parameter set applies.'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_88));
    /** @type {[typeof OperationSamples, ]} */ ;
    // @ts-ignore
    const __VLS_91 = __VLS_asFunctionalComponent(OperationSamples, new OperationSamples({
        id: "samples",
        input: (__VLS_ctx.op.sample_id),
        output: (__VLS_ctx.op.output_sample_id),
        inputHidden: (!!__VLS_ctx.hidden.data.sample_id),
        outputHidden: (!!__VLS_ctx.hidden.data.output_sample_id),
    }));
    const __VLS_92 = __VLS_91({
        id: "samples",
        input: (__VLS_ctx.op.sample_id),
        output: (__VLS_ctx.op.output_sample_id),
        inputHidden: (!!__VLS_ctx.hidden.data.sample_id),
        outputHidden: (!!__VLS_ctx.hidden.data.output_sample_id),
    }, ...__VLS_functionalComponentArgsRest(__VLS_91));
    /** @type {[typeof OperationAnalysis, ]} */ ;
    // @ts-ignore
    const __VLS_94 = __VLS_asFunctionalComponent(OperationAnalysis, new OperationAnalysis({
        operationId: (__VLS_ctx.id),
        category: (__VLS_ctx.op.process_category),
        force: (__VLS_ctx.force),
        fast: (__VLS_ctx.fast),
    }));
    const __VLS_95 = __VLS_94({
        operationId: (__VLS_ctx.id),
        category: (__VLS_ctx.op.process_category),
        force: (__VLS_ctx.force),
        fast: (__VLS_ctx.fast),
    }, ...__VLS_functionalComponentArgsRest(__VLS_94));
    /** @type {[typeof SampleFiles, ]} */ ;
    // @ts-ignore
    const __VLS_97 = __VLS_asFunctionalComponent(SampleFiles, new SampleFiles({
        id: "files",
        files: (__VLS_ctx.allFiles),
        loading: (__VLS_ctx.files.loading || __VLS_ctx.shared.loading),
        error: (__VLS_ctx.files.error || __VLS_ctx.shared.error),
        emptyText: "No files linked to this operation.",
    }));
    const __VLS_98 = __VLS_97({
        id: "files",
        files: (__VLS_ctx.allFiles),
        loading: (__VLS_ctx.files.loading || __VLS_ctx.shared.loading),
        error: (__VLS_ctx.files.error || __VLS_ctx.shared.error),
        emptyText: "No files linked to this operation.",
    }, ...__VLS_functionalComponentArgsRest(__VLS_97));
    var __VLS_23;
    const __VLS_100 = {}.EditDrawer;
    /** @type {[typeof __VLS_components.EditDrawer, ]} */ ;
    // @ts-ignore
    const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "manufacturing_operations",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
    }));
    const __VLS_102 = __VLS_101({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "manufacturing_operations",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
    }, ...__VLS_functionalComponentArgsRest(__VLS_101));
    let __VLS_104;
    let __VLS_105;
    let __VLS_106;
    const __VLS_107 = {
        onSaved: (__VLS_ctx.onSaved)
    };
    var __VLS_103;
}
var __VLS_7;
var __VLS_2;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            ExplorerView: ExplorerView,
            EditDrawer: EditDrawer,
            HiddenLink: HiddenLink,
            LoadState: LoadState,
            NotVisible: NotVisible,
            PageShell: PageShell,
            RecordLayout: RecordLayout,
            RecordLink: RecordLink,
            RecordRail: RecordRail,
            operationKind: operationKind,
            OperationSamples: OperationSamples,
            OperationAnalysis: OperationAnalysis,
            RecordDetails: RecordDetails,
            SampleFiles: SampleFiles,
            loading: loading,
            notVisible: notVisible,
            error: error,
            params: params,
            force: force,
            fast: fast,
            files: files,
            shared: shared,
            hidden: hidden,
            editing: editing,
            canUpdate: canUpdate,
            onSaved: onSaved,
            op: op,
            studioTo: studioTo,
            project: project,
            campaign: campaign,
            sample: sample,
            code: code,
            isCode: isCode,
            pageTitle: pageTitle,
            railFacts: railFacts,
            details: details,
            allFiles: allFiles,
            contents: contents,
            openReport: openReport,
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
