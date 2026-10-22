<script setup lang="ts">
import { computed } from 'vue';
import { DataTable } from '@d1/ui';
import type { ProgressFolder } from './inboxApi';
import ScanBar from './ScanBar.vue';
import { loginText, measuresOf, sortFolders } from './progressModel';

// The admin tab's "Folders" table: every folder the crawler scans (people with a uni alias, teams with a share folder), largest first, with the owner, whether the
// person has a login, the number of files and the four scan progress measures (the same bar as the Inbox page's strip). The kit's DataTable draws the table.
const props = defineProps<{
	folders: ProgressFolder[];
	/** A full scan has finished at least once: only then is a low number a warning. */
	scanFinished: boolean;
}>();
const rows = computed(() => sortFolders(props.folders).map((f) => ({ folder: f, measures: measuresOf(f) })));
const HEADS = ['Folders listed', 'Images read', 'Thumbnails', 'SEM scale'];
</script>

<template>
	<DataTable data-test="scan-folders">
		<thead>
			<tr>
				<th>Owner</th>
				<th>Login</th>
				<th class="num">Files</th>
				<th v-for="h in HEADS" :key="h" class="num bar">{{ h }}</th>
			</tr>
		</thead>
		<tbody>
			<tr v-for="r in rows" :key="r.folder.owner.id" data-test="scan-folder-row">
				<td class="owner">
					<span class="name" data-test="scan-owner">{{ r.folder.owner.name }}</span>
					<span class="alias" :title="r.folder.owner.root">{{ r.folder.owner.folder }}</span>
				</td>
				<td class="dim login" data-test="scan-login">{{ loginText(r.folder) }}</td>
				<td class="num" data-test="scan-files">{{ r.folder.files.toLocaleString('en-GB') }}</td>
				<td v-for="m in r.measures" :key="m.key" class="num bar"><ScanBar :measure="m" :scan-finished="scanFinished" bare /></td>
			</tr>
		</tbody>
	</DataTable>
</template>

<style scoped>
th.bar, td.bar { min-width: 110px; }
.owner { min-width: 160px; }
.name { font-weight: 600; margin-right: 8px; }
.alias { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); overflow-wrap: anywhere; }
.login { font-size: var(--fs-sm, 12px); white-space: nowrap; }
</style>
