<script setup lang="ts">
import ChecksSection from './ChecksSection.vue';
import { useEditRail } from './railContext';
import { useEditModeInjected } from './useEditMode';

// The rail's Checks (spec E5, §7.1): what is missing before Create, by card; a click selects the card. Only while a draft can be changed.
const edit = useEditModeInjected();
const rail = useEditRail();
</script>

<template>
	<ChecksSection v-if="edit?.editing.value && rail" :checks="edit.checks.value" :label-for="rail.labelFor" @select="rail.select" />
</template>
