<script setup lang="ts">
// Renders the shared dashboard. Its ForceHost is installed once at bootstrap (main.ts).
import { ForceDashboard } from '@d1/force-plotting';

// Named explicitly so AppShell.vue's <keep-alive include="StandaloneForceDashboard"> can target
// it reliably — the Plot route used to fully remount (refetching samples/operations/octrees) on
// every navigation to /plot, which is what made it feel like a full reload each time (#15).
defineOptions({ name: 'StandaloneForceDashboard' });
</script>

<template><ForceDashboard /></template>
