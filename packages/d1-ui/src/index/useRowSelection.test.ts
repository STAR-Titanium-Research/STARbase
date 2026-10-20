import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { bulkEntries } from '../bulk/bulkModel';
import { indexDefBySlug } from './indexConfig';
import { SELECT_MAX } from './indexView';
import { useRowSelection } from './useRowSelection';

const rows = ref([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
const key = (r: Record<string, unknown>) => String(r.id);

describe('useRowSelection', () => {
	it('ticks on any list, whatever its def offers', () => {
		const sel = useRowSelection(indexDefBySlug('tools')!, rows, key, vi.fn());
		sel.toggle(rows.value[0]);
		sel.togglePage();
		expect(sel.picked.value).toEqual(['a', 'b', 'c']);
	});

	it('still takes the ticked keys to the labels page for the print entry', () => {
		const samples = indexDefBySlug('samples')!;
		expect(bulkEntries(samples)[0]).toMatchObject({ id: 'print', kind: 'print' });
		const navigate = vi.fn();
		const sel = useRowSelection(samples, rows, key, navigate);
		sel.toggle(rows.value[0]);
		sel.toggle(rows.value[2]);
		sel.run();
		expect(navigate).toHaveBeenCalledWith('/home/labels?ids=a,c');
	});

	it('does nothing for run() with nothing ticked or no select action', () => {
		const navigate = vi.fn();
		useRowSelection(indexDefBySlug('samples')!, rows, key, navigate).run();
		const tools = useRowSelection(indexDefBySlug('tools')!, rows, key, navigate);
		tools.toggle(rows.value[0]);
		tools.run();
		expect(navigate).not.toHaveBeenCalled();
	});

	it('keeps exactly the skipped rows ticked after a bulk action', () => {
		const sel = useRowSelection(indexDefBySlug('samples')!, rows, key, vi.fn());
		sel.togglePage();
		sel.keepOnly(['b']);
		expect(sel.picked.value).toEqual(['b']);
		sel.keepOnly([]);
		expect(sel.picked.value).toEqual([]);
	});

	it('caps the kept rows at the tick limit', () => {
		const sel = useRowSelection(indexDefBySlug('samples')!, rows, key, vi.fn());
		sel.keepOnly(Array.from({ length: SELECT_MAX + 5 }, (_, i) => `k${i}`));
		expect(sel.picked.value).toHaveLength(SELECT_MAX);
	});
});
