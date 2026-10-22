// The Inbox API's payload types (FoundFile and the rest). Types only, kept apart from inboxApi.ts (the calls, and the readers of what the server sent),
// which re-exports them all so no import elsewhere changes.

/** What kind of thing the crawler thinks a found file is (file_candidates.kind). */
export type FileKind = 'sem_image' | 'surface_scan' | 'image' | 'document' | 'other';
export type MatchStrength = 'short_id' | 'code' | 'edge_code' | 'none';
/** The tabs. `older` is the backlog (origin = 'backlog', state = 'new'); `linked` and `dismissed` are the states of those names. */
export type InboxTab = 'new' | 'older' | 'linked' | 'dismissed';
export type LinkKind = 'manual' | 'bulk' | 'auto';

/** One record a file's path names (file_candidates.matches). `via` is how it was named: 'short_id', 'code' or 'edge_code'. */
export interface FileMatch {
	collection: string;
	record_id: string;
	via: string;
	token: string;
}

/** Whose Inbox a file is in: a person (their personal folder) or a team (its team folder). A bare name is read as a person. */
export interface FileOwner {
	kind: 'person' | 'team';
	id: string | null;
	name: string;
}

/**
 * One found file, as GET /d1-inbox/files returns it: the d1_private.file_candidates columns the page uses, plus labels the server resolves
 * (the page never reads another table to name a record). Dates are ISO strings. `extracted` holds only what the crawler actually read:
 * an SEM image's imaging settings (see semSettings.ts): `kv`, `magnification`, `scale_bar_um` (older rows: the text `scale_bar`), `instrument`, and more, with their `sources` and `flags`.
 */
export interface FoundFile {
	candidate_id: string;
	/** The directus_files pointer row. Directus cannot serve its bytes (storage 'star'), so the page never draws a picture from it (see has_thumbnail). */
	directus_files_id: string;
	/** The file's name (directus_files.filename_download, else the last part of rel_path). */
	name?: string;
	mime_type?: string | null;
	/** True once a person linked this document or other file and the crawler may read it to fingerprint it. */
	adopted?: boolean;
	kind: FileKind;
	kind_confidence: number | null;
	extracted: Record<string, unknown>;
	origin: 'new' | 'backlog';
	state: 'new' | 'linked' | 'dismissed' | 'gone';
	match_strength: MatchStrength;
	matches: FileMatch[];
	suggested_collection: string | null;
	suggested_record_id: string | null;
	/** Server-resolved name of the suggested record ("S-0042"), or null when the caller cannot read it. */
	suggested_label: string | null;
	/** Present when a suggestion is: false when the caller may not edit the suggested record (so Link would be refused). */
	suggested_can_edit?: boolean;
	duplicate_of: string | null;
	/**
	 * Whose Inbox the original is in, for "copy of a file in ...": null when the row is not a copy; the name when the original is in the
	 * caller's own folder, one of their teams, or the caller is an administrator; otherwise { kind: 'other' } with no name (D11).
	 */
	duplicate_of_owner?: string | { kind: 'other' } | null;
	rel_path: string;
	size_bytes: number | null;
	source_mtime: string | null;
	first_seen_at: string | null;
	decided_at: string | null;
	link_kind: LinkKind | null;
	link_batch_id: string | null;
	/** Linked tab: the record the file was linked to, with a server-resolved label. */
	linked_collection?: string | null;
	linked_record_id?: string | null;
	linked_label?: string | null;
	/** Linked tab: the linked record's second line as the caller may read it (a sample's nickname, a test's type); null for an operation or when unreadable. */
	linked_title?: string | null;
	/** Linked tab: how many files the row's link batch holds. An Undo undoes the whole batch. Null when the row is not linked. */
	link_batch_size?: number | null;
	/** Linked rows: would an Undo (and so a Change) of this link work for the caller now: they linked it, or are an administrator who may change the file. Absent from an older server: read as yes. */
	can_undo?: boolean;
	/** Linked tab, a file added as a surface scan: the insert or the edge it was added to (the other is null). Absent on any other row. */
	linked_insert_id?: string | null;
	linked_edge_id?: string | null;
	/** Optional: the person (login name) who decided it. */
	decided_by_name?: string | null;
	owner: FileOwner;
	/**
	 * The crawler stored a small picture of this file (an image or SEM image), served by GET /d1-inbox/files/<id>/thumb and /preview. An older
	 * server leaves the field out: that reads as false.
	 */
	has_thumbnail: boolean;
}

/**
 * GET /d1-inbox/files query. Every key is optional and sent only when set.
 *  - tab: new | older | linked | dismissed (default new)
 *  - kind: comma list of kinds
 *  - folder: text the folder part of rel_path contains (case-insensitive)
 *  - from, to: YYYY-MM-DD, on the file's own date (source_mtime, else first_seen_at), both ends included
 *  - owner: 'me' (my personal folder) or 'team:<team_id>'; omitted = everything the caller may see
 *  - strength: comma list of match strengths
 *  - link_kind: manual | bulk | auto (the "Recently auto-linked" list asks tab=linked&link_kind=auto)
 *  - limit, offset: paging
 */
export interface FilesQuery {
	tab?: InboxTab;
	kind?: string;
	folder?: string;
	from?: string;
	to?: string;
	owner?: string;
	strength?: string;
	link_kind?: LinkKind;
	/** 1 on a list's first page: the answer carries meta.acceptable, how many of the matching files Accept all would link. */
	acceptable?: 0 | 1;
	limit?: number;
	offset?: number;
}

/** GET /d1-inbox/siblings: the other pictures linked to the same record as a file, newest link first, and how many there are in all. */
export interface SiblingsPage {
	rows: FoundFile[];
	total: number;
}

export interface FilesPage {
	rows: FoundFile[];
	/** Rows the query matches in all (the page shows one page of them). */
	total: number;
	/** Optional: how many of the matching rows Accept all would link (server-evaluated); the page estimates from the rows when absent. */
	acceptable: number | null;
}

export interface LinkItem {
	candidate_id: string;
	collection: string;
	record_id: string;
}
/**
 * A surface scan added from the Inbox (spec section 8, as built by stream F1): exactly one of insert_id and edge_id, a condition the person
 * chose (required, never defaulted), and optionally the operation, the day, a condition note (500 characters) and notes (2000). It has no record_id.
 */
export interface ScanLinkItem {
	candidate_id: string;
	collection: 'surface_scans';
	insert_id?: string;
	edge_id?: string;
	condition: 'new' | 'worn' | 'cleaned' | 'other';
	operation_id?: string;
	scanned_on?: string;
	condition_note?: string;
	notes?: string;
}
/** One link made (or, in a dry run, that would be): the file, the record, and the junction row it made. */
export interface LinkedItem {
	candidate_id: string;
	collection: string;
	record_id: string;
	/** Optional: the server-resolved code of the record ("S-0042"). */
	label?: string | null;
	junction_id?: string;
	adopted?: boolean;
	already_linked?: boolean;
	/** A surface scan item: record_id is the new scan's id; these name the insert or edge it was added to (the other is null). */
	insert_id?: string | null;
	edge_id?: string | null;
}
export interface LinkResult {
	link_batch_id: string;
	/** How many files were linked. */
	linked: number;
	items: LinkedItem[];
}
/** Why Accept all left a file for the person (the endpoint's codes): SURFACE_SCAN, NOT_EDITABLE, ALREADY_ON_RECORD, COPY, NOT_NEW... */
export interface Skipped {
	candidate_id: string;
	reason: string;
}
export interface AcceptAllResult extends LinkResult {
	skipped: Skipped[];
	/** How many files were left in all: `skipped` lists at most the first 200 of them. */
	skippedTotal: number;
	/** More files matched than one run takes (500): run it again after this one. */
	has_more: boolean;
	/** A dry run: nothing was linked; `acceptable` is what a real run would link. */
	dry_run: boolean;
	/** The count a dry run answers (`count`, or `acceptable` in the first draft); for a real run, what it linked. */
	acceptable: number;
	/** The files a dry run would link (`ids`, or the candidate_ids of its `items`): Confirm can ask for exactly these. */
	ids: string[];
}
export interface AcceptOptions {
	dryRun?: boolean;
	/** Link exactly these files (the ones a dry run listed), when the endpoint takes them. */
	candidateIds?: string[];
}

export interface InboxPrefs {
	auto_link: boolean;
}

/** One ignored-folder rule: `folder` is relative to the owner's root (never starts with Users/<alias> or Shared/<folder>). */
export interface IgnoredRule {
	ignored_id: string;
	folder: string;
	owner: FileOwner;
	created_at: string | null;
	/** False for a Lab Viewer (they may read the rules, not remove them). */
	can_remove: boolean;
}
/** The rules the caller may see, and whether they may change them (meta.can_change; null from an older server that does not say). */
export interface IgnoredList {
	rules: IgnoredRule[];
	canChange: boolean | null;
}
/** What adding a rule answers: how many open files below the folder moved to Dismissed. */
export interface IgnoredAdded {
	ignored_id: string;
	folder: string;
	team_id: string | null;
	dismissed: number;
}
export interface IgnoredRemoved {
	ignored_id: string;
	folder: string;
	/** Whether a rescan was queued (the rescan limit may say wait; the removal worked either way). */
	rescan_queued: boolean;
	/** True when another rule of the same owner still covers the folder: the folder stays ignored and no rescan was queued. False from an older server. */
	still_ignored: boolean;
}

export interface CrawlerStatus {
	desired_state: string | null;
	interval_minutes: number | null;
	/** The endpoint's own verdict from the heartbeat (5-minute rule): alive, paused, stale (no recent heartbeat), never (none yet). */
	daemon: 'alive' | 'paused' | 'stale' | 'never' | null;
	last_heartbeat_at: string | null;
	daemon_started_at: string | null;
	current_activity: string | null;
	last_scan_started_at: string | null;
	last_scan_finished_at: string | null;
	files_registered: number;
	error_count: number;
	last_error: string | null;
}
export interface PersonWithoutAlias {
	person_id: string;
	full_name: string;
	/** The list is of active people; a Former person is not scanned unless scan_while_former is on. */
	active: boolean;
	/** Whether the person has a login (a person with none will not open the Inbox). */
	has_login: boolean;
}
export interface ScanError {
	at: string | null;
	message: string;
}
/** GET /d1-inbox/admin: inbox_crawler_state, the folders under Users/ and Shared/ that match no one, and the people with no alias. */
export interface InboxAdmin {
	status: CrawlerStatus;
	/** Recent failures (failed scan requests, scan aborts); status.last_error is the latest. Optional. */
	errors: ScanError[];
	/** Share-relative paths ("Users/zz9", "Shared/Old project") of folders no alias or share folder names. */
	unmatched_folders: string[];
	people_without_alias: PersonWithoutAlias[];
	/** Scan requests waiting for the daemon (queued plus running). */
	queued_requests: number;
	queue: { queued: number; running: number };
	/** File candidates by state ({ new, linked, dismissed, gone }). */
	candidates: Record<string, number>;
}
