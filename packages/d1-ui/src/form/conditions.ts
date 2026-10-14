// Directus field conditions (`directus_fields.conditions`), evaluated against the values of a form.
//
// A condition is `{ name, rule, hidden?, readonly?, required?, options? }`: when its `rule` (a Directus filter on
// sibling fields of the same record) matches the current values, the field is hidden, read-only or required
// as the condition says. Data Studio applies the LAST matching condition, so a field with a base rule
// and a more specific one behaves like a cascade; this does the same. Pure: no Vue, no host.
//
// Supported operators: _eq _neq _in _nin _null _nnull _empty _nempty _gt _gte _lt _lte _between _nbetween
// _contains _ncontains _icontains _starts_with _ends_with, and _and / _or around them. A leaf that names
// a nested object (`{ a: { b: { _eq: 1 } } }`) reads values.a.b. A rule this cannot read (an unknown
// operator, a dynamic variable such as $CURRENT_USER) does not match, so the field keeps its base state.

export type Values = Record<string, unknown>;

export interface FieldCondition {
	name?: string;
	rule?: unknown;
	hidden?: boolean;
	readonly?: boolean;
	required?: boolean;
	options?: Record<string, unknown> | null;
}

/** What a field is, before conditions. */
export interface FieldState {
	hidden: boolean;
	readonly: boolean;
	required: boolean;
}

export interface EvalOptions {
	/**
	 * How a field the values do not have is read. Default `'null'`: as null, so `_empty` and `_neq` can match
	 * a blank form. `'fail'` is Data Studio's own `requireAll`: a leaf on an absent field never matches.
	 */
	absent?: 'null' | 'fail';
}

const MISSING = Symbol('missing');

function read(values: unknown, path: string[]): unknown {
	let cur: unknown = values;
	for (const key of path) {
		if (cur === null || cur === undefined || typeof cur !== 'object' || !(key in (cur as object))) return MISSING;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

const isBlank = (v: unknown): boolean => v === null || v === undefined;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const off = (arg: unknown): boolean => arg === false || arg === 'false';

function isEmpty(v: unknown): boolean {
	if (isBlank(v) || v === '') return true;
	if (Array.isArray(v)) return v.length === 0;
	if (typeof v === 'object') return Object.keys(v as object).length === 0;
	return false;
}

function numeric(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	return null;
}

// Equality as Directus filters have it: 5 and "5" are the same key, and NUMERIC columns arrive as strings.
function same(a: unknown, b: unknown): boolean {
	if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
	const na = numeric(a);
	const nb = numeric(b);
	if (typeof a !== 'boolean' && typeof b !== 'boolean' && na !== null && nb !== null) return na === nb;
	return String(a) === String(b);
}

// Ordering: numbers when both read as numbers, else text (ISO dates sort as text). null when either is blank.
function compare(a: unknown, b: unknown): number | null {
	if (isBlank(a) || isBlank(b)) return null;
	const na = numeric(a);
	const nb = numeric(b);
	if (na !== null && nb !== null) return na - nb;
	return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()) : isBlank(v) ? [] : [v]);

function operator(op: string, actual: unknown, arg: unknown): boolean {
	switch (op) {
		case '_eq': return same(actual, arg);
		case '_neq': return !same(actual, arg);
		case '_in': return list(arg).some((x) => same(actual, x));
		case '_nin': return !list(arg).some((x) => same(actual, x));
		case '_null': return off(arg) ? !isBlank(actual) : isBlank(actual);
		case '_nnull': return off(arg) ? isBlank(actual) : !isBlank(actual);
		case '_empty': return off(arg) ? !isEmpty(actual) : isEmpty(actual);
		case '_nempty': return off(arg) ? isEmpty(actual) : !isEmpty(actual);
		case '_gt': { const c = compare(actual, arg); return c !== null && c > 0; }
		case '_gte': { const c = compare(actual, arg); return c !== null && c >= 0; }
		case '_lt': { const c = compare(actual, arg); return c !== null && c < 0; }
		case '_lte': { const c = compare(actual, arg); return c !== null && c <= 0; }
		case '_between':
		case '_nbetween': {
			const [lo, hi] = list(arg);
			const a = compare(actual, lo);
			const b = compare(actual, hi);
			const inside = a !== null && b !== null && a >= 0 && b <= 0;
			return op === '_between' ? inside : !inside;
		}
		case '_contains': return !isBlank(actual) && String(actual).includes(String(arg));
		case '_ncontains': return isBlank(actual) || !String(actual).includes(String(arg));
		case '_icontains': return !isBlank(actual) && String(actual).toLowerCase().includes(String(arg).toLowerCase());
		case '_starts_with': return !isBlank(actual) && String(actual).startsWith(String(arg));
		case '_ends_with': return !isBlank(actual) && String(actual).endsWith(String(arg));
		default: return false; // an operator this does not know never matches
	}
}

// `path` is the field a bare operator applies to: [] at the top, ['a', 'b'] inside `{ a: { b: {...} } }`.
function evalNode(node: unknown, values: Values, path: string[], opts: EvalOptions): boolean {
	if (!isObject(node)) return false;
	const entries = Object.entries(node);
	if (!entries.length) return false;
	return entries.every(([key, arg]) => {
		if (key === '_and') return Array.isArray(arg) && arg.every((r) => evalNode(r, values, path, opts));
		if (key === '_or') return Array.isArray(arg) && arg.some((r) => evalNode(r, values, path, opts));
		if (key.startsWith('_')) {
			if (!path.length) return false; // an operator with no field to apply to
			let actual = read(values, path);
			if (actual === MISSING) {
				if (opts.absent === 'fail') return false;
				actual = null;
			}
			return operator(key, actual, arg);
		}
		return evalNode(arg, values, [...path, key], opts);
	});
}

/** True when the Directus filter `rule` holds for `values`. An empty or unreadable rule never matches. */
export function matchesRule(rule: unknown, values: Values, opts: EvalOptions = {}): boolean {
	return evalNode(rule, values, [], opts);
}

export interface AppliedConditions extends FieldState {
	/** Interface options the matching condition changed, or null when they stay as the field has them. */
	options: Record<string, unknown> | null;
	/** The `name` of the condition that applied, when one did. */
	by: string | null;
}

/**
 * The state of a field for `values`: its base state, overridden by the last matching condition. Only the
 * flags a condition spells out are taken; one that says just `hidden: true` leaves `required` as the field has it.
 */
export function applyConditions(
	base: FieldState,
	conditions: readonly FieldCondition[] | null | undefined,
	values: Values,
	opts: EvalOptions = {},
): AppliedConditions {
	const out: AppliedConditions = { ...base, options: null, by: null };
	if (!conditions?.length) return out;
	for (let i = conditions.length - 1; i >= 0; i--) {
		const c = conditions[i];
		if (!c || !matchesRule(c.rule, values, opts)) continue;
		if (typeof c.hidden === 'boolean') out.hidden = c.hidden;
		if (typeof c.readonly === 'boolean') out.readonly = c.readonly;
		if (typeof c.required === 'boolean') out.required = c.required;
		out.options = isObject(c.options) ? c.options : null;
		out.by = c.name ?? null;
		break;
	}
	return out;
}
