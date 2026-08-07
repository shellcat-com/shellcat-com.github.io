---
title: 'The recon checklist is finished. Here is what replaced it.'
description: 'Subdomain enumeration and URL crawling found the low-hanging fruit. The bugs that pay now are hiding in JavaScript bundles, undocumented APIs, and authentication flows — places a checklist will never look. AI recon finds them.'
pubDate: 2026-08-07
tags: ['Recon', 'AI', 'Methodology']
---

The InfosecWriteups recon checklist has 13 sections. Subdomain enumeration with
Amass. DNS resolution with shuffledns. Live host detection with HTTPX. Visual
recon with Aquatone. URL crawling with Katana and Hakrawler. Historical URLs
with GAU and the Wayback Machine.

It is not wrong. Every tool on that list does exactly what it claims to do. I
still run most of them. The problem is simpler and more brutal than that: if
your recon output looks the same as every other hunter's recon output, you are
competing with every other hunter. And the programs have already triaged the
bugs that checklist recon finds.

The difference between finding 200 subdomains and finding the one that hosts an
unprotected GraphQL endpoint with introspection enabled is not a better
wordlist. It is not running Amass with different flags. It is not adding
another API key to your config file. It is **AI**. Not AI as an oracle that
tells you where the bugs are. AI as a component that reads the output of your
recon tools and finds the signal.

Here is what changed — and what the checklist will never tell you.

## The checklist is a fishing net. You need a spear.

Run the full checklist against a medium-sized program. You will get back: 800
subdomains, 320 live hosts, 1400 screenshots, and 60,000 URLs. Now what?

The checklist answer is "look at the screenshots, grep for interesting
parameters, test the login forms." That answer assumes you have 40 hours and
infinite attention. You don't. You have maybe four hours before the program's
attack surface expands under you. The checklist gives you a haystack and wishes
you luck.

AI recon gives you a classifier. Feed it 60,000 URLs and it tells you which 17
are worth opening in Burp. Feed it 320 live hosts and it tells you which 4 are
running different software than the main app — acquisition targets, forgotten
staging environments, internal tools accidentally exposed. Feed it the
JavaScript from those 4 hosts and it finds the admin API that nobody
documented.

The checklist collects. AI selects. That is the difference.

## Phase 1 — JavaScript bundle mining (this is where the money is)

The checklist tells you to `cat urls.txt | grep '.js'`. It does not tell you
what to do with the 3,400 `.js` files you just found. So most hunters don't do
anything. They collect the URLs, check the box, and move to the next section.

JavaScript bundle mining is the single highest-leverage recon activity in 2026.
Not because JavaScript is new. Because AI can now read a 5MB webpack bundle in
30 seconds and extract every endpoint, every feature flag, every hardcoded
token, every internal path — things a human would need two days to find.

Here is the actual workflow:

### 1. Collect every JS file

```bash
katana -u https://app.target.com -jc -kf all -em js | sort -u > js_urls.txt
gau target.com | grep '\.js' >> js_urls.txt
gospider -s https://app.target.com -o gospider_output
cat gospider_output/* | grep '\.js' | grep -oP 'https?://[^"'"'"']+\.js' >> js_urls.txt
```

The checklist stops here. Maybe you run `gf js` and call it done. The AI part
starts now.

### 2. Download and deobfuscate

```bash
mkdir js_dump && cd js_dump
cat ../js_urls.txt | sort -u | httpx -mc 200 -o live_js.txt
cat live_js.txt | while read url; do
  name=$(echo "$url" | md5)
  curl -s "$url" -o "$name.js"
done
```

### 3. Feed each bundle to an LLM with a structured prompt

This is the prompt that does the work. Not "analyze this JavaScript." That gets
you a summary. This gets you a data structure:

```text
You are analyzing a JavaScript bundle from {target_domain}.
Extract EVERYTHING an attacker could use. Return ONLY JSON.

Schema:
{
  "api_endpoints": ["/api/v2/users", "/internal/admin", ...],
  "graphql_endpoints": ["/graphql", ...],
  "hidden_routes": ["/admin/import", "/debug/state", ...],
  "feature_flags": ["beta_search", "admin_impersonation", ...],
  "api_keys": ["sk_live_...", "AIza...", "ghp_..."],
  "internal_hosts": ["internal-api.target.com", "10.0...", ...],
  "auth_endpoints": ["/oauth/authorize", "/sso/login", ...],
  "websocket_endpoints": ["wss://...", ...],
  "s3_buckets": ["bucket-name", ...],
  "comments_of_interest": ["TODO: remove before deploy", "FIXME: auth bypass", ...]
}

Rules:
- "api_endpoints": full paths, not fragments. Include query params if present.
- "hidden_routes": paths that don't appear in any navigation — import tools,
  debug panels, legacy endpoints, admin-only paths.
- "feature_flags": any boolean toggle that gates functionality. Especially
  anything containing "admin", "internal", "staff", "beta", "superuser".
- "api_keys": any string that looks like a credential. Google API keys, Stripe
  publishable keys, Mapbox tokens, GitHub tokens, AWS access keys. Include
  the full key.
- "comments_of_interest": comments that suggest something was rushed, hidden,
  or left in by accident. Security-relevant only.
- If you find nothing for a field, return []. Do not fabricate.
```

### 4. What you find vs. what the checklist finds

I have found the following in JavaScript bundles, every one of them missed by
checklist recon:

- **An undocumented `/api/internal-graphql` endpoint** with introspection
  enabled, serving full schema including mutations that let admins impersonate
  any user. The endpoint existed nowhere in the UI, nowhere in documentation,
  nowhere in robots.txt. It existed in exactly one place: a webpack chunk
  loaded only for admin-role users. The bundle was fetched client-side for
  *all* users — only the rendering was gated. The endpoint wasn't.

- **A Stripe secret key** (`sk_live_...`) in a vendor bundle. The key was
  committed in 2019, the bundle was minified, the minified variable was `a7b`,
  and no grep pattern in existence would have found it. An LLM reading the
  bundle top-to-bottom recognized it as a Stripe live secret key because it
  appeared next to `stripe.charges.create`.

- **A `staff_impersonate` feature flag** set to `false` in production but with
  the entire UI and API logic already built. The flag was a single string in a
  4.7MB main bundle. The LLM found it because it was trained to look for
  anything containing "admin", "staff", "impersonate", or "superuser."

- **An internal hostname** (`api-legacy.internal.target.com`) hardcoded in a
  service worker. The host was not in DNS, not in certificate transparency logs,
  not in any subdomain enumeration tool. It resolved only from inside the
  corporate VPN. But knowing it existed told me what to look for when the
  company acquired a smaller startup six months later — same hostname pattern,
  same infrastructure, more vulnerable.

The checklist cannot find any of these because the checklist does not read
code. It collects URLs. Reading is the thing that matters.

## Phase 2 — API surface mapping (the undocumented stuff)

The checklist says "crawl URLs with Katana and Hakrawler." That finds what the
UI links to. It does not find what the UI hides.

### API version enumeration

Most apps have `/api/v1/`, `/api/v2/`, and `/api/v3/`. The checklist finds v1
because the UI links to it. v2 and v3 might exist. v2 might have an endpoint
with no auth. v3 might have a debug parameter that bypasses rate limiting.

AI approach: feed the known API schema to an LLM and ask it to *predict* what
other versions and endpoints might exist based on naming conventions:

```text
Given these observed API endpoints from {target}:
[/api/v2/users, /api/v2/users/{id}, /api/v2/me, /api/v2/me/email,
 /api/v2/orders, /api/v2/orders/{id}, /api/v2/products]

Generate a list of potentially undocumented endpoints in the same API based on:
- REST naming convention consistency
- Common patterns in Node.js/Express APIs
- Endpoints that are often implemented but not exposed in UI
- v1/v3 version variants
- Internal/admin variants of the same resources

For each candidate, explain why it likely exists.
```

The output gives you a targeted wordlist — not the 10-million-line raft of
SecLists you were going to run anyway — maybe 40 endpoints. Test those 40.
Somewhere in that list is a `/api/v2/users/export` that dumps every user's PII
without pagination because the developer built it for an internal dashboard and
never documented it. The checklist would never find it because the checklist
only visits URLs it already knows about.

### GraphQL reconnaissance

The checklist says nothing about GraphQL. In 2026, ignoring GraphQL is
malpractice. Every SaaS product built after 2021 uses it somewhere.

The recon:

```bash
# Find GraphQL endpoints
echo "target.com" | waybackurls | grep -i graphql | sort -u
cat js_urls.txt | grep -i graphql | sort -u

# Try introspection
curl -s https://app.target.com/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{__schema{types{name,fields{name,args{name,type{name}}}}}}"}' \
  | jq '.data.__schema.types[] | select(.fields != null) | {name, fields: [.fields[].name]}'
```

If introspection is on — and it is, on almost every forgotten internal
GraphQL endpoint — you just got the complete data model. Every type, every
field, every mutation. Now feed that schema to an LLM:

```text
This is the full GraphQL introspection result from {target}.
Analyze it for security vulnerabilities:

1. Mutations that modify other users' data without ownership checks
2. Queries that accept user IDs or emails as arguments (potential IDOR)
3. Fields that return PII (email, phone, address) — trace back to queries
4. Mutations that change roles, permissions, or subscription tiers
5. Nested queries that could be used for data exfiltration
6. Deprecated fields still present in schema (often less hardened)

For each finding, provide the exact query/mutation name and the argument
that would exploit it.
```

The LLM is not finding the bug. It is reading the schema and pointing you at
the 12 most interesting queries out of 340. You test those 12. The checklist
does not even know GraphQL exists on the target.

## Phase 3 — Authentication surface mapping

The checklist covers subdomains. It does not cover the authentication
infrastructure spread across them. A medium-sized company might have:

- `sso.target.com` — centralized OAuth/OIDC provider
- `app.target.com` — main application (OAuth client)
- `admin.target.com` — admin panel (different auth, maybe basic or SAML)
- `api.target.com` — API gateway (JWT, maybe API keys)
- `dashboard.target.com` — analytics (Google OAuth, maybe passwordless)
- `status.target.com` — status page (no auth, but calls internal APIs)

Each of these is a separate authentication surface with its own flaws. The
checklist gives you the subdomains. It does not tell you how they authenticate.

AI recon for auth surfaces:

```text
For each of these hosts on {target}:
{host_list}

Visit the URL and determine:
1. How does this host authenticate users? (OAuth, SAML, password, SSO, JWT,
   API key, basic auth, none)
2. If OAuth: what is the redirect_uri pattern? Implicit or auth code flow?
   Is PKCE enforced?
3. If JWT: inspect a token from the browser. What algorithm? Is the signing
   key predictable?
4. If SAML: is the XML signature validated? Is the recipient checked?
5. Is there a password reset flow? On the same host or a different one?
6. Is there a registration flow? Open or invite-only?
7. Are there any POST endpoints that accept a user ID or email without
   authentication?

For each finding, provide the exact URL and request that demonstrated it.
Return structured JSON grouped by host.
```

What you get back is an authentication topology map. You now know that
`admin.target.com` uses SAML with a hardcoded test IdP still in the metadata,
or that `dashboard.target.com` accepts a `token` query parameter that bypasses
the Google OAuth flow entirely for "internal tool access."

The checklist was never going to tell you that because the checklist was never
going to look.

## Phase 4 — Recon that becomes a hypothesis

Every piece of recon output should produce a **testable hypothesis** about a
vulnerability. The checklist does not do this. It outputs lists. You stare at
lists. You eventually get bored and start testing random endpoints with random
payloads.

AI recon outputs hypotheses. Here is the pattern:

```text
Based on the following recon data from {target}:
- JS bundle analysis: {js_findings}
- API surface: {api_findings}
- Auth topology: {auth_findings}
- Live hosts: {host_list}

Generate a prioritized list of testable vulnerability hypotheses.
Each hypothesis must be:

1. Specific — name the exact endpoint, parameter, or behavior
2. Testable — describe the exact HTTP request that would prove or disprove it
3. Exploitable if true — state the impact in concrete terms (data exposed,
   account taken over, privilege escalated)

Format each hypothesis as:
{
  "hypothesis": "one sentence",
  "confidence": "low|medium|high",
  "test_request": "curl command or raw HTTP request",
  "expected_vulnerable_response": "what the response looks like if vulnerable",
  "expected_safe_response": "what the response looks like if not",
  "impact_if_true": "specific impact",
  "recon_source": "which piece of recon data generated this hypothesis"
}

Prioritize by: (impact * confidence). High-confidence IDOR with PII exposure
ranks above low-confidence open redirect. Do not generate hypotheses for known
informational issues (missing headers, CORS, rate limiting).
```

Feed this to a second model — the adversarial validator from the pipeline
post — and let it kill the weak ones before you waste a single Burp request.

The point is that you do not start testing until you have hypotheses. You do
not "explore." Exploration without hypothesis is browsing. Browsing does not
find bugs. Targeted testing against specific predictions finds bugs.

## The economics of AI recon

Running the full checklist takes roughly:

| Activity | Manual Time | AI-Assisted Time |
|---|---|---|
| Subdomain enumeration (Amass + brute force + GitHub + Shodan) | 45 min | 15 min (setup + review) |
| Live host detection + screenshots (HTTPX + Aquatone) | 20 min | 5 min (review flagged hosts) |
| URL crawling (Katana + Hakrawler + GAU + wayback) | 30 min | 10 min (targeted re-crawl of interesting paths) |
| JS bundle mining (download + read) | 8 hours (to actually READ 400 bundles) | 45 min (download + AI analysis) |
| API mapping (version enumeration + GraphQL introspection) | 3 hours | 30 min |
| Auth surface mapping | 2 hours | 25 min |
| Hypothesis generation | Not on the checklist | 15 min |
| **Total recon phase** | **~14 hours** | **~2.5 hours** |

The AI-assisted column is not "push a button and walk away." You still set up
the tools, still review the output, still sanity check anything that looks
weird. But you are reviewing structured findings, not raw lists. You are
testing hypotheses, not poking at URLs.

The cost: roughly $8–15 per engagement in API credits (Claude API, GPT-4o,
DeepSeek). If you hunt 12 programs a month, that is $96–180/month. It pays for
itself if it finds one extra Medium-severity bug per month. It routinely finds
more than that.

## Where the checklist still wins

Some things are deterministic and should stay deterministic:

- **DNS resolution.** shuffledns or massdns. No AI needed. It either resolves
  or it doesn't.
- **Port scanning.** nmap or rustscan. TCP either responds or it doesn't.
- **Screenshots.** Aquatone or gowitness. You need to see what's there. An LLM
  cannot look at a login page and tell you it is a Jenkins instance. (Yet.)
- **Certificate transparency logs.** crt.sh. This is database lookup, not
  analysis. Run it.
- **Technology fingerprinting.** Wappalyzer or whatweb. Deterministic pattern
  matching on HTTP headers and HTML. Do not ask an LLM what stack a site runs
  on — it will guess and be confidently wrong.

The rule: if the task is **collection**, use deterministic tools. If the task
is **selection** — picking the 12 interesting things out of 60,000 — use AI.
If the task is **analysis** — reading a JS bundle and finding the admin
endpoint — use AI. If the task is **resolution** — does this hostname resolve
to an IP — use a tool.

## What to actually run, in order

A complete AI-era recon run, annotated:

### Step 1 — Subdomain enumeration (deterministic, 15 min)
```bash
subfinder -d target.com -o subs.txt
assetfinder target.com >> subs.txt
amass enum -passive -d target.com >> subs.txt
# GitHub subdomains
github-subdomains -d target.com -t $GITHUB_TOKEN >> subs.txt
# Shodan
shodan domain target.com | jq -r '.subdomains[]' >> subs.txt
cat subs.txt | sort -u > subs_clean.txt
```

### Step 2 — Live host detection (deterministic, 5 min)
```bash
cat subs_clean.txt | httpx -mc 200,301,302,403 -title -tech-detect -o live_hosts.txt
```

### Step 3 — URL collection (deterministic, 10 min)
```bash
cat live_hosts.txt | awk '{print $1}' | katana -jc -kf all -o katana_urls.txt
gau --o gau_urls.txt target.com
cat katana_urls.txt gau_urls.txt | sort -u > all_urls.txt
```

### Step 4 — JS bundle extraction and AI analysis (the step that matters, 45 min)
```bash
cat all_urls.txt | grep '\.js' | sort -u | httpx -mc 200 -o live_js.txt
mkdir js_dump && cd js_dump
cat ../live_js.txt | while read url; do
  curl -s "$url" -o "$(echo "$url" | md5).js"
done
# Now feed each .js file to an LLM with the structured prompt from Phase 1.
# Batch process: one API call per bundle. 400 bundles × ~$0.002 each = $0.80.
```

### Step 5 — API surface and auth mapping (AI-assisted, 45 min)
```bash
# Find GraphQL endpoints
cat all_urls.txt | grep -i graphql | sort -u > graphql_candidates.txt
# Try introspection on each
cat graphql_candidates.txt | while read url; do
  curl -s "$url" -H 'Content-Type: application/json' \
    -d '{"query":"{__schema{types{name}}}"}' | jq -r '.data.__schema.types[:5][].name // empty'
done

# Feed live_hosts.txt to AI for auth topology analysis
# Feed the API endpoints from JS analysis for version enumeration
```

### Step 6 — Hypothesis generation (AI, 15 min)
Feed all recon output to the hypothesis generation prompt from Phase 4. Review
the output. Kill anything that looks like hallucination. You now have 10–30
testable vulnerability predictions, ranked by confidence × impact.

### Step 7 — Hunt
Test the hypotheses. Start at the top of the ranked list. Every one you kill
costs you maybe two minutes. Every one that survives is a finding.

## What this actually looks like in practice

I ran this pipeline against a program two weeks ago. Here is the timeline:

- **09:00** — Started subdomain enumeration. 743 subdomains.
- **09:15** — Live host detection. 201 live hosts. Flagged: `api-admin.target.com`
  (403), `internal.target.com` (200 but entirely different tech stack from
  main app).
- **09:30** — URL crawling complete. 41,000 URLs. JS filter: 810 `.js` files.
- **10:15** — JS bundle analysis complete. The AI flagged 14 findings. The one
  that mattered: an endpoint `/api/v1/internal/users/bulk-import` referenced in
  a webpack chunk comment: `// TODO: remove this before launch — @josh`.
- **10:30** — `/api/v1/internal/users/bulk-import` returned 401 without the
  right header. The admin panel at `api-admin.target.com` accepted a
  `X-Internal-Token: dev-2024` header (found in the SAME webpack chunk).
  `/api/v1/internal/users/bulk-import` with that header returned the full user
  table — 340,000 records, including email, phone, and hashed password.
- **10:45** — Report draft started. Impact: unauthenticated mass PII exposure
  via a hardcoded internal token committed to a public JavaScript bundle.

Total recon-to-report time: 1 hour 45 minutes. The checklist never found the
`api-admin` host because it was returning 403 to HTTPX at Step 2. The AI found
it because the JS bundle referenced it by name, and the AI read the bundle.

## The checklist didn't fail. It just stopped being enough.

Every hunter runs the same tools against the same targets. The programs have
already triaged the bugs those tools surface. The checklist found the
low-hanging fruit four years ago. It is still finding it now, but so is
everyone else, and the programs are patching it faster than you can report it.

The bugs that pay now are hiding where the checklist cannot look: inside
compiled code, inside undocumented APIs, inside authentication flows spread
across twelve subdomains. AI recon goes there. Not because AI is magical.
Because AI reads, and reading is the thing the checklist cannot do.

Recon is not collecting URLs. Recon is **knowing which three URLs to test**.
Everything else is preparation.
