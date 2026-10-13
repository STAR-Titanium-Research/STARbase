import { onBeforeUnmount, onMounted, ref } from 'vue';
import { shouldOpenFinder } from './finderNav';

// Ctrl/Cmd+K opens the finder, unless it is already open or a dialog is in front. Each host's frame
// uses this next to <ExplorerNav> and <Finder>.
export function useFinderShortcut() {
	const finderOpen = ref(false);
	const onKey = (e: KeyboardEvent) => {
		if (shouldOpenFinder(e, finderOpen.value, document)) finderOpen.value = true;
	};
	onMounted(() => window.addEventListener('keydown', onKey));
	onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
	return { finderOpen, openFinder: () => void (finderOpen.value = true), closeFinder: () => void (finderOpen.value = false) };
}
