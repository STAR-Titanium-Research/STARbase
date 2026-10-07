// One cached computed per key (here: per Signals panel). A template calls the returned function on
// every render; the value is only rebuilt when something `build` actually read has changed, and is
// otherwise the SAME object -- so a child given it as a prop sees no change.
//
// Used for the Plot page's chart inputs (#100): chartsFor() used to allocate a fresh compare array
// and radial Float32Array per axis on every render, and the page re-renders on every mouse move
// (the shared hover index), which handed every ForceChart "new" props and made each recompute its
// whole O(N) geometry per mouse move.
import { computed, type ComputedRef } from 'vue';

export function perKeyComputed<K extends object, V>(keyOf: (k: K) => string, build: (k: K) => V): (k: K) => V {
	const cache = new Map<string, { owner: K; value: ComputedRef<V> }>();
	return (k) => {
		const key = keyOf(k);
		let hit = cache.get(key);
		// A different object under the same key (the panel list was rebuilt) must not keep serving
		// the old one's closure.
		if (!hit || hit.owner !== k) {
			hit = { owner: k, value: computed(() => build(k)) };
			cache.set(key, hit);
		}
		return hit.value.value;
	};
}
