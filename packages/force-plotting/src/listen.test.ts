import { describe, expect, it } from 'vitest';
import { listen } from './listen';

describe('listen', () => {
	it('fires until disposed, then never again', () => {
		const target = new EventTarget();
		let n = 0;
		const off = listen(target, 'click', () => { n++; });
		target.dispatchEvent(new Event('click'));
		expect(n).toBe(1);
		off();
		target.dispatchEvent(new Event('click'));
		expect(n).toBe(1);
	});
	it('mounting twice and disposing the first leaves exactly one live handler', () => {
		const target = new EventTarget();
		let n = 0;
		const off1 = listen(target, 'click', () => { n++; });
		const off2 = listen(target, 'click', () => { n++; });
		off1();
		target.dispatchEvent(new Event('click'));
		expect(n).toBe(1);
		off2();
	});
});
