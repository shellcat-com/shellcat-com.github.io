---
title: "Building a face search engine end to end"
description: "The engineering build log behind the FaceCheck reconstruction — the RAM-only query path, the SCRFD + ArcFace embedder, the ChromaDB cosine index, and the crawlers that mostly don't work. Real code, 252 faces, no billion-scale hand-waving."
pubDate: 2026-08-08T18:00:00
tags: ["Face Recognition", "ArcFace", "Vector Search", "InsightFace"]
---

A GitHub repo called [Facecheck.id-Extractor](https://github.com/quantumthe0ry/Facecheck.id-Extractor) used to pull results out of FaceCheck.id programmatically. The trick was small and ugly: FaceCheck returned each result image as base64, and the source URL was embedded inside the image bytes. The repo decoded the base64 and ran `"url":"https://..."` through a regex on the raw bytes. FaceCheck moved the URLs out of the images, the regex stopped matching, and the technique died.

That repo is why I wrote this. Scraping the output told me nothing about the engine. So I built the engine.

This is the build log — the actual pipeline, the actual data structures, and the two places I got it wrong the first time.

## The number that decides the architecture

The short version, since it dictates everything below. FaceCheck's counter says ~1.4 billion faces. A 50KB thumbnail times 1.4 billion is 70TB, and full-resolution photos are roughly 10× that. Nobody stores 700TB of photos that already live on `fbi.gov`, Instagram, and VK.

A face is not a photo. Run it through ArcFace and you get 512 float32 numbers. That is exactly 2,048 bytes:

```text
1,400,000,000 faces × 2,048 bytes           = 2.8 TB   (vectors only)
+ source URL + metadata ≈ 9 KB per record   ≈ 13 TB    (full index)
```

One hard drive. That single fact decides everything downstream: the database stores vectors and URLs, never image bytes. The photos stay where they already are, and the search results load from those origin servers directly into the browser. The engine never copies them.

![FaceCheck Pro architecture](/diagrams/facecheck-architecture.svg)

## The embedder: SCRFD and ArcFace in one pass

The recognition side is a `pip install` and a day of work. InsightFace ships `buffalo_l`, which bundles SCRFD 10g for detection and ArcFace ResNet50 for the 512-dimensional embedding. ONNX Runtime handles acceleration — CoreML on Apple Silicon, CPU fallback everywhere else.

```python
self._model = insightface.app.FaceAnalysis(
    name="buffalo_l",
    allowed_modules=["detection", "recognition"],   # SCRFD 10g + ArcFace R50
    providers=["CoreMLExecutionProvider", "CPUExecutionProvider"],
)
self._model.prepare(ctx_id=0, det_size=(640, 640), det_thresh=0.5)
```

The important detail is `model.get()` — one call does detection and recognition together. You hand it a numpy image, it hands back a list of faces, each already carrying its bounding box and its embedding. No two-stage plumbing.

```python
faces = self._model.get(img)          # detect + embed, single pass
for face in faces:
    x1, y1, x2, y2 = face.bbox.astype(float)
    embedding = face.embedding
    if embedding is None or len(embedding) != 512:
        continue
    results.append({
        "box": {"x": int(x1), "y": int(y1), "w": int(x2 - x1), "h": int(y2 - y1)},
        "embedding": embedding.astype(np.float32),   # 512 float32 = 2,048 bytes
        "confidence": float(face.det_score),
    })
```

ArcFace vectors are compared by angle, not magnitude — that is what cosine similarity measures. I store the raw 512-d `face.embedding` and let ChromaDB's cosine space do the normalizing; on unit vectors that comparison collapses to a plain dot product. The `len(embedding) != 512` guard is not paranoia — a corrupt decode or a non-face crop can return something malformed, and a bad vector in the index poisons every future search near it.

## Two detectors, and the thing I got wrong

It is tempting to call the browser's face descriptor a search "fallback." That is wrong, and it is exactly the kind of thing that sounds right and isn't.

There are two detectors in this system, and they exist for two unrelated reasons.

The **browser** runs `face-api.js` with `TinyFaceDetector`. Its only job is instant UX — the moment you drop a photo in, the page draws a box and says "face detected" without a network round trip. `face-api.js` will also compute a 128-dimensional descriptor if you ask it to. That descriptor is a dead end for search. It comes from a different model trained in a different embedding space. You cannot compare a 128-d browser descriptor against a 512-d ArcFace index — they are not the same units, not the same geometry, and cosine distance between them is noise. It is not a fallback. It never touches the database.

The **server** runs SCRFD. That detection is the accurate one, and it feeds ArcFace to produce the 512-d embedding that the search actually uses. Every match in the results came from the server path. The browser detector is a UX affordance; the server detector is the engine.

Two detectors, two jobs. Local feedback is not remote search. Keep them separate in your head or you will write the same wrong sentence I did.

## The query path is RAM-only

The frontend is Next.js 16, React 19, Tailwind. The search page posts a multipart upload to a Next route on `:3000`, which forwards it straight to FastAPI on `:8000`. The proxy is thin on purpose — it does not decode the image, it just moves bytes and handles the failure case.

```typescript
const res = await fetch(`${BACKEND_URL}/api/search`, {
  method: "POST",
  body: formData,                       // multipart forwarded straight through
  signal: AbortSignal.timeout(60000),
})
if (res.ok) return NextResponse.json(await res.json())
// backend down → degrade to external reverse-image engines
return getFallbackResponse()   // Lens, Yandex, Bing, TinEye, PimEyes, Search4Faces
```

If the Python backend is down, the proxy degrades to links: Google Lens, Yandex, Bing Visual Search, TinEye, PimEyes, Search4Faces. You re-upload on those yourself. It is not a real search, but it means the page never hard-fails.

On the FastAPI side, the uploaded bytes are read into memory, embedded, and searched. They are never written to disk.

```python
contents = await file.read()                 # bytes in RAM
faces = await embedder.embed_bytes(contents, threshold=0.4)
# ...
results = vector_store.search(query_embedding, top_k=30, min_similarity=0.25)
```

`embed_bytes` decodes with `cv2.imdecode` from a numpy buffer — no temp file, no path.

```python
async def embed_bytes(self, image_bytes: bytes, threshold: float = 0.5) -> List[dict]:
    import cv2
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)   # decode in memory
    if img is None:
        return []
    return self._process_image(img, threshold)    # detect + embed, then discard
```

After the response is built, `contents` goes out of scope and gets garbage-collected. The photo you searched with existed on the server for about two seconds and left no trace. The result photos never pass through the server at all — the browser loads each one from its `thumbnail_url`, which points at the origin (`fbi.gov`, a CDN, wherever the face actually lives).

## The vector store

ChromaDB, `PersistentClient`, one collection named `faces`, cosine space:

```python
self._collection = self._client.create_collection(
    name="faces",
    metadata={"hnsw:space": "cosine"},
)
```

A stored record is the 512-float embedding plus flat metadata — `source_url`, `source_name`, `category`, `title`, `thumbnail_url`, `description`, `indexed_at`. No image, ever. ChromaDB is picky about metadata types, so lists get JSON-encoded and `None` values get dropped before insert, otherwise the add throws.

The one part worth reading closely is the score conversion. ChromaDB returns cosine **distance**, not similarity. With `hnsw:space=cosine`, distance is `1 - cos(θ)`, so you invert it:

```python
distance   = results["distances"][0][i]      # ChromaDB returns cosine DISTANCE
similarity = 1.0 - distance                  # 1 - cos(θ)  →  similarity
match_score = int(similarity * 100)
if similarity < min_similarity:              # search() passes 0.25
    continue
```

Get that inversion backwards and your best matches sort to the bottom. The `match_score` becomes the number the UI shows, bucketed into labels:

```text
score >= 90   Certain
score >= 83   Confident
score >= 70   Uncertain
score >= 50   Weak
```

These thresholds are a product decision, not a property of the model. ArcFace gives you a cosine number; where you draw "Certain" versus "Weak" is you deciding how much confidence to imply. FaceCheck draws its own lines. So do I.

## The index path: crawl, embed, throw the photo away

Seeding runs offline through `/api/seed`, and it reuses the already-loaded models — no second process spinning up a second copy of ArcFace. Crawlers return face records; each record's image is downloaded to RAM, embedded, and stored as a vector. The bytes are then dropped.

```python
image_bytes = await download_image_bytes(image_url)   # httpx GET → RAM only
faces = await embedder.embed_bytes(image_bytes, threshold=0.4)
# image_bytes is now the only reference — garbage collected after this
for face in faces:
    vector_store.add_face(
        embedding=face["embedding"],        # 512 floats
        source_url=record["source_url"],    # + URL + metadata
        source_name=record["source_name"],
        category=record["category"],
        thumbnail_url=record["thumbnail_url"],
        # ...the photo itself is never persisted
    )
```

The download uses a `FaceCheck-Pro/1.0 (research; public-data)` User-Agent and rejects anything that comes back as HTML or under 100 bytes — a blocked request usually returns a challenge page, not an image. There is exactly one place in the whole project where an image touches disk: the standalone `seed_database.py` script keeps a local processing cache. That cache is gitignored and it is not the search database. The live `/api/seed` path is RAM-only end to end.

## The crawlers are the part that doesn't work

Here is the honest split. The model took a day. The crawlers took a week and mostly do not work.

One crawler works: `fbi_wanted.py`. It hits the FBI Wanted API (`api.fbi.gov/@wanted`, free, no key) and Interpol Red Notices. Both return structured JSON with real mugshots, the person's crimes, reward amounts, and a full physical description — sex, race, hair, eyes, height, weight, scars. That gets stored alongside the embedding, which is why an FBI match in the results carries the whole rap sheet.

The rest are written and mostly blocked:

- `sex_offender_registries.py` — NSOPW and state registries.
- `social_media.py` — Google image search plus `randomuser.me` and `dicebear` for **synthetic** test faces. The synthetic ones are the point; the Google path is what gets blocked.
- `news_media.py` — GDELT and RSS, needs a `NEWSAPI_KEY`.
- `videos_youtube.py` — needs a `YOUTUBE_API_KEY`.
- `scammers.py`, `jailbase.py` — scraped sources.

They hit 429s, Cloudflare, and JavaScript-rendering walls. And there is deliberately no proxy rotation, no CAPTCHA-solving, no evasion of any kind in this repo. That absence is the thesis. The model is commodity — InsightFace, ONNX, ChromaDB, all off the shelf. The moat is crawling infrastructure at scale: rotating residential proxies, headless browser fleets, per-platform parsers that break weekly, session pools refreshed hourly. FaceCheck did not solve face recognition. They solved web crawling. That is the expensive, unglamorous, week-plus part, and it is the part I did not build.

## The FaceCheck-shaped API

For anyone wiring against FaceCheck's own request shape, there are two compatible endpoints. `POST /api/facecheck/upload` embeds the photo and stashes the 512-d vector in an in-memory dict keyed by a generated `id_search`. `POST /api/facecheck/search` polls by that id and returns FaceCheck's exact response envelope.

```python
SEARCH_SESSIONS: Dict[str, dict] = {}         # in-memory, keyed by id_search

# POST /api/facecheck/upload  → embed → store vector → return { id_search }
# POST /api/facecheck/search  → poll by id_search → FaceCheck's own shape:
# { "data": { "output": { "items": [ { "score", "url", "thumbnail_url" } ] } } }
```

I just moved these to be RAM-only too — the session dict holds a vector and a timestamp, never an image. Where FaceCheck base64-encoded result images (the anti-scraping measure the extractor repo exploited), this hands back the origin `thumbnail_url` and lets the browser fetch it. Same shape, none of the storage.

## 252 faces

The demo index has 252 faces. FBI Wanted, Interpol, and a batch of synthetic test faces. Not 1.4 billion.

I am stating that number plainly because it is the whole point. Every line of code above is a faithful reconstruction of how a billion-scale face search engine works — the RAM-only query path, the 512-d embeddings, the cosine index, the vector-plus-URL records. The architecture is correct at any scale. What separates 252 from 1.4 billion is not a smarter model or a cleverer query. It is a fleet of crawlers running around the clock behind proxy infrastructure I chose not to build. The code is not the hard part. The code is the day-one part.

## Why this should bother you

Everything here is public. InsightFace is a free download. ChromaDB is `pip install`. The FBI publishes an open API with mugshots and physical descriptions. Face detection runs on a laptop. I assembled a working face search engine over a couple of evenings out of parts that are all lying in the open, and the only reason mine indexes 252 faces instead of a billion is that I stopped at the crawling wall.

That is the part that should bother you. The capability is not gated behind some rare model or a research lab. It is gated behind operational effort, and operational effort is cheap for anyone motivated. The photo you posted once, on a profile you forgot about, is a 2,048-byte point in someone's index whether or not you ever consented to it. Deleting the photo does not delete the vector.

I built this to understand it, on public data, and I am not going to hand anyone the crawling layer that turns 252 into a billion. Read the code, run it against your own faces, see the machine for what it is. Then think about the fact that the hard part was never the recognition.

## The code

Everything is at [github.com/shellcat-com/facecheck-pro](https://github.com/shellcat-com/facecheck-pro), MIT.

```bash
git clone https://github.com/shellcat-com/facecheck-pro.git
cd facecheck-pro
cd backend && bash run.sh      # :8000 — downloads InsightFace models first run, seeds FBI
npm install && npm run dev     # :3000
```

First backend run pulls the `buffalo_l` model pack (a few hundred megabytes) and seeds from the FBI API, so it works out of the box with real faces. Upload one and you get real matches. Just not a billion of them.
