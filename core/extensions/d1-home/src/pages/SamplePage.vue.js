/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { EditDrawer, HiddenLink, useCanUpdate, LIST_CAP, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, Section, StatusBadge, buildLife, dataStudioRoute, detailFacts, sampleCampaigns, sampleDetailBase, sampleDims, sampleKind, sampleRailFacts, truncatedNotes, } from '@d1/ui';
import { dimsText } from '../geometry';
import { useSampleData } from './sample/useSampleData';
import SampleGeometry from './sample/SampleGeometry.vue';
import SampleDetails from './sample/SampleDetails.vue';
import LifeStrip from './sample/LifeStrip.vue';
import SampleRecords from './sample/SampleRecords.vue';
import SampleFiles from './sample/SampleFiles.vue';
const props = defineProps();
const { sample, loading, notVisible, error, elements, campaigns, operations, tests, files, trace, hidden, reload } = useSampleData(toRef(props, 'id'));
const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('physical_samples', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
    reload();
    refreshCanUpdate();
}
const code = computed(() => sample.value?.sample_code ?? 'Sample');
// The header bar names the kind of record too: a bare code ("10") says nothing on its own.
const pageTitle = computed(() => (sample.value?.sample_code ? `Sample ${sample.value.sample_code}` : 'Sample'));
const studioTo = computed(() => dataStudioRoute('physical_samples', props.id));
const life = computed(() => (trace.value.data ? buildLife(trace.value.data) : []));
const notes = computed(() => (trace.value.data ? truncatedNotes(trace.value.data) : []));
const dims = computed(() => sampleDims(sample.value));
// The rail's key facts, and the details panel: the sample's remaining values, minus what the rail shows.
const railFacts = computed(() => sampleRailFacts(sample.value, dimsText(dims.value), campaigns.value.data, hidden.value.data));
const details = computed(() => detailFacts(sampleDetailBase(sample.value), [], railFacts.value));
// The breadcrumb: the project, then each campaign the user may read.
const project = computed(() => sample.value?.project_id);
const campaignRows = computed(() => sampleCampaigns(campaigns.value.data));
// "On this page": the panels this sample has, in page order. A count is null while it loads, and for
// panels with no count of their own (the material and the life strip).
const contents = computed(() => [
    { id: 'details', title: 'Material and details', count: null },
    { id: 'life', title: 'Life of the sample', count: null },
    { id: 'operations', title: 'Operations', count: operations.value.loading ? null : Math.min(operations.value.data.length, LIST_CAP) },
    { id: 'tests', title: 'Tests', count: tests.value.loading ? null : Math.min(tests.value.data.length, LIST_CAP) },
    { id: 'files', title: 'Files', count: files.value.loading ? null : files.value.data.length },
]);
// /d1-report/* are endpoint pages (printable HTML), not app routes: open them in a new tab, same
// session, as the Home page does.
const openReport = (path) => window.open(path, '_blank', 'noopener');
const printLabel = () => openReport(`/d1-report/label?ids=${encodeURIComponent(props.id)}`);
const openReportPage = () => openReport(`/d1-report/sample/${encodeURIComponent(props.id)}`);
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
if (__VLS_ctx.loading && !__VLS_ctx.sample) {
    const __VLS_8 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
        loading: true,
        loadingText: "Loading sample…",
    }));
    const __VLS_10 = __VLS_9({
        loading: true,
        loadingText: "Loading sample…",
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
}
else if (__VLS_ctx.notVisible) {
    const __VLS_12 = {}.NotVisible;
    /** @type {[typeof __VLS_components.NotVisible, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        what: "sample",
    }));
    const __VLS_14 = __VLS_13({
        what: "sample",
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
else if (__VLS_ctx.sample) {
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
        if (__VLS_ctx.project?.project_id) {
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
        for (const [c] of __VLS_getVForSourceType((__VLS_ctx.campaignRows.campaigns))) {
            (c.campaign_id);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_36 = {}.RecordLink;
            /** @type {[typeof __VLS_components.RecordLink, typeof __VLS_components.RecordLink, ]} */ ;
            // @ts-ignore
            const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
                collection: "campaigns",
                id: (c.campaign_id),
            }));
            const __VLS_38 = __VLS_37({
                collection: "campaigns",
                id: (c.campaign_id),
            }, ...__VLS_functionalComponentArgsRest(__VLS_37));
            __VLS_39.slots.default;
            (c.campaign_code ? `Campaign ${c.campaign_code}` : c.name || 'Campaign');
            var __VLS_39;
        }
        if (__VLS_ctx.campaignRows.hidden > 0) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            const __VLS_40 = {}.HiddenLink;
            /** @type {[typeof __VLS_components.HiddenLink, ]} */ ;
            // @ts-ignore
            const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
                label: (__VLS_ctx.campaignRows.hidden === 1 ? 'Campaign' : `${__VLS_ctx.campaignRows.hidden} campaigns`),
            }));
            const __VLS_42 = __VLS_41({
                label: (__VLS_ctx.campaignRows.hidden === 1 ? 'Campaign' : `${__VLS_ctx.campaignRows.hidden} campaigns`),
            }, ...__VLS_functionalComponentArgsRest(__VLS_41));
        }
    }
    {
        const { rail: __VLS_thisSlot } = __VLS_23.slots;
        const __VLS_44 = {}.RecordRail;
        /** @type {[typeof __VLS_components.RecordRail, typeof __VLS_components.RecordRail, ]} */ ;
        // @ts-ignore
        const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
            kind: (__VLS_ctx.sampleKind(__VLS_ctx.sample)),
            code: (__VLS_ctx.code),
            title: (__VLS_ctx.sample.nickname),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }));
        const __VLS_46 = __VLS_45({
            kind: (__VLS_ctx.sampleKind(__VLS_ctx.sample)),
            code: (__VLS_ctx.code),
            title: (__VLS_ctx.sample.nickname),
            facts: (__VLS_ctx.railFacts),
            contents: (__VLS_ctx.contents),
        }, ...__VLS_functionalComponentArgsRest(__VLS_45));
        __VLS_47.slots.default;
        {
            const { 'kind-icon': __VLS_thisSlot } = __VLS_47.slots;
            const __VLS_48 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
                name: "science",
                xSmall: true,
            }));
            const __VLS_50 = __VLS_49({
                name: "science",
                xSmall: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_49));
        }
        {
            const { status: __VLS_thisSlot } = __VLS_47.slots;
            const __VLS_52 = {}.StatusBadge;
            /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
            // @ts-ignore
            const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
                kind: "sample",
                value: (__VLS_ctx.sample.current_status),
            }));
            const __VLS_54 = __VLS_53({
                kind: "sample",
                value: (__VLS_ctx.sample.current_status),
            }, ...__VLS_functionalComponentArgsRest(__VLS_53));
            if (__VLS_ctx.sample.export_controlled) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "export" },
                });
            }
        }
        {
            const { actions: __VLS_thisSlot } = __VLS_47.slots;
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
                        if (!!(__VLS_ctx.loading && !__VLS_ctx.sample))
                            return;
                        if (!!(__VLS_ctx.notVisible))
                            return;
                        if (!!(__VLS_ctx.error))
                            return;
                        if (!(__VLS_ctx.sample))
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
                onClick: (__VLS_ctx.printLabel)
            };
            __VLS_71.slots.default;
            const __VLS_76 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
                name: "label",
                small: true,
                left: true,
            }));
            const __VLS_78 = __VLS_77({
                name: "label",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_77));
            var __VLS_71;
            const __VLS_80 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({
                ...{ 'onClick': {} },
                small: true,
                secondary: true,
            }));
            const __VLS_82 = __VLS_81({
                ...{ 'onClick': {} },
                small: true,
                secondary: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_81));
            let __VLS_84;
            let __VLS_85;
            let __VLS_86;
            const __VLS_87 = {
                onClick: (__VLS_ctx.openReportPage)
            };
            __VLS_83.slots.default;
            const __VLS_88 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({
                name: "picture_as_pdf",
                small: true,
                left: true,
            }));
            const __VLS_90 = __VLS_89({
                name: "picture_as_pdf",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_89));
            var __VLS_83;
            const __VLS_92 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }));
            const __VLS_94 = __VLS_93({
                small: true,
                secondary: true,
                to: (__VLS_ctx.studioTo),
            }, ...__VLS_functionalComponentArgsRest(__VLS_93));
            __VLS_95.slots.default;
            const __VLS_96 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({
                name: "open_in_new",
                small: true,
                left: true,
            }));
            const __VLS_98 = __VLS_97({
                name: "open_in_new",
                small: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_97));
            var __VLS_95;
        }
        {
            const { extra: __VLS_thisSlot } = __VLS_47.slots;
            /** @type {[typeof SampleGeometry, ]} */ ;
            // @ts-ignore
            const __VLS_100 = __VLS_asFunctionalComponent(SampleGeometry, new SampleGeometry({
                dims: (__VLS_ctx.dims),
            }));
            const __VLS_101 = __VLS_100({
                dims: (__VLS_ctx.dims),
            }, ...__VLS_functionalComponentArgsRest(__VLS_100));
        }
        var __VLS_47;
    }
    /** @type {[typeof SampleDetails, ]} */ ;
    // @ts-ignore
    const __VLS_103 = __VLS_asFunctionalComponent(SampleDetails, new SampleDetails({
        sample: (__VLS_ctx.sample),
        facts: (__VLS_ctx.details),
        elements: (__VLS_ctx.elements.data),
        elementsLoading: (__VLS_ctx.elements.loading),
        elementsError: (__VLS_ctx.elements.error),
    }));
    const __VLS_104 = __VLS_103({
        sample: (__VLS_ctx.sample),
        facts: (__VLS_ctx.details),
        elements: (__VLS_ctx.elements.data),
        elementsLoading: (__VLS_ctx.elements.loading),
        elementsError: (__VLS_ctx.elements.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_103));
    const __VLS_106 = {}.Section;
    /** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
    // @ts-ignore
    const __VLS_107 = __VLS_asFunctionalComponent(__VLS_106, new __VLS_106({
        id: "life",
        title: "Life of the sample",
    }));
    const __VLS_108 = __VLS_107({
        id: "life",
        title: "Life of the sample",
    }, ...__VLS_functionalComponentArgsRest(__VLS_107));
    __VLS_109.slots.default;
    {
        const { actions: __VLS_thisSlot } = __VLS_109.slots;
        const __VLS_110 = {}.VButton;
        /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
        // @ts-ignore
        const __VLS_111 = __VLS_asFunctionalComponent(__VLS_110, new __VLS_110({
            xSmall: true,
            secondary: true,
            to: (`/d1-lab-dashboard/graph?sample=${encodeURIComponent(__VLS_ctx.id)}`),
        }));
        const __VLS_112 = __VLS_111({
            xSmall: true,
            secondary: true,
            to: (`/d1-lab-dashboard/graph?sample=${encodeURIComponent(__VLS_ctx.id)}`),
        }, ...__VLS_functionalComponentArgsRest(__VLS_111));
        __VLS_113.slots.default;
        const __VLS_114 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_115 = __VLS_asFunctionalComponent(__VLS_114, new __VLS_114({
            name: "hub",
            xSmall: true,
            left: true,
        }));
        const __VLS_116 = __VLS_115({
            name: "hub",
            xSmall: true,
            left: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_115));
        var __VLS_113;
    }
    const __VLS_118 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_119 = __VLS_asFunctionalComponent(__VLS_118, new __VLS_118({
        loading: (__VLS_ctx.trace.loading),
        error: (__VLS_ctx.trace.error),
    }));
    const __VLS_120 = __VLS_119({
        loading: (__VLS_ctx.trace.loading),
        error: (__VLS_ctx.trace.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_119));
    __VLS_121.slots.default;
    /** @type {[typeof LifeStrip, ]} */ ;
    // @ts-ignore
    const __VLS_122 = __VLS_asFunctionalComponent(LifeStrip, new LifeStrip({
        items: (__VLS_ctx.life),
    }));
    const __VLS_123 = __VLS_122({
        items: (__VLS_ctx.life),
    }, ...__VLS_functionalComponentArgsRest(__VLS_122));
    for (const [n] of __VLS_getVForSourceType((__VLS_ctx.notes))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            key: (n),
            ...{ class: "d1-note warn note" },
        });
        (n);
    }
    var __VLS_121;
    var __VLS_109;
    /** @type {[typeof SampleRecords, ]} */ ;
    // @ts-ignore
    const __VLS_125 = __VLS_asFunctionalComponent(SampleRecords, new SampleRecords({
        operations: (__VLS_ctx.operations),
        tests: (__VLS_ctx.tests),
        sampleCode: (__VLS_ctx.sample.sample_code),
    }));
    const __VLS_126 = __VLS_125({
        operations: (__VLS_ctx.operations),
        tests: (__VLS_ctx.tests),
        sampleCode: (__VLS_ctx.sample.sample_code),
    }, ...__VLS_functionalComponentArgsRest(__VLS_125));
    /** @type {[typeof SampleFiles, ]} */ ;
    // @ts-ignore
    const __VLS_128 = __VLS_asFunctionalComponent(SampleFiles, new SampleFiles({
        id: "files",
        files: (__VLS_ctx.files.data),
        loading: (__VLS_ctx.files.loading),
        error: (__VLS_ctx.files.error),
    }));
    const __VLS_129 = __VLS_128({
        id: "files",
        files: (__VLS_ctx.files.data),
        loading: (__VLS_ctx.files.loading),
        error: (__VLS_ctx.files.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_128));
    var __VLS_23;
    const __VLS_131 = {}.EditDrawer;
    /** @type {[typeof __VLS_components.EditDrawer, ]} */ ;
    // @ts-ignore
    const __VLS_132 = __VLS_asFunctionalComponent(__VLS_131, new __VLS_131({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "physical_samples",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
    }));
    const __VLS_133 = __VLS_132({
        ...{ 'onSaved': {} },
        modelValue: (__VLS_ctx.editing),
        collection: "physical_samples",
        primaryKey: (__VLS_ctx.id),
        title: (`Edit ${__VLS_ctx.code}`),
    }, ...__VLS_functionalComponentArgsRest(__VLS_132));
    let __VLS_135;
    let __VLS_136;
    let __VLS_137;
    const __VLS_138 = {
        onSaved: (__VLS_ctx.onSaved)
    };
    var __VLS_134;
}
var __VLS_7;
var __VLS_2;
/** @type {__VLS_StyleScopedClasses['export']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['warn']} */ ;
/** @type {__VLS_StyleScopedClasses['note']} */ ;
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
            Section: Section,
            StatusBadge: StatusBadge,
            sampleKind: sampleKind,
            SampleGeometry: SampleGeometry,
            SampleDetails: SampleDetails,
            LifeStrip: LifeStrip,
            SampleRecords: SampleRecords,
            SampleFiles: SampleFiles,
            sample: sample,
            loading: loading,
            notVisible: notVisible,
            error: error,
            elements: elements,
            operations: operations,
            tests: tests,
            files: files,
            trace: trace,
            hidden: hidden,
            editing: editing,
            canUpdate: canUpdate,
            onSaved: onSaved,
            code: code,
            pageTitle: pageTitle,
            studioTo: studioTo,
            life: life,
            notes: notes,
            dims: dims,
            railFacts: railFacts,
            details: details,
            project: project,
            campaignRows: campaignRows,
            contents: contents,
            printLabel: printLabel,
            openReportPage: openReportPage,
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
