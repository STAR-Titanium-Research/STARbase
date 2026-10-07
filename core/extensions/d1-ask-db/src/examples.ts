/**
 * Example questions shown as chips on the empty chat and after a guard rejection.
 *
 * Hand-picked from plugins/llm-text-to-sql/eval/questions.json (the curated gold
 * set the guard is checked against), worded exactly as there. Bundled here rather
 * than fetched: the eval file is not served to the browser. Questions that name
 * one specific sample or tool box are left out so every chip works on any data, and
 * so is the export-controlled listing (no row filter for it yet, ADR-0005).
 */
export interface ExampleGroup {
	topic: string;
	questions: string[];
}

export const EXAMPLE_QUESTIONS: ExampleGroup[] = [
	{
		topic: 'Samples',
		questions: [
			'Which samples weigh more than 50 grams? Show their code and mass.',
			'How many samples exist for each material name?',
		],
	},
	{
		topic: 'Tests',
		questions: ['Which test sessions produced files larger than 10 GB?'],
	},
	{
		topic: 'FAST',
		questions: ['Show manufacturing operations performed with the FAST method.'],
	},
	{
		topic: 'Tooling',
		questions: ['Which operations consumed a cutting insert edge?'],
	},
];
