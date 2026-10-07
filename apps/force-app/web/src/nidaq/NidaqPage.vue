<script setup lang="ts">
// NI-DAQ page: a stylised chassis with each detected C-series module drawn to its real connector
// geometry (BNC / terminal / D-Sub). Click a port to assign it to a channel; "+" on an empty slot
// opens the card catalog. The channel model (roles + physical bindings) drives what the recorder
// captures. Simulated on dev machines, real hardware on the rig.
import { onMounted, ref, computed, watch } from 'vue';
import { nidaqApi, ROLE_COLORS, type Devices, type Channel, type CatalogCard, type Port, type Module } from './nidaqApi';
import { nidaqState } from './nidaqStore';
import { promptAction } from '../ui/confirm';
import VirtualChannelBuilder from './VirtualChannelBuilder.vue';
import { useDialog } from '../ui/useDialog';

const devices = ref<Devices | null>(null);
const channels = ref<Channel[]>([]);
const cards = ref<CatalogCard[]>([]);
const loading = nidaqState.loading;
const err = ref<string | null>(null);
// Seeded from the module-level snapshot (#109) — the last-known chassis and channels show at once
// and refresh in the background — and every local edit is written back to it, which also drops a
// refresh that was already in flight and would otherwise put the pre-edit channels back.
let seeding = false;
watch(() => nidaqState.data.value, (snap) => {
	if (!snap) return;
	seeding = true;
	devices.value = snap.devices; channels.value = snap.channels; cards.value = snap.cards;
	seeding = false;
}, { immediate: true });
watch([devices, channels], () => {
	if (seeding || !devices.value) return;
	nidaqState.mutate({ devices: devices.value, channels: channels.value, cards: cards.value });
}, { flush: 'sync' });

const pop = ref<{ physical: string; label: string; x: number; y: number } | null>(null);
const catalogFor = ref<number | null>(null); // target slot for add-card
const catalogPanel = ref<HTMLElement | null>(null);
useDialog(catalogPanel, () => { catalogFor.value = null; });

// Hardware info summary
const totalAi = computed(() => {
	if (!devices.value) return 0;
	return devices.value.chassis.reduce((sum, ch) => sum + ch.modules.reduce((ms, m) => ms + m.ports.filter(p => p.kind === 'ai').length, 0), 0)
		+ devices.value.standalone.reduce((sum, m) => sum + m.ports.filter(p => p.kind === 'ai').length, 0);
});
const totalCi = computed(() => {
	if (!devices.value) return 0;
	return devices.value.chassis.reduce((sum, ch) => sum + ch.modules.reduce((ms, m) => ms + m.ports.filter(p => p.kind === 'ci').length, 0), 0)
		+ devices.value.standalone.reduce((sum, m) => sum + m.ports.filter(p => p.kind === 'ci').length, 0);
});
const moduleCount = computed(() => {
	if (!devices.value) return 0;
	return devices.value.chassis.reduce((sum, ch) => sum + ch.modules.length, 0) + devices.value.standalone.length;
});
const assignedCount = computed(() => channels.value.filter(c => c.physical).length);

// Card catalog spec lookup for display
function cardSpec(productType: string): CatalogCard | undefined {
	return cards.value.find(c => c.product_type === productType || c.label === productType);
}

async function load() {
	err.value = null;
	await nidaqState.revalidate();
	if (nidaqState.error.value) err.value = nidaqState.error.value;
}
onMounted(load);

async function save() { try { await nidaqApi.putChannels(channels.value); } catch (e: any) { err.value = e?.message; } }

const byPhysical = computed(() => {
	const m = new Map<string, Channel>();
	for (const c of channels.value) if (c.physical) m.set(c.physical, c);
	return m;
});
function chanFor(physical: string): Channel | undefined { return byPhysical.value.get(physical); }

function openPopover(port: Port, ev: MouseEvent) {
	const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
	pop.value = { physical: port.physical, label: port.physical, x: Math.min(r.right + 8, window.innerWidth - 250), y: r.top };
}
function assignTo(name: string) {
	const physical = pop.value!.physical;
	channels.value = channels.value.map((c) =>
		c.name === name ? { ...c, physical, source: 'hardware' } : c.physical === physical ? { ...c, physical: null } : c);
	pop.value = null; save();
}
async function newAux() {
	const physical = pop.value!.physical;
	pop.value = null; // close the port popover immediately — the name prompt is its own dialog
	// window.prompt() is not implemented by Electron's BrowserWindow at all (confirmed: it throws
	// "prompt() is not supported." — unlike alert()/confirm(), which Electron does implement via a
	// native dialog). This button previously called it directly with no try/catch, so clicking it
	// threw immediately and silently: no dialog appeared, no channel was created, no error shown.
	const name = await promptAction({
		title: 'New Aux channel',
		message: `Bound to ${physical}.`,
		defaultValue: 'Aux',
		confirmLabel: 'Create',
	});
	if (!name) return;
	const cleaned = channels.value.map((c) => (c.physical === physical ? { ...c, physical: null } : c));
	cleaned.push({ name, role: 'Aux', physical, sensitivity_pc_per_n: null, gain_n_per_v: null, source: 'hardware', color: ROLE_COLORS.Aux });
	channels.value = cleaned; save();
}
function unassignPop() {
	const physical = pop.value!.physical;
	channels.value = channels.value.map((c) => (c.physical === physical ? { ...c, physical: null } : c));
	pop.value = null; save();
}
// The equation-builder dialog is shared for creating a new virtual channel and editing an
// existing one. `null` name = not editing anything real yet — Cancel just closes it, nothing is
// added to `channels` until Save.
const editingVirtual = ref<Channel | null>(null);
function addVirtual() {
	editingVirtual.value = { name: '', role: 'Aux', physical: null, sensitivity_pc_per_n: null, gain_n_per_v: null, source: 'virtual', formula: '', color: ROLE_COLORS.Virtual };
}
function editVirtual(c: Channel) { editingVirtual.value = c; }
function saveVirtual(name: string, formula: string) {
	const editingName = editingVirtual.value!.name;
	const entry: Channel = { name, role: 'Aux', physical: null, sensitivity_pc_per_n: null, gain_n_per_v: null, source: 'virtual', formula, color: ROLE_COLORS.Virtual };
	channels.value = editingName
		? channels.value.map((c) => (c.name === editingName ? entry : c))
		: [...channels.value, entry];
	editingVirtual.value = null;
	save();
}
function removeChannel(name: string) { channels.value = channels.value.filter((c) => c.name !== name); save(); }
async function autoassign() { try { channels.value = (await nidaqApi.autoassign()).channels; } catch (e: any) { err.value = e?.message; } }

function moduleAt(chassis: { modules: Module[] }, slot: number) { return chassis.modules.find((m) => m.slot === slot); }
async function addCard(product_type: string) {
	if (catalogFor.value == null) return;
	try { devices.value = await nidaqApi.addCard(catalogFor.value, product_type); } catch (e: any) { err.value = e?.message; }
	catalogFor.value = null;
}
async function removeCard(slot: number) { try { devices.value = await nidaqApi.removeCard(slot); } catch (e: any) { err.value = e?.message; } }
</script>

<template>
	<div class="nidaq" @click="pop = null">
		<header class="head">
			<h1>NI-DAQ</h1>
			<span v-if="devices" class="badge" :class="devices.simulated ? 'sim' : 'live'">{{ devices.simulated ? 'SIMULATED' : 'LIVE' }}</span>
			<div class="spacer"></div>
			<button class="btn" data-focus="nidaq-autoassign" @click="autoassign"><span class="material-symbols-rounded">bolt</span> Auto-assign force</button>
			<button class="btn icon" title="Refresh" aria-label="Refresh" :disabled="loading" @click="load"><span class="material-symbols-rounded">refresh</span></button>
		</header>
		<p v-if="err" class="err">{{ err }}</p>

		<!-- Hardware summary bar. No chassis or status chips: each chassis card below is titled with
			 its model, and the badge beside the heading already says SIMULATED/LIVE. -->
		<div v-if="devices" class="hw-summary">
			<div class="hw-stat">
				<span class="material-symbols-rounded">memory</span>
				<div><span class="hw-label">Modules</span><b>{{ moduleCount }}</b></div>
			</div>
			<div class="hw-stat">
				<span class="material-symbols-rounded">input</span>
				<div><span class="hw-label">AI channels</span><b>{{ totalAi }}</b></div>
			</div>
			<div v-if="totalCi" class="hw-stat">
				<span class="material-symbols-rounded">timer</span>
				<div><span class="hw-label">Counters</span><b>{{ totalCi }}</b></div>
			</div>
			<div class="hw-stat">
				<span class="material-symbols-rounded">link</span>
				<div><span class="hw-label">Assigned</span><b>{{ assignedCount }} / {{ channels.length }}</b></div>
			</div>
		</div>

		<div class="layout">
			<!-- Chassis diagram(s) -->
			<div class="diagram" data-focus="nidaq-chassis">
				<div v-for="ch in devices?.chassis || []" :key="ch.name" class="chassis">
					<div class="chassis-top"><b>{{ ch.product_type }}</b><span class="sub">{{ ch.name }} · {{ ch.slots }}-slot</span></div>
					<div class="slots">
						<template v-for="slot in ch.slots" :key="slot">
							<div v-if="moduleAt(ch, slot)" class="mod" @click.stop>
								<div class="mod-head">
									<span class="slotno">SLOT {{ slot }}</span>
									<button class="rm" title="Remove card" @click="removeCard(slot)"><span class="material-symbols-rounded">close</span></button>
								</div>
								<div class="model">{{ moduleAt(ch, slot)!.label }}<span v-if="moduleAt(ch, slot)!.iepe" class="iepe">IEPE</span></div>
								<div class="conn-note">{{ moduleAt(ch, slot)!.note }}</div>
								<div class="mod-specs" v-if="cardSpec(moduleAt(ch, slot)!.product_type)">
									<span v-if="cardSpec(moduleAt(ch, slot)!.product_type)?.vmax" class="spec">±{{ cardSpec(moduleAt(ch, slot)!.product_type)!.vmax }}V</span>
									<span v-if="cardSpec(moduleAt(ch, slot)!.product_type)?.ks" class="spec">{{ cardSpec(moduleAt(ch, slot)!.product_type)!.ks }}kS/s</span>
									<span class="spec">{{ moduleAt(ch, slot)!.ports.length }}ch</span>
								</div>
								<!-- ports, connector-specific -->
								<div class="ports" :class="moduleAt(ch, slot)!.connector">
									<button v-for="p in moduleAt(ch, slot)!.ports" :key="p.physical" class="port-row"
										:style="chanFor(p.physical) ? { '--c': chanFor(p.physical)!.color } : {}"
										:class="{ assigned: chanFor(p.physical) }" @click.stop="openPopover(p, $event)">
										<span class="jack" :class="moduleAt(ch, slot)!.connector"></span>
										<span class="pid">{{ p.id }}</span>
										<span v-if="chanFor(p.physical)" class="chip">{{ chanFor(p.physical)!.name }}</span>
										<span v-else class="chip none">—</span>
									</button>
								</div>
							</div>
							<button v-else type="button" class="mod empty" :aria-label="`Add a card to slot ${slot}`" @click.stop="catalogFor = slot">
								<span class="slotno">SLOT {{ slot }}</span>
								<span class="plus-wrap"><span class="plus">+</span></span>
							</button>
						</template>
					</div>
				</div>

				<!-- Virtual channels get their own "chassis" — same slot/card mental model as the real
					 hardware above, since a virtual channel is conceptually the same kind of thing (a
					 named, colour-coded input to the recorder) even though it has no physical port. -->
				<div class="chassis virtual-chassis">
					<div class="chassis-top"><b>Virtual Channels</b><span class="sub">computed, not acquired</span></div>
					<div class="slots">
						<!-- Not a <button>: it holds its own remove button. role/tabindex/keys give it the same
							 keyboard reach. -->
						<div v-for="c in channels.filter((c) => c.source === 'virtual')" :key="c.name" class="mod virtual-mod"
							role="button" tabindex="0" :aria-label="`Edit virtual channel ${c.name}`"
							@click.stop="editVirtual(c)" @keydown.enter.self.prevent="editVirtual(c)" @keydown.space.self.prevent="editVirtual(c)">
							<div class="mod-head">
								<span class="slotno" :style="{ color: c.color }">{{ c.name }}</span>
								<button class="rm" title="Remove" :aria-label="`Remove ${c.name}`" @click.stop="removeChannel(c.name)"><span class="material-symbols-rounded">close</span></button>
							</div>
							<div class="formula-preview">{{ c.formula || '—' }}</div>
						</div>
						<button type="button" class="mod empty" aria-label="New virtual channel" @click.stop="addVirtual">
							<span class="slotno">NEW</span>
							<span class="plus-wrap"><span class="plus">+</span></span>
						</button>
					</div>
				</div>

				<p class="hint">Click a port to assign it to a channel. Click <b>+</b> on an empty slot to add a card.</p>
			</div>

			<!-- Channel model list -->
			<aside class="channels" data-focus="nidaq-channels">
				<div class="ch-head"><b>Channels</b><button class="btn sm" @click="addVirtual">+ Virtual</button></div>
				<div v-for="c in channels" :key="c.name" class="chrow" :class="{ clickable: c.source === 'virtual' }" @click="c.source === 'virtual' && editVirtual(c)">
					<span class="dot" :style="{ background: c.color }"></span>
					<span class="cname" :title="c.name">{{ c.name }}</span>
					<span class="crole">{{ c.role }}</span>
					<span class="cbind" :class="{ unbound: !c.physical }">{{ c.physical || (c.source === 'virtual' ? c.formula || 'virtual' : 'unbound') }}</span>
					<button class="rm" title="Remove channel" aria-label="Remove channel" @click.stop="removeChannel(c.name)"><span class="material-symbols-rounded">close</span></button>
				</div>
				<p v-if="!channels.length" class="hint">No channels — hit Auto-assign force.</p>
			</aside>
		</div>

		<!-- Assign popover -->
		<div v-if="pop" class="popover" :style="{ left: pop.x + 'px', top: pop.y + 'px' }" @click.stop>
			<h4>Assign <code>{{ pop.label }}</code> to</h4>
			<button v-for="c in channels" :key="c.name" class="roleopt" @click="assignTo(c.name)">
				<span class="dot" :style="{ background: c.color }"></span>{{ c.name }} <em>{{ c.role }}</em>
				<span v-if="c.physical === pop.physical" class="cur">current</span>
			</button>
			<div class="pop-sep"></div>
			<button class="roleopt add" @click="newAux"><span class="dot" :style="{ background: ROLE_COLORS.Aux }"></span>+ New aux channel…</button>
			<button class="roleopt add" @click="unassignPop"><span class="material-symbols-rounded">link_off</span> Unassign</button>
		</div>

		<!-- Add-card catalog -->
		<div v-if="catalogFor != null" class="modal dialog-backdrop-in" @click.self="catalogFor = null">
			<div ref="catalogPanel" class="catalog dialog-in" role="dialog" aria-modal="true" aria-labelledby="cat-title" tabindex="-1">
				<div class="cat-head"><b id="cat-title">Add card to Slot {{ catalogFor }}</b><button class="rm" title="Close" aria-label="Close" @click="catalogFor = null"><span class="material-symbols-rounded">close</span></button></div>
				<div class="catgrid">
					<button v-for="card in cards" :key="card.product_type" class="cattile" @click="addCard(card.product_type)">
						<span class="ctag">{{ card.connector.toUpperCase() }}<template v-if="card.iepe"> · IEPE</template></span>
						<div class="cname">{{ card.label }}</div>
						<div class="cspec">{{ card.ai ? card.ai + '× AI' : '' }}{{ card.ci ? (card.ai ? ' · ' : '') + card.ci + ' ctr' : '' }}<template v-if="card.note"> · {{ card.note }}</template></div>
					</button>
				</div>
			</div>
		</div>

		<VirtualChannelBuilder
			v-if="editingVirtual"
			:channels="channels"
			:initial-name="editingVirtual.name || undefined"
			:initial-formula="editingVirtual.formula || undefined"
			@save="saveVirtual"
			@cancel="editingVirtual = null"
		/>
	</div>
</template>

<style scoped>
.nidaq { min-height: 100vh; background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg)); }
.head { display: flex; align-items: center; gap: 12px; padding: 18px 24px 12px; border-bottom: 1px solid var(--border); }
.head h1 { margin: 0; font-size: var(--fs-2xl); }
.spacer { flex: 1; }
.badge { font-size: var(--fs-xs); font-weight: 700; letter-spacing: .04em; padding: 3px 9px; border-radius: 999px; }
.badge.sim { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); }
.badge.live { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); }
.err { color: var(--danger); font-size: var(--fs-md); padding: 8px 24px 0; }
.hw-summary { display: flex; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.hw-stat { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; }
.hw-stat .material-symbols-rounded { font-size: var(--icon-md); color: var(--text-dim); }
.hw-stat div { display: flex; flex-direction: column; }
.hw-label { font-size: var(--fs-xs); color: var(--text-dim); text-transform: uppercase; letter-spacing: .04em; }
.hw-stat b { font-size: var(--fs-md); font-variant-numeric: tabular-nums; }
.mod-specs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
.spec { font-size: var(--fs-xs); font-weight: 700; padding: 1px 5px; border-radius: 4px; background: var(--surface-2); color: var(--text-dim); border: 1px solid var(--border); }
.layout { display: flex; gap: 20px; padding: 20px 24px; align-items: flex-start; }
.diagram { flex: 1; min-width: 0; }
.chassis { background: color-mix(in srgb, var(--bg-2) 80%, transparent); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin-bottom: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
.chassis-top { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.chassis-top .sub { color: var(--text-dim); font-size: var(--fs-sm); }
.slots { display: flex; gap: 8px; align-items: stretch; overflow-x: auto; padding-bottom: 4px; }
/* Portrait modules — real C-series geometry: tall + narrow. */
.mod { flex: 0 0 116px; min-height: 230px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 8px; display: flex; flex-direction: column; }
.mod-head { display: flex; align-items: center; }
.slotno { font-size: var(--fs-xs); color: var(--text-faint); letter-spacing: .05em; }
.mod .rm { margin-left: auto; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--text-faint); cursor: pointer; border-radius: 4px; }
.mod .rm:hover { color: var(--danger); background: rgba(239,68,68,.1); }
.mod .rm .material-symbols-rounded { font-size: var(--icon-xs); }
/* Virtual channels have no ports to list — a real chassis module's tall portrait shape (above)
   would just be mostly empty space for a name + a one-line formula. */
.virtual-chassis .slots { flex-wrap: wrap; }
.virtual-mod { flex: 0 0 150px; min-height: 0; cursor: pointer; gap: 6px; }
.virtual-mod:hover { border-color: var(--accent); }
.virtual-mod .slotno { font-size: var(--fs-xs); font-weight: 700; font-family: var(--mono); letter-spacing: 0; }
.formula-preview { font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-dim); overflow-wrap: break-word; }
.virtual-chassis .mod.empty { flex: 0 0 90px; min-height: 84px; }
.model { font-size: var(--fs-sm); font-weight: 700; margin: 1px 0 1px; display: flex; align-items: center; gap: 5px; }
.iepe { font-size: var(--fs-xs); font-weight: 700; padding: 1px 4px; border-radius: 4px; background: rgba(96,165,250,.16); color: #60a5fa; }
[data-theme="light"] .iepe { color: #1d4ed8; }
.conn-note { font-size: var(--fs-xs); color: var(--text-dim); margin-bottom: 8px; }
.ports { display: flex; flex-direction: column; gap: 5px; }
.ports.terminal { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.port-row { display: flex; align-items: center; gap: 6px; padding: 4px 5px; border-radius: 7px; background: var(--surface-2); border: 1px solid var(--border-2); cursor: pointer; color: inherit; }
.port-row:hover { border-color: var(--text-faint); }
.port-row.assigned { border-color: var(--c); }
.jack { flex: 0 0 auto; }
.jack.bnc { width: 15px; height: 15px; border-radius: 50%; background: radial-gradient(circle at 45% 40%,#33405f,#141b2e 70%); border: 2px solid #52618c; box-shadow: inset 0 0 0 3px var(--plot-bg); }
.jack.terminal { width: 9px; height: 9px; border-radius: 2px; background: #2a3550; border: 1px solid #46557d; }
.jack.dsub { width: 9px; height: 9px; border-radius: 50%; background: #2a3550; border: 1px solid #46557d; }
.port-row.assigned .jack { border-color: var(--c); }
.pid { font-size: var(--fs-xs); color: var(--text-dim); }
.port-row.terminal .pid, .ports.terminal .pid { width: 20px; }
.chip { margin-left: auto; font-size: var(--fs-xs); font-weight: 700; padding: 1px 5px; border-radius: 5px; color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
/* --c is a canvas channel colour (ROLE_COLORS), tuned for the dark plot ground; as text on the light
   theme's near-white it fell to ~1.6:1 (Fy). Darken it there for the label only. */
[data-theme="light"] .chip { color: color-mix(in srgb, var(--c) 60%, black); }
.chip.none { color: var(--text-faint); background: transparent; }
.mod.empty { position: relative; align-items: stretch; justify-content: flex-start; border-style: dashed; color: var(--text-faint); cursor: pointer; font: inherit; text-align: left; }
.mod.empty:hover { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.plus-wrap { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.mod.empty .plus { width: 34px; height: 34px; border-radius: 9px; background: var(--accent); border: 1px solid var(--accent); color: var(--accent-ink); font-size: var(--fs-2xl); display: flex; align-items: center; justify-content: center; }
.mod.empty:hover .plus { background: color-mix(in srgb, var(--accent) 85%, black); }
.hint { font-size: var(--fs-sm); color: var(--text-dim); margin: 4px 2px 0; }
/* channel list */
.channels { flex: 0 0 300px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
.ch-head { display: flex; align-items: center; margin-bottom: 8px; }
.ch-head b { flex: 1; }
.chrow { display: flex; align-items: center; gap: 7px; padding: 6px 4px; border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
.chrow.clickable { cursor: pointer; }
.chrow.clickable:hover { background: var(--surface); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
/* Hardware channel names are always short (Fx1, Tacho, ...) but a virtual channel's name is
   user-typed and can run longer — clip it instead of letting it collide with .crole. */
.cname { font-weight: 700; flex: 0 1 auto; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crole { color: var(--text-dim); font-size: var(--fs-xs); width: 38px; }
.cbind { flex: 1; font-family: var(--mono); font-size: var(--fs-xs); color: var(--text-dim); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbind.unbound { color: var(--text-faint); font-style: italic; }
.chrow .rm { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: none; color: var(--text-faint); cursor: pointer; }
.chrow .rm:hover { color: var(--danger); }
.chrow .rm .material-symbols-rounded { font-size: var(--icon-xs); }
/* popover */
/* --surface-2 is a translucent overlay TINT (rgba, ~7% alpha in both themes) meant to sit atop an
   already-opaque parent — not a panel colour on its own. Used here for a position:fixed popover
   with nothing opaque behind it, it read as almost fully see-through (the slot cards showed right
   through the assign menu). --bg-2 is the token other floating menus in this panel already use
   correctly for exactly this (CutPicker.vue's .menu). */
.popover { position: fixed; z-index: 60; width: 234px; background: var(--bg-2); border: 1px solid var(--border-2); border-radius: 10px; padding: 8px; box-shadow: 0 14px 40px rgba(0,0,0,.55); max-height: 60vh; overflow: auto; }
.popover h4 { margin: 2px 4px 8px; font-size: var(--fs-sm); font-weight: 600; color: var(--text-dim); }
.popover code { color: var(--text); }
.roleopt { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 7px; border-radius: 6px; font-size: var(--fs-sm); background: transparent; border: none; color: var(--text); cursor: pointer; text-align: left; }
.roleopt:hover { background: var(--bg-3); }
.roleopt em { color: var(--text-dim); font-style: normal; font-size: var(--fs-xs); }
.roleopt .cur { margin-left: auto; font-size: var(--fs-xs); color: var(--ok); }
.roleopt.add { color: var(--text-dim); }
.roleopt .material-symbols-rounded { font-size: var(--icon-sm); }
.pop-sep { height: 1px; background: var(--border); margin: 5px 0; }
/* modal */
.modal { position: fixed; inset: 0; z-index: 70; background: var(--overlay); display: flex; align-items: center; justify-content: center; padding: 24px; }
.catalog { width: min(720px, 96vw); max-height: 82vh; overflow: auto; background: var(--surface-2); border: 1px solid var(--border-2); border-radius: 12px; padding: 16px; box-shadow: 0 20px 50px rgba(0,0,0,.6); }
.cat-head { display: flex; align-items: center; margin-bottom: 12px; }
.cat-head b { flex: 1; font-size: var(--fs-lg); }
.cat-head .rm { background: transparent; border: none; color: var(--text-dim); cursor: pointer; }
.catgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px,1fr)); gap: 10px; }
.cattile { text-align: left; background: var(--surface); border: 1px solid var(--border-2); border-radius: 9px; padding: 10px; cursor: pointer; color: var(--text); }
.cattile:hover { border-color: var(--accent); transform: translateY(-2px); transition: all .12s; }
.ctag { float: right; font-size: var(--fs-xs); font-weight: 700; padding: 1px 5px; border-radius: 4px; background: var(--bg-3); color: var(--text-dim); border: 1px solid var(--border-2); }
.cattile .cname { font-size: var(--fs-md); font-weight: 700; }
.cattile .cspec { font-size: var(--fs-xs); color: var(--text-dim); margin-top: 2px; }
</style>
