/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { EditDrawer, HiddenLink, useCanUpdate, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, StatusBadge, asRecord, dataStudioRoute, detailFacts, detailsCount, formatDate, summaryCount, summaryGroups, testDetailBase, testRailFacts, testSample, testSubjectCount, testTypeText, } from '@d1/ui';
import { useTestData } from './test/useTestData';
import TestSubjects from './test/TestSubjects.vue';
import TestResults from './test/TestResults.vue';
import RecordDetails from './record/RecordDetails.vue';
import SampleFiles from './sample/SampleFiles.vue';
const props = defineProps();
const { test, loading, notVisible, error, params, subjects, files, hidden, reload } = useTestData(toRef(props, 'id'));
const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('test_sessions', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
    reload();
    refreshCanUpdate();
}
const t = computed(() => test.value);
const typeText = computed(() => testTypeText(t.value));
const pageTitle = computed(() => `${typeText.value} · ${formatDate(t.value?.session_date, 'Undated')}`);
const studioTo = computed(() => dataStudioRoute('test_sessions', props.id));
const project = computed(() => asRecord(t.value?.project_id));
const campaign = computed(() => asRecord(t.value?.campaign_id));
// The sample for the breadcrumb: the single-sample column, else the first sample subject.
const sample = computed(() => testSample(t.value, subjects.value.data));
// The rail's key facts, and the Details panel: the test's own values and its parameters, minus what
// the rail already shows.
const railFacts = computed(() => testRailFacts(t.value, subjects.value.data, hidden.value.data));
const details = computed(() => detailFacts(testDetailBase(t.value), params.value.data, railFacts.value));
// "On this page": the panels this test has, in page order. A count is null while it loads.
const contents = computed(() => {
    const x = t.value;
    if (!x)
        return [];
    const groups = summaryGroups(x.summary_stats);
    return [
        { id: 'details', title: 'Details', count: detailsCount(details.value.length, !!x.notes, params.value.loading, params.value.error) },
        {
            id: 'subject',
            title: 'Subject',
            count: subjects.value.loading || subjects.value.error ? null : testSubjectCount(x.sample_id, subjects.value.data, !!hidden.value.data.sample_id),
        },
        { id: 'results', title: 'Results', count: groups.length ? summaryCount(groups) || null : 0 },
        { id: 'files', title: 'Files', count: files.value.loading ? null : files.value.data.length },
    ];
});
const openReport = () => window.open(`/d1-report/test/${encodeURIComponent(props.id)}`, '_blank', 'noopener');
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
// CSS variable injection 
// CSS variable injection end 
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
if (__VLS_ctx.loading && !__VLS_ctx.t) {
    const __VLS_8 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        loading: true,
        loadingText: "Loading test…",
    }));
    const __VLS_10 = __VLS_9({
        loading: true,
        loadingText: "Loading test…",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
}
else if (__VLS_ctx.notVisible) {
    const __VLS_12 = {}.NotVisible;
    /** @type {[typeof __VLS_components.NotVisible, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        what: "test session",
    }));
    const __VLS_14 = __VLS_13({
        what: "test session",
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
else if (__VLS_ctx.t) {
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
        else if (__VLS_ctx.hidden.data.sample_id || __VLS_ctx.subjects.data.hidden) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_48 = {}.HiddenLink;
            /** @type {[typeof __VLS_components.HiddenLink, ]} */ ;
            // @ts-ignore
            const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
                label: "Sample",
            }));
            const __VLS_50 = __VLS_49({
                label: "Sample",
            }, ...__VLS_functionalComponentArgsRest(__VLS_49));
        }
    }
    {
        const { rail: __VLS_thisSlot } = __VLS_23.slots;
        const __VLS_52 = {}.RecordRail;
        /** @type {[typeof __VLS_components.RecordRail, typeof __VLS_components.RecordRail, ]} */ ;
        // @ts-ignore
        const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
            kind: "Test",
            code: (__VLS_ctx.typeText),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }));
        const __VLS_54 = __VLS_53({
            kind: "Test",
            code: (__VLS_ctx.typeText),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }, ...__VLS_functionalComponentArgsRest(__VLS_53));
        __VLS_55.slots.default;
        {
            const { 'kind-icon': __VLS_thisSlot } = __VLS_55.slots;
            const __VLS_56 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
                name: "biotech",
                xSmall: true,
            }));
            const __VLS_58 = __VLS_57({
                name: "biotech",
                xSmall: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_57));
        }
        {
            const { status: __VLS_thisSlot } = __VLS_55.slots;
            const __VLS_60 = {}.StatusBadge;
            /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
            // @ts-ignore
            const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
                kind: "test",
                value: (__VLS_ctx.t.status),
            }));
            const __VLS_62 = __VLS_61({
                kind: "test",
                value: (__VLS_ctx.t.status),
            }, ...__VLS_functionalComponentArgsRest(__VLS_61));
        }
        {
            const { actions: __VLS_thisSlot } = __VLS_55.slots;
            if (__VLS_ctx.canUpdate !== false) {
                const __VLS_64 = {}.VButton;
                /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
                // @ts-ignore
                const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
                    ...{ 'onClick': {} },
                    small: true,
                }));
                const __VLS_66 = __VLS_65({
                    ...{ 'onClick': {} },
                    small: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_65));
                let __VLS_68;
                let __VLS_69;
                let __VLS_70;
                const __VLS_71 = {
                    onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading && !__VLS_ctx.t))
                            return;
                        if (!!(__VLS_ctx.notVisible))
                            return;
                        if (!!(__VLS_ctx.error))
                            return;
                        if (!(__VLS_ctx.t))
                            return;
                        if (!(__VLS_ctx.canUpdate !== false))
                            return;
                        __VLS_ctx.editing = true;
                    }
                };
                __VLS_67.slots.default;
                const __VLS_72 = {}.VIcon;
                /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
                // @ts-ignore
                const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
                    name: "edit",
                    small: true,
                    left: true,
                }));
                const __VLS_74 = __VLS_73({
                    name: "edit",
                    small: true,
                    left: true,
                }, ...__VLS_functionalComponentArgsRest(__VLS_73));
                var __VLS_67;
            }
            const __VLS_76 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
                ...{ 'onClick': {} },
                small: true,
                secondary: true,
            }));
            const __VLS_78 = __VLS_77({
                ...{ 'onClick': {} },
                small: true,
                secondary: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_77));
            let __VLS_80;
            let __VLS_81;
            let __VLS_82;
            const __VLS_83 = {
                onClick: (__VLS_ctx.openReport)
            };
            __VLS_79.slots.default;
            const __VLS_84 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
                name: "picture_as_pdf",
                small: true,
                left: true,
            }));
            const __VLS_86 = __VLS_85({
                name: "picture_as_pdf",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_85));
            var __VLS_79;
            const __VLS_88 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }));
            const __VLS_90 = __VLS_89({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }, ...__VLS_functionalComponentArgsRest(__VLS_89));
            __VLS_91.slots.default;
            const __VLS_92 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
                name: "open_in_new",
                small: true,
                left: true,
            }));
            const __VLS_94 = __VLS_93({
                name: "open_in_new",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_93));
            var __VLS_91;
        }
        var __VLS_55;
    }
    /** @type {[typeof RecordDetails, ]} */ ;
    // @ts-ignore
    const __VLS_96 = __VLS_asFunctionalComponent(RecordDetails, new RecordDetails({
        facts: (__VLS_ctx.details),
        notes: (__VLS_ctx.t.notes),
        paramsLoading: (__VLS_ctx.params.loading),
        paramsError: (__VLS_ctx.params.error),
        emptyText: (__VLS_ctx.t.test_type ? 'No details or parameters recorded for this test.' : 'No details recorded, and no test type, so no parameter set applies.'),
    }));
    const __VLS_97 = __VLS_96({
        facts: (__VLS_ctx.details),
        notes: (__VLS_ctx.t.notes),
        paramsLoading: (__VLS_ctx.params.loading),
        paramsError: (__VLS_ctx.params.error),
        emptyText: (__VLS_ctx.t.test_type ? 'No details or parameters recorded for this test.' : 'No details recorded, and no test type, so no parameter set applies.'),
    }, ...__VLS_functionalComponentArgsRest(__VLS_96));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        id: "subject",
        ...{ class: "subject-slot" },
    });
    if (__VLS_ctx.subjects.loading || __VLS_ctx.subjects.error) {
        const __VLS_99 = {}.LoadState;
        /** @type {[typeof __VLS_components.LoadState, ]} */ ;
        // @ts-ignore
        const __VLS_100 = __VLS_asFunctionalComponent(__VLS_99, new __VLS_99({
            loading: (__VLS_ctx.subjects.loading),
            error: (__VLS_ctx.subjects.error),
        }));
        const __VLS_101 = __VLS_100({
            loading: (__VLS_ctx.subjects.loading),
            error: (__VLS_ctx.subjects.error),
        }, ...__VLS_functionalComponentArgsRest(__VLS_100));
    }
    else {
        /** @type {[typeof TestSubjects, ]} */ ;
        // @ts-ignore
        const __VLS_103 = __VLS_asFunctionalComponent(TestSubjects, new TestSubjects({
            sample: (__VLS_ctx.t.sample_id),
            subjects: (__VLS_ctx.subjects.data),
            sampleHidden: (!!__VLS_ctx.hidden.data.sample_id),
        }));
        const __VLS_104 = __VLS_103({
            sample: (__VLS_ctx.t.sample_id),
            subjects: (__VLS_ctx.subjects.data),
            sampleHidden: (!!__VLS_ctx.hidden.data.sample_id),
        }, ...__VLS_functionalComponentArgsRest(__VLS_103));
    }
    /** @type {[typeof TestResults, ]} */ ;
    // @ts-ignore
    const __VLS_106 = __VLS_asFunctionalComponent(TestResults, new TestResults({
        id: "results",
        stats: (__VLS_ctx.t.summary_stats),
        status: (__VLS_ctx.t.status),
    }));
    const __VLS_107 = __VLS_106({
        id: "results",
        stats: (__VLS_ctx.t.summary_stats),
        status: (__VLS_ctx.t.status),
    }, ...__VLS_functionalComponentArgsRest(__VLS_106));
    /** @type {[typeof SampleFiles, ]} */ ;
    // @ts-ignore
    const __VLS_109 = __VLS_asFunctionalComponent(SampleFiles, new SampleFiles({
        id: "files",
        files: (__VLS_ctx.files.data),
        loading: (__VLS_ctx.files.loading),
        error: (__VLS_ctx.files.error),
        emptyText: "No files linked to this test.",
    }));
    const __VLS_110 = __VLS_109({
        id: "files",
        files: (__VLS_ctx.files.data),
        loading: (__VLS_ctx.files.loading),
        error: (__VLS_ctx.files.error),
        emptyText: "No files linked to this test.",
    }, ...__VLS_functionalComponentArgsRest(__VLS_109));
    var __VLS_23;
    const __VLS_112 = {}.EditDrawer;
    /** @type {[typeof __VLS_components.EditDrawer, ]} */ ;
    // @ts-ignore
    const __VLS_113 = __VLS_asFunctionalComponent(__VLS_112, new __VLS_112({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "test_sessions",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.typeText}`),
    }));
    const __VLS_114 = __VLS_113({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "test_sessions",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.typeText}`),
    }, ...__VLS_functionalComponentArgsRest(__VLS_113));
    let __VLS_116;
    let __VLS_117;
    let __VLS_118;
    const __VLS_119 = {
        onSaved: (__VLS_ctx.onSaved)
    };
    var __VLS_115;
}
var __VLS_7;
var __VLS_2;
/** @type {__VLS_StyleScopedClasses['subject-slot']} */ ;
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
            StatusBadge: StatusBadge,
            TestSubjects: TestSubjects,
            TestResults: TestResults,
            RecordDetails: RecordDetails,
            SampleFiles: SampleFiles,
            loading: loading,
            notVisible: notVisible,
            error: error,
            params: params,
            subjects: subjects,
            files: files,
            hidden: hidden,
            editing: editing,
            canUpdate: canUpdate,
            onSaved: onSaved,
            t: t,
            typeText: typeText,
            pageTitle: pageTitle,
            studioTo: studioTo,
            project: project,
            campaign: campaign,
            sample: sample,
            railFacts: railFacts,
            details: details,
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
