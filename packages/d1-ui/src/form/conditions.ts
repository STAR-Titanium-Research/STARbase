// Directus field conditions (`directus_fields.conditions`), evaluated against the values of a form.
//
// A condition is `{ name, rule, hidden?, readonly?, required?, options? }`: when its `rule` (a Directus filter on
// sibling fields of the same record) matches the current values, the field is hidden, read-only or required
// as the condition says. Data Studio applies the LAST matching condition, so a field with a base rule
// and a more specific one behaves like a cascade; this does the same. Pure: no Vue, no host.
//
// The operators follow Data Studio's own evaluation (`validatePayload` of `@directus/utils`, Joi underneath), quirks
// included, so a form here shows what Data Studio would show:
//   _eq / _neq   strict equality; a number argument also matches its text form and a numeric text its number
//                ("5" matches 5, "5.0" does not match 5). null never matches a value, a null value matches _neq.
//   _in / _nin   strict, the argument must be a list.
//   _null / _nnull   the argument is ignored: `_null: false` still means null. (Not "null or undefined".)
//   _empty / _nempty   EMPTY IS THE EMPTY STRING ONLY: null, [] and {} are not empty, null matches _nempty.
//   _gt _gte _lt _lte _between _nbetween   numbers when the argument is numeric, else dates (any text Date.parse reads). (_nbetween is "outside",
//                as meant: Data Studio's own chains less() and greater() the wrong way round and can never match.)
//   _contains _ncontains _icontains _starts_with _ends_with (and the n / i variants)   text, a list for the contains
//                family; a blank value never matches, not even the negative forms.
//   _and / _or   around the above. A leaf naming a nested object (`{ a: { b: { _eq: 1 } } }`) reads values.a.b.
// A text argument starting with `$` is a dynamic variable. `$CURRENT_USER` and `$NOW` are resolved from the optional
// `context`; any other, or one with no context to resolve it from, never matches. So does an unknown operator: the
// field then keeps its base state.

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

/** What dynamic variables in a rule resolve to. */
export interface RuleContext {
	/** `$CURRENT_USER`: the signed-in user's id. */
	userId?: string | null;
	/** `$NOW`: the current time. */
	now?: Date | string | number;
}

export interface EvalOptions {
	/**
	 * How a field the values do not have is read. Default `'null'`: as null, the way a new Data Studio form holds every
	 * field it has no value for. `'fail'` is Data Studio's own `requireAll`: a leaf on an absent field never matches.
	 */
	absent?: 'null' | 'fail';
	context?: RuleContext;
}

const MISSING = Symbol('missing');
const NO_MATCH = Symbol('no-match');

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

// A dynamic variable resolved from the context, or NO_MATCH when it cannot be.
function variable(text: string, ctx: RuleContext | undefined): unknown {
	if (text === '$CURRENT_USER' && ctx?.userId) return ctx.userId;
	if (text === '$NOW' && ctx?.now !== undefined) return ctx.now instanceof Date ? ctx.now.toISOString() : ctx.now;
	return NO_MATCH;
}

// The argument of an operator with its variables resolved (also inside a list); NO_MATCH when one cannot be.
function resolveArg(arg: unknown, ctx: RuleContext | undefined): unknown {
	if (typeof arg === 'string' && arg.startsWith('$')) return variable(arg, ctx);
	if (Array.isArray(arg)) {
		const out: unknown[] = [];
		for (const x of arg) {
			const r = resolveArg(x, ctx);
			if (r === NO_MATCH) return NO_MATCH;
			out.push(r);
		}
		return out;
	}
	return arg;
}

function numeric(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	return null;
}

// Milliseconds of a date-like value: a Date, a timestamp, numeric text as a timestamp, else the text as a date.
function time(v: unknown): number | null {
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v !== 'string' || v.trim() === '') return null;
	const n = numeric(v);
	if (n !== null) return n;
	const t = Date.parse(v);
	return Number.isNaN(t) ? null : t;
}

// What _eq and _neq compare with: the argument, and its other form (a number as text, numeric text as a number).
function candidates(arg: unknown): unknown[] {
	if (typeof arg === 'number') return [arg, String(arg)];
	if ([null, '', true, false].includes(arg as never)) return [arg];
	const n = Number(arg);
	return Number.isNaN(n) ? [arg] : [arg, n];
}
const strictlyIn = (actual: unknown, list: readonly unknown[]): boolean => list.some((x) => x === actual);

// Ordering against `arg`: numbers when the argument is numeric, else dates. null when the value cannot be compared.
function order(actual: unknown, arg: unknown): number | null {
	if (arg instanceof Date || numeric(arg) === null) {
		const a = time(actual);
		const b = time(arg);
		return a === null || b === null ? null : a - b;
	}
	const a = numeric(actual);
	return a === null ? null : a - (numeric(arg) as number);
}

// Inside [lo, hi]; null when the argument is not a pair or the value cannot be compared with it.
function between(actual: unknown, arg: unknown): boolean | null {
	if (!Array.isArray(arg) || arg.length < 2) return null;
	const lo = order(actual, arg[0]);
	const hi = order(actual, arg[1]);
	return lo === null || hi === null ? null : lo >= 0 && hi <= 0;
}

// The text operators: a blank value (and the empty string) never matches; a list matches the contains family by its items.
function textOperator(op: string, actual: unknown, arg: unknown): boolean {
	if (typeof arg !== 'string') return false;
	const contains = (s: string, ci: boolean) => (ci ? s.toLowerCase().includes(arg.toLowerCase()) : s.includes(arg));
	const starts = (s: string, ci: boolean) => (ci ? s.toLowerCase().startsWith(arg.toLowerCase()) : s.startsWith(arg));
	const ends = (s: string, ci: boolean) => (ci ? s.toLowerCase().endsWith(arg.toLowerCase()) : s.endsWith(arg));
	const ci = op.includes('icontains') || op.startsWith('_i') || op.startsWith('_ni');
	const fn = op.includes('contains') ? contains : op.includes('starts_with') ? starts : ends;
	const negative = op.startsWith('_n');
	const test = (s: string) => fn(s, ci) !== negative;
	if (Array.isArray(actual) && op.includes('contains')) {
		return negative ? actual.every((x) => typeof x === 'string' && !fn(x, ci)) : actual.some((x) => typeof x === 'string' && fn(x, ci));
	}
	return typeof actual === 'string' && actual !== '' && test(actual);
}

const TEXT_OPS = new Set([
	'_contains', '_ncontains', '_icontains',
	'_starts_with', '_nstarts_with', '_istarts_with', '_nistarts_with',
	'_ends_with', '_nends_with', '_iends_with', '_niends_with',
]);

function operator(op: string, actual: unknown, arg: unknown): boolean {
	switch (op) {
		case '_eq': return strictlyIn(actual, candidates(arg));
		case '_neq': return !strictlyIn(actual, candidates(arg));
		case '_in': return Array.isArray(arg) && strictlyIn(actual, arg);
		case '_nin': return Array.isArray(arg) && !strictlyIn(actual, arg);
		case '_null': return isBlank(actual);
		case '_nnull': return !isBlank(actual);
		case '_empty': return actual === '';
		case '_nempty': return actual !== '';
		case '_gt': { const c = order(actual, arg); return c !== null && c > 0; }
		case '_gte': { const c = order(actual, arg); return c !== null && c >= 0; }
		case '_lt': { const c = order(actual, arg); return c !== null && c < 0; }
		case '_lte': { const c = order(actual, arg); return c !== null && c <= 0; }
		case '_between': return between(actual, arg) === true;
		case '_nbetween': return between(actual, arg) === false;
		default: return TEXT_OPS.has(op) && textOperator(op, actual, arg);
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
			const resolved = resolveArg(arg, opts.context);
			if (resolved === NO_MATCH) return false;
			let actual = read(values, path);
			if (actual === MISSING) {
				if (opts.absent === 'fail') return false;
				actual = null;
			}
			return operator(key, actual, resolved);
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
