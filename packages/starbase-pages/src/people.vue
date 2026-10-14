<script setup lang="ts">
// The People page lives in ./people/PeopleView.vue; this wrapper keeps the page's file name for routes.ts and index.ts.
import PeopleView from './people/PeopleView.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
	<PeopleView v-bind="$attrs" />
</template>
