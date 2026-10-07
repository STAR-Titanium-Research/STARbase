<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import ConfirmDialog from './ui/ConfirmDialog.vue';

// Best-effort offline indicator (Phase 1). Plotting needs the network to reach Directus; when
// the browser reports offline we surface a clear banner rather than letting requests hang
// silently. (Full offline plotting — a local data mirror — is deferred to a later phase.)
const online = ref(navigator.onLine);
function setOnline() {
	online.value = true;
}
function setOffline() {
	online.value = false;
}

// The banner is position:fixed at the very top, so it would sit over anything else anchored there
// (the Record alarm overlay, the disk-action banners, the expanded nav rail, dialog headers).
// Those read --offline-banner-h (0px while online) as their top offset. The banner's height is
// measured, not assumed: the message wraps on a narrow window.
const bannerEl = ref<HTMLElement | null>(null);
let bannerObserver: ResizeObserver | null = null;
function publishBannerHeight() {
	const h = online.value ? 0 : (bannerEl.value?.offsetHeight ?? 0);
	document.documentElement.style.setProperty('--offline-banner-h', `${h}px`);
}
watch(online, async (on) => {
	bannerObserver?.disconnect();
	if (on) return publishBannerHeight();
	await nextTick();
	publishBannerHeight();
	if (bannerEl.value && typeof ResizeObserver !== 'undefined') {
		bannerObserver = new ResizeObserver(publishBannerHeight);
		bannerObserver.observe(bannerEl.value);
	}
});
onMounted(() => {
	if (!online.value) void nextTick(() => publishBannerHeight());
	window.addEventListener('online', setOnline);
	window.addEventListener('offline', setOffline);
});
onBeforeUnmount(() => {
	bannerObserver?.disconnect();
	document.documentElement.style.removeProperty('--offline-banner-h');
	window.removeEventListener('online', setOnline);
	window.removeEventListener('offline', setOffline);
});
</script>

<template>
	<div class="app-root">
		<transition name="fade">
			<div v-if="!online" ref="bannerEl" class="offline-banner">
				<span class="material-symbols-rounded">cloud_off</span>
				Offline — the database is unreachable. Plotting needs a connection; reconnect to continue.
			</div>
		</transition>
		<router-view />
		<!-- Single host for confirmAction(); mounted at the root so every route, including login,
			 can prompt without owning dialog markup. -->
		<ConfirmDialog />
	</div>
</template>

<style scoped>
.app-root {
	min-height: 100vh;
}
.offline-banner {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	padding: 8px 14px;
	font-size: var(--fs-md);
	font-weight: 600;
	color: #7c2d12;
	background: #fed7aa;
	border-bottom: 1px solid #fb923c;
}
.offline-banner .material-symbols-rounded {
	font-size: var(--icon-md);
}
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>
