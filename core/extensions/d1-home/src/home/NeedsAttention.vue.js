/// <reference types="../../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { BOOKMARK_VISIBILITY_FILTER, EXPLORER_HOST, LoadState, Section, collectionRoute, errorText, indexRoute, pickBookmarkId, useItems, useRequestGate, } from '@d1/ui';
import { ATTENTION, ATTENTION_LIST_LIMIT } from './attention';
const props = defineProps();
const { getItems } = useItems();
const api = useApi();
const host = inject(EXPLORER_HOST, null);
const gate = useRequestGate();
const defs = computed(() => ATTENTION.filter((d) => !d.adminOnly || props.isAdmin));
const state = ref({});
const open = ref(null);
const list = ref({ loading: false, error: '', items: [] });
const listGate = useRequestGate();
async function loadCount(def, token) {
    state.value[def.key] = { count: null, error: '', loading: true };
    try {
        const rows = await getItems(def.collection, { aggregate: { count: '*' }, filter: def.filter, limit: 1 });
        if (gate.isCurrent(token))
            state.value[def.key] = { count: Number(rows[0]?.count ?? 0), error: '', loading: false };
    }
    catch (e) {
        if (gate.isCurrent(token))
            state.value[def.key] = { count: null, error: `Could not count: ${errorText(e)}`, loading: false };
    }
}
async function toggle(def) {
    if (open.value === def.key) {
        open.value = null;
        return;
    }
    open.value = def.key;
    const token = listGate.begin();
    list.value = { loading: true, error: '', items: [] };
    try {
        const rows = await getItems(def.collection, {
            filter: def.filter,
            fields: def.fields,
            sort: def.sort,
            limit: ATTENTION_LIST_LIMIT,
        });
        if (listGate.isCurrent(token))
            list.value = { loading: false, error: '', items: rows.map(def.toItem) };
    }
    catch (e) {
        if (listGate.isCurrent(token))
            list.value = { loading: false, error: `Could not load the list: ${errorText(e)}`, items: [] };
    }
}
// The id of a named bookmark on a collection, or null when there is none (or the role cannot read
// presets). Prefers the global bookmark, then a role's, then the user's own. An admin can read
// every user's presets, so the request carries the sidebar's visibility filter and the result is
// checked again against who is signed in: another user's private view is never linked.
async function bookmarkId(collection, name) {
    try {
        const res = await api.get('/presets', {
            params: {
                filter: JSON.stringify({ _and: [BOOKMARK_VISIBILITY_FILTER, { bookmark: { _eq: name } }, { collection: { _eq: collection } }] }),
                fields: ['id', 'user', 'role'],
                sort: ['id'],
                limit: -1,
            },
        });
        return pickBookmarkId(res.data.data ?? [], host?.user.value ?? null);
    }
    catch {
        return null;
    }
}
const openDef = computed(() => defs.value.find((d) => d.key === open.value) ?? null);
// A tile whose filter exists as a saved view ("Failed") links to the Explorer list with that view
// applied, found by name since its id differs between installs. Without it the link is the plain list.
const bookmarkIds = ref({});
const moreLink = computed(() => {
    const d = openDef.value;
    if (!d)
        return null;
    const id = bookmarkIds.value[d.key];
    return id === undefined
        ? { to: collectionRoute(d.collection), text: 'See the list' }
        : { to: indexRoute(d.collection, { bookmark: id }), text: 'See all' };
});
const openCount = computed(() => (open.value ? (state.value[open.value]?.count ?? 0) : 0));
// Counts load for the tiles shown, and again for a tile that appears later: the admin-only one
// shows only once the host has learnt the user is an admin (it starts as a guess).
const token = gate.begin();
const started = new Set();
function loadBookmark(d) {
    if (!d.bookmark)
        return;
    bookmarkId(d.collection, d.bookmark).then((id) => {
        const next = { ...bookmarkIds.value };
        if (id !== null)
            next[d.key] = id;
        else
            delete next[d.key];
        bookmarkIds.value = next;
    });
}
watch(defs, (list) => {
    for (const d of list) {
        if (started.has(d.key))
            continue;
        started.add(d.key);
        loadCount(d, token);
        loadBookmark(d);
    }
}, { immediate: true });
// Who is signed in arrives after the page does: pick the views again with it.
watch(() => host?.user.value?.id, () => {
    for (const d of defs.value)
        loadBookmark(d);
});
onBeforeUnmount(() => {
    gate.cancel();
    listGate.cancel();
});
const show = (s) => (!s || s.loading ? '…' : s.count === null ? '–' : s.count.toLocaleString('en-GB'));
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['hot']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['hot']} */ ;
/** @type {__VLS_StyleScopedClasses['open']} */ ;
/** @type {__VLS_StyleScopedClasses['t-value']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['t-value']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['hot']} */ ;
/** @type {__VLS_StyleScopedClasses['t-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['items']} */ ;
/** @type {__VLS_StyleScopedClasses['i-title']} */ ;
/** @type {__VLS_StyleScopedClasses['i-title']} */ ;
// CSS variable injection 
// CSS variable injection end 
const __VLS_0 = {}.Section;
/** @type {[typeof __VLS_components.Section, typeof __VLS_components.Section, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    title: "Needs attention",
}));
const __VLS_2 = __VLS_1({
    title: "Needs attention",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
var __VLS_4 = {};
__VLS_3.slots.default;
{
    const { actions: __VLS_thisSlot } = __VLS_3.slots;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "sub" },
    });
}
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "tiles" },
});
for (const [d] of __VLS_getVForSourceType((__VLS_ctx.defs))) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
        ...{ onClick: (...[$event]) => {
                __VLS_ctx.toggle(d);
            } },
        key: (d.key),
        ...{ class: "tile" },
        ...{ class: ({ hot: (__VLS_ctx.state[d.key]?.count ?? 0) > 0, open: __VLS_ctx.open === d.key }) },
        disabled: (!__VLS_ctx.state[d.key] || __VLS_ctx.state[d.key].loading || __VLS_ctx.state[d.key].count === null || __VLS_ctx.state[d.key].count === 0),
        'aria-expanded': (__VLS_ctx.open === d.key),
        title: (__VLS_ctx.state[d.key]?.error || d.hint),
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "t-value" },
    });
    (__VLS_ctx.show(__VLS_ctx.state[d.key]));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "t-label" },
    });
    const __VLS_5 = {}.VIcon;
    /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent(__VLS_5, new __VLS_5({
        name: (d.icon),
        xSmall: true,
        ...{ class: "t-icon" },
    }));
    const __VLS_7 = __VLS_6({
        name: (d.icon),
        xSmall: true,
        ...{ class: "t-icon" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    (d.label);
}
if (__VLS_ctx.openDef) {
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "list" },
    });
    const __VLS_9 = {}.LoadState;
    /** @type {[typeof __VLS_components.LoadState, typeof __VLS_components.LoadState, ]} */ ;
    // @ts-ignore
    const __VLS_10 = __VLS_asFunctionalComponent(__VLS_9, new __VLS_9({
        loading: (__VLS_ctx.list.loading),
        error: (__VLS_ctx.list.error),
    }));
    const __VLS_11 = __VLS_10({
        loading: (__VLS_ctx.list.loading),
        error: (__VLS_ctx.list.error),
    }, ...__VLS_functionalComponentArgsRest(__VLS_10));
    __VLS_12.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.ul, __VLS_intrinsicElements.ul)({
        ...{ class: "items" },
    });
    for (const [i] of __VLS_getVForSourceType((__VLS_ctx.list.items))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.li, __VLS_intrinsicElements.li)({
            key: (i.id),
        });
        const __VLS_13 = {}.RouterLink;
        /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
        // @ts-ignore
        const __VLS_14 = __VLS_asFunctionalComponent(__VLS_13, new __VLS_13({
            to: (i.to),
            ...{ class: "i-title" },
            ...{ class: ({ plain: i.plain }) },
        }));
        const __VLS_15 = __VLS_14({
            to: (i.to),
            ...{ class: "i-title" },
            ...{ class: ({ plain: i.plain }) },
        }, ...__VLS_functionalComponentArgsRest(__VLS_14));
        __VLS_16.slots.default;
        (i.title);
        var __VLS_16;
        if (i.sub) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "i-sub" },
            });
            (i.sub);
        }
    }
    if (__VLS_ctx.moreLink && __VLS_ctx.openCount > __VLS_ctx.list.items.length) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "d1-note more" },
        });
        (__VLS_ctx.list.items.length);
        (__VLS_ctx.openCount);
        const __VLS_17 = {}.RouterLink;
        /** @type {[typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, typeof __VLS_components.RouterLink, typeof __VLS_components.routerLink, ]} */ ;
        // @ts-ignore
        const __VLS_18 = __VLS_asFunctionalComponent(__VLS_17, new __VLS_17({
            to: (__VLS_ctx.moreLink.to),
        }));
        const __VLS_19 = __VLS_18({
            to: (__VLS_ctx.moreLink.to),
        }, ...__VLS_functionalComponentArgsRest(__VLS_18));
        __VLS_20.slots.default;
        (__VLS_ctx.moreLink.text);
        var __VLS_20;
    }
    var __VLS_12;
}
var __VLS_3;
/** @type {__VLS_StyleScopedClasses['sub']} */ ;
/** @type {__VLS_StyleScopedClasses['tiles']} */ ;
/** @type {__VLS_StyleScopedClasses['tile']} */ ;
/** @type {__VLS_StyleScopedClasses['t-value']} */ ;
/** @type {__VLS_StyleScopedClasses['t-label']} */ ;
/** @type {__VLS_StyleScopedClasses['t-icon']} */ ;
/** @type {__VLS_StyleScopedClasses['list']} */ ;
/** @type {__VLS_StyleScopedClasses['items']} */ ;
/** @type {__VLS_StyleScopedClasses['i-title']} */ ;
/** @type {__VLS_StyleScopedClasses['i-sub']} */ ;
/** @type {__VLS_StyleScopedClasses['d1-note']} */ ;
/** @type {__VLS_StyleScopedClasses['more']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            LoadState: LoadState,
            Section: Section,
            defs: defs,
            state: state,
            open: open,
            list: list,
            toggle: toggle,
            openDef: openDef,
            moreLink: moreLink,
            openCount: openCount,
            show: show,
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
