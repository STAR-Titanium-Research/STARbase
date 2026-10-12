# ADR-0013 — STARbase: its own tailnet device, sharing Directus's session

- **Status:** Accepted (2026-10-12)
- **Date:** 2026-10-12
- **Deciders:** Maintainer + Claude (STARbase detach interview,
  [spec](../superpowers/specs/2026-10-12-starbase-standalone-design.md))

STARbase (the app that grew as the "Explorer" inside the Directus `d1-home` module) gets **its own
tailnet device**, `starbase`, at `https://starbase.tail54eeb6.ts.net`. It is not a path on
d1-server like the Force App's `/app/`. It is a separate device so it can be shared, revoked and
eventually moved on its own, without changing d1-server's identity. STARbase **does not keep its
own token**. Its sign-in page posts to Directus in session mode, and from then on the browser
sends **Directus's session cookie** with every call STARbase makes to d1-server. **Editing** opens
a form-only Directus page in a frame. This works because `ts.net` is on the Public Suffix List
and the tailnet name is not, so `starbase.tail54eeb6.ts.net` and `d1-server.tail54eeb6.ts.net`
are the **same site**. Directus's `SameSite=Lax` cookies therefore travel in both directions: one
sign-in, one sign-out, and the framed form is already signed in.

## Considered options

- **A path on d1-server (`/explorer/`).** Simplest, because everything is same-origin. Rejected:
  it is not the app's own address, and STARbase could never move off d1-server without breaking
  every link.
- **A Tailscale Service (`svc:starbase`).** Rejected: d1-server would have to switch to a tag
  identity, which changes how the access rules see it, for no gain over a separate device.
- **A separate sign-in with a Bearer token, like the Force App.** Rejected: the framed Directus
  form would then ask the user to sign in a second time.
- **Proxying the Directus API through STARbase's own origin.** Rejected: the cookie would then
  belong to `starbase`, and Data Studio and the framed form would not see the session.

## Consequences

- The shared session depends on Tailscale's domain staying `<tailnet>.ts.net` and on `ts.net`
  staying a public suffix. A custom domain later must keep both hosts under one registrable domain.
- Directus must allow STARbase's origin with credentials (`CORS_ORIGIN` lists it exactly,
  `CORS_CREDENTIALS=true`). It must let STARbase frame the form page (the CSP `frame-ancestors`
  directive), and it must mark its cookies `Secure`. The plotting sidecars (`/filter`, `/diag`)
  need the same credentialed CORS.
- **SameSite no longer protects Directus from other `*.tail54eeb6.ts.net` devices.** A page on any
  device in the tailnet is same-site, so a cookie-carrying request from it is not blocked by
  SameSite. CORS still stops such a page from *reading* responses, but a blind form POST could
  carry the cookie. This is acceptable only because every tailnet device is trusted (the same
  posture as `/recorder` and `/backup-ingest`). Revisit if the tailnet ever admits untrusted
  devices.
- If Directus ignores the `frame-ancestors` setting, editing falls back to opening the form page
  in a new tab. Nothing else in this decision changes.
- Google sign-in later uses Directus's own provider in session mode, so it lands in the same
  shared session.
