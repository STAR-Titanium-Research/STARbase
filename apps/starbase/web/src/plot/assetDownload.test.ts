import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { downloadAsset, filenameFromDisposition, saveBlob } from './assetDownload';

describe('filenameFromDisposition', () => {
	it('reads a quoted filename', () => {
		expect(filenameFromDisposition('attachment; filename="run 12 F3.mat"')).toBe('run 12 F3.mat');
	});
	it('reads an unquoted one', () => {
		expect(filenameFromDisposition('attachment; filename=frm.png')).toBe('frm.png');
	});
	it('prefers the RFC 5987 form and decodes it', () => {
		expect(filenameFromDisposition(`attachment; filename="fallback.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`)).toBe('résumé.csv');
	});
	it('is null when there is no usable name', () => {
		expect(filenameFromDisposition(undefined)).toBeNull();
		expect(filenameFromDisposition('attachment')).toBeNull();
		expect(filenameFromDisposition('attachment; filename=""')).toBeNull();
	});
	it('drops any directory part, with either slash', () => {
		expect(filenameFromDisposition('attachment; filename="..\\..\\evil\\x.mat"')).toBe('x.mat');
		expect(filenameFromDisposition('attachment; filename="../../evil/x.mat"')).toBe('x.mat');
		expect(filenameFromDisposition("attachment; filename*=UTF-8''..%5C..%5Cevil%5Cx.mat")).toBe('x.mat');
	});
	it('never returns a dot name', () => {
		expect(filenameFromDisposition('attachment; filename=".."')).toBeNull();
		expect(filenameFromDisposition('attachment; filename="."')).toBeNull();
		expect(filenameFromDisposition('attachment; filename="a/.."')).toBeNull();
	});
});

describe('saveBlob', () => {
	const anchors: Array<{ href: string; download: string; rel: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }> = [];
	beforeEach(() => {
		vi.useFakeTimers();
		anchors.length = 0;
		vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake-1'), revokeObjectURL: vi.fn() });
		vi.stubGlobal('document', {
			createElement: vi.fn(() => {
				const a = { href: '', download: '', rel: '', click: vi.fn(), remove: vi.fn() };
				anchors.push(a);
				return a;
			}),
			body: { appendChild: vi.fn() },
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it('clicks a temporary <a download> on an object URL, then revokes it', () => {
		const blob = new Blob(['x']);
		saveBlob(blob, 'run.mat');
		expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
		expect(anchors).toHaveLength(1);
		expect(anchors[0]).toMatchObject({ href: 'blob:fake-1', download: 'run.mat' });
		expect(anchors[0].click).toHaveBeenCalledTimes(1);
		expect(anchors[0].remove).toHaveBeenCalledTimes(1);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled(); // not before the browser has taken the file
		vi.runAllTimers();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-1');
	});
	it('revokes the object URL at once when the click throws (nothing was handed to the browser), and still removes the link', () => {
		const blob = new Blob(['x']);
		(document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			const a = { href: '', download: '', rel: '', click: vi.fn(() => { throw new Error('blocked'); }), remove: vi.fn() };
			anchors.push(a);
			return a;
		});
		expect(() => saveBlob(blob, 'run.mat')).toThrow('blocked');
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-1');
		expect(anchors[0].remove).toHaveBeenCalledTimes(1);
	});
	it('revokes the object URL when appendChild throws', () => {
		(document.body.appendChild as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('no body'); });
		expect(() => saveBlob(new Blob(['x']), 'run.mat')).toThrow('no body');
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-1');
	});
});

describe('downloadAsset', () => {
	const fakeApi = (result: () => Promise<unknown>) => {
		const get = vi.fn(result);
		return { api: { get } as unknown as AxiosInstance, get };
	};
	const blob = new Blob(['x']);
	afterEach(() => vi.unstubAllGlobals());

	it('fetches the file through the credentialed api as a blob and saves it under the server name', async () => {
		const { api, get } = fakeApi(async () => ({ data: blob, headers: { 'content-disposition': 'attachment; filename="op7_F2.mat"' } }));
		const save = vi.fn();
		await downloadAsset(api, 'f 1', save);
		expect(get).toHaveBeenCalledWith('/assets/f%201', { params: { download: '' }, responseType: 'blob' });
		expect(save).toHaveBeenCalledWith(blob, 'op7_F2.mat');
	});
	it('falls back to the file id when the server sends no name and the type tells nothing', async () => {
		const { api } = fakeApi(async () => ({ data: blob, headers: {} }));
		const save = vi.fn();
		await downloadAsset(api, 'abc-123', save);
		expect(save).toHaveBeenCalledWith(blob, 'abc-123');
	});
	it.each([
		['image/png', 'png'],
		['text/csv; charset=utf-8', 'csv'],
		['application/octet-stream', 'bin'],
		['application/x-matlab-data', 'mat'],
		['application/matlab', 'mat'],
	])('with no readable name, a %s file is named <id>.%s', async (type, ext) => {
		const typed = new Blob(['x'], { type });
		const { api } = fakeApi(async () => ({ data: typed, headers: {} }));
		const save = vi.fn();
		await downloadAsset(api, 'abc-123', save);
		expect(save).toHaveBeenCalledWith(typed, `abc-123.${ext}`);
	});
	it('an unknown type gets no extension', async () => {
		const typed = new Blob(['x'], { type: 'application/x-weird' });
		const { api } = fakeApi(async () => ({ data: typed, headers: {} }));
		const save = vi.fn();
		await downloadAsset(api, 'abc-123', save);
		expect(save).toHaveBeenCalledWith(typed, 'abc-123');
	});
	it('a 200 whose body is not a file (a JSON error page) rejects and saves nothing', async () => {
		const { api } = fakeApi(async () => ({ data: { errors: [{ message: 'nope' }] }, headers: {} }));
		const save = vi.fn();
		await expect(downloadAsset(api, 'f1', save)).rejects.toThrow('not a file');
		expect(save).not.toHaveBeenCalled();
	});
	it.each([403, 404])('a %i rejects, saves nothing, and never navigates the tab', async (status) => {
		const location = { href: 'https://starbase.example/plot/force?operation=1', assign: vi.fn(), replace: vi.fn() };
		vi.stubGlobal('window', { location });
		const { api } = fakeApi(async () => Promise.reject(Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } })));
		const save = vi.fn();
		await expect(downloadAsset(api, 'gone', save)).rejects.toMatchObject({ response: { status } });
		expect(save).not.toHaveBeenCalled();
		expect(location.href).toBe('https://starbase.example/plot/force?operation=1');
		expect(location.assign).not.toHaveBeenCalled();
		expect(location.replace).not.toHaveBeenCalled();
	});
});
