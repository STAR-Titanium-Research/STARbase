import { createApp, h } from 'vue';
import { loadRuntimeConfig } from './config';

async function bootstrap() {
	await loadRuntimeConfig();
	createApp({ render: () => h('p', 'STARbase') }).mount('#app');
}
void bootstrap();
