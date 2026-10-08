import { describe, expect, it } from 'vitest';
import { projectInvestigatorFilter, projectsMine } from './mine';

describe('projectInvestigatorFilter', () => {
	it('is "this project" AND "I am its PI or an investigator"', () => {
		expect(projectInvestigatorFilter('p1')).toEqual({ _and: [{ project_id: { _eq: 'p1' } }, projectsMine] });
		const mine = JSON.stringify(projectsMine);
		expect(mine).toContain('principal_investigator_person');
		expect(mine).toContain('secondary_investigators');
		expect(mine).toContain('$CURRENT_USER');
	});
});
