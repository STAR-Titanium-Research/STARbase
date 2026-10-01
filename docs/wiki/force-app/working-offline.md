# Working offline

[← Force App wiki](README.md)

The Force App is meant for an acquisition PC that is often off the network. With no connection to
the database you can still **sign in, record, look at local captures and save**; everything that
has to reach the database waits, and is sent later **under the name of the person who recorded it**.

| Offline… | Works? |
|---|---|
| Sign in | yes, for an account that has signed in on this PC before (see below) |
| Record, stop, finalize, crash recovery, live backup catch-up | yes (none of it needs the database) |
| Pick Sample / Operator / Machine / Tool / Insert / Edge | yes, from a copy kept on this PC |
| View a cut on **Plot → Local capture** | yes |
| Edit a local capture's metadata | yes |
| Upload to the database, Plot/Replay of database cuts | no: waits for a connection |

## Signing in offline

Directus is the only account system and never hands its password hashes out, so the app keeps its
own small verifier: each time you sign in **online**, it stores a salted PBKDF2 hash of the password
you typed, plus your profile (name, role, linked person). Offline, typing the same password checks
against that hash.

- Only accounts that have signed in **on this PC** can sign in offline. There is no list of
  everyone's logins on the PC.
- It lasts **30 days** from the last time the server vouched for the account: an online sign-in, or
  the app renewing its session in the background. After that, sign in once while connected to renew it.
- Forgetting or revoking an account also ends an offline session already open for it, at the next
  page change (never mid-page, so a cut in progress is not interrupted).
- If an online sign-in is refused for a password that was still accepted locally (it was changed, or
  the account disabled), the offline entry is deleted straight away.
- After 5 wrong offline attempts each further attempt waits twice as long (up to 5 minutes).
- **Settings → Connectivity → Working offline** lists who can sign in offline and lets you **Forget**
  an account on this PC.

An offline session has no Directus token, so nothing can be written to the database. A banner at the
top says so. Once you are connected, **Sign in to sync** asks for your password again, which gives the
session its token; queued records then upload. It never sends you to the login page mid-recording.

## Who a recording belongs to

When you press Start, the app stamps the cut with who is signed in and when: your account, name,
linked person (`people.person_id`), whether you were signed in offline, and the start time. These go
into the capture's `summary.json` and from there into the database record, however much later it is
uploaded:

- the operation's **owner** is the person who recorded it, not whoever uploads it. If the person link
  wasn't known when you recorded (the lookup can fail), it is looked up from your account at upload
  time; if that lookup fails the upload waits rather than crediting the uploader;
- the **operation date** is when it was recorded, not when it was uploaded;
- `recorded_metadata` holds `recorded_by_*` and `recorded_offline`, and `synced_by_*` / `synced_at`
  for whoever performed the upload. (`audit_logs.actor_identity` still names the account that made
  the write; that is the truthful "who uploaded".)

A record waiting in the offline queue uploads by itself **only when its recorder is signed in**. If
someone else signs in on the same PC, it stays put (the sidebar chip says so). They can upload it
deliberately from **Settings → Local Captures → Upload as me**; it still carries the original
recorder and owner. Uploading a local capture that someone else recorded asks the same question first.

Captures recorded before v0.1.32 have no stamp. They upload as before: dated at upload time and
owned by whoever uploads them.

## Picker data

While connected the app keeps a copy of the samples, operators, machines, tools, inserts, edges and
methods (in the browser's IndexedDB). It refreshes after you sign in, when the connection returns
and every few hours. If it can't reach the database, or you are signed in offline, the pickers search
that copy instead. **Settings → Connectivity → Working offline** shows when it was last updated and
has **Refresh now**. A PC that has never been connected has nothing to search; connect and sign in once.

## Limits worth knowing

- The copy of the password check is only as private as the PC: someone with the PC's files can try
  passwords against it offline (PBKDF2, 310,000 rounds). It is one salted hash per account that has
  signed in here, never a list of everyone. Use Windows account security on the acquisition PC.
- A sample created in the database while you are offline won't appear until the copy refreshes.
- In a normal browser over plain `http://` (not the desktop app, `https` or `localhost`) the browser
  has no crypto API, so offline sign-in is unavailable there; the desktop app is unaffected.
