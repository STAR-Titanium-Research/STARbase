/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { DataTable, Section, analysisLink, collectionRoute, errorText, formatDate, hasPassCode, operationLabel, recordRoute } from '@d1/ui';
const KIND_LABEL = { sample: 'Sample', operation: 'Operation', fast: 'FAST', test: 'Test' };
const api = useApi();
const recent = ref([]);
const samplesLink = collectionRoute('physical_samples');
const error = ref('');
// Each source loads on its own: one the role cannot read leaves the others in the feed, and the
// failure is named instead of showing an empty feed that claims "No activity yet".
const SOURCES = [
    {
        label: 'samples',
        read: async () => {
            const res = await api.get('/items/physical_samples', {
                params: { sort: '-created_at', limit: 6, fields: ['sample_id', 'sample_code', 'form', 'created_at', 'material_id.common_name'] },
            });
            return (res.data.data ?? []).map((r) => ({
                kind: 'sample', id: r.sample_id, code: r.sample_code,
                meta: r.material_id?.common_name || r.form || '—', date: r.created_at,
                to: recordRoute('physical_samples', r.sample_id),
            }));
        },
    },
    {
        label: 'operations',
        read: async () => {
            const res = await api.get('/items/manufacturing_operations', {
                params: { sort: '-created_at', limit: 8, fields: ['operation_id', 'pass_code', 'operation_sequence', 'created_at', 'process_category', 'sample_id.sample_code'] },
            });
            return (res.data.data ?? []).map((r) => {
                const isFast = r.process_category === 'sintering';
                return {
                    kind: isFast ? 'fast' : 'operation',
                    id: r.operation_id, code: operationLabel(r), plain: !hasPassCode(r),
                    // Without a pass code the label already names the sample: do not print it twice.
                    meta: hasPassCode(r) ? (r.sample_id?.sample_code || '—') : '', date: r.created_at,
                    to: recordRoute('manufacturing_operations', r.operation_id),
                    extra: isFast ? analysisLink(r.operation_id, r.process_category) : null,
                };
            });
        },
    },
    {
        label: 'tests',
        read: async () => {
            const res = await api.get('/items/test_sessions', {
                params: { sort: '-created_at', limit: 6, fields: ['session_id', 'test_type', 'created_at', 'sample_id.sample_code'] },
            });
            return (res.data.data ?? []).map((r) => ({
                kind: 'test', id: r.session_id, code: r.test_type || 'Test',
                meta: r.sample_id?.sample_code || '—', date: r.created_at,
                to: recordRoute('test_sessions', r.session_id),
            }));
        },
    },
];
onMounted(async () => {
    const results = await Promise.allSettled(SOURCES.map((s) => s.read()));
    const failed = [];
    const merged = [];
    results.forEach((r, i) => {
        if (r.status === 'fulfilled')
            merged.push(...r.value);
        else
            failed.push(`${SOURCES[i].label} (${errorText(r.reason)})`);
    });
    recent.value = merged
        .filter((a) => a.date)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 9);
    error.value = failed.length ? `Could not load recent ${failed.join(', ')}.` : '';
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['link']} */ ;
/** @type {__VLS_StyleScopedClasses['r-code']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: "Recent activity",
    count: (__VLS_ctx.recent.length || null),
    empty: (!__VLS_ctx.recent.length && !__VLS_ctx.error),
    emptyText: "No activity yet.",
}));
const __VLS_2 = __VLS_1({
    title: "Recent activity",
    count: (__VLS_ctx.recent.length || null),
    empty: (!__VLS_ctx.recent.length && !__VLS_ctx.error),
    emptyText: "No activity yet.",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
{
    const { actions: __VLS_thisSlot } = __VLS_3.slots;
    const __VLS_5 = {}.RouterLink;
    /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        to: (__VLS_ctx.samplesLink),
        ...{ class: "link" },
    }));
    const __VLS_7 = __VLS_6({
        to: (__VLS_ctx.samplesLink),
        ...{ class: "link" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    __VLS_8.slots.default;
    var __VLS_8;
}
if (__VLS_ctx.error) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
        ...{ class: "d1-note bad error" },
        role: "alert",
    });
    (__VLS_ctx.error);
}
if (__VLS_ctx.recent.length) {
    const __VLS_9 = {}.DataTable;
    /** @type {[typeof __VLS_components.DataTable, typeof __VLS_components.DataTable, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({}));
    const __VLS_11 = __VLS_10({}, ...__VLS_functionalComponentArgsRest(__VLS_10));
    __VLS_12.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.thead, __VLS_intrinsicElements.thead)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
        ...{ class: "fit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
        ...{ class: "fit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
        ...{ class: "fit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th, __VLS_intrinsicElements.th)({
        ...{ class: "fit" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.th)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.tbody, __VLS_intrinsicElements.tbody)({});
    for (const [r] of __VLS_getVForSourceType((__VLS_ctx.recent))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.tr, __VLS_intrinsicElements.tr)({
            key: (`${r.kind}-${r.id}`),
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "fit dim" },
        });
        (__VLS_ctx.formatDate(r.date));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "fit" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "r-kind" },
            ...{ class: (`k-${r.kind}`) },
        });
        (__VLS_ctx.KIND_LABEL[r.kind]);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "fit" },
        });
        const __VLS_13 = {}.RouterLink;
        /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
        // @ts-ignore
        const __VLS_14 = __VLS_asFunctionalComponent(__VLS_13, new __VLS_13({
            to: (r.to),
            ...{ class: "r-code" },
            ...{ class: ({ mono: !r.plain }) },
        }));
        const __VLS_15 = __VLS_14({
            to: (r.to),
            ...{ class: "r-code" },
            ...{ class: ({ mono: !r.plain }) },
        }, ...__VLS_functionalComponentArgsRest(__VLS_14));
        __VLS_16.slots.default;
        (r.code);
        var __VLS_16;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "fit dim" },
        });
        (r.meta);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.td, __VLS_intrinsicElements.td)({
            ...{ class: "actions" },
        });
        if (r.extra) {
            const __VLS_17 = {}.RouterLink;
            /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
            // @ts-ignore
            const __VLS_18 = __VLS_asFunctionalComponent(__VLS_17, new __VLS_17({
                to: (r.extra.to),
                ...{ class: "link" },
            }));
            const __VLS_19 = __VLS_18({
                to: (r.extra.to),
                ...{ class: "link" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_18));
            __VLS_20.slots.default;
            (r.extra.label);
            var __VLS_20;
        }
    }
    var __VLS_12;
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['link']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['bad']} */ ;
/** @type {__VLS_StyleScopedClasses['error']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['dim']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['r-kind']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['r-code']} */ ;
/** @type {__VLS_StyleScopedClasses['fit']} */ ;
/** @type {__VLS_StyleScopedClasses['dim']} */ ;
/** @type {__VLS_StyleScopedClasses['actions']} */ ;
/** @type {__VLS_StyleScopedClasses['link']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            DataTable: DataTable,
            Section: Section,
            formatDate: formatDate,
            KIND_LABEL: KIND_LABEL,
            recent: recent,
            samplesLink: samplesLink,
            error: error,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
