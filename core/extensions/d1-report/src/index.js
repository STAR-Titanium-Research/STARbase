// Directus endpoint: d1-report (mounted at /d1-report)
//
// GET /d1-report/label?ids=<uuid,...>[&codes=<sample code,...>][&layout=a4-21|single-50x25][&start=n]
//   -> print-ready sample labels (code, QR to the record, material, date, owner initials).
// GET /d1-report/labels -> the picker page behind "Print labels" (paste codes / tick samples).
//
// GET /d1-report/sample/:id  -> a print-ready (A4, ≤2 page) HTML "Sample Overview"
// document assembling the sample's details, genealogy (parents AND children),
// manufacturing operations and tests, with a locally-generated QR code linking to
// the record. Everything renders server-side and offline — no external services.
//
// :id may be the sample UUID or the human sample_code. Requires a logged-in user, and
// every read goes through Directus's ItemsService with the CALLER's accountability
// (see access.js): a row the caller cannot read answers exactly like a missing one.
import { defineEndpoint } from '@directus/extensions-sdk';
import QRCode from 'qrcode';
import { adminRecordUrl, renderSampleReport, renderOperationReport, renderTestReport } from './render.js';
import { createAccess } from './access.js';
import {
	LABEL_JS,
	MAX_LABELS,
	capError,
	initials,
	labelDate,
	orderRows,
	parseSelection,
	parseStart,
	renderLabelPicker,
	renderLabelSheet,
	resolveLayout,
	sampleRecordUrl,
} from './label.js';

// Report pages are our own self-contained HTML. Directus's global CSP blocks inline
// scripts/handlers, so we (a) serve the toggle/print JS as a same-origin file and
// reference it (allowed by script-src 'self') and (b) set a scoped CSP on report
// responses that permits same-origin scripts and inline styles.
const REPORT_CSP =
	"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:";

const REPORT_JS = `(function () {
	var params = new URLSearchParams(location.search);
	document.querySelectorAll('.toolbar input[data-block]').forEach(function (cb) {
		var name = cb.getAttribute('data-block');
		if (params.get(name) === '0' || params.get(name) === 'false') cb.checked = false;
		toggle(name, cb.checked);
		cb.addEventListener('change', function () { toggle(name, cb.checked); updateColumnLayout(); schedulePaginate(); });
	});
	function toggle(name, on) {
		document.querySelectorAll('[data-block="' + name + '"]').forEach(function (el) {
			if (el.tagName === 'INPUT') return; // the checkbox itself carries data-block too — never hide it
			el.style.display = on ? '' : 'none';
		});
	}
	var pb = document.getElementById('printBtn'); if (pb) pb.addEventListener('click', function () { window.print(); });

	// "Plots ▾" dropdown: open/close on click, close on an outside click.
	var menu = document.querySelector('.fa-menu'), menuBtn = document.getElementById('faMenuBtn');
	if (menu && menuBtn) {
		menuBtn.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('open'); });
		document.addEventListener('click', function (e) { if (!menu.contains(e.target)) menu.classList.remove('open'); });
	}

	// If every Force (or every FFT) plot in the "Force Analysis" appendix is
	// hidden, let the remaining side fill the row instead of leaving a blank half.
	function updateColumnLayout() {
		var rows = document.getElementById('faRows');
		if (!rows) return;
		var anyForce = Array.prototype.some.call(rows.querySelectorAll('[data-block^="force-"]'), function (el) { return el.style.display !== 'none'; });
		var anyFft = Array.prototype.some.call(rows.querySelectorAll('[data-block^="fft-"]'), function (el) { return el.style.display !== 'none'; });
		rows.classList.toggle('all-force-hidden', !anyForce);
		rows.classList.toggle('all-fft-hidden', !anyFft);
	}
	updateColumnLayout();

	// Real pagination preview: measure actual rendered block heights and insert a
	// visible "page-gap" spacer immediately before whichever block would actually
	// overflow onto the next printed page — so what you see on screen matches what
	// "Save as PDF" produces, instead of a static line that can drift out of sync.
	var paginateTimer = null;
	function schedulePaginate() { if (paginateTimer) clearTimeout(paginateTimer); paginateTimer = setTimeout(paginate, 120); }
	function paginate() {
		var doc = document.querySelector('.doc');
		if (!doc) return;
		Array.prototype.forEach.call(doc.querySelectorAll('.page-gap'), function (el) { el.remove(); });

		var rect = doc.getBoundingClientRect();
		var mmPx = rect.width / 210; // .doc width is fixed at 210mm (A4)
		var cs = getComputedStyle(doc);
		var padTop = parseFloat(cs.paddingTop) || 16 * mmPx;
		var padBottom = parseFloat(cs.paddingBottom) || padTop;
		var pageContentPx = 297 * mmPx - padTop - padBottom;
		if (!(pageContentPx > 0)) return;

		var units = Array.prototype.slice.call(doc.querySelectorAll('.hd, .grid, .fa-row, .frm-fig, .notes, h2, footer.foot, .tl-item'));
		units = units.filter(function (el) {
			var st = getComputedStyle(el);
			if (st.display === 'none') return false;
			for (var p = el.parentElement; p && p !== doc; p = p.parentElement) { if (units.indexOf(p) !== -1) return false; }
			return true;
		});
		if (!units.length) return;

		var used = 0;
		units.forEach(function (el) {
			var h = el.getBoundingClientRect().height;
			var mb = parseFloat(getComputedStyle(el).marginBottom) || 0;
			if (used > 0 && used + h > pageContentPx) {
				var gap = document.createElement('div');
				gap.className = 'page-gap';
				gap.style.height = Math.max(4, pageContentPx - used) + 'px';
				el.parentNode.insertBefore(gap, el);
				used = 0;
			}
			used += h + mb;
		});
	}
	// FAST sintering trace plots: fetch the normalised CSV same-origin, parse, and
	// draw one small multi-line SVG per plot group (temperature / force+power /
	// pressure). Column i+1 of the CSV corresponds to catalog[i].
	function fmtNum(v) { var a = Math.abs(v); if (a === 0) return '0'; if (a >= 1000) return (v / 1000).toFixed(1) + 'k'; if (a >= 100) return v.toFixed(0); if (a >= 10) return v.toFixed(1); if (a >= 1) return v.toFixed(2); return v.toFixed(3); }
	var NS = 'http://www.w3.org/2000/svg';
	function el(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
	function buildPlot(p, time, data, meta, COLORS) {
		var W = 300, H = 148, ML = 36, MR = 6, MT = 8, MB = 15;
		var t0 = time[0], t1 = time[time.length - 1] || 1;
		var lo = Infinity, hi = -Infinity;
		p.keys.forEach(function (k) { var a = data[k]; if (!a) return; for (var i = 0; i < a.length; i++) { var v = a[i]; if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } } });
		if (!isFinite(lo)) { lo = 0; hi = 1; } if (lo === hi) { lo -= 1; hi += 1; }
		var plotW = W - ML - MR, plotH = H - MT - MB;
		var sx = function (x) { return ML + (x - t0) / (t1 - t0) * plotW; };
		var sy = function (v) { return MT + (1 - (v - lo) / (hi - lo)) * plotH; };
		var stride = Math.max(1, Math.floor(time.length / 400));
		var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
		function ln(a, b, c, d, s) { svg.appendChild(el('line', { x1: a, y1: b, x2: c, y2: d, stroke: s, 'stroke-width': '0.7' })); }
		ln(ML, MT, ML, H - MB, '#94a3b8'); ln(ML, H - MB, W - MR, H - MB, '#94a3b8');
		[hi, (lo + hi) / 2, lo].forEach(function (v) { var tx = el('text', { x: ML - 3, y: sy(v) + 2, 'text-anchor': 'end', 'class': 'fp-tick' }); tx.textContent = fmtNum(v); svg.appendChild(tx); });
		[[t0, ML, 'start'], [t1, W - MR, 'end']].forEach(function (a) { var tx = el('text', { x: a[1], y: H - 3, 'text-anchor': a[2], 'class': 'fp-tick' }); tx.textContent = fmtNum(a[0]) + 's'; svg.appendChild(tx); });
		var ci = 0;
		p.keys.forEach(function (k) {
			var a = data[k]; if (!a) return; var col = COLORS[ci++ % COLORS.length]; var d = '', pen = false;
			for (var i = 0; i < a.length; i += stride) { var v = a[i]; if (!isFinite(v)) { pen = false; continue; } var X = sx(time[i]).toFixed(1), Y = sy(v).toFixed(1); d += (pen ? 'L' : 'M') + X + ',' + Y + ' '; pen = true; }
			svg.appendChild(el('path', { d: d, fill: 'none', stroke: col, 'stroke-width': '1' }));
		});
		var wrap = document.createElement('div'); wrap.className = 'fp-plot';
		var title = document.createElement('div'); title.className = 'fp-title'; title.textContent = p.title; wrap.appendChild(title);
		wrap.appendChild(svg);
		var leg = document.createElement('div'); leg.className = 'fp-legend'; ci = 0;
		p.keys.forEach(function (k) { var m = meta[k]; if (!m) return; var col = COLORS[ci++ % COLORS.length]; var s = document.createElement('span'); var ic = document.createElement('i'); ic.style.background = col; s.appendChild(ic); s.appendChild(document.createTextNode(m.label + (m.unit ? ' ' + m.unit : ''))); leg.appendChild(s); });
		wrap.appendChild(leg);
		return wrap;
	}
	function drawFast() {
		var host = document.querySelector('.fast-plots[data-file]');
		if (!host) return;
		var file = host.getAttribute('data-file');
		var catalog, plots;
		try { catalog = JSON.parse(host.getAttribute('data-catalog') || '[]'); plots = JSON.parse(host.getAttribute('data-plots') || '[]'); } catch (e) { return; }
		var COLORS = ['#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
		fetch('/assets/' + file, { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (csv) {
			var lines = csv.split('\\n');
			var keyCol = {}; for (var i = 0; i < catalog.length; i++) keyCol[catalog[i].key] = i + 1;
			var need = {}; plots.forEach(function (p) { p.keys.forEach(function (k) { if (keyCol[k] != null) need[k] = keyCol[k]; }); });
			var time = [], data = {}; Object.keys(need).forEach(function (k) { data[k] = []; });
			for (var r2 = 1; r2 < lines.length; r2++) { if (!lines[r2]) continue; var cells = lines[r2].split(','); time.push(+cells[0]); Object.keys(need).forEach(function (k) { var v = cells[need[k]]; data[k].push(v === '' || v === undefined ? NaN : +v); }); }
			host.innerHTML = '';
			var meta = {}; catalog.forEach(function (c) { meta[c.key] = c; });
			plots.forEach(function (p) { host.appendChild(buildPlot(p, time, data, meta, COLORS)); });
			schedulePaginate();
		}).catch(function () { host.innerHTML = '<div class="fp-msg">Trace unavailable.</div>'; });
	}

	if (document.readyState === 'complete') { schedulePaginate(); drawFast(); }
	else window.addEventListener('load', function () { schedulePaginate(); drawFast(); });
	window.addEventListener('resize', schedulePaginate);
})();`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default defineEndpoint({
	id: 'd1-report',
	handler: (router, { database, env, logger, services, getSchema }) => {
		const { ItemsService } = services;

		// Reads for one request, through the CALLER's accountability so their own
		// permissions apply (see access.js). `database` (root knex) is used below only
		// for the flat v_* views, and only after the caller has been shown to be
		// allowed to read the base row — and then only for ids they may read.
		const accessFor = async (req) =>
			createAccess({
				ItemsService,
				accountability: req.accountability,
				schema: req.schema ?? (await getSchema()),
			});

		// Same body whether the row is missing or the caller may not read it, so the
		// endpoints cannot be used to probe which sample codes / ids exist.
		// Plain-text error body: never HTML, so nothing a caller put in the query can render.
		const plain = (res, status, text) => res.status(status).type('text/plain').send(text);
		const notFound = (res, what) => plain(res, 404, `${what} not found.`);

		// Same-origin toggle/print script (keeps us within Directus's script-src 'self').
		router.get('/report.js', (_req, res) => {
			res.set('Content-Type', 'application/javascript; charset=utf-8').send(REPORT_JS);
		});

		// Sample labels. Same auth model as the reports: a signed-in user, and every row is
		// read through ItemsService with the CALLER's accountability, so a sample they cannot
		// read simply gets no label. The QR encodes the record's admin URL: scanning it
		// opens the Directus app, which asks for sign-in; nothing public is exposed.
		router.get('/label.js', (_req, res) => {
			res.set('Content-Type', 'application/javascript; charset=utf-8').send(LABEL_JS);
		});

		router.get('/label', async (req, res) => {
			if (!req.accountability?.user) return plain(res, 401, 'Authentication required.');

			const sel = parseSelection(req.query);
			if (sel.error) return plain(res, 400, sel.error);
			const lay = resolveLayout(req.query.layout);
			if (!lay) return plain(res, 400, 'Unknown layout. Use a4-21 or single-50x25.');
			const start = parseStart(req.query.start, lay.layout);
			if (start.error) return plain(res, 400, start.error);

			try {
				const a = await accessFor(req);
				const clauses = [];
				if (sel.ids.length) clauses.push({ sample_id: { _in: sel.ids } });
				if (sel.codes.length) clauses.push({ sample_code: { _in: sel.codes } });
				const rows = orderRows(
					await a.list('physical_samples', clauses.length === 1 ? clauses[0] : { _or: clauses }),
					sel
				);
				// Distinct samples, after codes resolved to ids (a code may repeat an id).
				if (capError(rows)) return plain(res, 400, capError(rows));
				// Same body whether the samples are missing or not permitted.
				if (!rows.length) return notFound(res, 'Sample');

				// Material and owner are shown only when the caller can read those collections.
				const related = (collection, pk, key) => {
					const ids = [...new Set(rows.map((r) => r[key]).filter(Boolean))];
					return ids.length ? a.list(collection, { [pk]: { _in: ids } }) : [];
				};
				const [materials, people] = await Promise.all([
					related('materials', 'material_id', 'material_id'),
					related('people', 'person_id', 'owner_person_id'),
				]);
				const matById = new Map(materials.map((m) => [String(m.material_id), m]));
				const personById = new Map(people.map((p) => [String(p.person_id), p]));

				const haveIds = new Set(rows.map((r) => String(r.sample_id).toLowerCase()));
				const haveCodes = new Set(rows.map((r) => String(r.sample_code)));
				const missing = sel.ids.some((i) => !haveIds.has(i)) || sel.codes.some((c) => !haveCodes.has(c));

				const labels = await Promise.all(
					rows.map(async (r) => {
						const m = matById.get(String(r.material_id));
						return {
							code: r.sample_code,
							material: m ? m.common_name || m.alloy_code : '',
							date: labelDate(r.manufactured_date, r.created_at),
							owner: initials(personById.get(String(r.owner_person_id))?.full_name),
							qrSvg: await QRCode.toString(sampleRecordUrl(env.PUBLIC_URL, r.sample_id), {
								type: 'svg',
								margin: 1,
								errorCorrectionLevel: lay.layout.style.qrEcc,
							}),
						};
					})
				);

				res.set('Content-Security-Policy', REPORT_CSP);
				res.set('Content-Type', 'text/html; charset=utf-8').send(
					renderLabelSheet({
						labels,
						layoutKey: lay.key,
						skip: start.skip,
						query: req.query,
						notice: missing ? 'Some samples were not found or you may not read them; they have no label.' : '',
					})
				);
			} catch (err) {
				logger.error(`d1-report label failed: ${err.stack || err.message}`);
				plain(res, 500, 'Label generation failed.');
			}
		});

		router.get('/labels', async (req, res) => {
			if (!req.accountability?.user) return plain(res, 401, 'Authentication required.');
			const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '';
			try {
				const a = await accessFor(req);
				const filter = q ? { sample_code: { _icontains: q } } : {};
				const [rows, total] = await Promise.all([
					a.list('physical_samples', filter, ['sample_id', 'sample_code'], ['-created_at'], MAX_LABELS),
					a.count('physical_samples', filter),
				]);
				res.set('Content-Security-Policy', REPORT_CSP);
				res.set('Content-Type', 'text/html; charset=utf-8').send(renderLabelPicker({ rows, q, total }));
			} catch (err) {
				logger.error(`d1-report label picker failed: ${err.stack || err.message}`);
				plain(res, 500, 'Could not list samples.');
			}
		});

		router.get('/sample/:id', async (req, res) => {
			if (!req.accountability?.user) {
				return res.status(401).send('Authentication required.');
			}

			const id = String(req.params.id);
			const isUuid = UUID_RE.test(id);

			try {
				const a = await accessFor(req);

				// Gate: the caller must be able to read this physical_samples row.
				const base = await a.first(
					'physical_samples',
					isUuid ? { sample_id: { _eq: id } } : { sample_code: { _eq: id } },
					['sample_id']
				);
				if (!base) return notFound(res, 'Sample');
				const sid = base.sample_id;

				const sample = await database('v_complete_sample_history').where({ sample_id: sid }).first();
				if (!sample) return notFound(res, 'Sample');

				// physical_samples carries a few fields the flat view omits (read through
				// ItemsService, so field-level restrictions apply to these).
				const ps = (await a.one('physical_samples', sid)) || {};

				// Ensure the geometry drawing has every dimension (the flat view omits some).
				for (const k of ['form', 'diameter_mm', 'length_mm', 'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm']) {
					if (ps[k] !== null && ps[k] !== undefined) sample[k] = ps[k];
				}

				// The owner's name/email come from `people`: shown only to callers who can read it.
				const ownerRow = await a.one('people', ps.owner_person_id);
				const owner = ownerRow ? { full_name: ownerRow.full_name, email: ownerRow.email } : null;

				// Operations and tests: ask Directus which ones this caller may read, then
				// fetch the view rows for exactly those ids.
				const [opRows, testRows] = await Promise.all([
					a.list('manufacturing_operations', { sample_id: { _eq: sid } }, ['operation_id', 'campaign_id', 'project_id']),
					a.list('test_sessions', { sample_id: { _eq: sid } }, ['session_id', 'campaign_id', 'project_id']),
				]);
				const opIds = opRows.map((r) => r.operation_id);
				const testIds = testRows.map((r) => r.session_id);

				// Lineage needs the genealogy collection and each linked sample to be readable.
				const lineageAllowed = await a.canRead('sample_genealogy');

				const [ops, parentRows, childRows, tests] = await Promise.all([
					opIds.length
						? database('v_manufacturing_operations_full')
								.whereIn('operation_id', opIds)
								.orderBy(['operation_date', 'operation_sequence'])
						: [],
					lineageAllowed ? database('v_sample_genealogy_flat').where('child_sample_id', sid) : [],
					// Children joined to physical_samples for their creation date (timeline).
					lineageAllowed
						? database('v_sample_genealogy_flat as g')
								.join('physical_samples as ps', 'g.child_sample_id', 'ps.sample_id')
								.where('g.parent_sample_id', sid)
								.orderBy('ps.created_at')
								.select(
									'g.child_sample_id',
									'g.child_sample_code',
									'g.relationship_type',
									'g.fraction',
									'ps.created_at as child_created',
									'ps.form as child_form'
								)
						: [],
					testIds.length ? database('v_test_sessions_full').whereIn('session_id', testIds).orderBy('session_date') : [],
				]);

				const [readableParents, readableChildren] = await Promise.all([
					a.readableIds('physical_samples', 'sample_id', parentRows.map((p) => p.parent_sample_id)),
					a.readableIds('physical_samples', 'sample_id', childRows.map((c) => c.child_sample_id)),
				]);
				const parents = parentRows.filter((p) => readableParents.has(String(p.parent_sample_id)));
				const children = childRows.filter((c) => readableChildren.has(String(c.child_sample_id)));

				// Campaign per operation / test (the views expose project, not campaign).
				// Campaign names are shown only if the caller can read `campaigns`.
				const campaignIds = [...opRows, ...testRows].map((r) => r.campaign_id);
				const campaigns = campaignIds.some((v) => v)
					? await a.list('campaigns', { campaign_id: { _in: [...new Set(campaignIds.filter(Boolean))] } }, ['campaign_id', 'campaign_code', 'name'])
					: [];
				const campById = Object.fromEntries(campaigns.map((c) => [String(c.campaign_id), c]));
				const withCampaign = (rows, srcRows, key) => {
					const campOf = Object.fromEntries(srcRows.map((r) => [String(r[key]), campById[String(r.campaign_id)]]));
					rows.forEach((row) => {
						const c = campOf[String(row[key])];
						row.campaign_code = c?.campaign_code;
						row.campaign_name = c?.name;
					});
				};
				withCampaign(ops, opRows, 'operation_id');
				withCampaign(tests, testRows, 'session_id');

				// The v_* views are read with the root handle, so they carry the code, name and document
				// number of a project the caller may not read (ADR-0011: a record can be visible
				// through its sample or campaign while its project is not). Show a project only when the
				// caller can read it, the same rule the operation and test reports apply with a.one().
				const readableProjects = await a.readableIds(
					'projects',
					'project_id',
					[ps.project_id, ...opRows.map((r) => r.project_id), ...testRows.map((r) => r.project_id)]
				);
				const blankProject = (row, projectId) => {
					if (projectId && readableProjects.has(String(projectId))) return;
					for (const k of ['project_code', 'project_name', 'project_document_number']) if (k in row) row[k] = null;
				};
				const projectOf = (srcRows, key) => Object.fromEntries(srcRows.map((r) => [String(r[key]), r.project_id]));
				blankProject(sample, ps.project_id);
				const opProject = projectOf(opRows, 'operation_id');
				ops.forEach((row) => blankProject(row, opProject[String(row.operation_id)]));
				const testProject = projectOf(testRows, 'session_id');
				tests.forEach((row) => blankProject(row, testProject[String(row.session_id)]));

				const publicUrl = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
				const recordUrl = adminRecordUrl(publicUrl, 'physical_samples', sid);
				const qrSvg = await QRCode.toString(recordUrl, {
					type: 'svg',
					margin: 0,
					errorCorrectionLevel: 'M',
				});

				const html = renderSampleReport({
					sample,
					owner,
					nickname: ps.nickname,
					location: ps.location,
					surfaceFinish: ps.surface_finish,
					ops,
					parents,
					children,
					tests,
					qrSvg,
					recordUrl,
				});
				res.set('Content-Security-Policy', REPORT_CSP);
				res.set('Content-Type', 'text/html; charset=utf-8').send(html);
			} catch (err) {
				logger.error(`d1-report failed for ${id}: ${err.stack || err.message}`);
				res.status(500).send('Report generation failed.');
			}
		});

		// GET /d1-report/operation/:id -> a one-page operation datasheet.
		router.get('/operation/:id', async (req, res) => {
			if (!req.accountability?.user) {
				return res.status(401).send('Authentication required.');
			}
			const id = String(req.params.id);
			// A malformed id cannot match a uuid key; answer like any other miss.
			if (!UUID_RE.test(id)) return notFound(res, 'Operation');
			try {
				const a = await accessFor(req);

				// Read the BASE table (not the v_* view, which only covers machining ops
				// with samples) so every operation works — FAST/sintering included. `*`
				// carries all process params; related names are read per collection and
				// simply left blank when the caller cannot read that collection.
				const mo = await a.one('manufacturing_operations', id);
				if (!mo) return notFound(res, 'Operation');

				const [ps, mm, pr, c, e] = await Promise.all([
					a.one('physical_samples', mo.sample_id),
					a.one('manufacturing_methods', mo.method_id),
					a.one('projects', mo.project_id),
					a.one('campaigns', mo.campaign_id),
					a.one('equipment', mo.equipment_id),
				]);
				const op = {
					...mo,
					sample_code: ps?.sample_code,
					method_name: mm?.method_name,
					method_code: mm?.method_code,
					project_code: pr?.project_code,
					project_name: pr?.project_name,
					campaign_code: c?.campaign_code,
					campaign_name: c?.name,
					equipment_code: e?.equipment_code,
					equipment_name: e?.equipment_name,
				};

				// Force/FFT/FRM appendix, only present for processed machining ops
				// (scripts/force_orchestrator.py populates this table).
				const fa = await a.first(
					'machining_force_analysis',
					{ _and: [{ operation_id: { _eq: op.operation_id } }, { status: { _eq: 'done' } }] },
					['series', 'fft', 'frm_fx', 'frm_fy', 'frm_fz', 'cut_start_idx', 'cut_end_idx', 'sample_rate', 'status', 'trigger_time']
				);

				// FAST sintering ops get a trace-plot appendix instead of the force one.
				const fastRun =
					op.process_category === 'sintering'
						? await a.first(
								'fast_run_data',
								{ _and: [{ operation_id: { _eq: op.operation_id } }, { status: { _eq: 'done' } }] },
								['series', 'directus_files_id', 'status']
							)
						: null;

				const publicUrl = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
				const recordUrl = adminRecordUrl(publicUrl, 'manufacturing_operations', id);
				const qrSvg = await QRCode.toString(recordUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });

				res.set('Content-Security-Policy', REPORT_CSP);
				res.set('Content-Type', 'text/html; charset=utf-8').send(
					renderOperationReport({ op, fa, fastRun, qrSvg, recordUrl, publicUrl })
				);
			} catch (err) {
				logger.error(`d1-report operation failed for ${id}: ${err.stack || err.message}`);
				res.status(500).send('Report generation failed.');
			}
		});

		// GET /d1-report/test/:id -> a one-page test datasheet (type-specific params).
		router.get('/test/:id', async (req, res) => {
			if (!req.accountability?.user) return res.status(401).send('Authentication required.');
			const id = String(req.params.id);
			if (!UUID_RE.test(id)) return notFound(res, 'Test');
			try {
				const a = await accessFor(req);

				const t0 = await a.one('test_sessions', id);
				if (!t0) return notFound(res, 'Test');

				const [ps, pr, c, e] = await Promise.all([
					a.one('physical_samples', t0.sample_id),
					a.one('projects', t0.project_id),
					a.one('campaigns', t0.campaign_id),
					a.one('equipment', t0.equipment_id),
				]);
				const t = {
					...t0,
					sample_code: ps?.sample_code,
					project_code: pr?.project_code,
					project_name: pr?.project_name,
					campaign_code: c?.campaign_code,
					campaign_name: c?.name,
					equipment_code: e?.equipment_code,
					equipment_name: e?.equipment_name,
				};

				const publicUrl = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
				const recordUrl = adminRecordUrl(publicUrl, 'test_sessions', id);
				const qrSvg = await QRCode.toString(recordUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });

				res.set('Content-Security-Policy', REPORT_CSP);
				res.set('Content-Type', 'text/html; charset=utf-8').send(
					renderTestReport({ test: t, qrSvg, recordUrl, publicUrl })
				);
			} catch (err) {
				logger.error(`d1-report test failed for ${id}: ${err.stack || err.message}`);
				res.status(500).send('Report generation failed.');
			}
		});
	},
});
