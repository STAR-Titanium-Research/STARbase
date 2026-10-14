// The soft ground shadow under the tray: a blurred rounded rectangle on a canvas texture.

import { CanvasTexture, SRGBColorSpace } from 'three';

export const SHADOW_FILL = 0.56; // the tray covers this fraction of the shadow plane

export function shadowTexture(): CanvasTexture {
	const size = 256;
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d')!;
	// The shape is drawn far off canvas and only its blurred shadow lands on it.
	const off = 4000;
	ctx.shadowColor = '#000';
	ctx.shadowBlur = size * 0.1;
	ctx.shadowOffsetX = off;
	ctx.fillStyle = '#000';
	const a = size * 0.22, b = size * 0.78, r = size * 0.06;
	ctx.beginPath();
	ctx.roundRect(a - off, a, b - a, b - a, r);
	ctx.fill();
	const t = new CanvasTexture(c);
	t.colorSpace = SRGBColorSpace;
	return t;
}
