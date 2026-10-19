import type { InjectionKey, Ref } from 'vue';

/**
 * What the form says in place of "Open in Data Studio" on a field it cannot draw, when there is no record to open yet (a new item of a
 * draft): the page that owns the form says when it will open. FieldForm provides it; FieldInput reads it. Null: the link is a button.
 */
export const EXTERNAL_HINT: InjectionKey<Ref<string | null>> = Symbol('externalHint');
