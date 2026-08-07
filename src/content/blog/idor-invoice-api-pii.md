---
title: 'IDOR in an invoice API leaking 40k customers'' PII'
description: 'One sequential ID, no ownership check, and a JSON response full of names, emails, and addresses. The oldest bug in the book still pays.'
pubDate: 2026-05-10
heroImage: '/thumbnails/idor.png'
tags: ['IDOR', 'PII', 'High']
---

Insecure Direct Object Reference is the bug people assume is already dead. It isn't. The
mistake just moved from the HTML page to the JSON API, where nobody's looking. This one
exposed the PII of roughly forty thousand customers through a single unauthenticated-ish
parameter swap.

## The endpoint

Downloading your own invoice made this call:

```http
GET /api/v1/invoices/500123 HTTP/1.1
Host: api.acme.example
Authorization: Bearer <my-token>

200 OK
{
  "id": 500123,
  "customer": { "name": "…", "email": "…", "address": "…", "phone": "…" },
  "lines": [ … ],
  "total": 129.00
}
```

Sequential integer ID. Authenticated request. The only question that matters: does the
server check that invoice `500123` belongs to *me*?

## Testing ownership

Decrement the ID by one and replay with my own token:

```http
GET /api/v1/invoices/500122 HTTP/1.1
Authorization: Bearer <my-token>

200 OK
{ "id": 500122, "customer": { "name": "Someone Else", "email": "…" }, … }
```

`200`, and it's not my invoice. No ownership check at all — the token only proved I was
*a* user, not that I was *the* user for this record. That's a horizontal authorization
bypass, and the object it exposes is full customer PII.

## Proving scale (without hoarding data)

You don't dump 40,000 records to prove impact — that's the difference between a researcher
and a liability. I pulled a **tiny, bounded sample** to show the pattern holds across the
ID range, then stopped:

```bash
# three non-adjacent IDs, spread across the range, to show it's systemic — not a fluke
for id in 500122 512000 540000; do
  curl -s -H "Authorization: Bearer $TOKEN" \
    "https://api.acme.example/api/v1/invoices/$id" \
    | jq '{id, name: .customer.name, email: .customer.email}'
done
```

Three IDs, three different real customers, each a `200`. Highest observed ID was ~540000
and the range was contiguous, so the exposure is on the order of tens of thousands of
records. That's the impact statement — measured, not guessed. Sample deleted after
capture.

## The sibling rule

One IDOR is never alone. The same developer made the same mistake next door:

```
/api/v1/invoices/{id}      ← confirmed
/api/v1/orders/{id}        ← also missing the check
/api/v1/subscriptions/{id} ← also missing the check
```

Same class, three endpoints. I reported them as **one root cause** (missing
object-level authorization) with three affected routes — one bug, not three padded
reports.

## Impact

Any authenticated user could read the name, email, address, and phone of every customer
by iterating a sequential ID across three endpoints. Mass PII exposure — reported **High**,
triaged fast, fixed by adding an ownership check at the data layer.

## Takeaways

- APIs are where IDORs live now. Test every `/{id}` with a second account's token.
- Prove **scale**, not volume. A bounded, deleted-after sample beats a 40k-row dump and
  keeps you on the right side of the rules.
- Apply the sibling rule every time. Confirmed bug on one object == check every object
  next to it.
