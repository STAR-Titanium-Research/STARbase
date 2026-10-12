/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed } from 'vue';
import { DataTable, LIST_CAP, LoadState, Section, StatusBadge, analysisLink, breakableParts, formatDate, formatQuantity } from '@d1/ui';
const props = defineProps();
const link = computed(() => analysisLink(props.operationId, props.category));
const capped = computed(() => props.force.data.length > LIST_CAP);
const rows = computed(() => props.force.data.slice(0, LIST_CAP).sort((a, b) => fileName(a).localeCompare(fileName(b), undefined, { numeric: true })));
const fileName = (r) => r?.directus_files_id?.filename_download || r?.directus_files_id?.title || '(file)';
const isMachining = computed(() => props.category === 'machining');
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['fast']} */ ;
/** @type {__VLS_StyleScopedClasses['err']} */ ;
// CSS variable injection 
// CSS variable injection end 
if (__VLS_ctx.isMachining) {
    const __VLS_0 = {}.Section;
    /** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
        id: "force-analysis",
        title: "Force analysis",
        count: (__VLS_ctx.force.loading ? null : __VLS_ctx.rows.length),
        empty: (!__VLS_ctx.force.loading && !__VLS_ctx.force.error && !__VLS_ctx.rows.length),
        emptyText: "No force files have been picked up for analysis yet.",
    }));
    const __VLS_2 = __VLS_1({
        id: "force-analysis",
        title: "Force analysis",
        count: (__VLS_ctx.force.loading ? null : __VLS_ctx.rows.length),
        empty: (!__VLS_ctx.force.loading && !__VLS_ctx.force.error && !__VLS_ctx.rows.length),
        emptyText: "No force files have been picked up for analysis yet.",
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_3.slots.default;
    if (__VLS_ctx.link && __VLS_ctx.rows.length) {
        {
            const { actions: __VLS_thisSlot } = __VLS_3.slots;
            const __VLS_4 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
                xSmall: true,
                secondary: true,
                to: (__VLS_ctx.link.to),
            }));
            const __VLS_6 = __VLS_5({
                xSmall: true,
                secondary: true,
                to: (__VLS_ctx.link.to),
            }, ...__VLS_functionalComponentArgsRest(__VLS_5));
            __VLS_7.slots.default;
            const __VLS_8 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
                name: "show_chart",
                xSmall: true,
                left: true,
            }));
            const __VLS_10 = __VLS_9({
                name: "show_chart",
                xSmall: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_9));
            (__VLS_ctx.link.label);
            var __VLS_7;
        }
    }
    const __VLS_12 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        loading: (__VLS_ctx.force.loading),
        error: (__VLS_ctx.force.error),
    }));
    const __VLS_14 = __VLS_13({
        loading: (__VLS_ctx.force.loading),
        error: (__VLS_ctx.force.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    __VLS_15.slots.default;
    if (__VLS_ctx.capped) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note capped" },
        });
        (__VLS_ctx.LIST_CAP);
    }
    const __VLS_16 = {}.DataTable;
    /** @type {[typeof __VLS_components.DataTable, typeof __VLS_components.DataTable, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({}));
    const __VLS_18 = __VLS_17({}, ...__VLS_functionalComponentArgsRest(__VLS_17));
    __VLS_19.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
        ...{ class: "fit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
        ...{ class: "fit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
        ...{ class: "fit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
    for (const [r] of __VLS_getVForSourceType((__VLS_ctx.rows))) {
        (r.id);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
            ...{ class: ({ failed: r.error_message || r.diag_error }) },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "file mono" },
        });
        for (const [part, i] of __VLS_getVForSourceType((__VLS_ctx.breakableParts(__VLS_ctx.fileName(r))))) {
            (i);
            (part);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.wbr)({});
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "fit" },
        });
        const __VLS_20 = {}.StatusBadge;
        /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
        // @ts-ignore
        const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
            kind: "force",
            value: (r.status),
        }));
        const __VLS_22 = __VLS_21({
            kind: "force",
            value: (r.status),
        }, ...__VLS_functionalComponentArgsRest(__VLS_21));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "fit" },
        });
        const __VLS_24 = {}.StatusBadge;
        /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
        // @ts-ignore
        const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
            kind: "diag",
            value: (r.diag_status),
        }));
        const __VLS_26 = __VLS_25({
            kind: "diag",
            value: (r.diag_status),
        }, ...__VLS_functionalComponentArgsRest(__VLS_25));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "fit dim" },
        });
        (__VLS_ctx.formatDate(r.processed_at, ''));
        if (r.error_message || r.diag_error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
                ...{ class: "errors" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
                colspan: "4",
            });
            if (r.error_message) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                    ...{ class: "err" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
                (r.error_message);
            }
            if (r.diag_error) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                    ...{ class: "err" },
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
                (r.diag_error);
            }
        }
    }
    var __VLS_19;
    var __VLS_15;
    var __VLS_3;
}
if (__VLS_ctx.category === 'sintering') {
    const __VLS_28 = {}.Section;
    /** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
        id: "fast-run",
        title: "FAST run",
        count: (__VLS_ctx.fast.loading ? null : __VLS_ctx.fast.data ? 1 : 0),
        empty: (!__VLS_ctx.fast.loading && !__VLS_ctx.fast.error && !__VLS_ctx.fast.data),
        emptyText: "No FAST trace has been imported for this run yet.",
    }));
    const __VLS_30 = __VLS_29({
        id: "fast-run",
        title: "FAST run",
        count: (__VLS_ctx.fast.loading ? null : __VLS_ctx.fast.data ? 1 : 0),
        empty: (!__VLS_ctx.fast.loading && !__VLS_ctx.fast.error && !__VLS_ctx.fast.data),
        emptyText: "No FAST trace has been imported for this run yet.",
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    __VLS_31.slots.default;
    if (__VLS_ctx.link && __VLS_ctx.fast.data) {
        {
            const { actions: __VLS_thisSlot } = __VLS_31.slots;
            const __VLS_32 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
                xSmall: true,
                secondary: true,
                to: (__VLS_ctx.link.to),
            }));
            const __VLS_34 = __VLS_33({
                xSmall: true,
                secondary: true,
                to: (__VLS_ctx.link.to),
            }, ...__VLS_functionalComponentArgsRest(__VLS_33));
            __VLS_35.slots.default;
            const __VLS_36 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
                name: "show_chart",
                xSmall: true,
                left: true,
            }));
            const __VLS_38 = __VLS_37({
                name: "show_chart",
                xSmall: true,
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_37));
            (__VLS_ctx.link.label);
            var __VLS_35;
        }
    }
    const __VLS_40 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        loading: (__VLS_ctx.fast.loading),
        error: (__VLS_ctx.fast.error),
    }));
    const __VLS_42 = __VLS_41({
        loading: (__VLS_ctx.fast.loading),
        error: (__VLS_ctx.fast.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
    __VLS_43.slots.default;
    if (__VLS_ctx.fast.data) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fast" },
        });
        const __VLS_44 = {}.StatusBadge;
        /** @type {[typeof __VLS_components.StatusBadge, ]} */ ;
        // @ts-ignore
        const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
            kind: "force",
            value: (__VLS_ctx.fast.data.status),
        }));
        const __VLS_46 = __VLS_45({
            kind: "force",
            value: (__VLS_ctx.fast.data.status),
        }, ...__VLS_functionalComponentArgsRest(__VLS_45));
        if (__VLS_ctx.fast.data.recipe) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.fast.data.recipe);
        }
        if (__VLS_ctx.fast.data.plant) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.fast.data.plant);
        }
        if (__VLS_ctx.fast.data.run_start) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatDate(__VLS_ctx.fast.data.run_start));
        }
        if (__VLS_ctx.fast.data.duration_s) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatQuantity(__VLS_ctx.fast.data.duration_s));
        }
        if (__VLS_ctx.fast.data.n_rows) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.formatQuantity(__VLS_ctx.fast.data.n_rows));
        }
        if (__VLS_ctx.fast.data.error_message) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "err" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.strong, __VLS_intrinsicElements.strong)({});
            (__VLS_ctx.fast.data.error_message);
        }
    }
    var __VLS_43;
    var __VLS_31;
}
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['capped']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['file']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['dim']} */ ;
/** @type {__VLS_StyleScopedClasses['errors']} */ ;
/** @type {__VLS_StyleScopedClasses['err']} */ ;
/** @type {__VLS_StyleScopedClasses['err']} */ ;
/** @type {__VLS_StyleScopedClasses['fast']} */ ;
/** @type {__VLS_StyleScopedClasses['err']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            DataTable: DataTable,
            LIST_CAP: LIST_CAP,
            LoadState: LoadState,
            Section: Section,
            StatusBadge: StatusBadge,
            breakableParts: breakableParts,
            formatDate: formatDate,
            formatQuantity: formatQuantity,
            link: link,
            capped: capped,
            rows: rows,
            fileName: fileName,
            isMachining: isMachining,
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
