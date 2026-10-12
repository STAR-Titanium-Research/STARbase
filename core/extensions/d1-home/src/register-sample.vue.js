/// <reference types="../../../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import ExplorerView from './ExplorerView.vue';
import { useExplorerHost } from './explorerHost';
import { computed, onMounted, ref, watch } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { CREATED_BUT_HIDDEN_MESSAGE, NO_PERSON_MESSAGE, PageShell, createdRecord, recordRoute } from '@d1/ui';
import { buildGeometry, dimsText, FORMS, FORM_FIELDS, PRESETS, fieldLabel } from './geometry';
export default await (async () => {
    const api = useApi();
    const router = useRouter();
    const { useUserStore } = useStores();
    const userStore = useUserStore();
    // An admin reads every row, so a sample with no owner is still visible to them: only members need
    // a People row to see what they register. The server's own answer, shared with the sidebar.
    // isAdmin starts as a guess: the no-person warning waits for adminKnown so it never flashes at an admin.
    const { isAdmin, adminKnown } = useExplorerHost();
    const materials = ref([]);
    const methods = ref([]);
    const projects = ref([]);
    const forms = FORMS;
    const formLabel = computed(() => forms.find((x) => x.value === f.value.form)?.text ?? f.value.form);
    const f = ref({
        material_id: null,
        primary_method_id: null,
        manufactured_date: new Date().toISOString().slice(0, 10),
        form: null,
        diameter_mm: null,
        inner_diameter_mm: null,
        length_mm: null,
        width_mm: null,
        thickness_mm: null,
        gauge_length_mm: null,
        gauge_width_mm: null,
        mass_grams: null,
        project_id: null,
        location: null,
        nickname: null,
        notes: null,
    });
    // The sample number is assigned by the database on save (trigger on physical_samples replaces a
    // leading {seq}-). `seq` is only a preview of it, read with this user's permissions, so it can be
    // lower than the real next number; a failed read shows `seqError` and "?" -- never a made-up 1.
    const seq = ref(null);
    const seqError = ref('');
    const saving = ref(false);
    const error = ref('');
    const created = ref(null);
    // Set when the sample was created but the answer was empty: the user cannot read it (ADR-0011).
    const createdHidden = ref(false);
    // The People row of this login: ownership points at it, and without one a registered sample is
    // owned by nobody and not readable by its creator. null = no row, undefined = not known (yet).
    const personId = ref(undefined);
    async function lookupPerson() {
        const uid = userStore.currentUser?.id;
        if (!uid)
            return undefined;
        try {
            const pr = await api.get('/items/people', {
                params: { filter: { user_id: { _eq: uid } }, fields: ['person_id'], limit: 1 },
            });
            return pr?.data?.data?.[0]?.person_id ?? null;
        }
        catch {
            return undefined; // unknown: let the server decide
        }
    }
    // Live parametric isometric preview + the dimension inputs relevant to the chosen
    // form. Picking a standard test coupon fills its standard dimensions, which then
    // stay editable and reshape the drawing.
    const dimFields = computed(() => FORM_FIELDS[(f.value.form || '').toLowerCase()] ?? []);
    const geoSvg = computed(() => buildGeometry(f.value));
    const geoDimsText = computed(() => dimsText(f.value));
    const flabel = fieldLabel;
    watch(() => f.value.form, (form) => {
        const preset = PRESETS[(form || '').toLowerCase()];
        if (preset)
            Object.assign(f.value, preset); // standard specimen → standard dimensions
    });
    function codeWith(num) {
        const mat = materials.value.find((m) => m.value === f.value.material_id);
        const met = methods.value.find((m) => m.value === f.value.primary_method_id);
        if (!mat?.extra || !met?.extra)
            return '';
        const d = new Date(f.value.manufactured_date || Date.now());
        return `${num}-${mat.extra}-${met.extra}-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }
    // What is sent: the number is left to the database.
    const codeTemplate = computed(() => codeWith('{seq}'));
    // What is shown.
    const codePreview = computed(() => codeWith(seq.value != null ? String(seq.value) : '?'));
    const canSubmit = computed(() => !!f.value.material_id && !!f.value.primary_method_id && !!codeTemplate.value);
    // Preview only: /d1-next-number/sample asks the database (the same rule as the save-time trigger).
    async function nextSequence() {
        try {
            const res = await api.get('/d1-next-number/sample');
            const n = Number(res?.data?.next);
            if (!Number.isFinite(n))
                throw new Error('no number returned');
            seqError.value = '';
            return n;
        }
        catch {
            seqError.value = 'Could not read the next sample number, so no preview is available. The database still assigns the number when you save.';
            return null;
        }
    }
    async function submit() {
        if (!canSubmit.value || saving.value)
            return;
        saving.value = true;
        error.value = '';
        try {
            const payload = { sample_code: codeTemplate.value };
            for (const k of ['material_id', 'primary_method_id', 'manufactured_date', 'form', 'project_id', 'location', 'nickname', 'notes']) {
                if (f.value[k] !== null && f.value[k] !== '')
                    payload[k] = f.value[k];
            }
            for (const k of ['diameter_mm', 'inner_diameter_mm', 'length_mm', 'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm', 'mass_grams']) {
                if (f.value[k] !== null && f.value[k] !== '')
                    payload[k] = Number(f.value[k]);
            }
            // Ownership points at people, not directus_users: the owner is the current user's person
            // row. Without one the sample would belong to nobody and its creator could not see it, so
            // refuse up front instead of registering it into the void.
            if (personId.value === undefined)
                personId.value = await lookupPerson();
            if (personId.value === null && adminKnown.value && !isAdmin.value) {
                error.value = NO_PERSON_MESSAGE;
                return;
            }
            if (personId.value)
                payload.owner_person_id = personId.value;
            const res = await api.post('/items/physical_samples', payload);
            // An empty answer (HTTP 204) means created but not readable by this user.
            const row = createdRecord(res.data, 'sample_id', 'sample_code');
            createdHidden.value = !row;
            created.value = row ?? { id: '', code: '' };
        }
        catch (e) {
            error.value = e?.response?.data?.errors?.[0]?.message || e?.message || 'Could not register the sample.';
        }
        finally {
            saving.value = false;
        }
    }
    function resetForm() {
        created.value = null;
        createdHidden.value = false;
        f.value.material_id = null;
        f.value.primary_method_id = null;
        f.value.form = null;
        f.value.diameter_mm = f.value.inner_diameter_mm = f.value.length_mm = f.value.width_mm = f.value.thickness_mm = null;
        f.value.gauge_length_mm = f.value.gauge_width_mm = f.value.mass_grams = null;
        f.value.nickname = f.value.notes = f.value.location = null;
        nextSequence().then((n) => (seq.value = n));
    }
    const go = (to) => router.push(to); // router base is already /admin
    const openReport = (id) => window.open(`/d1-report/sample/${id}`, '_blank', 'noopener');
    onMounted(async () => {
        lookupPerson().then((p) => (personId.value = p));
        const [m, me, p, s] = await Promise.all([
            api.get('/items/materials', { params: { fields: ['material_id', 'common_name', 'alloy_code'], sort: 'common_name', limit: -1 } }),
            api.get('/items/manufacturing_methods', { params: { fields: ['method_id', 'method_name', 'method_code'], sort: 'method_name', limit: -1 } }),
            api.get('/items/projects', { params: { fields: ['project_id', 'project_code', 'project_name'], sort: 'project_code', limit: -1 } }),
            nextSequence(),
        ]);
        materials.value = (m.data.data || []).map((x) => ({ text: `${x.common_name || '—'}${x.alloy_code ? ` · ${x.alloy_code}` : ''}`, value: x.material_id, extra: x.alloy_code }));
        methods.value = (me.data.data || []).map((x) => ({ text: `${x.method_name || '—'}${x.method_code ? ` · ${x.method_code}` : ''}`, value: x.method_id, extra: x.method_code }));
        projects.value = (p.data.data || []).map((x) => ({ text: `${x.project_code || ''} — ${x.project_name || ''}`, value: x.project_id }));
        seq.value = s;
    });
    debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
    const __VLS_ctx = {};
    let __VLS_components;
    let __VLS_directives;
    /** @type {__VLS_StyleScopedClasses['geo-live']} */ ;
    /** @type {__VLS_StyleScopedClasses['dimgrid']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['row3']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['done']} */ ;
    /** @type {__VLS_StyleScopedClasses['done']} */ ;
    /** @type {__VLS_StyleScopedClasses['done']} */ ;
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['row3']} */ ;
    // CSS variable injection 
    // CSS variable injection end 
    /** @type {[typeof ExplorerView, typeof ExplorerView, ]} */ ;
    // @ts-ignore
    const __VLS_0 = __VLS_asFunctionalComponent(ExplorerView, new ExplorerView({
        title: "Register a Sample",
    }));
    const __VLS_1 = __VLS_0({
        title: "Register a Sample",
    }, ...__VLS_functionalComponentArgsRest(__VLS_0));
    var __VLS_3 = {};
    __VLS_2.slots.default;
    const __VLS_4 = {}.PageShell;
    /** @type {[typeof __VLS_components.PageShell, typeof __VLS_components.PageShell, ]} */ ;
    // @ts-ignore
    const __VLS_5 = __VLS_asFunctionalComponent(__VLS_4, new __VLS_4({
        narrow: true,
    }));
    const __VLS_6 = __VLS_5({
        narrow: true,
    }, ...__VLS_functionalComponentArgsRest(__VLS_5));
    __VLS_7.slots.default;
    if (__VLS_ctx.created) {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "card done" },
        });
        const __VLS_8 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
            name: "check_circle",
            ...{ class: "done-ic" },
        }));
        const __VLS_10 = __VLS_9({
            name: "check_circle",
            ...{ class: "done-ic" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_9));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h2, __VLS_intrinsicElements.h2)({});
        if (__VLS_ctx.createdHidden) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "hidden-note" },
            });
            (__VLS_ctx.CREATED_BUT_HIDDEN_MESSAGE);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "done-actions" },
            });
            const __VLS_12 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_13 = __VLS_asFunctionalComponent(__VLS_12, new __VLS_12({
                ...{ 'onClick': {} },
                secondary: true,
            }));
            const __VLS_14 = __VLS_13({
                ...{ 'onClick': {} },
                secondary: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_13));
            let __VLS_16;
            let __VLS_17;
            let __VLS_18;
            const __VLS_19 = {
                onClick: (__VLS_ctx.resetForm)
            };
            __VLS_15.slots.default;
            const __VLS_20 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
                name: "add",
                left: true,
            }));
            const __VLS_22 = __VLS_21({
                name: "add",
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_21));
            var __VLS_15;
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "code" },
            });
            (__VLS_ctx.created.code);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "done-actions" },
            });
            const __VLS_24 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
                ...{ 'onClick': {} },
            }));
            const __VLS_26 = __VLS_25({
                ...{ 'onClick': {} },
            }, ...__VLS_functionalComponentArgsRest(__VLS_25));
            let __VLS_28;
            let __VLS_29;
            let __VLS_30;
            const __VLS_31 = {
                onClick: (...[$event]) => {
                    if (!(__VLS_ctx.created))
                        return;
                    if (!!(__VLS_ctx.createdHidden))
                        return;
                    __VLS_ctx.go(__VLS_ctx.recordRoute('physical_samples', __VLS_ctx.created.id));
                }
            };
            __VLS_27.slots.default;
            const __VLS_32 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
                name: "open_in_new",
                left: true,
            }));
            const __VLS_34 = __VLS_33({
                name: "open_in_new",
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_33));
            var __VLS_27;
            const __VLS_36 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_37 = __VLS_asFunctionalComponent(__VLS_36, new __VLS_36({
                ...{ 'onClick': {} },
                secondary: true,
            }));
            const __VLS_38 = __VLS_37({
                ...{ 'onClick': {} },
                secondary: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_37));
            let __VLS_40;
            let __VLS_41;
            let __VLS_42;
            const __VLS_43 = {
                onClick: (...[$event]) => {
                    if (!(__VLS_ctx.created))
                        return;
                    if (!!(__VLS_ctx.createdHidden))
                        return;
                    __VLS_ctx.openReport(__VLS_ctx.created.id);
                }
            };
            __VLS_39.slots.default;
            const __VLS_44 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
                name: "picture_as_pdf",
                left: true,
            }));
            const __VLS_46 = __VLS_45({
                name: "picture_as_pdf",
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_45));
            var __VLS_39;
            const __VLS_48 = {}.VButton;
            /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
            // @ts-ignore
            const __VLS_49 = __VLS_asFunctionalComponent(__VLS_48, new __VLS_48({
                ...{ 'onClick': {} },
                secondary: true,
            }));
            const __VLS_50 = __VLS_49({
                ...{ 'onClick': {} },
                secondary: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_49));
            let __VLS_52;
            let __VLS_53;
            let __VLS_54;
            const __VLS_55 = {
                onClick: (__VLS_ctx.resetForm)
            };
            __VLS_51.slots.default;
            const __VLS_56 = {}.VIcon;
            /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
            // @ts-ignore
            const __VLS_57 = __VLS_asFunctionalComponent(__VLS_56, new __VLS_56({
                name: "add",
                left: true,
            }));
            const __VLS_58 = __VLS_57({
                name: "add",
                left: true,
            }, ...__VLS_functionalComponentArgsRest(__VLS_57));
            var __VLS_51;
        }
    }
    else {
        __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
            ...{ class: "intro" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
            ...{ class: "card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "step" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        const __VLS_60 = {}.VSelect;
        /** @type {[typeof __VLS_components.VSelect, typeof __VLS_components.vSelect, ]} */ ;
        // @ts-ignore
        const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
            items: (__VLS_ctx.materials),
            modelValue: (__VLS_ctx.f.material_id),
            placeholder: "Choose material…",
            showDeselect: true,
        }));
        const __VLS_62 = __VLS_61({
            items: (__VLS_ctx.materials),
            modelValue: (__VLS_ctx.f.material_id),
            placeholder: "Choose material…",
            showDeselect: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_61));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        const __VLS_64 = {}.VSelect;
        /** @type {[typeof __VLS_components.VSelect, typeof __VLS_components.vSelect, ]} */ ;
        // @ts-ignore
        const __VLS_65 = __VLS_asFunctionalComponent(__VLS_64, new __VLS_64({
            items: (__VLS_ctx.methods),
            modelValue: (__VLS_ctx.f.primary_method_id),
            placeholder: "Choose route…",
            showDeselect: true,
        }));
        const __VLS_66 = __VLS_65({
            items: (__VLS_ctx.methods),
            modelValue: (__VLS_ctx.f.primary_method_id),
            placeholder: "Choose route…",
            showDeselect: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_65));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.input)({
            type: "date",
            ...{ class: "date" },
        });
        (__VLS_ctx.f.manufactured_date);
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld code-preview" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "code-val" },
        });
        if (__VLS_ctx.codePreview) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
            (__VLS_ctx.codePreview);
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
                ...{ class: "muted" },
            });
        }
        if (__VLS_ctx.seqError) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "err" },
            });
            (__VLS_ctx.seqError);
        }
        else if (__VLS_ctx.codePreview) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "muted" },
            });
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
            ...{ class: "card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "step" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        const __VLS_68 = {}.VSelect;
        /** @type {[typeof __VLS_components.VSelect, typeof __VLS_components.vSelect, ]} */ ;
        // @ts-ignore
        const __VLS_69 = __VLS_asFunctionalComponent(__VLS_68, new __VLS_68({
            items: (__VLS_ctx.forms),
            modelValue: (__VLS_ctx.f.form),
            placeholder: "Shape…",
            showDeselect: true,
        }));
        const __VLS_70 = __VLS_69({
            items: (__VLS_ctx.forms),
            modelValue: (__VLS_ctx.f.form),
            placeholder: "Shape…",
            showDeselect: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_69));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        const __VLS_72 = {}.VInput;
        /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
        // @ts-ignore
        const __VLS_73 = __VLS_asFunctionalComponent(__VLS_72, new __VLS_72({
            type: "number",
            modelValue: (__VLS_ctx.f.mass_grams),
            placeholder: "0",
        }));
        const __VLS_74 = __VLS_73({
            type: "number",
            modelValue: (__VLS_ctx.f.mass_grams),
            placeholder: "0",
        }, ...__VLS_functionalComponentArgsRest(__VLS_73));
        if (__VLS_ctx.dimFields.length) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "dimgrid" },
            });
            for (const [k] of __VLS_getVForSourceType((__VLS_ctx.dimFields))) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                    ...{ class: "fld" },
                    key: (k),
                });
                __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
                (__VLS_ctx.flabel(k));
                const __VLS_76 = {}.VInput;
                /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
                // @ts-ignore
                const __VLS_77 = __VLS_asFunctionalComponent(__VLS_76, new __VLS_76({
                    ...{ 'onUpdate:modelValue': {} },
                    type: "number",
                    modelValue: (__VLS_ctx.f[k]),
                    placeholder: "0",
                }));
                const __VLS_78 = __VLS_77({
                    ...{ 'onUpdate:modelValue': {} },
                    type: "number",
                    modelValue: (__VLS_ctx.f[k]),
                    placeholder: "0",
                }, ...__VLS_functionalComponentArgsRest(__VLS_77));
                let __VLS_80;
                let __VLS_81;
                let __VLS_82;
                const __VLS_83 = {
                    'onUpdate:modelValue': (...[$event]) => {
                        if (!!(__VLS_ctx.created))
                            return;
                        if (!(__VLS_ctx.dimFields.length))
                            return;
                        __VLS_ctx.f[k] = $event;
                    }
                };
                var __VLS_79;
            }
        }
        if (__VLS_ctx.geoSvg) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "geo-live" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "geo-canvas" },
            });
            __VLS_asFunctionalDirective(__VLS_directives.vHtml)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.geoSvg) }, null, null);
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "geo-cap" },
            });
            (__VLS_ctx.formLabel);
            if (__VLS_ctx.geoDimsText) {
                __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
                (__VLS_ctx.geoDimsText);
            }
        }
        else {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
                ...{ class: "geo-live empty" },
            });
            __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
            ...{ class: "card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "step" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "row" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        const __VLS_84 = {}.VSelect;
        /** @type {[typeof __VLS_components.VSelect, typeof __VLS_components.vSelect, ]} */ ;
        // @ts-ignore
        const __VLS_85 = __VLS_asFunctionalComponent(__VLS_84, new __VLS_84({
            items: (__VLS_ctx.projects),
            modelValue: (__VLS_ctx.f.project_id),
            placeholder: "Project…",
            showDeselect: true,
        }));
        const __VLS_86 = __VLS_85({
            items: (__VLS_ctx.projects),
            modelValue: (__VLS_ctx.f.project_id),
            placeholder: "Project…",
            showDeselect: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_85));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        const __VLS_88 = {}.VInput;
        /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
        // @ts-ignore
        const __VLS_89 = __VLS_asFunctionalComponent(__VLS_88, new __VLS_88({
            modelValue: (__VLS_ctx.f.nickname),
            placeholder: "Optional friendly name",
        }));
        const __VLS_90 = __VLS_89({
            modelValue: (__VLS_ctx.f.nickname),
            placeholder: "Optional friendly name",
        }, ...__VLS_functionalComponentArgsRest(__VLS_89));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "fld" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.label, __VLS_intrinsicElements.label)({});
        const __VLS_92 = {}.VInput;
        /** @type {[typeof __VLS_components.VInput, typeof __VLS_components.vInput, ]} */ ;
        // @ts-ignore
        const __VLS_93 = __VLS_asFunctionalComponent(__VLS_92, new __VLS_92({
            modelValue: (__VLS_ctx.f.location),
            placeholder: "Where is it stored?",
        }));
        const __VLS_94 = __VLS_93({
            modelValue: (__VLS_ctx.f.location),
            placeholder: "Where is it stored?",
        }, ...__VLS_functionalComponentArgsRest(__VLS_93));
        __VLS_asFunctionalElement(__VLS_intrinsicElements.section, __VLS_intrinsicElements.section)({
            ...{ class: "card" },
        });
        __VLS_asFunctionalElement(__VLS_intrinsicElements.h3, __VLS_intrinsicElements.h3)({});
        __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
            ...{ class: "step" },
        });
        const __VLS_96 = {}.VTextarea;
        /** @type {[typeof __VLS_components.VTextarea, typeof __VLS_components.vTextarea, ]} */ ;
        // @ts-ignore
        const __VLS_97 = __VLS_asFunctionalComponent(__VLS_96, new __VLS_96({
            modelValue: (__VLS_ctx.f.notes),
            placeholder: "Anything worth recording…",
        }));
        const __VLS_98 = __VLS_97({
            modelValue: (__VLS_ctx.f.notes),
            placeholder: "Anything worth recording…",
        }, ...__VLS_functionalComponentArgsRest(__VLS_97));
        if (__VLS_ctx.personId === null && __VLS_ctx.adminKnown && !__VLS_ctx.isAdmin && !__VLS_ctx.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "err" },
                role: "alert",
            });
            (__VLS_ctx.NO_PERSON_MESSAGE);
        }
        if (__VLS_ctx.error) {
            __VLS_asFunctionalElement(__VLS_intrinsicElements.p, __VLS_intrinsicElements.p)({
                ...{ class: "err" },
            });
            (__VLS_ctx.error);
        }
        __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
            ...{ class: "actions" },
        });
        const __VLS_100 = {}.VButton;
        /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
        // @ts-ignore
        const __VLS_101 = __VLS_asFunctionalComponent(__VLS_100, new __VLS_100({
            ...{ 'onClick': {} },
            secondary: true,
        }));
        const __VLS_102 = __VLS_101({
            ...{ 'onClick': {} },
            secondary: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_101));
        let __VLS_104;
        let __VLS_105;
        let __VLS_106;
        const __VLS_107 = {
            onClick: (...[$event]) => {
                if (!!(__VLS_ctx.created))
                    return;
                __VLS_ctx.go('/home');
            }
        };
        __VLS_103.slots.default;
        var __VLS_103;
        const __VLS_108 = {}.VButton;
        /** @type {[typeof __VLS_components.VButton, typeof __VLS_components.vButton, typeof __VLS_components.VButton, typeof __VLS_components.vButton, ]} */ ;
        // @ts-ignore
        const __VLS_109 = __VLS_asFunctionalComponent(__VLS_108, new __VLS_108({
            ...{ 'onClick': {} },
            disabled: (!__VLS_ctx.canSubmit),
            loading: (__VLS_ctx.saving),
            large: true,
        }));
        const __VLS_110 = __VLS_109({
            ...{ 'onClick': {} },
            disabled: (!__VLS_ctx.canSubmit),
            loading: (__VLS_ctx.saving),
            large: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_109));
        let __VLS_112;
        let __VLS_113;
        let __VLS_114;
        const __VLS_115 = {
            onClick: (__VLS_ctx.submit)
        };
        __VLS_111.slots.default;
        const __VLS_116 = {}.VIcon;
        /** @type {[typeof __VLS_components.VIcon, typeof __VLS_components.vIcon, ]} */ ;
        // @ts-ignore
        const __VLS_117 = __VLS_asFunctionalComponent(__VLS_116, new __VLS_116({
            name: "add_circle",
            left: true,
        }));
        const __VLS_118 = __VLS_117({
            name: "add_circle",
            left: true,
        }, ...__VLS_functionalComponentArgsRest(__VLS_117));
        var __VLS_111;
    }
    var __VLS_7;
    var __VLS_2;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    /** @type {__VLS_StyleScopedClasses['done']} */ ;
    /** @type {__VLS_StyleScopedClasses['done-ic']} */ ;
    /** @type {__VLS_StyleScopedClasses['hidden-note']} */ ;
    /** @type {__VLS_StyleScopedClasses['done-actions']} */ ;
    /** @type {__VLS_StyleScopedClasses['code']} */ ;
    /** @type {__VLS_StyleScopedClasses['done-actions']} */ ;
    /** @type {__VLS_StyleScopedClasses['intro']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    /** @type {__VLS_StyleScopedClasses['step']} */ ;
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['date']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['code-preview']} */ ;
    /** @type {__VLS_StyleScopedClasses['code-val']} */ ;
    /** @type {__VLS_StyleScopedClasses['muted']} */ ;
    /** @type {__VLS_StyleScopedClasses['err']} */ ;
    /** @type {__VLS_StyleScopedClasses['muted']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    /** @type {__VLS_StyleScopedClasses['step']} */ ;
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['dimgrid']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-live']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-canvas']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-cap']} */ ;
    /** @type {__VLS_StyleScopedClasses['geo-live']} */ ;
    /** @type {__VLS_StyleScopedClasses['empty']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    /** @type {__VLS_StyleScopedClasses['step']} */ ;
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['fld']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    /** @type {__VLS_StyleScopedClasses['step']} */ ;
    /** @type {__VLS_StyleScopedClasses['err']} */ ;
    /** @type {__VLS_StyleScopedClasses['err']} */ ;
    /** @type {__VLS_StyleScopedClasses['actions']} */ ;
    var __VLS_dollars;
    const __VLS_self = (await import('vue')).defineComponent({
        setup() {
            return {
                ExplorerView: ExplorerView,
                CREATED_BUT_HIDDEN_MESSAGE: CREATED_BUT_HIDDEN_MESSAGE,
                NO_PERSON_MESSAGE: NO_PERSON_MESSAGE,
                PageShell: PageShell,
                recordRoute: recordRoute,
                isAdmin: isAdmin,
                adminKnown: adminKnown,
                materials: materials,
                methods: methods,
                projects: projects,
                forms: forms,
                formLabel: formLabel,
                f: f,
                seqError: seqError,
                saving: saving,
                error: error,
                created: created,
                createdHidden: createdHidden,
                personId: personId,
                dimFields: dimFields,
                geoSvg: geoSvg,
                geoDimsText: geoDimsText,
                flabel: flabel,
                codePreview: codePreview,
                canSubmit: canSubmit,
                submit: submit,
                resetForm: resetForm,
                go: go,
                openReport: openReport,
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
