// The Record page's plot modes, in one place: the panel header's mode picker (RecordPage.vue),
// the panel that renders them (ForcePanel.vue) and its pop-out window (LivePanelWindow.vue) all
// read this list. "Time" names the mode (the raw time-domain view), not what is plotted on it,
// which isn't always force (Tacho, or a milling recording's Mz/X/Y/Z channels).
export type PlotMode = 'time' | 'fft' | 'psd' | 'spectrogram' | 'waterfall';

export const PLOT_MODES: { key: PlotMode; label: string; title: string }[] = [
	{ key: 'time', label: 'Time', title: 'Time plot' },
	{ key: 'fft', label: 'FFT', title: 'Amplitude spectrum' },
	{ key: 'psd', label: 'Power', title: 'Power spectrum (dB)' },
	{ key: 'spectrogram', label: 'Spectrogram', title: 'Time × frequency heatmap' },
	{ key: 'waterfall', label: 'Waterfall', title: 'Stacked spectra over time' },
];
