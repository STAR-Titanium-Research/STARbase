<script setup lang="ts">
import { useRouter } from 'vue-router';
import { FastDashboard, conformProfile, setFastHost } from '@d1/fast-plotting';
import { useApp } from '../context';
import PhoneNote from './PhoneNote.vue';
import { starbaseFastHost } from './plotHosts';

// /plot/conform?operation=<id>: the run plotter with the Conform profile (the same host and client as FAST).
const { api } = useApp();
setFastHost(starbaseFastHost({ api, router: useRouter() }));
</script>

<template>
	<PhoneNote />
	<FastDashboard :profile="conformProfile" />
</template>
