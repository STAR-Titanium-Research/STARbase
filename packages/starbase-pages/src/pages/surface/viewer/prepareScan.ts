// Everything the viewer needs from a fetched scan, worked out once on the CPU before the scene starts: the
// texture data, the layout, the height range and the exaggeration the slider starts at. Pure.

import { buildTextureData, type GridStats, type ScanMeta, type TextureData } from './gridData';
import { defaultExaggeration, heightRange, scanLayout, type HeightRange, type ScanLayout } from './scanLayout';

export interface PreparedScan {
	meta: ScanMeta;
	texture: TextureData;
	stats: GridStats;
	layout: ScanLayout;
	range: HeightRange;
	initialExaggeration: number;
}

export function prepareScan(meta: ScanMeta, grid: Float32Array): PreparedScan {
	const texture = buildTextureData(grid, meta.width, meta.height);
	const layout = scanLayout(meta);
	const range = heightRange(meta, texture.stats);
	return { meta, texture, stats: texture.stats, layout, range, initialExaggeration: defaultExaggeration(layout, range) };
}
