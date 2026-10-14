<template>
	<private-view title="Lab Dashboard">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Lab Dashboard', to: '/d1-lab-dashboard/machining' }]" />
		</template>

		<template #title-outer:prepend>
			<v-button class="header-icon" rounded disabled icon secondary>
				<v-icon name="analytics" />
			</v-button>
		</template>

		<template #actions>
			<router-link to="/d1-lab-dashboard/samples">
				<v-button :secondary="!isSamples" small>Samples</v-button>
			</router-link>
			<router-link to="/d1-lab-dashboard/machining">
				<v-button :secondary="!isMachining" small>Machining</v-button>
			</router-link>
			<router-link to="/d1-lab-dashboard/fast">
				<v-button :secondary="!isFast" small>FAST</v-button>
			</router-link>
		</template>

		<router-view />
	</private-view>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const isMachining = computed(() => route.path.includes('machining'));
const isSamples = computed(() => route.path.includes('samples'));
const isFast = computed(() => route.path.includes('fast'));
</script>
