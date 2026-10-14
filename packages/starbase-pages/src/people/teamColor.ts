// The team palette keys (the teams table's teams_color_check) and the CSS class a chip uses for one. Task 6's TeamTile in @d1/ui may replace this.
export const TEAM_COLORS = ['teal', 'blue', 'indigo', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'slate'] as const;

/** The class for a palette key; an unknown key falls back to teal, the table's default. */
export const teamColorClass = (color: string | null | undefined): string => `c-${(TEAM_COLORS as readonly string[]).includes(color ?? '') ? color : 'teal'}`;
