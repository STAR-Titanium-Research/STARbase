<script setup lang="ts">
// The run modal: title, progress (steps and time), the step list, the open question with its
// options, a note field and a countdown, and Cancel (confirmed). Minimise turns it into the
// bottom bar (RigTestBar). It reopens by itself when a step needs the operator.
//
// Escape MINIMISES; it never cancels the run. Nothing here is dismissed by a click on the
// backdrop either: the run keeps going and the operator should know where it is.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useDialog } from '../ui/useDialog';
import { ThinkingOrb } from '@d1/force-plotting';
import { confirmAndCancelRun } from './confirmCancel';
import { rigTest } from './rigTestStore';
import {
	currentPosition, finishedText, formatClock, httpUrl, minimisedText, progress, questionKey, secondsLeft, stepMark, timeLeft,
	type RigRun,
} from './rigTestLogic';

const s = rigTest.state;
const panel = ref<HTMLElement | null>(null);
/** What the modal shows: the run that just ended, else the live one. */
const run = computed<RigRun | null>(() => s.finished ?? s.run);
const finished = computed(() => !!s.finished);
// The run carries its own title and link; the pending list is the fallback for an older backend.
const title = computed(() => {
	const r = run.value;
	const t = r ? r.title || s.known[r.number]?.title : '';
	return t ? `Rig test #${r!.number}: ${t}` : `Rig test #${r?.number ?? ''}`;
});
const link = computed(() => httpUrl(run.value ? run.value.url || s.known[run.value.number]?.url : ''));
const prog = computed(() => (run.value ? progress(run.value) : null));
const question = computed(() => (finished.value ? undefined : run.value?.question));
const questionStep = computed(() => run.value?.steps.find((x) => x.index === question.value?.step));
const options = computed(() => (question.value?.options.length ? question.value.options : ['Continue']));
const currentText = computed(() => {
	const r = run.value;
	return r?.steps.find((x) => x.index === r.current)?.text ?? '';
});

// The countdown ticks locally between polls.
const nowMs = ref(Date.now());
const left = computed(() => (question.value ? secondsLeft(question.value.expires_at, nowMs.value) : 0));
let ticker: ReturnType<typeof setInterval> | null = null;
watch(() => !!question.value, (open) => {
	if (open && !ticker) { nowMs.value = Date.now(); ticker = setInterval(() => { nowMs.value = Date.now(); }, 1000); }
	else if (!open && ticker) { clearInterval(ticker); ticker = null; }
}, { immediate: true });
onBeforeUnmount(() => { if (ticker) clearInterval(ticker); });

// A fresh question starts with an empty note.
const note = ref('');
watch(() => questionKey(s.run), () => { note.value = ''; });

function pick(option: string) {
	if (question.value) void rigTest.answer(question.value.step, option, questionStep.value?.kind === 'note' ? '' : note.value);
}
function dismiss() { if (finished.value) rigTest.closeFinished(); else rigTest.minimise(); }
useDialog(panel, dismiss);
</script>

<template>
	<div v-if="run" class="rm-backdrop" data-testid="rig-test-modal">
		<div ref="panel" class="rm-panel dialog-in" role="dialog" aria-modal="true" aria-labelledby="rm-title" tabindex="-1">
			<header class="rm-head">
				<span class="material-symbols-rounded rm-icon">science</span>
				<h2 id="rm-title">{{ title }}</h2>
				<button v-if="!finished" type="button" class="btn icon sm" title="Minimise (the test keeps running)" aria-label="Minimise" @click="rigTest.minimise()">
					<span class="material-symbols-rounded">minimize</span>
				</button>
			</header>
			<a v-if="link" class="rm-link" :href="link" target="_blank" rel="noopener">Open the issue on GitHub</a>

			<p v-if="finished" class="rm-done" :class="run.state" role="status">{{ finishedText(run.state) }}</p>

			<div v-if="prog" class="rm-bars">
				<div class="rm-bar-row">
					<span>Steps</span>
					<div class="rm-track" role="progressbar" aria-label="Steps done" :aria-valuenow="prog.done" aria-valuemin="0" :aria-valuemax="prog.total">
						<div class="rm-fill" :style="{ width: `${prog.stepFraction * 100}%` }"></div>
					</div>
					<b>{{ prog.done }}/{{ prog.total }}</b>
				</div>
				<div class="rm-bar-row">
					<span>Time</span>
					<div class="rm-track" role="progressbar" aria-label="Time used of the estimate" :aria-valuenow="Math.round(prog.timeFraction * 100)" aria-valuemin="0" aria-valuemax="100">
						<div class="rm-fill time" :style="{ width: `${prog.timeFraction * 100}%` }"></div>
					</div>
					<b>{{ finished ? 'done' : timeLeft(run) }}</b>
				</div>
			</div>

			<section v-if="question" class="rm-q" aria-live="assertive" data-testid="rig-test-question">
				<div class="rm-q-head">
					<span class="rm-q-tag">Step {{ currentPosition(run) }} needs you</span>
					<span class="rm-count" :class="{ low: left <= 30 }">{{ left > 0 ? `Answer within ${formatClock(left)}` : 'Time is up: recording no response' }}</span>
				</div>
				<p class="rm-q-text">{{ question.text }}</p>
				<div class="rm-opts" role="group" aria-label="Answers">
					<button v-for="o in options" :key="o" type="button" class="btn" :disabled="s.answering || left <= 0" @click="pick(o)">{{ o }}</button>
				</div>
				<label v-if="questionStep?.kind !== 'note'" class="rm-note">
					<span>Note (optional)</span>
					<textarea v-model="note" rows="2" maxlength="500" placeholder="What you saw, if it helps"></textarea>
				</label>
				<p v-if="s.answerError" class="rm-err" role="alert"><span class="material-symbols-rounded">error</span>{{ s.answerError }}</p>
			</section>
			<p v-else-if="!finished && currentText" class="rm-working">
				<ThinkingOrb :size="18" label="" />{{ minimisedText(run) }}
			</p>

			<ol class="rm-steps" aria-label="Steps">
				<li v-for="st in run.steps" :key="st.index" :class="[stepMark(st.status).tone, { cur: st.index === run.current && !finished }]">
					<span class="material-symbols-rounded rm-mark" aria-hidden="true">{{ stepMark(st.status).icon }}</span>
					<span class="rm-step-text"><code>{{ st.item_id }}</code> {{ st.text }}<em v-if="st.answer"> → {{ st.answer }}</em></span>
					<span class="rm-sr">{{ stepMark(st.status).label }}</span>
				</li>
			</ol>

			<p v-if="s.cancelError" class="rm-err" role="alert"><span class="material-symbols-rounded">error</span>{{ s.cancelError }}</p>
			<footer class="rm-foot">
				<button v-if="!finished" type="button" class="btn danger quiet" @click="confirmAndCancelRun">
					<span class="material-symbols-rounded">cancel</span>Cancel test
				</button>
				<span class="rm-spacer"></span>
				<button v-if="!finished" type="button" class="btn" @click="rigTest.minimise()">
					<span class="material-symbols-rounded">minimize</span>Minimise
				</button>
				<button v-else type="button" class="btn primary" @click="rigTest.closeFinished()">Close</button>
			</footer>
		</div>
	</div>
</template>

<style scoped>
/* z-index 190: same layer as the consent prompt. Above the page, the recording banner (150) and
   the update prompt (180); below the recording Save dialog (200), the other dialogs, the alarm
   banner (290) and the confirm prompt (300), which Cancel opens. z-order.test.ts pins this. */
.rm-backdrop { position: fixed; inset: 0; z-index: 190; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--overlay); backdrop-filter: blur(2px); }
.rm-panel { width: min(600px, 100%); max-height: 100%; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 20px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 30px 80px rgba(0,0,0,0.45); outline: none; }
.rm-head { display: flex; align-items: center; gap: 10px; }
.rm-head h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-xl); line-height: 1.25; overflow-wrap: anywhere; }
.rm-icon { font-size: var(--icon-xl); color: var(--accent); }
.rm-link { font-size: var(--fs-sm); color: var(--text-dim); }
.rm-done { margin: 0; padding: 9px 12px; font-size: var(--fs-md); font-weight: 600; border-radius: 9px; background: var(--surface); border: 1px solid var(--border); }
.rm-done.done { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.rm-done.partial, .rm-done.timed_out { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.rm-bars { display: flex; flex-direction: column; gap: 6px; }
.rm-bar-row { display: grid; grid-template-columns: 44px 1fr 92px; align-items: center; gap: 10px; font-size: var(--fs-sm); color: var(--text-dim); }
.rm-bar-row b { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
.rm-track { height: 8px; border-radius: 99px; background: var(--surface-2); overflow: hidden; }
.rm-fill { height: 100%; background: var(--accent); border-radius: 99px; transition: width 0.4s ease; }
.rm-fill.time { background: var(--text-faint); }
.rm-q { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: color-mix(in srgb, var(--accent) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 11px; }
.rm-q-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.rm-q-tag { font-size: var(--fs-sm); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); }
.rm-count { font-size: var(--fs-sm); color: var(--text-dim); font-variant-numeric: tabular-nums; }
.rm-count.low { color: var(--warn); font-weight: 600; }
.rm-q-text { margin: 0; font-size: var(--fs-lg); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.rm-opts { display: flex; flex-wrap: wrap; gap: 8px; }
.rm-note { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-dim); }
.rm-note textarea { padding: 8px 10px; font: inherit; font-size: var(--fs-md); color: var(--text); background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; resize: vertical; }
.rm-note textarea:focus { border-color: var(--accent); outline: none; }
.rm-working { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--fs-md); color: var(--text-dim); }
.rm-working .material-symbols-rounded { font-size: var(--icon-md); }
.rm-err { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: var(--fs-md); color: var(--danger); }
.rm-err .material-symbols-rounded { font-size: var(--icon-md); }
.rm-steps { list-style: none; margin: 0; padding: 4px 0; display: flex; flex-direction: column; max-height: 220px; overflow-y: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.rm-steps li { display: flex; align-items: flex-start; gap: 8px; padding: 5px 2px; font-size: var(--fs-md); color: var(--text-dim); }
.rm-steps li.cur { color: var(--text); font-weight: 600; }
.rm-mark { font-size: var(--icon-md); flex: 0 0 auto; }
.rm-steps li.ok .rm-mark { color: var(--ok); }
.rm-steps li.bad .rm-mark { color: var(--danger); }
.rm-steps li.warn .rm-mark { color: var(--warn); }
.rm-steps li.active .rm-mark { color: var(--accent); }
.rm-step-text { min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rm-step-text code { font-size: var(--fs-xs); color: var(--accent); }
.rm-step-text em { font-style: normal; color: var(--text); }
.rm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.rm-foot { display: flex; align-items: center; gap: 10px; }
.rm-spacer { flex: 1; }
</style>
