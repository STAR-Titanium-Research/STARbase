// The gesture list shown by the Plot dashboard's "?" overlay (PlotHelp.vue). Kept as plain data so
// the wording lives apart from the markup, like diagHelp.ts. Each line describes something the
// dashboard really does; if a gesture changes, this is where the help is wrong.

export interface HelpGesture { gesture: string; does: string }
export interface HelpSection { title: string; items: HelpGesture[] }

export const PLOT_HELP: HelpSection[] = [
	{
		title: 'Signals charts',
		items: [
			{ gesture: 'Right-click a chart', does: 'Show position on map, clear the marker, set the crop start or end at that time, and Save chart as PNG or SVG (a report-styled figure with title, units, crop band and compare legend).' },
			{ gesture: 'Drag a crop handle', does: 'Moves the start or end of the analysed window. It is held until you Save changes.' },
			{ gesture: 'Rectangular zoom', does: 'Turn on the box tool in the toolbar, then drag a box on any chart. Every chart zooms together; the mouse wheel zooms too.' },
			{ gesture: 'Hover a chart', does: 'A cursor follows all charts together, and a ring follows the matching point on the map.' },
		],
	},
	{
		title: 'FRM map',
		items: [
			{ gesture: 'Right-click a point', does: 'Show position in time pins a marker on every Force chart. Copy point info and Set crop start or end here are in the same menu.' },
			{ gesture: 'Right-drag', does: 'Pans the map. Only a right-click that does not move opens the menu.' },
			{ gesture: 'Escape', does: 'Clears the pinned marker.' },
		],
	},
	{
		title: 'Comparing cuts',
		items: [
			{ gesture: 'Compare, then + Add cut', does: 'Overlays another cut as a dashed trace. Each chip has a colour, a × to remove it and a ref button.' },
			{ gesture: 'ref, then Difference', does: 'Plots the current cut minus the reference over the stretch where both crop windows overlap, with its mean and RMS in N.' },
		],
	},
	{
		title: 'Sharing and export',
		items: [
			{ gesture: 'Copy link', does: 'Copies a link that reopens this view: the cut, mode, axes, zoom and compare set.' },
			{ gesture: 'Download CSV', does: 'On the statistics, wear and cluster tables, saves the rows with units in the column names.' },
			{ gesture: 'Download image', does: 'On the FRM map, saves the current view as a PNG. Charts save from their right-click menu.' },
		],
	},
];
