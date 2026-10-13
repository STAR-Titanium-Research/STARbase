import { ref } from 'vue';

// Whether the camera scan dialog is open. Module-level on purpose: the Finder's Scan button and the
// Scan tile on Home are in different components, and ExplorerView (which hosts the dialog) is the
// one place that reads it, and clears it when the page goes away (ExplorerView.vue).
export const scanOpen = ref(false);
export const openScan = (): void => {
	scanOpen.value = true;
};
