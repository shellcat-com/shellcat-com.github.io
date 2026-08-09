---
title: 'The model that finds the bug will defend the bug'
description: 'The rule that made my AI pipeline work: never let the model that found the bug judge it. Three validation rounds kill 80% of AI-generated findings. Here''s the architecture, the prompts, and the dead ends.'
pubDate: 2026-08-04
tags: ['AI', 'Methodology', 'Tooling']
---

Last month my pipeline surfaced what looked like critical SQL injection. Error-based,
MySQL 8.0, stack traces in the response. I was already mentally writing the report.
The gate killed it. The database was
`analytics_proxy`. The "users" table was `user_agents` browser strings. Every byte
of it was already public. Two hours of exploitation I'd have burned without the
gate — the adversarial gate whose entire job is to **break** what the rest
of the pipeline discovers.

Everyone is using AI wrong in bug bounty.

Not "wrong" as in "the prompts could be better." Wrong as in the entire mental model.
Drop a codebase into ChatGPT and ask if it's vulnerable. Paste a request into Claude
and ask what exploit to try. The output reads like a security consultant who skimmed
the OWASP Top 10 in an Uber on the way to the meeting. Confident, fluent, useless.

The hunters who are winning right now don't use LLMs as an oracle. They use them
as a pipeline component — same as ffuf, same as Caido, same as Burp Collaborator.
A component with a specific job, a specific prompt, and a specific output schema.
The pipeline is the hunter. The model is just one of its tools.

I've spent the last year building that pipeline. Watching brilliant-sounding findings
die in validation. Learning which problems LLMs crush and which ones they hallucinate
on spectacularly. This is what I know.

## The pipeline that survived

After burning a lot of tokens on approaches that went nowhere — prompts that produced
novels of false positives, agents that confidently explained why random noise was
actually deserialization, a "one prompt to rule them all" phase I'm embarrassed to
admit lasted two months — I landed on four stages:

```text
Recon ─→ Hypotheses ─→ Focused Weirdness ─→ Adversarial Gate ─→ Exploitation
DeepSeek    Codex       revisit anomalies      Claude Opus         Codex
(volume)   (hunting)    (83% of findings)      (P8 → P9 → P10)     (precision)

           └──── loops through 14 surfaces until exhausted ────┘
```

Each stage runs on a different model, and that split isn't about cost. DeepSeek does
the cheap volume work. Codex does the sustained multi-agent hunting. Claude Opus runs
the gate — and it has to be a different model than the one that found the bug, for the
reason in the title. **The finder will defend the bug**, same way a developer defends
their own code. Discovery and validation run on different models, in different
sessions, with opposite instructions: one paid to find, the other paid to destroy.

## Phase 1: Recon at machine scale

This is where AI earns its keep. Not because LLMs are better than `katana` or
`waybackurls` — they're worse at raw discovery. But they *understand* what those
tools find in ways grep never will.

### JS bundle analysis

I run a prompt against every JavaScript file I can extract from a target: `<script>`
tags, webpack chunks, lazy-loaded bundles, service workers, `.map` source files. A
shell script downloads each one and feeds it through. Three minutes, a few cents of
tokens, output that takes two days to compile by hand.

Here's the prompt as I actually paste it — lowercase, messy, real:

```text
you are analyzing javascript from a web app for security stuff. go through this file
and pull out:

API ENDPOINTS - any url path that looks like an api call. get the full path, the http
method if you can see it, what parameters it takes, and whether it sends auth headers.
if there's no Authorization header or token being passed, flag that specifically.

HIDDEN PARAMETERS - any parameter name that doesn't appear in the UI. things passed
in query strings, post bodies, graphql arguments, custom headers. these are often
not tested by anyone.

ADMIN/INTERNAL ROUTES - /admin, /internal, /dashboard, /manage, /staff, /debug, or
anything gated by feature flags like isAdmin, role, permissions, canAccess.

SECRETS - api keys, tokens, internal hostnames, IPs, websocket urls, s3 bucket refs,
firebase configs. even if they look like dev/test values, include them. dev creds
work on production more often than anyone admits.

AUTH LOGIC - anything dealing with tokens, sessions, oauth config, password reset,
mfa enrollment. i want to know exactly how authentication works on this app.

FRAMEWORK STACK - what framework and version. flag anything with known CVEs.

output as json. include source file and approximate line number for each finding.
```

What this has surfaced:

- **Firebase config with read access to every user document.** In a webpack chunk
  loaded only on the settings page. Two years in production. Nobody had spidered
  deep enough to find that chunk, and nobody read it carefully enough to notice
  the database URL wasn't restricted.

- **`?__skipPayment=true` on a subscription endpoint.** A debug flag, commented
  out in the main bundle but still active in a legacy bundle being served. The
  parameter was read before the comment check. The main bundle had it inside
  `if (__DEV__)`. The legacy bundle didn't.

- **A WebSocket endpoint at `wss://internal-api.target.com/ws`** that accepted
  unauthenticated connections and streamed real-time user activity. Found in a
  source map. The production server had no session validation because "it's
  internal traffic" — except the endpoint was publicly reachable.

- **An internal GraphQL endpoint at `/api/internal-graphql`** with introspection
  enabled, no auth required. Referenced in a single comment in a minified file.
  Grep would find the string. It wouldn't understand that `/api/internal-graphql`
  was a separate, unprotected endpoint distinct from the public `/graphql` — which
  is exactly what the LLM read from the surrounding comment.

### What doesn't work

I tried "find all API endpoints for target.com" for weeks. The model invents things.
Not maliciously — it just pattern-matches from training data and presents the results
as discovered. `admin.target.com`, `api.internal.target.com`, `staging.target.com`
— plausible, confidently stated, completely made up.

LLMs don't do *data* discovery — finding new endpoints, subdomains, or assets.
They do analysis — understanding and connecting what real tools uncover. (Finding
vulnerability *chains* in source code is a different category; the wp2shell chain
proves LLMs can discover exploit paths no human has assembled before. But they
can't discover what APIs exist on a live target.) Feed them real data from real
tools, then ask them to understand it. Never ask them to generate the data.

### API surface mapping

After JS analysis, I map the API surface. The discovery comes from real tools —
waybackurls, gau, katana, ffuf — running in parallel. The LLM's job is synthesis:
deduplicate, categorize, flag what's interesting.

I run five sources simultaneously, merge, deduplicate, and feed each endpoint through:

```text
analyze this endpoint for security testing:

{endpoint}

tell me: based on the URL structure, naming patterns, and context from the JS analysis,
what do you expect this endpoint does? does it appear to require auth (look for token
headers or session checks in the calling code)? what parameters does it accept based on
the request-building code? are there error responses in the JS that hint at internal
behavior?

flag if: the endpoint works without auth when it probably shouldn't, there are
different API versions and some are less protected, it accepts unusual content
types, error messages leak stack traces or internal paths, the behavior changes
based on parameters you wouldn't expect.
```

15 minutes, complete API surface map. Including endpoints that only exist in
JavaScript, endpoints in Swagger docs that are publicly accessible, and — this one
keeps paying — API version differences where auth was added in v3 but forgotten in
v1 and v2.

## Phase 2: Hypothesis generation

Before I send a single test request, I generate specific, testable hypotheses.
Not "check for IDOR" — that's a task. A hypothesis is: "the `user_id` parameter in
`GET /api/v2/orders` is interpolated directly into a database query without
ownership verification, because the mobile app passes it as a query param rather
than reading it from the session."

```text
based on this attack surface, generate specific testable vulnerability hypotheses.

for each hypothesis:

1. exactly what the vulnerability is. not "sql injection" but "the sort parameter
   in GET /api/v2/users appears to be interpolated directly into an ORDER BY clause
   based on the error messages when non-alphanumeric characters are passed"

2. the exact http request to test it. full request line, headers, body if relevant.

3. what the vulnerable response would look like vs the normal response. be specific
   enough that someone who's never seen this app could tell the difference.

4. how this would escalate. blind sqli to data extraction to admin session theft
   to shell. or idor to mass pii exposure. draw the full chain — don't stop at
   the first impact.

5. what could make this LOOK vulnerable when it isn't. response time differences
   can be network jitter. error messages can be misleading. 500s can be crashes
   not injections. what's the false positive risk here?

6. priority 1-5. 1 = drop everything and test this first. 5 = check if bored.

rules: every hypothesis must be testable with ONE http request. no generic "check
for xss." consider the entire data flow. think about chaining — does this bug
become more dangerous when combined with another finding?
```

This generates 20-40 hypotheses per target. Most are wrong. That's the point. The
goal isn't accuracy — it's forcing you to consider every attack vector systematically
instead of chasing whatever catches your eye.

### The sibling rule

The single highest-ROI prompt I've written. Developers copy patterns. If
`/api/v2/users/123/profile` has an IDOR, five other endpoints under the same path
prefix probably have the same mistake — same developer, same afternoon, same bug.

```text
we found this vulnerability in {endpoint}: {description}

here are all the API endpoints we know about for this application: {endpoint_list}

find every endpoint that shares the same authorization pattern, parameter structure,
or likely code path. these are "sibling endpoints" — the developer probably made the
same mistake in all of them.

for each sibling: why the pattern applies, confidence (high/medium/low), and the
exact test request to confirm.

if you find any sibling that would escalate the original finding's impact, flag
that explicitly. a medium on one endpoint that becomes critical when the same bug
exists on 6 others.
```

IDOR on user profiles → mass PII exposure when the same bug hits six related
endpoints. Business logic in checkout → free-subscription generator when the same
flaw exists in upgrade, downgrade, and cancellation. All written by the same team,
all vulnerable in the same way.

## Focused weirdness

Testing the hypotheses is table stakes. The bugs that pay come from what happens
after — going back through everything that behaved *slightly* wrong and refusing to
let it go. A 500 that should have been a 400. A response 80ms slower than its
neighbors. An endpoint that quietly accepts a parameter it never documents.
Individually, noise. That's exactly why they're still there when you arrive — the
obvious stuff was found and fixed years ago.

So the loop doesn't stop when the hypotheses are tested. It rotates back through every
attack surface a second time, and this pass only cares about the anomalies — the
responses that didn't fit the model of how the app is supposed to work. mdp_sec puts
the share of real findings that originate in this pass at 83%, and after a year of
this I don't argue with the number. The first pass teaches you the app's normal. The
second pass is where you catch it being abnormal.

This is also the pass an LLM is worst at driving alone and best at assisting. It has
no baseline, so it can't *feel* that a response is off. But hand it the anomaly plus
the surrounding code and it's fast at the next question: "here are the 200 and the 500
for the same endpoint with one parameter changed — which branch produces the
difference, and what reaches it?"

## Phase 3: The adversarial gate

This is the part almost nobody builds, and it's the part that separates findings
that pay from findings that waste your time.

I didn't invent this gate. The structure is @mdp_sec's validation pipeline — three
stages, P8 through P10, each a separate Claude Opus
instance with no memory of the one before it. Before I manually verify anything,
every finding runs all three. The model that found the bug never sits on its own jury.

### P8 — Validate and escalate

The first instance doesn't ask "is this real?" It asks "how bad does this actually
get?" P8 confirms the trigger, then goes hunting for the impact ceiling — every object
ID it can reach, every privilege boundary, every chain. It doesn't stop at the first
success. It stops when it runs out of things to escalate into.

```text
you are P8 — the validator. a finding has been identified. your job:

1. confirm the trigger. understand the prerequisites and the claimed impact.
2. try EVERY safe escalation from the trigger condition:
   - can it read other users' data? try every object id you can reach.
   - can it write, modify, or delete data you don't own?
   - can it elevate role (user → admin, member → owner)?
   - can it chain (ssrf → metadata, xss → session theft, idor → mass pii)?
   - can it cross a tenant or org boundary?
3. record every escalation attempt and its outcome.
4. do NOT accept "probably doesn't work" — test it.
5. do NOT stop at the first success — find the ceiling.

output: maximum confirmed impact + every escalation path attempted.
```

### P9 — Independent reproduction

This is the false-positive killer, and it's the stage almost nobody writes. A fresh
instance gets ONLY the trigger and the prerequisites — no screenshots, no original
notes, no "here's what I saw." If it can't rebuild the finding from that alone, the
finding isn't real. A bug that only exists when you already believe in it is not a bug.

```text
you are P9 — the independent reproducer. you have ONLY the trigger condition and the
prerequisites. you do NOT have the original proof, screenshots, or notes.

1. start from a clean session. create fresh accounts if needed.
2. reproduce using only the described endpoint, parameter, payload, and auth level.
3. capture your OWN evidence — request/response pairs, not the original's.
4. compare against the claim:
   - matches → pass
   - different behavior → document the difference exactly
   - cannot reproduce → FAIL. do not guess. do not submit.

output: reproduction status (confirmed / partial / failed) + corrected proof.
```

### P10 — Hostile triager

The last instance does not believe you. Its only job is to kill the report. It re-runs
every request from the stated attacker position, questions every prerequisite,
recalculates the severity you're hoping for, and returns exactly one verdict.

```text
you are P10 — the hostile triager. you do NOT believe this report is real. your job
is to KILL it. only bulletproof reports survive.

1. re-run every step from the stated attacker position, same session context.
2. check every prerequisite — is it actually required, or is the attack simpler?
   does it work without auth? without the role? against other users' data?
3. verify severity — recalculate cvss. is the impact demonstrated or hypothetical?
   would the program actually pay, or is it on the never-pay list? (missing headers,
   self-xss, clickjacking on non-sensitive actions, open redirect with no chain,
   rate limiting without account lockout)
4. check classification, scope, and duplicates.

verdict (pick exactly one):
- PASS      → real, proven, correct severity. submit.
- DOWNGRADE → real but severity inflated. fix it before submitting.
- BLOCK     → evidence or prerequisites unclear. add more, then re-triage.
- REJECT    → not exploitable, out of scope, or accepted risk. do not submit.

you may NOT invent a new angle to save a weak report, accept "probably exploitable,"
or lean on theoretical evidence. every screenshot comes from real execution.
```

In practice the gate kills about 80% of what the pipeline hands it, and the split is
clean. P8 exposes the findings with no real impact ceiling. P9 exposes the
hallucinations — the ones that evaporate the moment a clean session tries to rebuild
them. P10 exposes the inflated-severity reports I *want* to be criticals. The 20% that
survive are almost always real, and roughly half hold up as exploitable once I verify
by hand. That beats my manual hunting, where I burn hours on hunches that go nowhere.

The `analytics_proxy` SQLi I opened with died in P8 — not because it wasn't real, but
because P8 went looking for the ceiling and there wasn't one. I'd assumed user PII
because it was a user-facing endpoint. P8 saw the database name in an error string and
queried `information_schema` instead of celebrating: every table was aggregate event
counts, and the "users" table held browser user-agent strings. Real injection.
Read-only replica. Public data. Impact ceiling: zero. Killed before P9 or P10 ever
ran. Two hours saved.

## Phase 4: Exploitation

Once a finding survives the gate, exploitation is where LLMs earn their place.

### Blind SQLi extraction

Blind boolean-based SQLi in a `sort` parameter. MySQL 8.0, inside `ORDER BY`. No
UNION possible. No error messages. Boolean only — response order changes tell you
whether the condition was true.

```text
blind boolean-based sqli in ORDER BY clause. mysql 8.0.
injection via the "sort" parameter:
GET /api/v2/reports?sort=(select%20case%20when%20(1=1)%20then%20id%20else%20name%20end) HTTP/2

we can distinguish true from false by response ordering — when the condition is true,
results are sorted by id. when false, they're sorted by name. the CASE WHEN swaps the
sort column based on the injected condition. no error output, no UNION, no timing side
channel needed — pure boolean oracle via application behavior.

i need a python script that:
- confirms the injection reliably (10 true/false test pairs with known correct answers)
- extracts database names
- extracts table names from the current database
- extracts column names from interesting tables
- dumps data from the most sensitive-looking columns

use requests.Session(), retry on connection errors, respect rate limiting (max
2 req/sec), save progress to a json file after each successful extraction so we
don't lose work on crash.

output complete runnable python script. no explanations in the output — just
the code with comments for the important logic.
```

280 lines. Worked on the second run — first run hit a charset encoding issue
("database is utf8mb4, handle unicode"). 10-second fix, re-ran, data flowing.
The difference isn't that LLMs get everything right. It's that the iteration
cycle is seconds instead of hours.

### The ceiling case: wp2shell

The strongest public demonstration of this architecture is Adam Kues's
[wp2shell](https://slcyber.io/research-center/exploit-brokers-pay-500000-for-a-wordpress-rce-i-found-one-with-gpt5-6/)
— a pre-auth RCE in WordPress core that exploit brokers price at $500,000. The
methodology maps directly to the pipeline: remove `.git` to force reasoning from
source rather than diffing patches, constrain to "pre-authentication in production
with MySQL," run parallel agents for 6+ hours with adversarial sub-agents
double-checking each candidate (that's P10 running at ten times the intensity),
and adapt the
[Cycle Double Cover](https://signalreads.com/articles/gpt-56-sol-ultra-produces-proof-of-the-cycle-doubl/)
approach — a prompt pattern from GPT-5.6 Sol Ultra's proof of a 50-year-old graph
theory conjecture — to keep searching past dead ends.

The chain is the best argument for systematic pipeline hunting over "find the bug."
The vulnerability was a batch API desynchronization: validation and execution run in
separate loops, and a malformed request skips the match array — one request's
validation pairs with another's endpoint handler. By itself, interesting but
unexploitable. From there the LLM threaded through six interconnected WordPress
subsystems: the REST `author_exclude` parameter mapping to `author__not_in` in
`WP_Query` (bypassing `absint`), `oembed_cache` fabrication via relative URL embeds,
`customize_changeset` admin impersonation, post parent cycle repair overwriting
`post_content`, and `do_action` dynamic dispatch for arbitrary hook execution. Each
gadget useless alone. Together: remote code execution.

No human researcher had assembled this complete chain before. A pipeline running four
parallel agents found it in 10 hours for $25 in API costs. Is everyone going to find a WordPress RCE? No. But the
architecture is the same architecture that finds the SQLi in your target's forgotten
API endpoint and the IDOR everyone else missed.

## Real costs

| What | Tool | $/mo |
|------|------|------|
| Recon, volume scanning, endpoint triage | DeepSeek V4 | $15-25 |
| Primary hunting, code analysis, exploit dev | Codex / GPT-5.6 | $80-150 |
| Validation gate (P8/P9/P10) | Claude Opus (Max) | $200 |
| **Total** | | **~$300-375** |

The gate is the most expensive line, and that's deliberate. The cheapest place to run
validation is a local model — and that's exactly where false positives walk through.
The hostile triager has to be smart enough to out-argue you about your own finding,
so it gets your strongest reasoner, not your cheapest.

Before AI: Burp Pro (~$37/mo annually), $30/mo VPS, and roughly 3x more time per
finding. The pipeline roughly doubles my effective speed for ~$235-310 in net new
costs. One extra Medium finding per month pays for the entire thing.

## Prompts worth stealing

Not templates. These are the patterns that survived a year of watching prompts fail.
They work because they address the specific ways LLMs fail at security analysis — not
because they're clever.

### Constraints beat freedom

LLMs default to being helpful, which means when asked to find vulnerabilities they
default to being *too* helpful — listing every theoretical concern no matter how
unlikely. The fix: sandwich the task between hard limits.

Bad: "Find vulnerabilities in this code."

Better:

```text
CONSTRAINT: you are an unauthenticated external attacker. no valid session, no
internal hostname knowledge, no assumptions about what's behind firewalls.

METHODOLOGY: identify all entry points → trace each input through every
transformation → at each step ask "what input would bypass this?" → report
only findings that survive your own critique.

CONSTRAINT: ignore timing side channels under 500ms (too unreliable over WAN),
anything requiring a valid account, and anything that depends on knowing a
specific user's email address or internal ID.
```

The model can't drift into "the application might not have rate limiting" because
that's not a testable claim. Constraints force specificity.

### Don't ask for bugs — ask for explanation

Don't ask the LLM to find vulnerabilities. Ask it to explain the code line by line.
It's significantly better at explanation than at bug discovery, and the vulnerability
surfaces in the explanation.

```text
explain this code to me. every line, every variable, every function call, every
return value. what value does each variable hold at each step? what transformations
are applied to user input? what does the final output look like for a given input?

do NOT look for vulnerabilities. do NOT mention security. just explain what the
code does, in painstaking detail. walk the full execution path.
```

The explanation routinely produces "and then `filename`, which came directly from
the user's POST body, is passed to `subprocess.call(['convert', filename,
output_path])`" — without the model ever being prompted to find bugs. It's not
trying to find vulnerabilities. It's explaining code. It's much better at that.

### What am I missing?

After I think I've thoroughly tested a target, one more prompt. It has repeatedly
surfaced things I overlooked.

```text
we tested {target} and found: {findings}
our methodology: {methods}

what attack surface did we MISS?

consider: API versions we didn't test (v1/v2/v3/internal/admin), content types we
didn't try (XML, multipart, protobuf, graphql), auth mechanisms we didn't probe
(OAuth, SSO, JWT, API keys), subdomains we overlooked (acquisitions, legacy,
staging, dev), JS bundles we missed (lazy chunks, service workers, .map files),
parameters we didn't fuzz (nested JSON, arrays, prototype pollution), HTTP methods
we didn't attempt (PATCH, OPTIONS, TRACE).

be brutally honest. what didn't we do that we should have done?
```

Last time: tested `/graphql` thoroughly. Never checked whether `/graphiql` was
exposed. It was. Introspection enabled. Every mutation documented, including
`transferFunds` — which didn't validate source account ownership.

## Where it fell apart

I need to be clear about the limits because the hype is actively harmful. If you
think AI replaces the human, you'll lose money and miss bugs.

**Authentication bypass requiring understanding of session architecture.**
OAuth with PKCE, SAML relay state, multi-step MFA — the security boundaries are
spread across middleware, handlers, and framework defaults. A real example: testing
an OAuth SSO app, the LLM correctly flagged loose `redirect_uri` validation. It
completely missed that the `state` parameter was generated, sent, received back,
and never compared to anything. The model can't know that the state parameter
*should* be validated — that knowledge is implicit in the spec, not explicit in code.
Map the auth flow yourself. Feed each step individually: "does this code validate
what it should?"

**Business logic requiring understanding of intent.** A payment endpoint accepted
`plan: "pro_monthly"` and computed the price server-side. The LLM flagged the coupon
parameter as potentially guessable. It didn't notice that sending `plan: "pro_monthly"`
on the `enterprise_yearly` checkout flow gave enterprise access at the pro monthly
price. Same endpoint, same code, no bug in the code — the bug exists in the gap
between what the business intended and what the code allows. Define expected behavior.
Then ask: "where in the code does it enforce this?"

**Race conditions.** LLMs see code as sequential. They rarely encounter concurrent
code paths in training and can't execute code to discover interleavings — the gap
between a check and its use is invisible. Ask the LLM to list every state-changing
operation, then manually hunt for TOCTOU pairs and non-atomic operations. The LLM
gives you the map. You spot the gaps.

**Novel attack techniques.** LLMs are trained on existing knowledge. A new gadget
chain in a custom serialization format or a fresh HTTP smuggling variant in a
specific proxy config — the model helps you understand the code. The creative leap
still requires a human.

**Context that spans too many files.** Even with 1M–2M token context windows, LLMs lose
track of cross-file relationships. A middleware reads `req.userId`. A handler reads
`req.params.userId`. The LLM sees both but misses they use different sources —
creating an IDOR. Feed smaller pieces and ask about the relationship specifically:
"does the handler trust assumptions the middleware made?"

## Where to start

Don't build the whole pipeline at once. People who try that end up debugging
orchestration code instead of hunting. Also: stay in scope. Don't dump production
data to prove an extraction oracle works — a few rows from your own test account
is sufficient. Getting banned from a program over an over-eager extraction script
defeats the point of the pipeline.

Start with the JS analysis prompt against a real target. Once you can map an API
surface in minutes, add hypothesis generation. Once hypotheses are flowing, build
the gate — run your existing findings through it, including ones you already got
paid for. Watch what dies. Adjust.

Let go of the "one prompt" fantasy. There is no prompt that turns an LLM into a
bug hunter. The hunter is the system — the prompts, the gates, the feedback loops,
the human steering at every decision point. The LLM is the best research assistant
you'll ever have. It's not the researcher.

---

Last month the pipeline killed a SQLi I was genuinely excited about. The validator
found what I was too invested to see: the database was analytics, the data was
public, the impact was zero. Two hours saved. A year ago I'd have burned those
two hours, written the report, and damaged my credibility with a triager who
actually checks. The model didn't save me. The gate did. Build the gate.
