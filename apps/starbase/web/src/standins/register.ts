import type { App, Component } from 'vue';
import VButton from './VButton.vue';
import VCard from './VCard.vue';
import VCardActions from './VCardActions.vue';
import VCardText from './VCardText.vue';
import VCardTitle from './VCardTitle.vue';
import VCheckbox from './VCheckbox.vue';
import VDialog from './VDialog.vue';
import VIcon from './VIcon.vue';
import VInput from './VInput.vue';
import VNotice from './VNotice.vue';
import VProgressCircular from './VProgressCircular.vue';
import VProgressLinear from './VProgressLinear.vue';
import VSelect from './VSelect.vue';
import VTextarea from './VTextarea.vue';
import { vTooltip } from './tooltip';

// The Directus global components the shared pages use, as STARbase's own (the inventory is in plan 2,
// Task 4). v-form and v-drawer are deliberately absent: EditDrawer uses the host's editor in STARbase.
export const STANDINS: Record<string, Component> = {
	'v-button': VButton, 'v-card': VCard, 'v-card-actions': VCardActions, 'v-card-text': VCardText, 'v-card-title': VCardTitle,
	'v-checkbox': VCheckbox, 'v-dialog': VDialog, 'v-icon': VIcon, 'v-input': VInput, 'v-notice': VNotice,
	'v-progress-circular': VProgressCircular, 'v-progress-linear': VProgressLinear, 'v-select': VSelect, 'v-textarea': VTextarea,
};

export function registerStandins(app: App): void {
	for (const [name, component] of Object.entries(STANDINS)) app.component(name, component);
	app.directive('tooltip', vTooltip);
}
