<script setup lang="ts">
import { useRouter } from 'vue-router';
import { FastDashboard, setFastHost } from '@d1/fast-plotting';
import { useApp } from '../context';
import PhoneNote from './PhoneNote.vue';
import { starbaseFastHost } from './plotHosts';

// /plot/fast?operation=<id> (spec §8 erratum 2): the shared FAST plotter.
const { api, session } = useApp();
setFastHost(starbaseFastHost({ api, session, router: useRouter() }));
</script>

<template>
	<PhoneNote />
	<FastDashboard />
</template>
