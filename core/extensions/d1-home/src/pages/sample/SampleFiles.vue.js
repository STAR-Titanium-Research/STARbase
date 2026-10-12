/// <reference types="../../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref } from 'vue';
import { Section, LoadState } from '@d1/ui';
const __VLS_props = defineProps();
const copiedKey = ref(null);
async function copy(text, key) {
    try {
        await navigator.clipboard.writeText(text);
    }
    catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }
    copiedKey.value = key;
    setTimeout(() => (copiedKey.value = null), 1500);
}
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['file']} */ ;
/** @type {__VLS_StyleScopedClasses['file']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: "Files",
    count: (__VLS_ctx.loading ? null : __VLS_ctx.files.length),
    empty: (!__VLS_ctx.loading && !__VLS_ctx.error && !__VLS_ctx.files.length),
    emptyText: (__VLS_ctx.emptyText ?? 'No files linked to this sample.'),
}));
const __VLS_2 = __VLS_1({
    title: "Files",
    count: (__VLS_ctx.loading ? null : __VLS_ctx.files.length),
    empty: (!__VLS_ctx.loading && !__VLS_ctx.error && !__VLS_ctx.files.length),
    emptyText: (__VLS_ctx.emptyText ?? 'No files linked to this sample.'),
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
const __VLS_5 = {}.LoadState;
/** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
// @ts-ignore
const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
    loading: (__VLS_ctx.loading),
    error: (__VLS_ctx.error),
}));
const __VLS_7 = __VLS_6({
    loading: (__VLS_ctx.loading),
    error: (__VLS_ctx.error),
}, ...__VLS_functionalComponentArgsRest(__VLS_6));
__VLS_8.slots.default;
__VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
    ...{ class: "files" },
});
for (const [f] of __VLS_getVForSourceType((__VLS_ctx.files))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
        key: (f.id),
        ...{ class: "file" },
    });
    const __VLS_9 = {}.VIcon;
    /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
        name: "insert_drive_file",
        small: true,
    }));
    const __VLS_11 = __VLS_10({
        name: "insert_drive_file",
        small: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "name" },
        title: (f.unc ?? f.name),
    });
    (f.name);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span)({
        ...{ class: "spacer" },
    });
    if (f.kind === 'archive' && f.unc && f.folder) {
        const __VLS_13 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_14 = __VLS_asFunctionalComponent(__VLS_13, new __VLS_13({
            ...{ 'onClick': {} },
            name: (__VLS_ctx.copiedKey === f.id + ':file' ? 'check' : 'content_copy'),
            clickable: true,
            small: true,
        }));
        const __VLS_15 = __VLS_14({
            ...{ 'onClick': {} },
            name: (__VLS_ctx.copiedKey === f.id + ':file' ? 'check' : 'content_copy'),
            clickable: true,
            small: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_14));
        let __VLS_17;
        let __VLS_18;
        let __VLS_19;
        const __VLS_20 = {
            onClick: (...[$event]) => {
                if (!(f.kind === 'archive' && f.unc && f.folder))
                    return;
                __VLS_ctx.copy(f.unc, f.id + ':file');
            }
        };
        __VLS_asFunctionalDirective(__VLS_directives.vTooltip)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.copiedKey === f.id + ':file' ? 'Copied!' : 'Copy file path') }, null, null);
        var __VLS_16;
        const __VLS_21 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_22 = __VLS_asFunctionalComponent(__VLS_21, new __VLS_21({
            ...{ 'onClick': {} },
            name: (__VLS_ctx.copiedKey === f.id + ':dir' ? 'check' : 'folder_copy'),
            clickable: true,
            small: true,
        }));
        const __VLS_23 = __VLS_22({
            ...{ 'onClick': {} },
            name: (__VLS_ctx.copiedKey === f.id + ':dir' ? 'check' : 'folder_copy'),
            clickable: true,
            small: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_22));
        let __VLS_25;
        let __VLS_26;
        let __VLS_27;
        const __VLS_28 = {
            onClick: (...[$event]) => {
                if (!(f.kind === 'archive' && f.unc && f.folder))
                    return;
                __VLS_ctx.copy(f.folder, f.id + ':dir');
            }
        };
        __VLS_asFunctionalDirective(__VLS_directives.vTooltip)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.copiedKey === f.id + ':dir' ? 'Copied!' : 'Copy folder path (paste into Explorer address bar)') }, null, null);
        var __VLS_24;
        if (f.fileUri) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
                href: (f.fileUri),
                target: "_blank",
                rel: "noopener",
            });
            const __VLS_29 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_30 = __VLS_asFunctionalComponent(__VLS_29, new __VLS_29({
                name: "open_in_new",
                clickable: true,
                small: true,
            }));
            const __VLS_31 = __VLS_30({
                name: "open_in_new",
                clickable: true,
                small: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_30));
            __VLS_asFunctionalDirective(__VLS_directives.vTooltip)(null, { ...__VLS_directiveBindingRestFields, value: ('Open (only works with the d1file:// handler or a permissive browser)') }, null, null);
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.a, __VLS_intrinsicElements.a)({
            href: (`/assets/${f.id}?download`),
            target: "_blank",
            rel: "noopener",
        });
        const __VLS_33 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_34 = __VLS_asFunctionalComponent(__VLS_33, new __VLS_33({
            name: "download",
            clickable: true,
            small: true,
        }));
        const __VLS_35 = __VLS_34({
            name: "download",
            clickable: true,
            small: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_34));
        __VLS_asFunctionalDirective(__VLS_directives.vTooltip)(null, { ...__VLS_directiveBindingRestFields, value: ('Download') }, null, null);
    }
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
    ...{ class: "hint" },
});
var __VLS_8;
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['files']} */ ;
/** @type {__VLS_StyleScopedClasses['file']} */ ;
/** @type {__VLS_StyleScopedClasses['name']} */ ;
/** @type {__VLS_StyleScopedClasses['spacer']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            Section: Section,
            LoadState: LoadState,
            copiedKey: copiedKey,
            copy: copy,
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
