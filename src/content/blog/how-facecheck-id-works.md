---
title: "How I reverse-engineered FaceCheck.id and built my own face search engine"
description: "A deep dive into the architecture behind billion-scale face recognition — client-side detection, ArcFace embeddings, vector similarity search, and why storing 1.4 billion faces only takes 18 terabytes, not 1.4 petabytes."
pubDate: 2026-08-08
tags: ["reverse-engineering", "face-recognition", "vector-search", "arcface", "chromadb", "architecture"]
heroImage: ""
---

I found a GitHub repo called [Facecheck.id-Extractor](https://github.com/quantumthe0ry/Facecheck.id-Extractor) that extracts face search results programmatically. It got me thinking: how does a website find where any face appears online, across ~1.4 billion indexed photos, in under two seconds?

So I built one. Here is everything I learned.

## The question that started this

FaceCheck.id claims to search 1.4 billion faces. My first thought was: _that has to be petabytes of photos_. A single compressed JPEG thumbnail is maybe 50KB. Multiply by 1.4 billion:

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

That is a $300 hard drive. Not a data center. The entire "face database" is just a giant matrix of 512-dimensional vectors and a bunch of URLs pointing back to where the original photos live.

## The pipeline

Every face search engine — FaceCheck.id, PimEyes, Clearview, and mine — follows the same five-step pipeline:

```
                    ┌──────────────────────┐
  1. UPLOAD         │  User uploads photo  │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
  2. DETECT         │  Find the face in    │
                    │  the image (SCRFD)   │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
  3. EMBED          │  Convert face to     │
                    │  512-dim vector      │
                    │  (ArcFace R50)       │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
  4. SEARCH         │  Cosine similarity   │
                    │  against N vectors   │
                    │  in the database     │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
  5. RETURN         │  Top-K matches       │
                    │  with source URLs    │
                    └──────────────────────┘
```

Steps 1-3 happen in RAM. The uploaded photo lives in memory for about two seconds, gets converted to a vector, and then gets garbage-collected. Nothing is written to disk. The result photos shown to the user load from their original source URLs — FBI servers, public Instagram CDN, whatever — directly in the user's browser. They never pass through the search server at all.

Step 4 is the interesting part. Cosine similarity between two 512-dimensional vectors is just a dot product. With HNSW indexing (what ChromaDB uses), searching a million faces takes milliseconds. At billion scale, you shard across machines and use approximate nearest neighbor (ANN) with IVF-PQ quantization — tiny accuracy loss, massive speed gain.

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

**Two face detectors is deliberate.** The browser one gives instant UX feedback. The server one (SCRFD) is far more accurate and produces the 512-dim ArcFace embedding used for actual matching. The browser's 128-dim descriptor is a fallback.

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
# Download image to RAM → extract face → store vector → discard image
image_bytes = await download_image_bytes(url)          # RAM only
faces = await embedder.embed_bytes(image_bytes)        # 512-dim from bytes
vector_store.add_face(embedding, source_url, ...)      # store 2KB vector + URL
# image_bytes falls out of scope → freed by GC
```

Every image is downloaded, processed, and discarded. What persists in ChromaDB is exactly 512 floats plus a source URL. The photos you see in search results load directly from `fbi.gov` in your browser.

## Where the data comes from

FaceCheck.id has 50+ crawlers running 24/7. Public sources only — nothing behind authentication:

| Source | How they get it |
|---|---|
| VK (Russian Facebook) | Extremely open API. Public profiles have essentially no privacy. |
| Instagram | Public profiles only. Profile photo CDN URLs are unauthenticated. |
| TikTok | Public profile photos. CDN direct links. |
| FBI Wanted | Free public API: `api.fbi.gov/@wanted` |
| Sex offender registries | All 50 US states have public databases (mandated by law). |
| News sites | Public web pages. Google News, RSS, GDELT. |
| YouTube | Public video thumbnails. No API key needed. |

For my project, I use the FBI Wanted API — it is free, requires no key, and returns structured JSON with mugshots, crimes, reward amounts, and physical descriptions. My crawler extracts all of this and stores it alongside the face embedding.

The other crawlers (Instagram, TikTok, registries) I wrote the code for but they hit the same wall every scraper hits: rate limiting, Cloudflare anti-bot, and CAPTCHAs. The _code_ is straightforward — the _infrastructure_ (rotating residential proxies, headless browser fleet, session management) is the real product.

## What each database record looks like

```
┌─────────────────────────────────────────────────────────┐
│  id:              a1b2c3d4-...                            │
│  embedding:       [0.023, -0.145, 0.887, ...]  ← 512 floats │
│  source_url:      https://www.fbi.gov/wanted/cei/john-doe │
│  thumbnail_url:   https://www.fbi.gov/.../image/large     │
│  title:           JOHN DOE — FBI Most Wanted               │
│  category:        mugshot                                  │
│  crimes:          Murder, Racketeering, Drug Trafficking   │
│  reward:          Up to $250,000                            │
│  physical:        {sex: Male, race: White, eyes: Brown,    │
│                    height: 5'11", weight: 180 lbs}         │
│  source:          fbi                                      │
│  indexed_at:      2026-08-08T14:30:00Z                     │
│                                                           │
│  Photo?           NOT HERE — lives on fbi.gov              │
└─────────────────────────────────────────────────────────┘
```

Total: roughly 9KB per face. The photo loads from `thumbnail_url` — FBI's CDN, not ours.

## Why Crawlers Are Harder Than Models

The machine learning part took a day. The InsightFace buffalo_l model works out of the box. ONNX Runtime handles GPU/CoreML acceleration. ChromaDB is a `pip install`. The five-step pipeline is maybe 200 lines of Python.

The crawlers took a week and mostly do not work. Here is why:

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

## The FaceCheck.id API Format

The extractor repo I found revealed their internal API format:

```json
// POST /api/search
{
    "id_search": "<session_token>",
    "with_progress": true,
    "status_only": false,
    "demo": false
}

// Response
{
    "data": {
        "output": {
            "items": [
                {
                    "base64": "<result image as base64>",
                    "score": 94,
                    // source URLs encoded inside the image itself (steganography)
                }
            ]
        }
    }
}
```

They embed source URLs inside the result images as base64-encoded data — a crude but effective anti-scraping measure. The extractor tool reads those URLs back out. My implementation uses the same upload/search endpoint structure for compatibility.

## What I Would Do Differently

**Start with the database, not the model.** Face recognition models are commodity. ArcFace, MagFace, AdaFace — they all produce embeddings. The model is 1% of the work. 99% is getting faces _into_ the database.

**Use existing datasets for the initial seed.** VGGFace2 has 3.3 million faces from public figures. IMDB-Wiki has 500K celebrity faces. CelebA has 200K. All free, all legal for research. Download once, embed once, done. That would have given me a real searchable database instead of 252 test faces.

**The crawler architecture is the moat.** A billion-face index is not a machine learning problem. It is a distributed crawling problem. Rotating proxies, headless browsers, per-platform parsers, and a pipeline that processes thousands of faces per second continuously. The crawlers ARE the startup.

## The code

Everything is at [github.com/shellcat-com/facecheck-pro](https://github.com/shellcat-com/facecheck-pro). MIT license. It works — upload a face, get results. Just not at billion scale.

```bash
git clone https://github.com/shellcat-com/facecheck-pro.git
cd facecheck-pro
cd backend && bash run.sh &   # starts on :8000
npm install && npm run dev     # starts on :3000
```

The architecture is correct. The pipeline is identical to FaceCheck.id. The database just has 252 faces instead of 1.4 billion — and fixing that is a crawling infrastructure problem, not a code problem.
