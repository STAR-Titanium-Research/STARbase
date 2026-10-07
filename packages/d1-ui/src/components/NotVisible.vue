<script setup lang="ts">
// The page for a record that is missing or that the signed-in user may not read. The two look the
// same on purpose, so the page never confirms that a hidden record exists.
defineProps<{ what: string }>();
</script>

<template>
	<div class="d1-not-visible">
		<v-icon name="lock" large />
		<h2>Not found or not visible to you</h2>
		<p>This {{ what }} does not exist, or you do not have permission to see it.</p>
		<v-button to="/home">Back to Home</v-button>
	</div>
</template>

<style scoped>
.d1-not-visible {
	max-width: 520px;
	margin: 64px auto;
	text-align: center;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
}
.d1-not-visible :deep(.v-icon) { --v-icon-color: var(--theme--foreground-subdued); }
h2 { margin: 6px 0 0; font-size: 20px; }
p { margin: 0 0 12px; color: var(--theme--foreground-subdued); }
</style>
