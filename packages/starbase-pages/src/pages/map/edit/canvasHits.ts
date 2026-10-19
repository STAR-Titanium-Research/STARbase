// What is under a point of the canvas, for the gestures that end there (a wire dragged from a socket, an entry dragged from the palette):
// the sockets (found by their `data-sock`), the drawn wire, whether the point is empty canvas. Read from the DOM at the moment of the gesture.

import { decodeSocket, type SocketRef, type SocketSpot } from './socketRefs';

/** Where every socket of the canvas is on the screen (the centre of its dot). */
export function socketSpots(canvasEl: HTMLElement | null): SocketSpot[] {
	const out: SocketSpot[] = [];
	for (const el of canvasEl?.querySelectorAll<HTMLElement>('[data-sock]') ?? []) {
		const sock = decodeSocket(el.dataset.sock);
		if (!sock) continue;
		const r = el.getBoundingClientRect();
		out.push({ sock, x: r.left + r.width / 2, y: r.top + r.height / 2 });
	}
	return out;
}

/** Anywhere on the empty canvas: not on a card, a control, the minimap, a wire or the palette's own overlays. */
export function onEmptyCanvas(canvasEl: HTMLElement | null, x: number, y: number): boolean {
	const el = document.elementFromPoint(x, y);
	return !!el && !!canvasEl?.contains(el) && !el.closest('.vue-flow__node, .vue-flow__controls, .vue-flow__minimap, .vue-flow__edge, .pm-wirepreview');
}

/** The id of the drawn wire under a point (the `data-id` of its edge: `<from socket>><to socket>`), or null. */
export function wireAt(canvasEl: HTMLElement | null, x: number, y: number): string | null {
	const el = document.elementFromPoint(x, y);
	if (!el || !canvasEl?.contains(el)) return null;
	return el.closest('.vue-flow__edge')?.getAttribute('data-id') ?? null;
}

/** True when the point is over the canvas panel at all (a drop outside it does nothing). */
export function overCanvas(canvasEl: HTMLElement | null, x: number, y: number): boolean {
	const r = canvasEl?.getBoundingClientRect();
	return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** The drawn card (Vue Flow node id) a socket is on, so what is added beside it lines up with it. */
export function nodeIdOfSocket(canvasEl: HTMLElement | null, sock: SocketRef): string | undefined {
	for (const el of canvasEl?.querySelectorAll<HTMLElement>('[data-sock]') ?? []) {
		const s = decodeSocket(el.dataset.sock);
		if (s && s.kind === sock.kind && s.id === sock.id && s.side === sock.side && !!s.add === !!sock.add) return (el.closest('.vue-flow__node') as HTMLElement | null)?.dataset.id;
	}
	return undefined;
}
