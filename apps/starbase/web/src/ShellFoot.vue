<script setup lang="ts">
import { computed } from 'vue';
import { NavIcon, usePins, type NavIconName } from '@d1/ui';
import { getConfig } from './config';
import { useApp } from './context';
import { userLabel } from './shellView';
import { THEME_LABELS, nextTheme } from './appearance';

// The sidebar's foot (the desktop sidebar, the overlay and the phone sheet): who is signed in, the Settings
// gear, a theme toggle, Data Studio in a new tab and Sign out. `compact` is the rail's: icons only, each
// with its name as aria-label and tooltip (Settings, Data Studio, Sign out; the theme is set in Settings).
defineProps<{ compact?: boolean }>();
const { session } = useApp();
const { prefs, setPref } = usePins();
const studioHref = `${getConfig().directusUrl}/admin`;

const THEME_ICONS: Record<'system' | 'light' | 'dark', NavIconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const theme = computed(() => prefs.value.theme);
const themeName = computed(() => `Theme: ${THEME_LABELS[theme.value]}. Change to ${THEME_LABELS[nextTheme(theme.value)]}`);

// A full document load, not a router.replace: nothing of this user (plotter caches, an in-flight admin
// read, the Explorer host) may survive into the next sign-in on this tab.
async function signOut() {
	await session.signOut();
	window.location.assign('/signin');
}
</script>

<template>
	<div v-if="compact" class="sb-foot rail">
		<router-link to="/settings" class="sb-foot-btn" aria-label="Settings" title="Settings"><NavIcon name="settings" :size="18" /></router-link>
		<a :href="studioHref" target="_blank" rel="noopener" class="sb-foot-btn" aria-label="Data Studio (new tab)" title="Data Studio (new tab)"><NavIcon name="external-link" :size="18" /></a>
		<button type="button" class="sb-foot-btn" aria-label="Sign out" title="Sign out" @click="signOut"><NavIcon name="log-out" :size="18" /></button>
	</div>
	<div v-else class="sb-foot">
		<div class="sb-foot-top">
			<span class="sb-user" :title="userLabel(session.user.value)">{{ userLabel(session.user.value) }}</span>
			<button type="button" class="sb-foot-btn" :aria-label="themeName" :title="themeName" data-test="theme-toggle" @click="setPref('theme', nextTheme(theme))">
				<NavIcon :name="THEME_ICONS[theme]" :size="18" />
			</button>
			<router-link to="/settings" class="sb-foot-btn" aria-label="Settings" title="Settings"><NavIcon name="settings" :size="18" /></router-link>
		</div>
		<div class="sb-foot-links">
			<a :href="studioHref" target="_blank" rel="noopener" class="sb-foot-link"><NavIcon name="external-link" :size="14" />Data Studio</a>
			<button type="button" class="sb-foot-link" @click="signOut"><NavIcon name="log-out" :size="14" />Sign out</button>
		</div>
	</div>
</template>

<style scoped>
.sb-foot {
	margin-top: auto; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 12px; flex: none;
	border-top: 1px solid var(--d1-side-hairline); font-size: var(--fs-sm, 12px); color: var(--d1-side-dim);
}
.sb-foot.rail { align-items: center; gap: 4px; padding: 8px 0 12px; }
.sb-foot-top { display: flex; align-items: center; gap: 2px; }
.sb-user { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--d1-side-text); font-weight: 600; }
.sb-foot-links { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sb-foot-btn {
	display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px; border: 0; border-radius: 8px;
	background: none; color: var(--d1-side-dim); cursor: pointer; text-decoration: none;
}
.sb-foot-btn:hover { background: var(--d1-side-hover); color: var(--d1-side-text); }
.sb-foot-btn.router-link-active { background: var(--d1-side-current); color: #fff; }
.sb-foot-link {
	display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px; border: 0; border-radius: 6px; background: none;
	font: inherit; color: var(--d1-side-dim); text-decoration: none; cursor: pointer;
}
.sb-foot-link:hover { background: var(--d1-side-hover); color: var(--d1-side-text); }
.sb-foot-btn:focus-visible, .sb-foot-link:focus-visible { outline: 2px solid var(--d1-side-bar); outline-offset: 1px; }
</style>
