/// <reference types="../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from './ExplorerView.vue';
import { useExplorerHost } from './explorerHost';
import { computed, onMounted, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { useRoute, useRouter } from 'vue-router';
import { PageShell } from '@d1/ui';
export default await (async () => {
    const api = useApi();
    const router = useRouter();
    const route = useRoute();
    // Only an admin may link a login to a People row (ADR-0011: the link decides whose records a
    // person sees, so a member relinking it would inherit someone else's records). The host reads the
    // flag from the server; if a non-admin were wrongly shown the picker, the server still refuses the write.
    const { isAdmin } = useExplorerHost();
    const go = (to) => router.push(to);
    const people = ref([]);
    const users = ref([]);
    const loading = ref(true);
    const filter = ref('all');
    // The finder sends a People hit to /home/people?q=<name>: the search box starts with that text, and
    // follows it if the query changes while the page stays open (a second finder search).
    const routeQ = () => (typeof route.query.q === 'string' ? route.query.q : '');
    const q = ref(routeQ());
    watch(() => route.query.q, () => (q.value = routeQ()));
    // Edit / add dialog state.
    const dialog = ref(false);
    const saving = ref(false);
    const draft = ref(blank());
    const isNew = computed(() => !draft.value.person_id);
    const err = ref('');
    function blank() {
        return { full_name: '', email: null, user_id: null, is_researcher: true, is_operator: false, active: true, notes: null };
    }
    // The login list is only needed by the admin-only login picker. isAdmin starts as a guess and can
    // turn true after the page has loaded, so this runs again when it does.
    async function loadUsers() {
        if (!isAdmin.value)
            return;
        try {
            const ur = await api.get('/users', { params: { limit: -1, fields: ['id', 'first_name', 'last_name', 'email'], sort: ['first_name'] } });
            users.value = (ur?.data?.data ?? []).map((u) => ({
                text: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || u.id,
                value: u.id,
            }));
        }
        catch {
            users.value = [];
        }
    }
    watch(isAdmin, (admin) => {
        if (admin && !users.value.length)
            void loadUsers();
    });
    async function load() {
        loading.value = true;
        try {
            const [pr] = await Promise.all([
                api.get('/items/people', { params: { limit: -1, sort: ['full_name'] } }),
                loadUsers(),
            ]);
            people.value = pr?.data?.data ?? [];
        }
        finally {
            loading.value = false;
        }
    }
    onMounted(load);
    const tabs = computed(() => [
        { id: 'all', label: 'Everyone', n: people.value.length },
        { id: 'researchers', label: 'Researchers', n: people.value.filter((p) => p.is_researcher).length },
        { id: 'operators', label: 'Operators', n: people.value.filter((p) => p.is_operator).length },
        { id: 'former', label: 'Former', n: people.value.filter((p) => !p.active).length },
        { id: 'nologin', label: 'No app login', n: people.value.filter((p) => !p.user_id).length },
    ]);
    const filtered = computed(() => {
        const term = q.value.trim().toLowerCase();
        return people.value.filter((p) => {
            if (filter.value === 'researchers' && !p.is_researcher)
                return false;
            if (filter.value === 'operators' && !p.is_operator)
                return false;
            if (filter.value === 'former' && p.active)
                return false;
            if (filter.value === 'nologin' && p.user_id)
                return false;
            if (term && !(`${p.full_name} ${p.email ?? ''}`.toLowerCase().includes(term)))
                return false;
            return true;
        });
    });
    function roleChips(p) {
        const r = [];
        if (p.is_researcher)
            r.push('Researcher');
        if (p.is_operator)
            r.push('Operator');
        if (!r.length)
            r.push('—');
        return r;
    }
    function openAdd() { draft.value = blank(); err.value = ''; dialog.value = true; }
    function openEdit(p) { draft.value = { ...p }; err.value = ''; dialog.value = true; }
    async function save() {
        if (!draft.value.full_name.trim()) {
            err.value = 'Name is required.';
            return;
        }
        saving.value = true;
        err.value = '';
        try {
            const body = {
                full_name: draft.value.full_name.trim(),
                email: draft.value.email || null,
                is_researcher: draft.value.is_researcher,
                is_operator: draft.value.is_operator,
                active: draft.value.active,
                notes: draft.value.notes || null,
            };
            // Members never send the login: the server refuses a change to it.
            if (isAdmin.value)
                body.user_id = draft.value.user_id || null;
            if (isNew.value)
                await api.post('/items/people', body);
            else
                await api.patch(`/items/people/${draft.value.person_id}`, body);
            dialog.value = false;
            await load();
        }
        catch (e) {
            err.value = e?.response?.data?.errors?.[0]?.message || e?.message || 'Could not save.';
        }
        finally {
            saving.value = false;
        }
    }
    async function remove() {
        if (!draft.value.person_id)
            return;
        if (!confirm(`Delete ${draft.value.full_name}? This is permanent. (Use "Former" instead if they just left.)`))
            return;
        saving.value = true;
        try {
            await api.delete(`/items/people/${draft.value.person_id}`);
            dialog.value = false;
            await load();
        }
        catch (e) {
            err.value = e?.response?.data?.errors?.[0]?.message || 'Could not delete (they may be referenced by records — mark Former instead).';
        }
        finally {
            saving.value = false;
        }
    }
    debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
    const __VLS_ctx = {};
    let __VLS_components;
    let __VLS_directives;
    /** @type {__VLS_StyleScopedClasses['tab']} */ ;
    /** @type {__VLS_StyleScopedClasses['tab']} */ ;
    /** @type {__VLS_StyleScopedClasses['tab']} */ ;
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    /** @type {__VLS_StyleScopedClasses['chip']} */ ;
    /** @type {__VLS_StyleScopedClasses['chip']} */ ;
    /** @type {__VLS_StyleScopedClasses['chip']} */ ;
    /** @type {__VLS_StyleScopedClasses['chip']} */ ;
    /** @type {__VLS_StyleScopedClasses['login']} */ ;
    /** @type {__VLS_StyleScopedClasses['edit-card']} */ ;
    /** @type {__VLS_StyleScopedClasses['edit-card']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['edit-card']} */ ;
    /** @type {__VLS_StyleScopedClasses['tg']} */ ;
    /** @type {__VLS_StyleScopedClasses['edit-card']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['hint']} */ ;
    // CSS variable injection 
    // CSS variable injection end 
    /** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
    // @ts-ignore
    const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
        title: "People",
    }));
    const __VLS_1 = __VLS_0({
        title: "People",
    }, ...__VLS_functionalComponentArgsRest(__VLS_0));
    var __VLS_3 = {};
    __VLS_2.slots.default;
    {
        const { headline: __VLS_thisSlot } = __VLS_2.slots;
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ onClick: (...[$event]) => {
                    __VLS_ctx.go('/home');
                } },
            ...{ class: "crumb" },
        });
    }
    {
        const { 'title-outer:prepend': __VLS_thisSlot } = __VLS_2.slots;
        const __VLS_4 = {}.VButton;
        /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
        // @ts-ignore
        const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
            ...{ class: "header-icon" },
            rounded: true,
            icon: true,
            secondary: true,
            disabled: true,
        }));
        const __VLS_6 = __VLS_5({
            ...{ class: "header-icon" },
            rounded: true,
            icon: true,
            secondary: true,
            disabled: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_5));
        __VLS_7.slots.default;
        const __VLS_8 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
            name: "groups",
        }));
        const __VLS_10 = __VLS_9({
            name: "groups",
        }, ...__VLS_functionalComponentArgsRest(__VLS_9));
        var __VLS_7;
    }
    const __VLS_12 = {}.PageShell;
    /** @type {[typeof __VLS_components.PageShell, typeof __VLS_components.PageShell, ]} */ ;
    // @ts-ignore
    const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
        narrow: true,
    }));
    const __VLS_14 = __VLS_13({
        narrow: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_13));
    __VLS_15.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "intro" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.b, __VLS_intrinsicElements.b)({});
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "bar" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "tabs" },
    });
    for (const [t] of __VLS_getVForSourceType((__VLS_ctx.tabs))) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
            ...{ onClick: (...[$event]) => {
                    __VLS_ctx.filter = t.id;
                } },
            key: (t.id),
            ...{ class: "tab" },
            ...{ class: ({ on: __VLS_ctx.filter === t.id }) },
        });
        (t.label);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "tn" },
        });
        (t.n);
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "bar-right" },
    });
    const __VLS_16 = {}.VInput;
    /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
    // @ts-ignore
    const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
        modelValue: (__VLS_ctx.q),
        ...{ class: "search" },
        placeholder: "Search name / email…",
        small: (true),
    }));
    const __VLS_18 = __VLS_17({
        modelValue: (__VLS_ctx.q),
        ...{ class: "search" },
        placeholder: "Search name / email…",
        small: (true),
    }, ...__VLS_functionalComponentArgsRest(__VLS_17));
    __VLS_19.slots.default;
    {
        const { prepend: __VLS_thisSlot } = __VLS_19.slots;
        const __VLS_20 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
            name: "search",
            small: true,
        }));
        const __VLS_22 = __VLS_21({
            name: "search",
            small: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_21));
    }
    var __VLS_19;
    const __VLS_24 = {}.VButton;
    /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
    // @ts-ignore
    const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
        ...{ 'onClick': {} },
        small: true,
    }));
    const __VLS_26 = __VLS_25({
        ...{ 'onClick': {} },
        small: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_25));
    let __VLS_28;
    let __VLS_29;
    let __VLS_30;
    const __VLS_31 = {
        onClick: (__VLS_ctx.openAdd)
    };
    __VLS_27.slots.default;
    const __VLS_32 = {}.VIcon;
    /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
    // @ts-ignore
    const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
        name: "person_add",
        left: true,
        small: true,
    }));
    const __VLS_34 = __VLS_33({
        name: "person_add",
        left: true,
        small: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_33));
    var __VLS_27;
    if (__VLS_ctx.loading) {
        const __VLS_36 = {}.VProgressCircular;
        /** @type {[typeof __VLS_components.VProgressCircular, typeof __VLS_components.vProgressCircular, ]} */ ;
        // @ts-ignore
        const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
            indeterminate: true,
            ...{ class: "load" },
        }));
        const __VLS_38 = __VLS_37({
            indeterminate: true,
            ...{ class: "load" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    }
    else if (!__VLS_ctx.filtered.length) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "empty" },
        });
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "list" },
        });
        for (const [p] of __VLS_getVForSourceType((__VLS_ctx.filtered))) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.button, __VLS_intrinsicElements.button)({
                ...{ onClick: (...[$event]) => {
                        if (!!(__VLS_ctx.loading))
                            return;
                        if (!!(!__VLS_ctx.filtered.length))
                            return;
                        __VLS_ctx.openEdit(p);
                    } },
                key: (p.person_id),
                ...{ class: "prow" },
                ...{ class: ({ former: !p.active }) },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "avatar" },
            });
            const __VLS_40 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
                name: (p.is_operator && !p.is_researcher ? 'engineering' : 'person'),
            }));
            const __VLS_42 = __VLS_41({
                name: (p.is_operator && !p.is_researcher ? 'engineering' : 'person'),
            }, ...__VLS_functionalComponentArgsRest(__VLS_41));
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "pinfo" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "pname" },
            });
            (p.full_name);
            if (!p.active) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "former-tag" },
                });
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "pmeta" },
            });
            for (const [r] of __VLS_getVForSourceType((__VLS_ctx.roleChips(p)))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    key: (r),
                    ...{ class: "chip" },
                    ...{ class: (r.toLowerCase()) },
                });
                (r);
            }
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "chip login" },
                ...{ class: ({ off: !p.user_id }) },
            });
            (p.user_id ? 'App user' : 'No login');
            if (p.email) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                    ...{ class: "pemail" },
                });
                (p.email);
            }
            const __VLS_44 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
                name: "chevron_right",
                ...{ class: "go" },
            }));
            const __VLS_46 = __VLS_45({
                name: "chevron_right",
                ...{ class: "go" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_45));
        }
    }
    var __VLS_15;
    const __VLS_48 = {}.VDialog;
    /** @type {[typeof __VLS_components.VDialog, typeof __VLS_components.vDialog, typeof __VLS_components.VDialog, typeof __VLS_components.vDialog, ]} */ ;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
        ...{ 'onEsc': {} },
        modelValue: (__VLS_ctx.dialog),
    }));
    const __VLS_50 = __VLS_49({
        ...{ 'onEsc': {} },
        modelValue: (__VLS_ctx.dialog),
    }, ...__VLS_functionalComponentArgsRest(__VLS_49));
    let __VLS_52;
    let __VLS_53;
    let __VLS_54;
    const __VLS_55 = {
        onEsc: (...[$event]) => {
            __VLS_ctx.dialog = false;
        }
    };
    __VLS_51.slots.default;
    const __VLS_56 = {}.VCard;
    /** @type {[typeof __VLS_components.VCard, typeof __VLS_components.vCard, typeof __VLS_components.VCard, typeof __VLS_components.vCard, ]} */ ;
    // @ts-ignore
    const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
        ...{ class: "edit-card" },
    }));
    const __VLS_58 = __VLS_57({
        ...{ class: "edit-card" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_57));
    __VLS_59.slots.default;
    const __VLS_60 = {}.VCardTitle;
    /** @type {[typeof __VLS_components.VCardTitle, typeof __VLS_components.vCardTitle, typeof __VLS_components.VCardTitle, typeof __VLS_components.vCardTitle, ]} */ ;
    // @ts-ignore
    const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({}));
    const __VLS_62 = __VLS_61({}, ...__VLS_functionalComponentArgsRest(__VLS_61));
    __VLS_63.slots.default;
    (__VLS_ctx.isNew ? 'Add a person' : __VLS_ctx.draft.full_name);
    var __VLS_63;
    const __VLS_64 = {}.VCardText;
    /** @type {[typeof __VLS_components.VCardText, typeof __VLS_components.vCardText, typeof __VLS_components.VCardText, typeof __VLS_components.vCardText, ]} */ ;
    // @ts-ignore
    const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({}));
    const __VLS_66 = __VLS_65({}, ...__VLS_functionalComponentArgsRest(__VLS_65));
    __VLS_67.slots.default;
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "fld" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
    const __VLS_68 = {}.VInput;
    /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
    // @ts-ignore
    const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
        modelValue: (__VLS_ctx.draft.full_name),
        placeholder: "First Last",
        autofocus: true,
    }));
    const __VLS_70 = __VLS_69({
        modelValue: (__VLS_ctx.draft.full_name),
        placeholder: "First Last",
        autofocus: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_69));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "row" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "fld" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
    const __VLS_72 = {}.VInput;
    /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
    // @ts-ignore
    const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
        modelValue: (__VLS_ctx.draft.email),
        placeholder: "name@sheffield.ac.uk",
    }));
    const __VLS_74 = __VLS_73({
        modelValue: (__VLS_ctx.draft.email),
        placeholder: "name@sheffield.ac.uk",
    }, ...__VLS_functionalComponentArgsRest(__VLS_73));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "fld" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
    if (__VLS_ctx.isAdmin) {
        const __VLS_76 = {}.VSelect;
        /** @type {[typeof __VLS_components.VSelect, typeof __VLS_components.vSelect, ]} */ ;
        // @ts-ignore
        const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
            modelValue: (__VLS_ctx.draft.user_id),
            items: (__VLS_ctx.users),
            placeholder: "Not an app user",
            showDeselect: true,
        }));
        const __VLS_78 = __VLS_77({
            modelValue: (__VLS_ctx.draft.user_id),
            items: (__VLS_ctx.users),
            placeholder: "Not an app user",
            showDeselect: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_77));
    }
    else {
        const __VLS_80 = {}.VInput;
        /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
        // @ts-ignore
        const __VLS_81 = __VLS_asFunctionalComponent(__VLS_80, new __VLS_80({
            modelValue: (__VLS_ctx.draft.user_id ? 'Linked to an app login' : 'No app login'),
            disabled: true,
        }));
        const __VLS_82 = __VLS_81({
            modelValue: (__VLS_ctx.draft.user_id ? 'Linked to an app login' : 'No app login'),
            disabled: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_81));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "hint" },
        });
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "toggles" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "tg" },
    });
    const __VLS_84 = {}.VCheckbox;
    /** @type {[typeof __VLS_components.VCheckbox, typeof __VLS_components.vCheckbox, ]} */ ;
    // @ts-ignore
    const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
        modelValue: (__VLS_ctx.draft.is_researcher),
    }));
    const __VLS_86 = __VLS_85({
        modelValue: (__VLS_ctx.draft.is_researcher),
    }, ...__VLS_functionalComponentArgsRest(__VLS_85));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "tg" },
    });
    const __VLS_88 = {}.VCheckbox;
    /** @type {[typeof __VLS_components.VCheckbox, typeof __VLS_components.vCheckbox, ]} */ ;
    // @ts-ignore
    const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({
        modelValue: (__VLS_ctx.draft.is_operator),
    }));
    const __VLS_90 = __VLS_89({
        modelValue: (__VLS_ctx.draft.is_operator),
    }, ...__VLS_functionalComponentArgsRest(__VLS_89));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({
        ...{ class: "tg" },
    });
    const __VLS_92 = {}.VCheckbox;
    /** @type {[typeof __VLS_components.VCheckbox, typeof __VLS_components.vCheckbox, ]} */ ;
    // @ts-ignore
    const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
        modelValue: (__VLS_ctx.draft.active),
    }));
    const __VLS_94 = __VLS_93({
        modelValue: (__VLS_ctx.draft.active),
    }, ...__VLS_functionalComponentArgsRest(__VLS_93));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "hint" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "fld" },
    });
    __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
    const __VLS_96 = {}.VTextarea;
    /** @type {[typeof __VLS_components.VTextarea, typeof __VLS_components.vTextarea, ]} */ ;
    // @ts-ignore
    const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({
        modelValue: (__VLS_ctx.draft.notes),
        placeholder: "Optional",
    }));
    const __VLS_98 = __VLS_97({
        modelValue: (__VLS_ctx.draft.notes),
        placeholder: "Optional",
    }, ...__VLS_functionalComponentArgsRest(__VLS_97));
    if (__VLS_ctx.err) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "err" },
        });
        (__VLS_ctx.err);
    }
    var __VLS_67;
    const __VLS_100 = {}.VCardActions;
    /** @type {[typeof __VLS_components.VCardActions, typeof __VLS_components.vCardActions, typeof __VLS_components.VCardActions, typeof __VLS_components.vCardActions, ]} */ ;
    // @ts-ignore
    const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({}));
    const __VLS_102 = __VLS_101({}, ...__VLS_functionalComponentArgsRest(__VLS_101));
    __VLS_103.slots.default;
    if (!__VLS_ctx.isNew && __VLS_ctx.isAdmin) {
        const __VLS_104 = {}.VButton;
        /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
        // @ts-ignore
        const __VLS_105 = __VLS_asFunctionalComponent(__VLS_104, new __VLS_104({
            ...{ 'onClick': {} },
            secondary: true,
            ...{ class: "del" },
            loading: (__VLS_ctx.saving),
        }));
        const __VLS_106 = __VLS_105({
            ...{ 'onClick': {} },
            secondary: true,
            ...{ class: "del" },
            loading: (__VLS_ctx.saving),
        }, ...__VLS_functionalComponentArgsRest(__VLS_105));
        let __VLS_108;
        let __VLS_109;
        let __VLS_110;
        const __VLS_111 = {
            onClick: (__VLS_ctx.remove)
        };
        __VLS_107.slots.default;
        const __VLS_112 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_113 = __VLS_asFunctionalComponent(__VLS_112, new __VLS_112({
            name: "delete",
            left: true,
            small: true,
        }));
        const __VLS_114 = __VLS_113({
            name: "delete",
            left: true,
            small: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_113));
        var __VLS_107;
    }
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div)({
        ...{ class: "spacer" },
    });
    const __VLS_116 = {}.VButton;
    /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
    // @ts-ignore
    const __VLS_117 = __VLS_asFunctionalComponent(__VLS_116, new __VLS_116({
        ...{ 'onClick': {} },
        secondary: true,
    }));
    const __VLS_118 = __VLS_117({
        ...{ 'onClick': {} },
        secondary: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_117));
    let __VLS_120;
    let __VLS_121;
    let __VLS_122;
    const __VLS_123 = {
        onClick: (...[$event]) => {
            __VLS_ctx.dialog = false;
        }
    };
    __VLS_119.slots.default;
    var __VLS_119;
    const __VLS_124 = {}.VButton;
    /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
    // @ts-ignore
    const __VLS_125 = __VLS_asFunctionalComponent(__VLS_124, new __VLS_124({
        ...{ 'onClick': {} },
        loading: (__VLS_ctx.saving),
    }));
    const __VLS_126 = __VLS_125({
        ...{ 'onClick': {} },
        loading: (__VLS_ctx.saving),
    }, ...__VLS_functionalComponentArgsRest(__VLS_125));
    let __VLS_128;
    let __VLS_129;
    let __VLS_130;
    const __VLS_131 = {
        onClick: (__VLS_ctx.save)
    };
    __VLS_127.slots.default;
    (__VLS_ctx.isNew ? 'Add person' : 'Save');
    var __VLS_127;
    var __VLS_103;
    var __VLS_59;
    var __VLS_51;
    var __VLS_2;
    /** @type {__VLS_StyleScopedClasses['crumb']} */ ;
    /** @type {__VLS_StyleScopedClasses['header-icon']} */ ;
    /** @type {__VLS_StyleScopedClasses['intro']} */ ;
    /** @type {__VLS_StyleScopedClasses['bar']} */ ;
    /** @type {__VLS_StyleScopedClasses['tabs']} */ ;
    /** @type {__VLS_StyleScopedClasses['tab']} */ ;
    /** @type {__VLS_StyleScopedClasses['tn']} */ ;
    /** @type {__VLS_StyleScopedClasses['bar-right']} */ ;
    /** @type {__VLS_StyleScopedClasses['search']} */ ;
    /** @type {__VLS_StyleScopedClasses['load']} */ ;
    /** @type {__VLS_StyleScopedClasses['empty']} */ ;
    /** @type {__VLS_StyleScopedClasses['list']} */ ;
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    /** @type {__VLS_StyleScopedClasses['avatar']} */ ;
    /** @type {__VLS_StyleScopedClasses['pinfo']} */ ;
    /** @type {__VLS_StyleScopedClasses['pname']} */ ;
    /** @type {__VLS_StyleScopedClasses['former-tag']} */ ;
    /** @type {__VLS_StyleScopedClasses['pmeta']} */ ;
    /** @type {__VLS_StyleScopedClasses['chip']} */ ;
    /** @type {__VLS_StyleScopedClasses['chip']} */ ;
    /** @type {__VLS_StyleScopedClasses['login']} */ ;
    /** @type {__VLS_StyleScopedClasses['pemail']} */ ;
    /** @type {__VLS_StyleScopedClasses['go']} */ ;
    /** @type {__VLS_StyleScopedClasses['edit-card']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['hint']} */ ;
    /** @type {__VLS_StyleScopedClasses['toggles']} */ ;
    /** @type {__VLS_StyleScopedClasses['tg']} */ ;
    /** @type {__VLS_StyleScopedClasses['tg']} */ ;
    /** @type {__VLS_StyleScopedClasses['tg']} */ ;
    /** @type {__VLS_StyleScopedClasses['hint']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['err']} */ ;
    /** @type {__VLS_StyleScopedClasses['del']} */ ;
    /** @type {__VLS_StyleScopedClasses['spacer']} */ ;
    var __VLS_dollars;
    const __VLS_self = (await import('vue')).defineComponent({
        setup() {
            return {
                ExplorerView: ExplorerView,
                PageShell: PageShell,
                isAdmin: isAdmin,
                go: go,
                users: users,
                loading: loading,
                filter: filter,
                q: q,
                dialog: dialog,
                saving: saving,
                draft: draft,
                isNew: isNew,
                err: err,
                tabs: tabs,
                filtered: filtered,
                roleChips: roleChips,
                openAdd: openAdd,
                openEdit: openEdit,
                save: save,
                remove: remove,
            };
        },
        inheritAttrs: false
    });
    return (await import('vue')).defineComponent({
        setup() {
            return {};
        },
        inheritAttrs: false
    });
})();
; /* PartiallyEnd: #4569/main.vue */
