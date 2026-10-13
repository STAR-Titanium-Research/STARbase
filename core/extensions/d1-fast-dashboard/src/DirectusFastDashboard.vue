<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { FastDashboard, setFastHost } from '@d1/fast-plotting';
import { recordRoute } from '@d1/ui';

// The Directus side of the FAST plotter's host contract; STARbase installs its own.
const api = useApi();
const router = useRouter();
setFastHost({ api, openRecord: (collection, id) => void router.push(recordRoute(collection, id)) });
</script>

<template>
	<FastDashboard />
</template>
