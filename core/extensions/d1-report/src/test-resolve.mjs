// Test-only resolve hook: map the bundler-style extensionless './geometry' to geometry.ts.
export async function resolve(specifier, context, nextResolve) {
	if (specifier === './geometry') {
		return nextResolve('./geometry.ts', context);
	}
	return nextResolve(specifier, context);
}
