<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ForceDashboard, setForceHost } from '@d1/force-plotting';
import { getConfig } from '../config';
import { useApp } from '../context';
import PhoneNote from './PhoneNote.vue';
import { starbaseForceHost } from './plotHosts';

// /plot/force?operation=<id>: the shared Force plotter (the Force App's too). Its <private-view> is
// STARbase's PlainFrame (main.ts registers it under that name).
const { api, session, guard } = useApp();
setForceHost(starbaseForceHost({ api, session, guard, router: useRouter(), config: getConfig }));
</script>

<template>
	<PhoneNote />
	<ForceDashboard />
</template>
