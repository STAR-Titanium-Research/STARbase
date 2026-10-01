// Bundled with each build (not fetched), so it always matches whatever version is actually
// installed and needs no network call. Add an entry here as part of any release that bumps
// apps/force-app/desktop/package.json's version — newest first.
export interface ChangelogEntry {
	version: string;
	date: string;   // YYYY-MM-DD
	notes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
	{
		version: '0.1.32',
		date: '2026-09-30',
		notes: [
			'Sign in with no connection. An account that has signed in on this PC before can sign in offline with the same password (kept only as a salted hash, for 30 days after its last online sign-in). A banner marks an offline session; "Sign in to sync" upgrades it once you are connected.',
			'Every recording now carries who recorded it and when. A capture recorded offline and uploaded later, even by someone else, keeps its original owner and recording time; the database also notes who uploaded it.',
			'Queued run records upload automatically only under the account that recorded them. Another user can upload them deliberately with "Upload as me" in Settings > Local Captures.',
			'The Sample, Operator, Machine, Tool, Insert and Edge pickers work offline from a copy refreshed while connected (Settings > Connectivity shows its age and has "Refresh now").',
			'Fixed: a dropped connection while refreshing the session signed you out. Only a refusal from the server does that now.',
			'Fixed: editing a capture\'s metadata no longer drops who recorded it.',
		],
	},
	{
		version: '0.1.31',
		date: '2026-09-27',
		notes: [
			'Icons now show on a PC with no internet connection. They used to appear as their names (e.g. "fiber_manual_record Start") because the icon font was downloaded on every start.',
			'Fixed: the live FFT and Power plots stayed blank until a channel chip was clicked, and the spectrogram and waterfall stuck to the first channel picked.',
			'Each plot panel\'s title is now its plot-type picker: point at "FFT ›" to switch between Time, FFT, Power, Spectrogram and Waterfall. The same applies in the pop-out window and the Plot page.',
			'The FRM map has a colour-scale editor with a legend: colormap, steps, display and saturation ranges, with a histogram of the values behind the colour bar.',
			'Virtual channels: build computed channels from a formula on the NI-DAQ page, and add extra hardware (Aux) channels.',
			'Clearer text and controls: one set of text sizes with nothing smaller than 11px, one button style across the app, and one accent colour (amber in dark mode, slate in light mode).',
			'Light mode reworked: plot traces, legends, status colours and the login card are now easy to read on the light background.',
			'Removed duplicated controls and readouts: the separate "Recording behaviour" block (the toggles next to Start do the same), the RPM tile in Overview, the storage block on the Connectivity page, and the Plot page\'s show/hide eye buttons.',
			'Number tiles keep their unit next to the value and no longer cut values off in a narrow panel.',
			'Resetting the panel layout now asks first.',
			'Keyboard: the navigation sidebar opens with Enter and closes with Escape, lookup lists can be moved through with the arrow keys, and every dialog keeps focus inside it and closes with Escape.',
			'Animations are consistent, and are turned off when Windows\' "Show animations" setting is off.',
			'Fixed: Local Captures could never tell which captures were already uploaded, so the Upload buttons never appeared.',
			'Fixed: editing the metadata of an uploaded capture failed to load its record.',
			'Connectivity Doctor hints now point to the right place for each fix.',
		],
	},
	{
		version: '0.1.30',
		date: '2026-09-24',
		notes: [
			'Fixed: replaying a file broke as soon as you left the Recording window and came back — the transport still looked active but play, pause and scrubbing all did nothing. Replay now keeps its place and resumes properly.',
			'Fixed: after leaving and returning to the Recording window during replay, only the time-series plot still worked — FFT, Power, Spectrogram and Waterfall stayed blank for the rest of the session.',
			'The FRM map can now be panned (drag) and zoomed (scroll wheel) instead of being locked to an automatic fit, with a "Reset view" button to return to the automatic framing.',
			'Fixed: changing the colormap during replay only recoloured newly-drawn points, leaving the rest of the spiral on the old colormap until you navigated away and back. The whole map now repaints immediately.',
			'Fixed: the Recording window always had a small scrollbar in its default layout, even with nothing to scroll to.',
			'The Recording panel has been reorganised: Machine and Operator now have their own subpanel, and the recording toggles sit next to Start.',
			'Fixed: captures too large to export as .mat no longer fail their whole upload — the "Save a local copy (.mat)" option is now correctly unavailable for them, with an explanation, instead of silently downloading nothing.',
			'Fixed: the Plot window leaked graphics resources each time you navigated away and back, which could leave the point cloud unable to recover on large operations.',
			'Bug reports no longer include your Windows account name in the attached diagnostics.',
		],
	},
	{
		version: '0.1.29',
		date: '2026-09-16',
		notes: [
			'F11 now toggles fullscreen.',
			'Fixed: dropdown menus (e.g. the Report a Bug area field) could show unreadable colouring when opened in dark mode.',
			'Settings > About: a link to the full GitHub releases page, and the changelog list now scrolls within its own area instead of growing the whole window taller.',
			'The recording-in-progress banner shown on other pages now says "Go to Recording".',
			'The incomplete-recordings banner gained an "Ignore for now" option, for when you want to deal with a crashed recording later instead of recovering or discarding it immediately.',
		],
	},
	{
		version: '0.1.28',
		date: '2026-09-16',
		notes: [
			'Recording Settings: the Sample Rate field now warns immediately if the configured rate exceeds what the assigned NI-DAQ hardware can actually deliver, instead of only failing once a recording is started.',
			'Lab Amp > Auto-range: "Recommend from peaks" can now use several previous recordings at once (not just the last one picked) — the recommendation uses each channel\'s largest peak across all of them.',
			'Fixed: the Plot dashboard\'s FRM panel could briefly claim the Signals column\'s space too when returning to the page from elsewhere, before snapping back to the correct layout a moment later.',
			'Fixed: the Logs view\'s timestamp column could overlap the level tag next to it; timestamps are now genuinely UTC (previously shown unlabeled machine-local time).',
		],
	},
	{
		version: '0.1.27',
		date: '2026-09-16',
		notes: [
			'Fixed: navigating away from the Record page and back during a live cut could silently reset the plotted history and buffers, as if the recording had just started, even though the recording itself never stopped.',
			'Fixed: the disk-space-warning and incomplete-recordings banners pushed the whole recording layout down while shown, then left it squeezed into the smaller space after being dismissed — both now overlay the page instead of shifting it.',
			'Fixed: the cross-page "recording in progress" banner\'s elapsed-time counter only advanced once every 5 seconds instead of ticking live.',
			'Fixed: the Spectrogram and Waterfall views let you tick multiple channels even though only the first ever rendered — selecting a channel in either view now replaces the selection instead of silently no-oping.',
		],
	},
	{
		version: '0.1.26',
		date: '2026-09-16',
		notes: [
			'Fixed: the live bandwidth readout on the Record page could flicker constantly between e.g. "1 MB/s" and "1000 KB/s".',
			'Fixed: the report-a-bug/feature form could lose whatever you\'d already typed if you switched Settings tabs or popped the window before submitting.',
			'Fixed: discarding an incomplete recording said this "cannot be undone" even when a remote backup copy still existed — the dialog now says so and points you to Settings > Remote Live Backup when that\'s the case.',
			'Renamed the Force panel\'s time-domain tab from "Force" to "Time" — the channels shown there aren\'t always force (e.g. Tacho, or a milling recording\'s torque/position channels).',
		],
	},
	{
		version: '0.1.25',
		date: '2026-09-16',
		notes: [
			'Fixed: the Lab Amp could be left in MEASURE mode indefinitely after a crashed recording was recovered or discarded, instead of resetting like a normal end-of-cut.',
			'Fixed: the "Reset view" button on the Record page could stop working after a banner (disk warning, incomplete recordings) was dismissed — the layout stayed squeezed into the smaller space even though more room was now available.',
		],
	},
	{
		version: '0.1.24',
		date: '2026-09-16',
		notes: [
			'Fixed: recording a very large capture could crash the whole app during finalize (an internal file-format limit on the archived .mat file). Oversized captures now finalize successfully — the plot data and summary are still produced and saved, just without a full-resolution .mat archive.',
			'Fixed: a recording that was still actively streaming could appear in the "incomplete recordings" recovery list with a Restore option, as if it had crashed.',
			'Fixed: changing the Lab Amp\'s mode, ranges, or calibration is now blocked while a recording is in progress, instead of being able to corrupt the live capture.',
			'Fixed: the safety alarm banner could show a nonsensical "0.0 N" for the tacho/RPM signal-integrity alarm, reading as a misbehaving force alarm even when force alarms were turned off.',
		],
	},
	{
		version: '0.1.23',
		date: '2026-09-15',
		notes: [
			'Report a bug/feature page: reports now carry an Area tag (Recording, Plotting, Diagnostics, Settings, Lab Amp, NI-DAQ, GUI, General), pre-selected from whichever page you were on before opening the report form.',
			'Fixed: the "current page" recorded on a filed report always said Settings, regardless of where the issue actually happened — it now correctly records the page you came from.',
		],
	},
	{
		version: '0.1.22',
		date: '2026-09-15',
		notes: [
			'No user-facing changes — a formatting fix to the bug-report relay to get CI passing again after 0.1.21.',
		],
	},
	{
		version: '0.1.21',
		date: '2026-09-15',
		notes: [
			'New Metadata Doctor (Plot dashboard): flags operations where the archived .mat file\'s recorded parameters disagree with, or are missing from, the database — undersized crop windows, conflicting feed/depth-of-cut/speed/diameter, unlinked samples — with one-click fixes that route through the existing "Save changes" dialog. A severity badge and filter show flagged ops directly in the Operations list; a workpiece diameter field was added to the metadata box so it has somewhere to adopt into.',
			'Fixed: the operation code and sequence fields in the Plot dashboard\'s metadata box looked editable but any edits were silently discarded — both are now shown as the fixed, non-editable values they always actually were.',
			'End-of-cut save dialog: the detected cut start/end can now be dragged to adjust before saving, with a note and one-click reset if you want to revert to the auto-detected window.',
			'Report a bug/feature page: you can now tag whether you\'re filing a bug or a feature request, your signed-in email is always attached to the report, and the page shows your recently-filed reports with their open/closed status.',
			'Fixed: leaving the Plot page and coming back reloaded it from scratch every time, including re-fetching the drive list on every visit to Settings > General.',
			'Fixed: discarding a just-finished recording (instead of saving it) could leave its plot data showing on the next recording.',
			'Fixed: the Signals/FRM column on the Plot page could fall slightly short of matching the record window\'s exact height.',
			'Fixed: the FRM point cloud in Lite mode could vanish when zoomed in, not reappearing until you zoomed back out.',
			'Fixed: a Full-res (Potree) point cloud kept showing the old crop window after the crop was adjusted and saved — it\'s now automatically rebuilt on the next save.',
		],
	},
	{
		version: '0.1.20',
		date: '2026-09-13',
		notes: [
			'Plot dashboard: dragging the FRM point-cloud crop handles is now instant even on multi-million-point cuts (previously visibly laggy) — the crop preview moved onto the GPU instead of being recomputed on every drag frame.',
			'Plot dashboard: the mouse cursor no longer lags when scrubbing across multiple open charts at once.',
			'Fixed: a saved crop override stopped being applied once you left Live mode, silently reverting to the auto-detected crop window.',
			'Plot dashboard: dark mode grid lines and axis ticks are now dim instead of bright white, and axis text is larger and easier to read.',
			'Plot dashboard: an optional second axis showing the tool\'s radial position (distance from the part centre) can now be added to the Signals charts.',
			'Plot dashboard: Power, Spectrogram, and Waterfall views now have the same per-axis layout, axis labels, hover readout, and zoom/pan as Force/FFT (previously collapsed multi-axis panels to a single axis and had no interactive axes at all).',
			'Plot dashboard: editing an operation\'s metadata (subtype, sequence, cutting parameters, notes) and adjusting its crop now save together in one combined "Save changes" summary, including a preview of the regenerated operation name.',
			'Fixed: the Plot page could scroll slightly on a normal-size monitor even though nothing was actually cut off.',
		],
	},
	{
		version: '0.1.19',
		date: '2026-09-11',
		notes: [
			'New Polar Plot panel (Record page → Add panel, with its own pop-out window): plots torque or force against spindle angle for a finished or replayed cut — the milling counterpart to the FRM map.',
			'Fixed: the FRM map could come up blank, or show a "no host installed" error, immediately after a recording finished — unless you had opened the Plot page earlier in the same session.',
			'Diagnostics Workbench: a very long or high-speed cut, a straight-line cut, or a recipe with the frame-transform step switched off no longer crashes the analysis bake — each now fails with a clear reason.',
			'Diagnostics Workbench: the framed-view recompute now returns a readable error (not a bare server error) when a crop is too large or a seed layer is missing; clicking a pipeline step to revert the view now redirects the view you are actually looking at and clears its stale colouring.',
			'Force capture files can now carry torque (Mz) and machine tool-position (X/Y/Z) channels alongside force, as groundwork for milling support. Older capture files load unchanged.',
		],
	},
	{
		version: '0.1.18',
		date: '2026-08-29',
		notes: [
			'The "recording in progress" banner shown when you navigate away from Record is now blue with live elapsed time, sample count, and peak force, instead of looking like a red error banner.',
			'Disabling a safety alarm in Settings, or silencing one that has tripped, now explains exactly what you are turning off and asks you to confirm.',
			'Quitting the app while a recording is in progress now warns you and lets you cancel, instead of silently stopping the acquisition.',
			'Fixed: a healthy tacho sensor could trigger a false "No tacho signal" alarm in the first couple of seconds of every real recording.',
			'Fixed: acknowledging one safety alarm could silently silence a different alarm that fired at the same moment, without ever showing it to you.',
			'Bug reports can now include more diagnostic detail (amp mode, NI-DAQ hardware, disk space, more log history, and this window\'s console) to make problems easier to diagnose remotely.',
			'Connectivity Doctor now checks that the NI-DAQ chassis and the Lab Amp are actually connected and responding, not just that the drivers/software are installed.',
		],
	},
	{
		version: '0.1.13',
		date: '2026-08-28',
		notes: [
			'Fixed: dropdown search menus (Sample, Machine, Tool, Operator, Insert, Edge, replay cut picker) stayed dark in light mode.',
			'Fixed: after picking a replay cut and clicking "change" to pick a different one, the list only ever showed one option instead of the full recent-cuts list.',
			'Recording panel: Insert/Edge and Machine/Operator fields are now side by side to save vertical space; picking an Edge auto-fills its parent Insert.',
			'The Tool field now shows the tool\'s name instead of its code.',
			'Record page panels can now extend further down the window, and the floating add-panel/reset-layout buttons are slightly larger and fade to translucent until hovered.',
			'The plotting window can now save a manually adjusted crop as the operation\'s official crop point, used automatically on future replays.',
			'The sidebar\'s collapsed nav handle is easier to hover onto without shrinking its visible size.',
		],
	},
	{
		version: '0.1.12',
		date: '2026-08-27',
		notes: [
			'Fixed: a failed download while switching replay cuts could leave the picker showing the new cuts name while the transport kept playing the old cut. The previous cut now stays fully in effect until a new one actually finishes loading.',
			'Fixed: switching to a new replay cut could show the previous cuts RPM target or depth of cut if the new cut had none recorded, instead of reading as not set.',
			'Fixed: a stored outer diameter of exactly 0 (meaning "not set") was being read as a real 0 mm override, showing Diameter and Surface speed as 0.',
			'Fixed: the Capture rate tile could read several times too low for a real recording, since it was reading the decimated cache rate instead of the true acquisition rate.',
			'Fixed: dismissing the cut search without picking a different cut (Escape, or clicking away) used to lose the loaded cuts label and parameter panel even though playback kept running.',
			'Fixed: the FRM panels Fx/Fy/Fz colour toggle had no effect once a replay cut was already loaded.',
		],
	},
	{
		version: '0.1.11',
		date: '2026-08-27',
		notes: [
			'Fixed: replayed cuts could stop short of the centre in the FRM map instead of spiralling all the way in. Replay now reads the real pulses-per-rev and diameters from the database instead of using whatever was left in the recording form.',
			'Fixed: the live FRM colour scale drifted while replaying, so early points looked off compared to the finished-cut view. It now uses the same colour range as the finished view, computed once from the whole cut.',
			'Replay: picking a cut now shows a loading indicator while it downloads, and the cut search collapses to a single line once a cut is picked instead of always showing the full list.',
			'Replay: the feed, diameter, pulses-per-rev, surface speed, depth of cut, capture rate and cut time are now shown as a compact parameter summary once a cut is loaded.',
			'Recording: the numeric setup fields (spindle, feed, diameter, sample rate, pulses/rev) use the same compact card style as the new replay parameter summary.',
		],
	},
	{
		version: '0.1.10',
		date: '2026-08-27',
		notes: [
			'Fixed: the replay scrub bar vanished when the Recording panel was narrow — it collapsed to zero width behind the play button and time readout, leaving playback uncontrollable. The row now wraps and the scrub keeps a usable width.',
		],
	},
	{
		version: '0.1.9',
		date: '2026-08-27',
		notes: [
			'Replay file now plays like a video: play, pause and scrub through a past cut, at true realtime speed by default (with slow-motion down to 0.25×). It drives the same waveform, FFT, FRM and RPM views a live cut does.',
			'Replaying a cut no longer records a second copy of it — it plays the file already in the database, so nothing new is written to disk.',
			'Fixed: replaying a long cut reported a spindle speed several times too high, which also raised a false safety alarm every time.',
			'Fixed: replay ignored the speed you asked for on long cuts, always finishing in about 40 seconds however long the cut really was.',
		],
	},
	{
		version: '0.1.6',
		date: '2026-08-26',
		notes: [
			'Settings > About: shows the running version and this changelog.',
			'The "update ready" prompt now waits for an active recording to finish instead of interrupting it, and lets you postpone an update and keep working — Settings > About always shows where to install it later.',
			'Settings > About: Restart & Install button to apply a downloaded update without waiting for the prompt.',
		],
	},
	{
		version: '0.1.5',
		date: '2026-08-26',
		notes: [
			'Settings > General: shows the running version and a manual Check for updates button.',
		],
	},
	{
		version: '0.1.4',
		date: '2026-08-26',
		notes: [
			'Fixed laggy crop-handle dragging on the Signals charts.',
			'Fixed the live force plot stalling on slower machines during long recordings.',
			'The left nav no longer reserves horizontal space it doesn’t use.',
			'Fixed the Simulated/Replay/NI-DAQ source row sometimes appearing clipped at the top of the Recording panel.',
			'Spectrogram view is single-axis only (a heatmap can’t usefully overlay multiple axes); Waterfall still supports all three.',
		],
	},
	{
		version: '0.1.3',
		date: '2026-08-23',
		notes: [
			'Live recording backup: streams to a crash-safety server in real time and recovers cleanly from a network outage mid-recording.',
			'Settings > Logs: view, filter, search, and download the backend log without leaving the app.',
			'Auto-update installs silently and relaunches automatically instead of opening the full installer wizard.',
			'Fixed the capture-drive setting silently failing to persist on a packaged install.',
		],
	},
];
