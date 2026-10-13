import { describe, expect, it } from 'vitest';
import { NAV_ICONS } from './navIcons';

const TAGS = ['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'];

describe('NAV_ICONS', () => {
	it('has the chrome icons and the section icons', () => {
		const names = [
			'search', 'home', 'pin', 'ellipsis', 'settings', 'moon', 'sun', 'panel-left-close', 'panel-left-open', 'chevron-down',
			'chevron-right', 'grip-vertical', 'x', 'external-link', 'link', 'arrow-up', 'arrow-down', 'filter',
			'records', 'analysis', 'inventory', 'reference', 'more', 'log-out', 'monitor',
		];
		for (const n of names) expect(Object.keys(NAV_ICONS), n).toContain(n);
	});

	it('draws every icon from known SVG elements with attributes', () => {
		for (const [name, nodes] of Object.entries(NAV_ICONS)) {
			expect(nodes.length, name).toBeGreaterThan(0);
			for (const n of nodes) {
				expect(TAGS, name).toContain(n.tag);
				expect(Object.keys(n.attrs).length, name).toBeGreaterThan(0);
			}
		}
	});
});
