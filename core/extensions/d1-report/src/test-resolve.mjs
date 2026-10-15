// Test-only resolve hook: map the bundler-style extensionless './geometry' and './choiceLabels' to their .ts files.
export async function resolve(specifier, context, nextResolve) {
	if (specifier === './geometry' || specifier === './choiceLabels') {
		return nextResolve(`${specifier}.ts`, context);
	}
	return nextResolve(specifier, context);
}
