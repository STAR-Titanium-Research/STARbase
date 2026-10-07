<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import ChartPanel from './chart-panel.vue';
import ExampleChips from './example-chips.vue';
import { copyText } from './clipboard';
import { csvCell, csvFilename, toCsv } from './csv';
import QuestionList from './question-list.vue';
import {
	HISTORY_KEY,
	HISTORY_LIMIT,
	SAVED_FULL_MESSAGE,
	SAVED_KEY,
	addQuestion,
	hasQuestion,
	loadList,
	dropLegacy,
	removeQuestion,
	scopedKey,
	startsConversation,
	toggleSavedQuestion,
	updateList,
} from './history';

interface ChartSpec {
	type: 'bar' | 'line' | 'scatter' | 'histogram' | 'pie';
	x: string;
	y: string[];
	title?: string;
}

interface Turn {
	question: string;
	status: 'pending' | 'done' | 'error';
	sql?: string;
	columns?: string[];
	rows?: Record<string, unknown>[];
	rowCount?: number;
	truncated?: boolean;
	chart?: ChartSpec | null;
	reply?: string | null;
	error?: string;
	/** The raw reason behind a rejected or failed query, shown under the message. */
	detail?: string;
	/** Offer the example chips, because rephrasing may help. */
	suggest?: boolean;
	/** Feedback on the last "Copy SQL" click; cleared after a moment. */
	copied?: 'ok' | 'fail';
}

const api = useApi();
const input = ref('');
const turns = ref<Turn[]>([]);
const scroller = ref<HTMLDivElement | null>(null);
/**
 * Last 20 asked questions and the pinned ones, per browser AND per Directus user (users sharing
 * one browser keep separate lists). Question text only, never rows.
 */
const { useUserStore } = useStores();
const userId: string | null = (useUserStore().currentUser as any)?.id ?? null;
const historyKey = scopedKey(HISTORY_KEY, userId);
const savedKey = scopedKey(SAVED_KEY, userId);
dropLegacy(userId);
const asked = ref(loadList(historyKey));
const saved = ref(loadList(savedKey));

// Every change re-reads storage first, so a second tab's additions are merged, not overwritten.
function remember(question: string) {
	asked.value = updateList(historyKey, asked.value, (l) => addQuestion(l, question, Date.now(), HISTORY_LIMIT));
}

function forget(question: string) {
	asked.value = updateList(historyKey, asked.value, (l) => removeQuestion(l, question));
}

// Shown beside Save question when a pin is refused because the list is full.
const saveNotice = ref('');
let saveNoticeTimer: ReturnType<typeof setTimeout> | undefined;

function toggleSaved(question: string) {
	let result: 'saved' | 'removed' | 'full' = 'saved';
	saved.value = updateList(savedKey, saved.value, (l) => {
		const r = toggleSavedQuestion(l, question, Date.now());
		result = r.result;
		return r.list;
	});
	clearTimeout(saveNoticeTimer);
	saveNotice.value = result === 'full' ? SAVED_FULL_MESSAGE : '';
	if (result === 'full') saveNoticeTimer = setTimeout(() => (saveNotice.value = ''), 4000);
}

function unsave(question: string) {
	saved.value = updateList(savedKey, saved.value, (l) => removeQuestion(l, question));
}

/** A plain-language message for a failed /d1-ask/chat call. */
function explainError(status: number | undefined, d: any, fallback: string) {
	if (status === 422 && d?.error === 'generated SQL rejected') {
		return {
			message:
				'That question could not be turned into a safe, read-only query, so nothing was run. Try rephrasing it, or start from one of these examples:',
			detail: d.reason,
			suggest: true,
		};
	}
	if (status === 422 && d?.error && d?.reason) {
		return {
			message:
				'The query written for that question could not run. Try asking it more specifically, or start from one of these examples:',
			detail: d.reason,
			suggest: true,
		};
	}
	if (status === 401 || status === 403) {
		return {
			message:
				'You are not allowed to use Ask the Database. Sign in again, or ask an administrator for access.',
		};
	}
	if (status === 502 && d?.code === 'upstream_auth') {
		// A server-side fault (the endpoint's secret was refused), not something the user can fix.
		return {
			message: `${d.error}. Tell an administrator; signing in again will not help.`,
		};
	}
	if (status === 502) {
		return {
			message:
				'The text-to-SQL service could not be reached. The language model may still be starting; try again in a minute, and tell an administrator if it keeps happening.',
		};
	}
	if (status === 504) {
		return {
			message:
				'The question took too long to answer. Try a simpler or more specific question.',
		};
	}
	return { message: d?.error || fallback };
}

const busy = () => turns.value.some((t) => t.status === 'pending');

/** Prior completed turns become conversation context so follow-ups can refine. */
function history(): { role: string; content: string }[] {
	const msgs: { role: string; content: string }[] = [];
	for (const t of turns.value) {
		if (t.status !== 'done') continue;
		msgs.push({ role: 'user', content: t.question });
		if (t.sql) msgs.push({ role: 'assistant', content: t.sql });
	}
	return msgs;
}

async function scrollToEnd() {
	await nextTick();
	scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' });
}

async function submit(text?: string) {
	const question = (text ?? input.value).trim();
	if (!question || busy()) return;

	const context = history();
	const messages = [...context, { role: 'user', content: question }];
	const turn = ref<Turn>({ question, status: 'pending' }).value;
	// Follow-ups are not context-free, so only a conversation's first question goes to Recent.
	// Judged by the context sent, not the transcript: a retry after a first-question error counts.
	if (startsConversation(context.length)) remember(question);
	turns.value.push(turn);
	input.value = '';
	await scrollToEnd();

	try {
		const { data } = await api.post('/d1-ask/chat', { messages });
		turn.reply = data.reply ?? null;
		turn.sql = data.sql;
		turn.columns = data.columns ?? [];
		const rows = data.rows ?? [];
		turn.rows = rows;
		turn.rowCount = data.row_count ?? rows.length;
		turn.truncated = data.truncated === true;
		turn.chart = data.chart ?? null;
		turn.status = 'done';
	} catch (err: any) {
		const d = err?.response?.data;
		turn.status = 'error';
		if (d?.sql) turn.sql = d.sql;
		const e = explainError(
			err?.response?.status,
			d,
			err?.message || 'The request failed.',
		);
		turn.error = e.message;
		turn.detail = e.detail;
		turn.suggest = e.suggest;
	}
	await scrollToEnd();
}

function downloadCsv(turn: Turn) {
	if (!turn.columns || !turn.rows) return;
	const blob = new Blob([toCsv(turn.columns, turn.rows)], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = csvFilename(turn.question);
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copySql(turn: Turn) {
	if (!turn.sql) return;
	turn.copied = (await copyText(turn.sql)) ? 'ok' : 'fail';
	setTimeout(() => {
		turn.copied = undefined;
	}, 2000);
}
</script>

<template>
	<private-view title="Ask the Database">
		<div class="ask-db">
			<div ref="scroller" class="transcript">
				<div v-if="turns.length === 0">
					<p class="hint">
						Ask a question about your lab data in plain English. Answers run as
						guarded, read-only queries; follow-up questions refine the previous
						one. Click an example to try it:
					</p>
					<ExampleChips :disabled="busy()" @pick="submit" />
					<QuestionList
						title="Saved"
						test-id="ask-saved"
						:items="saved"
						:disabled="busy()"
						@run="submit"
						@remove="unsave"
					/>
					<QuestionList
						title="Recent questions"
						test-id="ask-history"
						:items="asked"
						:disabled="busy()"
						@run="submit"
						@remove="forget"
					/>
				</div>

				<div v-for="(turn, i) in turns" :key="i" class="turn">
					<div class="question">{{ turn.question }}</div>

					<div v-if="turn.status === 'pending'" class="pending">Thinking…</div>

					<div v-else-if="turn.status === 'error'" class="answer error">
						<p>{{ turn.error }}</p>
						<p v-if="turn.detail" class="detail" data-test="ask-detail">
							{{ turn.detail }}
						</p>
						<ExampleChips v-if="turn.suggest" :disabled="busy()" @pick="submit" />
						<details v-if="turn.sql" data-test="ask-sql">
							<summary>Rejected SQL</summary>
							<pre>{{ turn.sql }}</pre>
						</details>
					</div>

					<!-- A plain conversational reply (greeting / off-topic): no table. -->
					<div v-else-if="turn.reply" class="answer">
						<p class="reply" data-test="ask-reply">{{ turn.reply }}</p>
					</div>

					<div v-else class="answer">
						<div class="actions" data-test="ask-actions">
							<button
								type="button"
								class="action"
								data-test="ask-csv"
								:disabled="!turn.rows || turn.rows.length === 0"
								@click="downloadCsv(turn)"
							>
								Download CSV
							</button>
							<button
								v-if="turn.sql"
								type="button"
								class="action"
								data-test="ask-copy-sql"
								@click="copySql(turn)"
							>
								{{
									turn.copied === 'ok'
										? 'Copied'
										: turn.copied === 'fail'
											? 'Copy failed'
											: 'Copy SQL'
								}}
							</button>
							<button
								type="button"
								class="action"
								data-test="ask-save-question"
								:aria-pressed="hasQuestion(saved, turn.question)"
								@click="toggleSaved(turn.question)"
							>
								{{ hasQuestion(saved, turn.question) ? 'Saved' : 'Save question' }}
							</button>
							<span v-if="saveNotice" class="save-notice" role="status" data-test="ask-save-notice">{{ saveNotice }}</span>
						</div>

						<details v-if="turn.sql" class="sql" data-test="ask-sql">
							<summary>SQL</summary>
							<pre>{{ turn.sql }}</pre>
						</details>

						<ChartPanel
							v-if="turn.chart && turn.rows && turn.rows.length"
							:spec="turn.chart"
							:rows="turn.rows"
						/>

						<div class="table-wrap" data-test="ask-table">
							<p v-if="!turn.rows || turn.rows.length === 0" class="hint">
								No rows.
							</p>
							<table v-else>
								<thead>
									<tr>
										<th v-for="col in turn.columns" :key="col">{{ col }}</th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="(row, r) in turn.rows" :key="r">
										<td v-for="col in turn.columns" :key="col">
											{{ csvCell(row[col]) }}
										</td>
									</tr>
								</tbody>
							</table>
						</div>
						<p v-if="turn.truncated" class="hint truncated" data-test="ask-truncated">
							Showing the first {{ turn.rowCount }} rows. Ask for something more
							specific (a filter or a count) to see the rest.
						</p>
					</div>
				</div>
			</div>

			<form class="composer" @submit.prevent="submit()">
				<input
					v-model="input"
					data-test="ask-input"
					type="text"
					placeholder="Ask a question about your data…"
					:disabled="busy()"
					autocomplete="off"
				/>
				<button data-test="ask-submit" type="submit" :disabled="busy() || !input.trim()">
					Ask
				</button>
			</form>
		</div>
	</private-view>
</template>

<style scoped>
.ask-db {
	display: flex;
	flex-direction: column;
	height: calc(100vh - 60px);
	padding: 0 32px 24px;
	max-width: 1100px;
}
.transcript {
	flex: 1;
	overflow-y: auto;
	padding: 16px 0;
}
.hint {
	color: var(--theme--foreground-subdued, #6c7789);
}
.turn {
	margin-bottom: 28px;
}
.question {
	font-weight: 600;
	font-size: 16px;
	margin-bottom: 10px;
	color: var(--theme--foreground, #2f3a4c);
}
.pending {
	color: var(--theme--foreground-subdued, #6c7789);
	font-style: italic;
}
.answer.error p {
	color: var(--theme--danger, #e35169);
}
.answer.error p.detail {
	color: var(--theme--foreground-subdued, #6c7789);
	font-size: 13px;
}
.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-bottom: 8px;
}
.action {
	padding: 4px 12px;
	border: 1px solid var(--theme--border-color, #d3dae4);
	border-radius: 6px;
	background: var(--theme--background, #fff);
	color: var(--theme--foreground, #2f3a4c);
	font-size: 13px;
	cursor: pointer;
}
.action:hover:not(:disabled) {
	border-color: var(--theme--primary, #6644ff);
	color: var(--theme--primary, #6644ff);
}
.save-notice {
	align-self: center;
	font-size: 13px;
	color: var(--theme--danger, #e35169);
}
.action:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.truncated {
	margin-top: 8px;
	font-size: 13px;
}
.sql summary {
	cursor: pointer;
	color: var(--theme--foreground-subdued, #6c7789);
}
pre {
	background: var(--theme--background-subdued, #f4f5f7);
	padding: 12px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 13px;
}
.table-wrap {
	margin-top: 12px;
	overflow-x: auto;
	border: 1px solid var(--theme--border-color-subdued, #e0e2e7);
	border-radius: 6px;
}
table {
	border-collapse: collapse;
	width: 100%;
	font-size: 13px;
}
th,
td {
	text-align: left;
	padding: 8px 12px;
	border-bottom: 1px solid var(--theme--border-color-subdued, #e0e2e7);
	white-space: nowrap;
}
th {
	background: var(--theme--background-subdued, #f4f5f7);
	font-weight: 600;
}
.composer {
	display: flex;
	gap: 8px;
	padding-top: 12px;
	border-top: 1px solid var(--theme--border-color-subdued, #e0e2e7);
}
.composer input {
	flex: 1;
	padding: 10px 14px;
	border: 2px solid var(--theme--border-color, #d3dae4);
	border-radius: 8px;
	font-size: 15px;
	background: var(--theme--background, #fff);
	color: var(--theme--foreground, #2f3a4c);
}
.composer input:focus {
	outline: none;
	border-color: var(--theme--primary, #6644ff);
}
.composer button {
	padding: 10px 22px;
	border: none;
	border-radius: 8px;
	background: var(--theme--primary, #6644ff);
	color: #fff;
	font-weight: 600;
	cursor: pointer;
}
.composer button:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
</style>
