---
title: 'I spent a year building an AI bug hunting pipeline. Here''s what actually works.'
description: 'Stop asking ChatGPT "is this vulnerable." The hunters winning right now use LLMs as a pipeline component — recon, hypothesis generation, adversarial validation, exploitation — not as an oracle. Here''s the architecture, the prompts, and the dead ends.'
pubDate: 2026-08-07
tags: ['AI', 'Methodology', 'Tooling']
---

Everyone is using AI wrong in bug bounty.

Not "wrong" as in "the prompts could be better." Wrong as in the entire mental model.
Drop a codebase into ChatGPT and ask if it's vulnerable. Paste a request into Claude
and ask what exploit to try. The output reads like a security consultant who skimmed
the OWASP Top 10 in an Uber on the way to the meeting. Confident, fluent, useless.

The hunters who are winning right now don't use LLMs as an oracle. They use them
as a **pipeline component** — same as ffuf, same as Caido, same as Burp Collaborator.
A component with a specific job, a specific prompt, and a specific output schema.
The pipeline is the hunter. The model is just one of its tools.

I've spent the last year building that pipeline. Iterating on prompts. Watching
brilliant-sounding findings die in validation. Learning which problems LLMs crush
and which ones they hallucinate on spectacularly. This is what I know.

## The pipeline that survived

After burning a lot of tokens on approaches that didn't work — prompts that produced
novels of false positives, agents that confidently explained why random noise was
actually deserialization, a "one prompt to rule them all" phase I'm embarrassed to
admit lasted two months — I landed on four stages:

```text
Recon → Hypothesis Generation → Adversarial Gate → Exploitation
  ↑            ↑                      ↑                  ↑
  LLM          LLM             3 validation rounds      LLM
  (volume)     (creative)      (separate instances)     (precision)
```

Each stage feeds the next. Nothing reaches exploitation without surviving the gate.
Nothing reaches the gate without a specific, testable hypothesis. Nothing generates
a hypothesis without clean recon data.

The key insight that took me six months to internalize: **you cannot use the same
model instance for discovery and validation.** The model that found the bug will
defend the bug. It's the same mechanism that makes humans double down on wrong
ideas — the model already committed to the finding, so it rationalizes. You need
a completely separate instance, with a completely separate prompt, whose entire
job is destruction.

## Phase 1: Recon at machine scale

This is where AI earns its keep with the least effort. Not because LLMs are better
than `katana` or `waybackurls` — they're categorically worse at raw discovery.
But because they can *understand* what those tools find in ways that grep never will.

### What actually works: JS bundle analysis

This prompt has found more real bugs for me than any other single technique. It's
not clever. It's systematic.

I run it against every JavaScript file I can extract from a target: `<script>` tags,
webpack chunks, lazy-loaded bundles, service workers, `.map` source files. A shell
script downloads each one and feeds it through. Three minutes, a few cents of API
tokens, output that would take two days to compile by hand.

Here's the prompt as I actually paste it — weird capitalization and all:

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

AUTH LOGIC - anything dealing with tokens, sessions, oauth config, password reset
flow, mfa enrollment. i want to know exactly how authentication works on this app.

FRAMEWORK STACK - what framework and version. flag anything with known CVEs.

output as json. include source file and approximate line number for each finding.
```

What this has surfaced across different targets:

- **Firebase config with read access to every user document.** The config was in a
  webpack chunk loaded only on the settings page. It had been there for two years.
  Nobody had spidered deep enough to find that chunk, and nobody had read it
  carefully enough to notice the database URL wasn't restricted.

- **`?__skipPayment=true` on a subscription endpoint.** A developer debug flag,
  commented out in the main bundle but left active in a legacy bundle that was still
  being served. The parameter was being read before the comment check. The main
  bundle had it wrapped in `if (__DEV__)`. The legacy bundle didn't.

- **A WebSocket endpoint at `wss://internal-api.target.com/ws` that accepted
  unauthenticated connections and streamed real-time user activity.** Found in a
  source map file. The production WebSocket server had no session validation
  because "it's internal traffic" — except the endpoint was publicly reachable.

- **An internal GraphQL endpoint at `/api/internal-graphql`** that had introspection
  enabled and no authentication requirement. It was referenced in a single comment
  in a minified file. Grep wouldn't catch it. The LLM did — because it read the
  comment as natural language and understood from context that this was a separate
  endpoint from the public `/graphql`.

### What doesn't work: asking the LLM to find new endpoints

I tried this for weeks. Prompts like "find all API endpoints for target.com" or
"discover hidden subdomains." The model invents things. Not maliciously — it just
pattern-matches endpoint names from its training data and presents them as
discovered. `admin.target.com`, `api.internal.target.com`, `staging.target.com` —
plausible, confidently stated, completely made up.

LLMs don't do discovery. They do analysis. Feed them real data from real tools,
then ask them to understand it. Never ask them to generate the data themselves.

### API surface mapping

After JS analysis, I map the full API surface. The discovery comes from real tools
— waybackurls, gau, katana, ffuf — running in parallel. The LLM's job is synthesis:
deduplicate, categorize, identify what's interesting.

I run five discovery sources simultaneously, merge the output, deduplicate, and
then feed each unique endpoint through:

```text
analyze this endpoint for security testing:

{endpoint}

tell me: what HTTP methods work (test OPTIONS if you can), does it require auth
(try without any cookies/tokens), what parameters does it accept, what content
types, what does the error handling look like. is there anything interesting about
how it behaves.

flag if: the endpoint works without auth when it probably shouldn't, there are
different API versions and some are less protected, it accepts unusual content
types, error messages leak stack traces or internal paths, the behavior changes
based on parameters you wouldn't expect.
```

15 minutes, complete API surface map. Including endpoints that only exist in
JavaScript, endpoints documented in Swagger but publicly accessible, and — this
one keeps paying — API version differences where auth was added in v3 but forgotten
in v1 and v2.

## Phase 2: Hypothesis generation

Before I send a single test request, I generate specific, testable hypotheses.
Not "check for IDOR" — that's a task, not a hypothesis. A hypothesis is: "the
`user_id` parameter in `GET /api/v2/orders` is probably used directly in a database
query without ownership verification, because the mobile app passes it as a query
param rather than reading it from the session."

I feed the LLM everything I know — endpoint map, JS analysis, auth architecture,
tech stack — and ask:

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
   to shell. or idor to mass pii exposure. or xss to session hijacking. draw the
   full chain — don't stop at the first impact.

5. what could make this LOOK vulnerable when it isn't. response time differences
   can be network jitter. error messages can be misleading. 500s can be crashes
   not injections. what's the false positive risk here?

6. priority 1-5. 1 = drop everything and test this first. 5 = check if bored.

rules: every hypothesis must be testable with ONE http request. no generic "check
for xss." consider the entire data flow. think about chaining — does this bug
become more dangerous when combined with another finding?
```

This generates 20-40 hypotheses per target. Most are wrong — that's the point.
The goal isn't to be right. The goal is to generate every attack vector a human
would think of, plus the ones from angles a human might not, so you can test them
systematically. It's a force-multiplier for coverage, not an accuracy engine.

### The sibling rule, automated

The single highest-ROI prompt I've written. Developers copy patterns. If
`/api/v2/users/123/profile` has an IDOR, `/api/v2/users/123/billing` and
`/api/v2/users/123/activity` and `/api/v2/users/123/settings` were probably written
by the same person on the same afternoon and have the same bug.

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

This has turned single Medium findings into Critical chains repeatedly. An IDOR on
user profiles becomes mass PII exposure when the same bug exists on six other
endpoints. A business logic flaw in checkout becomes a subscription generator when
the same flaw exists in upgrade, downgrade, and cancellation — all written by the
same team, all vulnerable in the same way.

## Phase 3: The adversarial gate

This is the part almost nobody builds, and it's the part that separates findings
that pay from findings that waste everyone's time.

Before I manually verify anything, every finding runs through three validation rounds.
Each round uses a **separate LLM instance** — this is critical. If you use the same
instance that generated the finding, it will defend its own output the same way a
developer defends their own code.

### Gate 1: "Prove this wrong"

```text
your job: disprove this finding. be ruthless and creative. assume the researcher
made a mistake, overlooked a mitigation, or misinterpreted the evidence.

finding: {text}

challenge every part of this:
- is it ACTUALLY exploitable, or just misconfigured in a way that looks vulnerable?
- would this work against production data, or only synthetic/test data?
- are there mitigations the researcher missed?
- is the "vulnerable" behavior actually documented intended functionality?
- does the PoC actually prove what it claims, or just show something adjacent?

if the finding survives, explain exactly why and what makes it real. if it doesn't,
explain exactly what kills it — be specific about which claim breaks.
```

### Gate 2: "What else could explain this?"

```text
for this finding: {finding}

generate 3 alternative explanations for the observed behavior that are NOT security
vulnerabilities. for each alternative, rate how likely it is compared to the
vulnerability hypothesis, and describe what additional test would definitively
distinguish between them.

the finding only advances if the vulnerability hypothesis is MORE likely than all
alternatives combined. be honest. most "findings" are configuration quirks.
```

### Gate 3: "Does this actually matter?"

```text
assuming this vulnerability is real: {finding}

validate the impact with brutal honesty:
- does this affect real users, data, or money? or just test/placeholder content?
- would a reasonable bug bounty program actually pay for this?
- what is the REALISTIC severity — not what you hope, what it is?
- is this on any "never pay" list? (missing security headers, self-xss requiring
  victim interaction, clickjacking on non-sensitive actions, open redirect without
  an impact chain, rate limiting without account lockout)
- can this be chained into something that matters more?

if the impact is low, say so. if it shouldn't be submitted, say so. nobody's ego
is protected here.
```

In practice, these three gates kill about 80% of AI-generated findings. A finding
that dies in Gate 1 was hallucinated. A finding that dies in Gate 2 was ambiguous.
A finding that dies in Gate 3 was real but worthless.

The 20% that survive all three are almost always real, and roughly half turn out to
be exploitable after manual verification. That's a much better hit rate than my
manual hunting, where I burn hours on hunches that go nowhere.

I had a finding last month that I was genuinely excited about. SQL injection in a
REST endpoint. Error-based, database version extracted, UNION working. Gate 1
survived. Gate 2 survived. Gate 3 — the impact validator — asked one question:
"what data is in this database?" I'd assumed user PII because it was a user-facing
endpoint. The validator pointed out that the database name was `analytics_proxy`,
the tables were all aggregate event counts, and the "users" table was `user_agents`
browser strings. The SQLi was real and exploitable. It was also a read-only
replica of data that was already public in every HTTP request. Finding killed.
Two hours of exploitation saved.

## Phase 4: Exploitation

Once a finding survives the gate, exploitation is where LLMs go from useful to
indispensable. Writing extraction scripts, building gadget chains, crafting
payloads — the stuff that used to take me hours of trial and error now takes
minutes of prompt iteration.

### Real example: blind SQLi extraction

Blind boolean-based SQLi in a `sort` parameter. MySQL 8.0. The injection point was
inside an `ORDER BY` clause, so no UNION, no error messages, no stack traces.
Boolean-based only: response order changes tell you whether the condition was true.

Manually extracting data one bit at a time would've taken all day. I wrote this
prompt instead:

```text
blind boolean-based sqli in ORDER BY clause. mysql 8.0.
injection via the "sort" parameter:
GET /api/v2/reports?sort=id%20ASC,(select%20if(1=1,sleep(0),sleep(0))) HTTP/2

we can distinguish true from false by response ordering — when the condition is true,
results are sorted by id. when false, they're sorted by name.

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

The script was 280 lines. It worked on the second run — first run hit a charset
encoding issue I'd forgotten to specify in the prompt ("database is utf8mb4, handle
unicode in extracted data"). 10-second fix, re-ran, data flowing. That's the
difference LLMs make: not that they get everything right on the first try, but that
the iteration cycle is seconds instead of hours.

### What the extreme case looks like: the wp2shell chain

The strongest public demonstration of AI-assisted hunting is Adam Kues's
[wp2shell](https://slcyber.io/research-center/exploit-brokers-pay-500000-for-a-wordpress-rce-i-found-one-with-gpt5-6/)
finding at Searchlight Cyber — a pre-auth RCE in WordPress core that exploit brokers
would pay $500,000 for.

The methodology is worth studying because it's the same pipeline pattern, just
executed at higher intensity: remove `.git` so the model can't cheat by diffing
patches, constrain to "pre-authentication in a production deployment with MySQL,"
run parallel agents for 6+ hours with adversarial sub-agents double-checking each
candidate, adapt OpenAI's Cycle Double Cover conjecture approach to force the model
to keep searching past dead ends.

The chain itself is a masterclass in why "find the vulnerability" isn't enough. The
bug was a batch API desynchronization — validation happens in one loop, execution
in another, and a malformed request skips the match array, so one request's
validation pairs with another's handler. By itself, interesting but unexploitable.
The LLM found the desync, then found the sink (`author__not_in` bypassing `absint`),
then found the cache gadget (embedding a relative URL fabricates an `oembed_cache`
row), then found the changeset gadget (assuming admin identity), then found the
cycle gadget (post parent repair overwrites `post_content` with attacker data), then
found the hook gadget (`do_action` dynamic dispatch) — six interconnected subsystems
chained into RCE. No human researcher found that chain in 20 years. An AI pipeline
did it in 6 hours for $25 in API costs.

Is everyone going to find a WordPress RCE? No. But the architecture that found it —
systematic prompt engineering, adversarial validation, treating the LLM as a
component in a larger system — is the same architecture that finds the SQLi in your
target's forgotten API endpoint and the IDOR that everyone else missed.

## The prompt patterns that survived

After a year of watching prompts fail, here are four patterns that actually work.
Not because they're clever — because they address the specific ways LLMs fail at
security analysis.

### 1. The Constraint Sandwich

LLMs default to being helpful, which means when asked to find vulnerabilities they
default to being *too* helpful — listing every theoretical concern, no matter how
unlikely. The fix: sandwich the task between hard constraints.

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

The constraints force specificity. The model can't drift into "the application might
not have rate limiting" because there's no specific testable claim there.

### 2. The Ruby Method

Named after rubber duck debugging. Don't ask the LLM to find vulnerabilities. Ask
it to explain the code line by line. It's dramatically more accurate at explanation
than at vulnerability discovery, and the vulnerability surfaces organically in the
explanation.

```text
explain this code to me. every line, every variable, every function call, every
return value. what value does each variable hold at each step? what transformations
are applied to user input? what does the final output look like for a given input?

do NOT look for vulnerabilities. do NOT mention security. just explain what the
code does, in painstaking detail. walk the full execution path.
```

The explanation routinely produces sentences like "and then `filename`, which came
directly from the user's POST body without any sanitization, is passed to
`subprocess.call(['convert', filename, output_path])`" — without the model ever
being prompted to "find bugs." It's not trying to find vulnerabilities. It's just
explaining code. It's much better at that.

### 3. The Adversarial Pair

Always run two agents. One finds. One disproves. Never use the same model instance.

```text
AGENT A: find every vulnerability in this code. be thorough, be creative, report
everything suspicious. don't filter yourself.

AGENT B: agent A reported these. for each finding, try to prove it's NOT
exploitable. assume the researcher is wrong. be ruthless. only findings that
survive your attack survive, period.
```

The adversarial agent doesn't just check for false positives. It actively hunts for
the flaw in the exploit chain. "You claim this XSS steals admin sessions. But the
session cookie has HttpOnly set. The attack fails at step one." That kind of thing
doesn't come from "review this finding" — it comes from "break this finding."

### 4. "What am I missing?"

After I think I've thoroughly tested a target, I run one more prompt. It has never
failed to surface something I overlooked:

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

Last time I ran this, it pointed out I'd tested `/graphql` thoroughly but never
checked whether `/graphiql` was exposed. It was. Introspection enabled. Mutations
I hadn't found through the normal API surface were all documented there, including
a `transferFunds` mutation that — you can probably guess — didn't validate the
source account ownership.

## What LLMs are terrible at

I need to be blunt about this because the hype is exhausting and harmful. If you
think AI will replace the human in bug hunting, you'll lose money and miss bugs.

### Authentication bypass requiring understanding of session architecture

LLMs struggle with complex auth that spans many files — OAuth with PKCE, SAML relay
state, multi-step MFA, JWT with JWKS rotation. The security boundaries are implicit,
spread across middleware, handlers, and framework defaults.

A real example: I was testing an app with OAuth SSO. The LLM identified that the
`redirect_uri` parameter wasn't strictly validated. Accurate. Useful. It completely
missed that the `state` parameter was never checked after the callback — the app
generated it, sent it, received it back, and... never compared it to anything. The
LLM caught the well-known OAuth weakness. It missed the catastrophic one because
understanding that bug requires knowing what *should* happen — the state parameter
should be validated — and that knowledge is implicit in the OAuth specification,
not explicit in the code.

**What to do instead:** you map the auth flow. Draw the sequence diagram with pen
and paper. Feed the LLM each step individually: "here's what this code should do
to validate the redirect_uri. does it do all of it?"

### Business logic requiring understanding of intent

LLMs can tell you a checkout endpoint trusts the `price` parameter from the client.
They can't tell you the intended behavior is to charge the price from the database,
because intent is in a PRD, a Slack thread, or someone's head — not in the code.

A payment endpoint I tested accepted `plan: "pro_monthly"` and `coupon: ""` and
computed the price server-side based on those two inputs. The LLM flagged the
coupon parameter as potentially vulnerable to coupon guessing. It didn't flag that
sending `plan: "pro_monthly"` on the `enterprise_yearly` checkout flow — just
changing the plan parameter in a different endpoint's request — gave you the
enterprise product at the pro monthly price. Same endpoint, same code, no bug
visible in the code. The bug only exists in the gap between what the business
intended and what the code allows.

**What to do instead:** you define the expected behavior. The LLM checks whether
the code enforces it. "This endpoint should charge the price associated with the
product in the product catalog. Where in the code does it look up the price? Show
me exactly where."

### Race conditions

LLMs understand code as sequential execution. The vulnerability exists between
two lines — the read and the write, the check and the use — and attention
mechanisms aren't built to spot those gaps.

**What to do instead:** ask the LLM to list every state-changing operation. Then
you manually hunt for TOCTOU pairs, non-atomic read-increment-write patterns,
and operations that should be wrapped in a transaction but aren't.

### Novel attack techniques

LLMs are trained on existing public knowledge. If you're looking for a new gadget
chain in a custom serialization format, or a novel HTTP smuggling variant in a
specific proxy combination, the model can help you *understand the code* but it
won't make the creative leap. That still requires a human who understands the
underlying primitives and thinks "what if I try..."

### Context that spans too many files

Even with large context windows, LLMs lose track of subtle cross-file details. A
middleware that reads `req.userId` and a handler that reads `req.params.userId` —
the LLM might note each individually but miss that the middleware uses one source
and the handler uses another, creating an IDOR. The vulnerability exists in the
*relationship* between two files.

**What to do instead:** feed smaller pieces and ask about the relationship.
"Here's the middleware that processes all requests to /api/v2/users/*. Here's the
handler for GET /api/v2/users/:id. Does the handler independently verify anything
the middleware already checked? Does it trust any assumption the middleware made?"

## Real costs

This is what I actually spend per month, hunting 15-20 hours/week:

| What | Tool | $/mo |
|------|------|------|
| Deep analysis, complex exploit dev | Claude Pro (Opus) | $200 |
| Bulk JS analysis, parameter scanning | GPT API | $80-150 |
| Endpoint triage, filtering noise | DeepSeek API | $15-25 |
| Adversarial validation | Local model (Ollama) | $0 |
| **Total** | | **~$300-375** |

Before AI: $150/mo Burp Pro, $30/mo VPS, and roughly 3x more hours per finding.
The pipeline roughly doubles my effective hunting speed for ~$100-150 in net new
costs.

One additional Medium finding per month pays for the pipeline. If the pipeline
surfaces even one bug I'd have missed — and it does, regularly — it's net positive.

## Where to start

Don't build the whole pipeline at once. The people who burn out on this try to
automate everything on day one and end up debugging orchestration code instead
of hunting.

**Start with recon.** Get the JS analysis prompt working against real targets.
Build the script that extracts script sources and feeds them through. Once you
can map a target's API surface in 10 minutes, you're ready for the next piece.

**Add the hypothesis generator.** Before you manually test anything, generate 20+
specific hypotheses. After a few targets, you'll start recognizing which ones
pay and which ones don't. Tune the prompt based on what works.

**Build the gate.** Set up the three-round validation. Run your existing findings
through it — including ones you've already been paid for. Watch what dies. Adjust
your hypothesis generator based on what the gate kills most often.

**Let go of the "one prompt" fantasy.** There is no prompt that turns an LLM into
a bug hunter. The hunter is the system — the prompts, the gates, the feedback
loops, the human steering at every decision point. The LLM is the best research
assistant you'll ever have. It's not the researcher.

---

The model didn't find those bugs. The pipeline did. Build the pipeline.
