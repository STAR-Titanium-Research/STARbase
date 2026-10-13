// Sidebar icons as path data, so the kit needs no host icon component (the Explorer sidebar spec,
// decision 3). Icons from Lucide (https://lucide.dev), ISC licence, copied from lucide-static 0.460.0:
// each entry is the child elements of the icon's 24x24 SVG. Keys are this kit's names; where one
// differs from Lucide's, the comment says which icon it is (home = house; the section icons
// records, analysis, inventory, reference and more are table-2, chart-line, package, book-open
// and layout-grid).

export interface IconNode {
	tag: 'path' | 'circle' | 'rect' | 'line' | 'polyline' | 'polygon' | 'ellipse';
	attrs: Record<string, string>;
}

// Keeps the keys as a union while typing each icon's nodes.
function icons<K extends string>(set: Record<K, IconNode[]>): Record<K, IconNode[]> {
	return set;
}

const ICONS = icons({
	// Chrome
	search: [
		{ tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
		{ tag: 'path', attrs: { d: 'm21 21-4.3-4.3' } },
	],
	home: [
		{ tag: 'path', attrs: { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' } },
		{ tag: 'path', attrs: { d: 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' } },
	],
	pin: [
		{ tag: 'path', attrs: { d: 'M12 17v5' } },
		{ tag: 'path', attrs: { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z' } },
	],
	ellipsis: [
		{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '1' } },
		{ tag: 'circle', attrs: { cx: '19', cy: '12', r: '1' } },
		{ tag: 'circle', attrs: { cx: '5', cy: '12', r: '1' } },
	],
	settings: [
		{ tag: 'path', attrs: { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' } },
		{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
	],
	moon: [
		{ tag: 'path', attrs: { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' } },
	],
	sun: [
		{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '4' } },
		{ tag: 'path', attrs: { d: 'M12 2v2' } },
		{ tag: 'path', attrs: { d: 'M12 20v2' } },
		{ tag: 'path', attrs: { d: 'm4.93 4.93 1.41 1.41' } },
		{ tag: 'path', attrs: { d: 'm17.66 17.66 1.41 1.41' } },
		{ tag: 'path', attrs: { d: 'M2 12h2' } },
		{ tag: 'path', attrs: { d: 'M20 12h2' } },
		{ tag: 'path', attrs: { d: 'm6.34 17.66-1.41 1.41' } },
		{ tag: 'path', attrs: { d: 'm19.07 4.93-1.41 1.41' } },
	],
	'panel-left-close': [
		{ tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2' } },
		{ tag: 'path', attrs: { d: 'M9 3v18' } },
		{ tag: 'path', attrs: { d: 'm16 15-3-3 3-3' } },
	],
	'panel-left-open': [
		{ tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2' } },
		{ tag: 'path', attrs: { d: 'M9 3v18' } },
		{ tag: 'path', attrs: { d: 'm14 9 3 3-3 3' } },
	],
	'chevron-down': [
		{ tag: 'path', attrs: { d: 'm6 9 6 6 6-6' } },
	],
	'chevron-right': [
		{ tag: 'path', attrs: { d: 'm9 18 6-6-6-6' } },
	],
	'grip-vertical': [
		{ tag: 'circle', attrs: { cx: '9', cy: '12', r: '1' } },
		{ tag: 'circle', attrs: { cx: '9', cy: '5', r: '1' } },
		{ tag: 'circle', attrs: { cx: '9', cy: '19', r: '1' } },
		{ tag: 'circle', attrs: { cx: '15', cy: '12', r: '1' } },
		{ tag: 'circle', attrs: { cx: '15', cy: '5', r: '1' } },
		{ tag: 'circle', attrs: { cx: '15', cy: '19', r: '1' } },
	],
	x: [
		{ tag: 'path', attrs: { d: 'M18 6 6 18' } },
		{ tag: 'path', attrs: { d: 'm6 6 12 12' } },
	],
	'external-link': [
		{ tag: 'path', attrs: { d: 'M15 3h6v6' } },
		{ tag: 'path', attrs: { d: 'M10 14 21 3' } },
		{ tag: 'path', attrs: { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' } },
	],
	link: [
		{ tag: 'path', attrs: { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' } },
		{ tag: 'path', attrs: { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' } },
	],
	'arrow-up': [
		{ tag: 'path', attrs: { d: 'm5 12 7-7 7 7' } },
		{ tag: 'path', attrs: { d: 'M12 19V5' } },
	],
	'arrow-down': [
		{ tag: 'path', attrs: { d: 'M12 5v14' } },
		{ tag: 'path', attrs: { d: 'm19 12-7 7-7-7' } },
	],
	filter: [
		{ tag: 'polygon', attrs: { points: '22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3' } },
	],
	// Sections
	records: [
		{ tag: 'path', attrs: { d: 'M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18' } },
	],
	analysis: [
		{ tag: 'path', attrs: { d: 'M3 3v16a2 2 0 0 0 2 2h16' } },
		{ tag: 'path', attrs: { d: 'm19 9-5 5-4-4-3 3' } },
	],
	inventory: [
		{ tag: 'path', attrs: { d: 'M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z' } },
		{ tag: 'path', attrs: { d: 'M12 22V12' } },
		{ tag: 'path', attrs: { d: 'm3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7' } },
		{ tag: 'path', attrs: { d: 'm7.5 4.27 9 5.15' } },
	],
	reference: [
		{ tag: 'path', attrs: { d: 'M12 7v14' } },
		{ tag: 'path', attrs: { d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z' } },
	],
	more: [
		{ tag: 'rect', attrs: { width: '7', height: '7', x: '3', y: '3', rx: '1' } },
		{ tag: 'rect', attrs: { width: '7', height: '7', x: '14', y: '3', rx: '1' } },
		{ tag: 'rect', attrs: { width: '7', height: '7', x: '14', y: '14', rx: '1' } },
		{ tag: 'rect', attrs: { width: '7', height: '7', x: '3', y: '14', rx: '1' } },
	],
	// Records
	folder: [
		{ tag: 'path', attrs: { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' } },
	],
	flag: [
		{ tag: 'path', attrs: { d: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z' } },
		{ tag: 'line', attrs: { 'x1': '4', 'x2': '4', 'y1': '22', 'y2': '15' } },
	],
	'test-tube': [
		{ tag: 'path', attrs: { d: 'M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5c-1.4 0-2.5-1.1-2.5-2.5V2' } },
		{ tag: 'path', attrs: { d: 'M8.5 2h7' } },
		{ tag: 'path', attrs: { d: 'M14.5 16h-5' } },
	],
	cog: [
		{ tag: 'path', attrs: { d: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z' } },
		{ tag: 'path', attrs: { d: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z' } },
		{ tag: 'path', attrs: { d: 'M12 2v2' } },
		{ tag: 'path', attrs: { d: 'M12 22v-2' } },
		{ tag: 'path', attrs: { d: 'm17 20.66-1-1.73' } },
		{ tag: 'path', attrs: { d: 'M11 10.27 7 3.34' } },
		{ tag: 'path', attrs: { d: 'm20.66 17-1.73-1' } },
		{ tag: 'path', attrs: { d: 'm3.34 7 1.73 1' } },
		{ tag: 'path', attrs: { d: 'M14 12h8' } },
		{ tag: 'path', attrs: { d: 'M2 12h2' } },
		{ tag: 'path', attrs: { d: 'm20.66 7-1.73 1' } },
		{ tag: 'path', attrs: { d: 'm3.34 17 1.73-1' } },
		{ tag: 'path', attrs: { d: 'm17 3.34-1 1.73' } },
		{ tag: 'path', attrs: { d: 'm11 13.73-4 6.93' } },
	],
	'clipboard-check': [
		{ tag: 'rect', attrs: { width: '8', height: '4', x: '8', y: '2', rx: '1', ry: '1' } },
		{ tag: 'path', attrs: { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' } },
		{ tag: 'path', attrs: { d: 'm9 14 2 2 4-4' } },
	],
	users: [
		{ tag: 'path', attrs: { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' } },
		{ tag: 'circle', attrs: { cx: '9', cy: '7', r: '4' } },
		{ tag: 'path', attrs: { d: 'M22 21v-2a4 4 0 0 0-3-3.87' } },
		{ tag: 'path', attrs: { d: 'M16 3.13a4 4 0 0 1 0 7.75' } },
	],
	// Analysis
	activity: [
		{ tag: 'path', attrs: { d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2' } },
	],
	zap: [
		{ tag: 'path', attrs: { d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z' } },
	],
	// Inventory
	wrench: [
		{ tag: 'path', attrs: { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' } },
	],
	briefcase: [
		{ tag: 'path', attrs: { d: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' } },
		{ tag: 'rect', attrs: { width: '20', height: '14', x: '2', y: '6', rx: '2' } },
	],
	diamond: [
		{ tag: 'path', attrs: { d: 'M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z' } },
	],
	'triangle-right': [
		{ tag: 'path', attrs: { d: 'M22 18a2 2 0 0 1-2 2H3c-1.1 0-1.3-.6-.4-1.3L20.4 4.3c.9-.7 1.6-.4 1.6.7Z' } },
	],
	cylinder: [
		{ tag: 'ellipse', attrs: { cx: '12', cy: '5', rx: '9', ry: '3' } },
		{ tag: 'path', attrs: { d: 'M3 5v14a9 3 0 0 0 18 0V5' } },
	],
	// Reference
	drill: [
		{ tag: 'path', attrs: { d: 'M10 18a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H5a3 3 0 0 1-3-3 1 1 0 0 1 1-1z' } },
		{ tag: 'path', attrs: { d: 'M13 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1l-.81 3.242a1 1 0 0 1-.97.758H8' } },
		{ tag: 'path', attrs: { d: 'M14 4h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3' } },
		{ tag: 'path', attrs: { d: 'M18 6h4' } },
		{ tag: 'path', attrs: { d: 'm5 10-2 8' } },
		{ tag: 'path', attrs: { d: 'm7 18 2-8' } },
	],
	layers: [
		{ tag: 'path', attrs: { d: 'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z' } },
		{ tag: 'path', attrs: { d: 'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65' } },
		{ tag: 'path', attrs: { d: 'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65' } },
	],
	'hard-hat': [
		{ tag: 'path', attrs: { d: 'M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5' } },
		{ tag: 'path', attrs: { d: 'M14 6a6 6 0 0 1 6 6v3' } },
		{ tag: 'path', attrs: { d: 'M4 15v-3a6 6 0 0 1 6-6' } },
		{ tag: 'rect', attrs: { x: '2', y: '15', width: '20', height: '4', rx: '1' } },
	],
	shapes: [
		{ tag: 'path', attrs: { d: 'M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z' } },
		{ tag: 'rect', attrs: { x: '3', y: '14', width: '7', height: '7', rx: '1' } },
		{ tag: 'circle', attrs: { cx: '17.5', cy: '17.5', r: '3.5' } },
	],
	tag: [
		{ tag: 'path', attrs: { d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z' } },
		{ tag: 'circle', attrs: { cx: '7.5', cy: '7.5', r: '.5', fill: 'currentColor' } },
	],
	workflow: [
		{ tag: 'rect', attrs: { width: '8', height: '8', x: '3', y: '3', rx: '2' } },
		{ tag: 'path', attrs: { d: 'M7 11v4a2 2 0 0 0 2 2h4' } },
		{ tag: 'rect', attrs: { width: '8', height: '8', x: '13', y: '13', rx: '2' } },
	],
	factory: [
		{ tag: 'path', attrs: { d: 'M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z' } },
		{ tag: 'path', attrs: { d: 'M17 18h1' } },
		{ tag: 'path', attrs: { d: 'M12 18h1' } },
		{ tag: 'path', attrs: { d: 'M7 18h1' } },
	],
	'building-2': [
		{ tag: 'path', attrs: { d: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z' } },
		{ tag: 'path', attrs: { d: 'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2' } },
		{ tag: 'path', attrs: { d: 'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2' } },
		{ tag: 'path', attrs: { d: 'M10 6h4' } },
		{ tag: 'path', attrs: { d: 'M10 10h4' } },
		{ tag: 'path', attrs: { d: 'M10 14h4' } },
		{ tag: 'path', attrs: { d: 'M10 18h4' } },
	],
	'flask-conical': [
		{ tag: 'path', attrs: { d: 'M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2' } },
		{ tag: 'path', attrs: { d: 'M8.5 2h7' } },
		{ tag: 'path', attrs: { d: 'M7 16h10' } },
	],
	droplet: [
		{ tag: 'path', attrs: { d: 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z' } },
	],
	flame: [
		{ tag: 'path', attrs: { d: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z' } },
	],
	// More and Admin
	printer: [
		{ tag: 'path', attrs: { d: 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2' } },
		{ tag: 'path', attrs: { d: 'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6' } },
		{ tag: 'rect', attrs: { x: '6', y: '14', width: '12', height: '8', rx: '1' } },
	],
	bug: [
		{ tag: 'path', attrs: { d: 'm8 2 1.88 1.88' } },
		{ tag: 'path', attrs: { d: 'M14.12 3.88 16 2' } },
		{ tag: 'path', attrs: { d: 'M9 7.13v-1a3.003 3.003 0 1 1 6 0v1' } },
		{ tag: 'path', attrs: { d: 'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6' } },
		{ tag: 'path', attrs: { d: 'M12 20v-9' } },
		{ tag: 'path', attrs: { d: 'M6.53 9C4.6 8.8 3 7.1 3 5' } },
		{ tag: 'path', attrs: { d: 'M6 13H2' } },
		{ tag: 'path', attrs: { d: 'M3 21c0-2.1 1.7-3.9 3.8-4' } },
		{ tag: 'path', attrs: { d: 'M20.97 5c0 2.1-1.6 3.8-3.5 4' } },
		{ tag: 'path', attrs: { d: 'M22 13h-4' } },
		{ tag: 'path', attrs: { d: 'M17.2 17c2.1.1 3.8 1.9 3.8 4' } },
	],
	database: [
		{ tag: 'ellipse', attrs: { cx: '12', cy: '5', rx: '9', ry: '3' } },
		{ tag: 'path', attrs: { d: 'M3 5V19A9 3 0 0 0 21 19V5' } },
		{ tag: 'path', attrs: { d: 'M3 12A9 3 0 0 0 21 12' } },
	],
	radar: [
		{ tag: 'path', attrs: { d: 'M19.07 4.93A10 10 0 0 0 6.99 3.34' } },
		{ tag: 'path', attrs: { d: 'M4 6h.01' } },
		{ tag: 'path', attrs: { d: 'M2.29 9.62A10 10 0 1 0 21.31 8.35' } },
		{ tag: 'path', attrs: { d: 'M16.24 7.76A6 6 0 1 0 8.23 16.67' } },
		{ tag: 'path', attrs: { d: 'M12 18h.01' } },
		{ tag: 'path', attrs: { d: 'M17.99 11.66A6 6 0 0 1 15.77 16.67' } },
		{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '2' } },
		{ tag: 'path', attrs: { d: 'm13.41 10.59 5.66-5.66' } },
	],
});

export type NavIconName = keyof typeof ICONS;

export const NAV_ICONS: Record<NavIconName, IconNode[]> = ICONS;
