---
title: "How I reverse-engineered FaceCheck.id and built my own face search engine"
description: "The architecture behind billion-scale face recognition — client-side detection, ArcFace embeddings, vector similarity search, and why storing 1.4 billion faces takes 13 terabytes, not 1.4 petabytes."
pubDate: 2026-08-08
tags: ["Face Recognition", "Vector Search", "ArcFace", "ChromaDB"]
---

A GitHub repo called [Facecheck.id-Extractor](https://github.com/quantumthe0ry/Facecheck.id-Extractor) used to pull FaceCheck.id search results out programmatically. How does a website find where any face appears online, across ~1.4 billion indexed photos, in seconds?

So I built one.

## The question that started this

FaceCheck.id's on-site counter shows roughly 1.4 billion faces indexed. My first thought was: _that has to be petabytes of photos_. A single compressed JPEG thumbnail is maybe 50KB. Multiply by 1.4 billion:

```
50KB × 1,400,000,000 = 70,000,000,000 KB = 70 terabytes
```

That is just thumbnails. Full-resolution photos would be 10× that. Nobody pays for 700TB of photo storage when those photos already live on Instagram, FBI servers, VK, and TikTok.

So they must not store photos. But then what _do_ they store?

## The answer: 512 numbers per face

A face is not a photo. A face is a **point in 512-dimensional space**.

When you run a photo through ArcFace (a face recognition model from InsightFace), it spits out 512 floating-point numbers. That is the face. The original photo is irrelevant after this point — the embedding IS the identity.

```
Photo (50KB-2MB)  →  ArcFace ResNet50  →  [0.023, -0.145, 0.887, ..., 0.432]
                                                 └────── 512 floats ──────┘
                                                         exactly 2,048 bytes
```

2KB per face. For 1.4 billion faces: **2.8 terabytes**.

That is one hard drive. Not a data center. The vectors are the bare minimum — add the source URL and the metadata each record carries (the record box below sums to roughly 9KB per face) and the full index lands near 13 terabytes. Still one hard drive. The entire "face database" is a giant matrix of 512-dimensional vectors and a bunch of URLs pointing back to where the original photos live.

## The pipeline

Every embedding-based face search engine — FaceCheck.id, PimEyes, Clearview, and mine — runs the same five steps:

```
upload → detect (SCRFD) → embed (ArcFace R50, 512-dim) → cosine search → top-K + source URLs
```

Steps 1-3 happen in RAM. The uploaded photo lives in memory for about two seconds, gets converted to a vector, and then gets garbage-collected. Nothing is written to disk. The result photos shown to the user load from their original source URLs — FBI servers, public Instagram CDN, whatever — directly in the user's browser. They never pass through the search server at all.

Step 4 is the interesting part. Cosine similarity between two 512-dimensional vectors is just a dot product. With HNSW indexing (what ChromaDB uses), my 252-face index answers a query in about a millisecond, and a million faces takes milliseconds. At billion scale, you shard across machines and use approximate nearest neighbor (ANN) with IVF-PQ quantization — tiny accuracy loss, massive speed gain.

## What I built

My implementation uses:

**Frontend (browser):**
- face-api.js with TinyFaceDetector for instant client-side feedback ("face detected")
- FaceLandmarks68 + FaceRecognition for a 128-dim browser-side descriptor
- Next.js 16 + React 19 with Tailwind

**Backend (Python):**
- FastAPI server on port 8000
- InsightFace buffalo_l: SCRFD 10g for detection, ArcFace ResNet50 for 512-dim embeddings
- ONNX Runtime with CoreML acceleration on Apple Silicon
- ChromaDB with HNSW cosine similarity for vector search

Running two face detectors is deliberate. The browser one gives instant UX feedback. The server one (SCRFD) is far more accurate and produces the 512-dim ArcFace embedding used for actual matching. The browser's 128-dim descriptor is a fallback.

**Pipeline (RAM-only, no disk):**

```python
# Search endpoint — the uploaded photo never touches disk
contents = await file.read()                           # bytes in RAM
faces = await embedder.embed_bytes(contents)           # face → 512-dim vector
results = vector_store.search(faces[0]["embedding"])   # cosine similarity search
return enriched_results                                # image bytes: garbage collected
```

**Seeding the database:**

```python
# Download image to data/images/<category>/ → embed → store vector → keep URL
local_path = await download_face_image(url, download_dir)   # disk cache
faces = await embedder.embed_image(local_path, threshold=0.4)
vector_store.add_face(faces[0]["embedding"], source_url, ...)  # 2KB vector + URL
# local_path stays as a processing cache; the photo's real home is fbi.gov
```

Seeding caches originals on disk — that is the one place a photo lands in my pipeline, and it is a local processing cache, not the search database. Search itself is RAM-only. What persists in ChromaDB is exactly 512 floats plus a source URL and a few metadata fields. The photos you see in search results load directly from `fbi.gov` in your browser.

## Where the data comes from

FaceCheck.id's own disclaimer says every image it indexes comes from public, readily available web pages. Feeding a 1.4-billion-face index from public pages means a fleet of crawlers running around the clock:

| Source | How they get it |
|---|---|
| VK (Russian Facebook) | Unusually open API — tokenless calls work for public profiles. |
| Instagram | Public profiles only. Profile photo CDN URLs are unauthenticated. |
| TikTok | Public profile photos. CDN direct links. |
| FBI Wanted | Free public API: `api.fbi.gov/@wanted` |
| Sex offender registries | All 50 US states have public databases (mandated by law). |
| News sites | Public web pages. Google News, RSS, GDELT. |
| YouTube | Public video thumbnails. No API key needed. |

For my project, I use the FBI Wanted API — it is free, requires no key, and returns structured JSON with mugshots, crimes, reward amounts, and physical descriptions. My crawler extracts all of this and stores it alongside the face embedding.

The other crawlers (Instagram, TikTok, registries) I wrote the code for but they hit the same wall every scraper hits: rate limiting, Cloudflare anti-bot, and CAPTCHAs. The _code_ is straightforward — the _infrastructure_ (rotating residential proxies, headless browser fleet, session management) is the real product.

## What each database record looks like

```text
id:            a1b2c3d4-...
embedding:     [0.023, -0.145, 0.887, ...]        ← 512 floats
source_url:    https://www.fbi.gov/wanted/cei/john-doe
thumbnail_url: https://www.fbi.gov/.../image/large
title:         JOHN DOE — FBI Most Wanted
crimes:        Murder, Racketeering, Drug Trafficking
reward:        Up to $250,000
indexed_at:    2026-08-08T14:30:00Z
photo:         NOT HERE — lives on fbi.gov
```

Total: roughly 9KB per face. The photo loads from `thumbnail_url` — FBI's CDN, not ours.

## Why crawlers are harder than models

The machine learning part took a day. The InsightFace buffalo_l model works out of the box. ONNX Runtime handles GPU/CoreML acceleration. ChromaDB is a `pip install`. The five-step pipeline is maybe 200 lines of Python.

The crawlers took a week and mostly do not work:

```python
# What I wrote:
async with httpx.AsyncClient() as client:
    resp = await client.get("https://www.google.com/search?q=site:instagram.com+face&tbm=isch")
```

Google returns HTTP 429 after two requests. Instagram requires JavaScript rendering. State registries use Cloudflare bot detection. Scammer forums have certificate pinning. Every single source blocks naive HTTP requests.

Production crawlers need:
- Residential proxy rotation (not datacenter IPs — those are blocklisted instantly)
- Headless Chrome via Playwright or Puppeteer (JavaScript rendering)
- Random delays, randomized viewport sizes, mouse movement simulation
- Session cookie pools refreshed every few hours
- Per-platform parsers (Instagram's HTML structure changes weekly)

The code is not the product. **The proxy fleet is the product.** FaceCheck.id did not solve face recognition — they solved web crawling at scale.

## The FaceCheck.id API format

The extractor repo I found revealed their internal API format:

```json
// POST /api/search
{
    "id_search": "<id from the URL after uploading>",
    "with_progress": true,
    "status_only": true,
    "demo": false
}

// Response
{
    "output": {
        "items": [
            {
                "base64": "<result image as base64>",
                "score": 94
            }
        ]
    }
}
```

They embedded source URLs inside the result images as base64-encoded data — an anti-scraping measure that doubled as the extractor's extraction mechanism. The repo decodes the base64 and regexes `"url":"https://..."` out of the image bytes. FaceCheck moved the URLs out of the images — the repo's README says the technique stopped working. My implementation keeps the same path — `POST /api/search` — but takes a multipart file upload instead of their JSON session payload.

## What I would do differently

**Start with the database, not the model.** Face recognition models are commodity. ArcFace, MagFace, AdaFace — they all produce embeddings. The model is 1% of the work. 99% is getting faces _into_ the database.

**Use existing datasets for the initial seed.** VGGFace2 has 3.3 million faces from public figures. IMDB-Wiki has 500K celebrity faces. CelebA has 200K. All free, all legal for non-commercial research — which means a product can't legally use them, only a prototype can. Download once, embed once, done. That would have given me a real searchable database instead of 252 faces.

**The crawler architecture is the moat.** A billion-face index is not a machine learning problem. It is a distributed crawling problem. Rotating proxies, headless browsers, per-platform parsers, and a pipeline that processes thousands of faces per second continuously. The crawlers ARE the startup.

## The code

Everything is at [github.com/shellcat-com/facecheck-pro](https://github.com/shellcat-com/facecheck-pro). MIT license. It works — upload a face, get results. Just not at billion scale.

```bash
git clone https://github.com/shellcat-com/facecheck-pro.git
cd facecheck-pro
cd backend && bash run.sh &   # starts on :8000
npm install && npm run dev     # starts on :3000
```

The architecture is correct. The pipeline is a faithful reconstruction of FaceCheck.id's. The database just has 252 faces instead of 1.4 billion — and fixing that is a crawling infrastructure problem, not a code problem.
