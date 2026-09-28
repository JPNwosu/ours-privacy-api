# Image Processing Service

A Cloudinary-style HTTP API that fetches an image from a URL, resizes and converts it, and returns the result. It can also take a thumbnail from a video.

```
GET /process?url=https://httpbin.org/image/jpeg&width=800&height=600&format=webp&crop=fill
GET /video/thumbnail?url=https://www.w3schools.com/html/mov_bbb.mp4&time=5
```

Built with TypeScript, Express 5, [sharp](https://sharp.pixelplumbing.com/) (libvips), ffmpeg (via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)), Zod and undici.

## Quick start

Requires **Node.js 22.19+, 24 or 26+** (24 LTS recommended). `npm install` also downloads an ffmpeg binary, so there is nothing else to install.

```bash
npm install
npm run dev        # http://localhost:3000, restarts on changes
```

Try it:

```bash
# Resize to 300px wide, keeping the aspect ratio
curl -o resized.jpg "http://localhost:3000/process?url=https://httpbin.org/image/jpeg&width=300"

# Convert PNG to JPEG
curl -o converted.jpg "http://localhost:3000/process?url=https://httpbin.org/image/png&format=jpeg&quality=80"

# Combine operations
curl -o thumb.webp "http://localhost:3000/process?url=https://httpbin.org/image/jpeg&width=200&height=200&format=webp&crop=fill"

# Video thumbnail at 5 seconds, 400px wide
curl -o frame.jpg "http://localhost:3000/video/thumbnail?url=https://www.w3schools.com/html/mov_bbb.mp4&time=5&width=400"

# See an error
curl "http://localhost:3000/process?url=https://httpbin.org/image/svg"
```

| Script                           | What it does                                        |
| -------------------------------- | --------------------------------------------------- |
| `npm run dev`                    | Start with auto-reload                              |
| `npm test`                       | Run the test suite                                  |
| `npm run coverage`               | Run the tests with a coverage report and thresholds |
| `npm run typecheck`              | Type-check source and tests                         |
| `npm run format`                 | Format with Prettier (`format:check` to verify)     |
| `npm run build` then `npm start` | Compile to `dist/` and run it                       |

Set `PORT` to listen on a different port.

## API

### `GET /process`

| Parameter | Required | Values                                                   | Default         |
| --------- | -------- | -------------------------------------------------------- | --------------- |
| `url`     | yes      | Absolute `http` or `https` URL with a domain name        |                 |
| `width`   | no       | Integer, 1–5000                                          | Source width    |
| `height`  | no       | Integer, 1–5000                                          | Source height   |
| `crop`    | no       | `fit`, `fill`, `scale` (needs both `width` and `height`) | `fit`           |
| `format`  | no       | `jpeg` (or `jpg`), `png`, `webp`, `avif`                 | Source format   |
| `quality` | no       | Integer, 1–100 (not for `png`)                           | Encoder default |

The response body is the image, with a matching `Content-Type` (for example `image/webp`). Numbers must be plain decimal digits: `0x10` and `1e3` are rejected rather than read as 16 and 1000.

**Resizing**

- Give only `width` or only `height` and the other side follows the aspect ratio.
- Give both and `crop` decides how the image fits the box:

| `crop`          | Result for a 400×200 source at `width=100&height=100`                     |
| --------------- | ------------------------------------------------------------------------- |
| `fit` (default) | 100×50. Whole image visible, aspect ratio kept, fits inside the box.      |
| `fill`          | 100×100. Box filled, aspect ratio kept, overflow cropped from the center. |
| `scale`         | 100×100. Stretched to the exact box, aspect ratio ignored.                |

Images are enlarged if you ask for a size bigger than the source.

**Output format**

- Without `format`, the source format is kept.
- GIF and TIFF sources can be read but not written, so they are returned as PNG, which is lossless and keeps transparency.
- `quality` only applies to lossy formats (`jpeg`, `webp`, `avif`). Asking for quality on PNG output is a 400 rather than being silently ignored, and that includes PNG chosen because the source was PNG, GIF or TIFF.

**Source images**

|               | Limit                                          |
| ------------- | ---------------------------------------------- |
| Formats       | JPEG, PNG, WebP, AVIF, GIF (first frame), TIFF |
| Download size | 20 MB                                          |
| Dimensions    | 50 megapixels                                  |
| Download time | 10 seconds, including redirects                |

The `url` must resolve to a public address. Private, loopback, link-local and other reserved networks are refused (see [Security](#security)).

### `GET /video/thumbnail`

Returns one frame of a video as an image.

| Parameter | Required | Values                                                           | Default |
| --------- | -------- | ---------------------------------------------------------------- | ------- |
| `url`     | yes      | Absolute `http` or `https` URL of an mp4, mov, webm or mkv video |         |
| `time`    | no       | Seconds from the start, 0–86400; fractions allowed (`1.5`)       | `0`     |

It also accepts every image option from `/process` (`width`, `height`, `crop`, `format`, `quality`) with the same rules. The one difference is that `format` defaults to **`jpeg`**, because video frames are photographic and PNG would be several times larger.

A `time` past the end of the video is a 400 that gives the video's length:

```json
{ "param": "time", "message": "time is past the end of the video (the video is 10.0 seconds long)" }
```

| Source videos   | Limit                                            |
| --------------- | ------------------------------------------------ |
| Containers      | mp4, mov, webm, mkv                              |
| Download size   | 100 MB                                           |
| Download time   | 30 seconds, including redirects                  |
| Processing time | 15 seconds                                       |
| Frame size      | Scaled down to fit 5000×5000 before any resizing |

### `GET /health`

Returns `{"status":"ok"}`.

### Errors

Every error is JSON with the same shape. Validation errors list **every** problem at once, one entry per parameter:

```json
{
  "error": {
    "code": "INVALID_PARAMETERS",
    "message": "Invalid query parameters",
    "details": [
      { "param": "url", "message": "url must be an absolute http(s) URL with a domain name" },
      { "param": "width", "message": "width must be an integer between 1 and 5000" },
      { "param": "widht", "message": "unknown parameter: widht" }
    ]
  }
}
```

| Status | `code`               | When                                                                                                       |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_PARAMETERS` | A parameter is missing, malformed, out of range or unknown, or `time` is past the end of the video         |
| 400    | `BLOCKED_URL`        | The url, or a redirect it leads to, points at a private or reserved network address                        |
| 404    | `NOT_FOUND`          | Unknown route                                                                                              |
| 413    | `SOURCE_TOO_LARGE`   | The source is over its size limit (20 MB or 50 megapixels for images, 100 MB for videos)                   |
| 415    | `UNSUPPORTED_SOURCE` | The source is not an image or video, is in an unsupported format, is corrupt, or takes too long to process |
| 500    | `INTERNAL_ERROR`     | A bug on our side; details are logged, never returned                                                      |
| 502    | `UPSTREAM_ERROR`     | The source server returned an error status or could not be reached                                         |
| 504    | `UPSTREAM_TIMEOUT`   | The source did not arrive in time (10 seconds for images, 30 for videos)                                   |

Clients should branch on `code`, which is stable. The messages are for people.

## Testing

```bash
npm test            # or: npm run coverage
npm run typecheck
```

83 tests across five files, running in under a second, with **97% line, 88% branch and 100% function coverage**. `npm run coverage` fails if coverage drops below its thresholds (see `vitest.config.ts`); the entry point `src/index.ts` is excluded because it only reads `PORT` and starts the server.

| File                          | Covers                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/validation.test.ts`     | Parameter parsing, coercion and every validation error                                                                                      |
| `test/transform.test.ts`      | Crop modes, aspect ratio, EXIF orientation, format conversion, quality, metadata stripping, and the 413/415/400 source errors               |
| `test/videoThumbnail.test.ts` | Frame selection by time, webm and mp4, the frame size cap, a time past the end, and refusing non-videos, other containers and HLS playlists |
| `test/app.test.ts`            | Both routes over HTTP: status codes, `Content-Type`, the JSON error format, and that unexpected errors are hidden                           |
| `test/fetchSource.test.ts`    | SSRF protection, redirects, size limits, timeouts and upstream failures against a local HTTP server                                         |

There are no binary fixtures. Test images are generated in memory with sharp, and test videos are generated with ffmpeg from solid-color segments, such as one second of red then one of blue, so a test can tell which moment a frame came from by its color. The route tests inject fake fetchers through `createApp({ fetchImage, fetchVideo })`, and the fetcher tests use `createSourceFetcher({ dispatcher, timeoutMs, maxBytes })` with small limits so the timeout test takes 200 ms instead of 10 s.

To check the tests catch real bugs, I planted some (removing auto-orientation, mapping `fill` to the wrong mode, removing the SSRF check, removing the video container allowlist) and made sure each one failed the suite. Two initially survived, and both tests are now stricter: a color helper that was too lenient, and an HLS test whose playlist pointed at a file ffmpeg couldn't play anyway, so it passed even with every protection removed.

## Project structure

```
src/
  index.ts           Reads PORT and starts the server
  app.ts             Express app and routes (fetch → [extract frame] → transform → respond)
  validation.ts      Query schemas (Zod) and conversion of failures into error details
  fetchSource.ts     SSRF-safe download with size and time limits
  transform.ts       Source checks, resize and encode with sharp
  videoThumbnail.ts  Frame extraction with ffmpeg
  errors.ts          ApiError, the code → status table, 404 and error handlers
test/                One test file per module, plus helpers/ for generating test videos
.github/workflows/   CI: format, typecheck, tests with coverage, build and audit on Node 22 and 24
```

Each stage throws an `ApiError` with a code for failures the client can act on. A single error handler turns those into JSON and turns anything else into a generic 500.

## Design notes

### Security

Fetching a user-supplied URL from inside a server is a classic [SSRF](https://owasp.org/www-community/attacks/Server_Side_Request_Forgery) risk: without care, `url=http://169.254.169.254/...` would read cloud credentials from the metadata service.

- **The check runs at connection time.** Hostnames are resolved inside the HTTP client's own DNS lookup, and every resolved address must be public unicast. The address we check is the address we connect to, so a DNS record can't switch between the check and the connection (DNS rebinding).
- **Redirects are checked too.** While writing tests I found that Node skips DNS lookups for IP addresses, so a public page redirecting to `http://127.0.0.1/` bypassed the first version of the check. Validation rejected IP addresses in `url` itself, but redirects never go through validation. The fix is a custom undici connector that checks IP addresses directly. Every connection, including each redirect hop, goes through it. The regression tests cover IPv4, IPv6, IPv4-mapped IPv6 and the metadata address.
- **Resource limits** cap the download (20 MB, counted as bytes arrive, because `Content-Length` is optional), the total time (10 s) and the decoded size (50 MP). The pixel limit guards against decompression bombs: a tiny file that declares huge dimensions. It is checked from the header before any decoding.
- **Sources are an allowlist**, so anything not listed is rejected. libvips can also decode SVG, PDF and other formats with a larger attack surface; those are rejected by default rather than blocked one by one.

### Video thumbnails

ffmpeg can download URLs itself, which would be simpler and would let it fetch only the part of the video it needs. It would also bypass all of the SSRF protection above, and ffmpeg has a history of SSRF and local-file-read vulnerabilities through HLS playlists: a "video" that is really a text playlist pointing at internal URLs or files on the server. So:

- **The video is downloaded by our own fetcher**, with the same SSRF protection and higher limits (100 MB, 30 s), then written to a temporary file that is always deleted.
- **ffmpeg may only read local files** (`-protocol_whitelist file`) **and only parse mp4/mov/webm/mkv** (`-format_whitelist`). The temp file has no extension either, because ffmpeg only treats a local file as a playlist when it has a playlist extension such as `.m3u8`. A test builds exactly that attack, a playlist pointing at a real video on the server. It fails with both protections removed and passes with either one in place.
- **ffmpeg runs via `execFile`, never a shell**, so no parameter can inject a command. It is killed after 15 seconds, and frames are scaled to fit 5000×5000 to bound memory for 8K video.
- **The frame then goes through the same `transformImage` pipeline**, so resizing, formats, errors and EXIF stripping behave exactly as in `/process`.
- **ffmpeg-static** bundles the binary, so reviewers don't need a system install. It adds about 70 MB to `node_modules`; a production image would more likely install ffmpeg through the OS package manager.

### Privacy

EXIF metadata, including GPS location, camera serial numbers and timestamps, is **removed from every output image**. The orientation it carries is applied to the pixels first, so phone photos still come out the right way up.

### API behavior

- **Unknown parameters are a 400**, not ignored. `?widht=500` silently returning the full-size image would be a confusing bug for the caller.
- **Errors are reported together**, so fixing a request doesn't take several round trips.
- **Status codes point at whose problem it is.** An upstream 404 becomes 502 because the source server failed, not this API. A URL that returns an HTML page or a corrupt image is a 415: the request is well formed, but the media is not something we can process. (Strictly, 415 describes the request's own body; I preferred it to 422 because it says "wrong kind of file" most directly.)
- **Defaults are applied late.** Validation leaves missing parameters as missing, and the transform chooses the defaults, so "not given" and "given" stay distinguishable.

### Known limitations

- Animated GIFs are returned as their first frame.
- HEIC/HEIF photos are not supported: sharp's prebuilt binaries don't include the HEVC decoder, which is covered by patent licensing.
- Enlarging beyond the source size is allowed, and can produce soft images.
- Video thumbnails download the whole video (up to 100 MB) even when the frame is near the start. Streaming with range requests would be faster, but it means giving ffmpeg network access, which the design above avoids.

## Running it in production

The service is **stateless**: each response depends only on the request and the source file. That property drives most of the choices below, because it makes the service easy to cache, scale horizontally and roll back.

### What is in place

- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push and pull request, on Node 22 and 24: format check, type check, tests with coverage thresholds, build, and `npm audit` of production dependencies. It uses a read-only token and cancels superseded runs.
- **Configuration through the environment** (`PORT`), with a supported Node range enforced by `engines` and `.nvmrc`.
- **Defense in depth** inside the app (SSRF checks, allowlists, size, time and pixel limits), so the service is safe to expose even before the infrastructure controls below exist.

### CI/CD pipeline I would build

```mermaid
flowchart LR
  PR[Pull request] --> CI[CI checks]
  CI --> Merge[Merge to main]
  Merge --> Build[Build image once<br/>tag = commit SHA]
  Build --> Scan[Scan, SBOM, sign]
  Scan --> Staging[Deploy to staging]
  Staging --> Smoke[Smoke tests]
  Smoke --> Canary[Canary in production<br/>5% → 25% → 100%]
  Canary -->|SLOs breached| Rollback[Automatic rollback]
```

- **Build once, promote the same artifact.** The container image is built a single time, tagged with the commit SHA, and the same image moves from staging to production. Only configuration changes between environments, so what was tested is what ships.
- **Supply chain.** Scan the image for vulnerabilities (Trivy or Grype), generate an SBOM, and sign the image (cosign) so the cluster only runs images this pipeline produced. Pin GitHub Actions to commit SHAs, and let Renovate or Dependabot open dependency updates that must pass CI.
- **Smoke tests against staging** after each deploy: `/health`, a real `/process` request, and a request that must return `BLOCKED_URL`, which proves the SSRF protection works in that network, not just in unit tests.
- **Progressive delivery.** Roll out to production gradually, gated on error rate and latency, with automatic rollback. Because the service is stateless, rolling back is just routing traffic to the previous image.
- **Branch protection** requiring CI and a review before merge.

### Container

- **Multi-stage Dockerfile**: a build stage compiles TypeScript, and the runtime stage (`node:24-slim` or distroless) contains only production dependencies and `dist/`.
- **Runs as a non-root user with a read-only filesystem**, with only a small writable `tmpfs` at `/tmp` for video temp files.
- **ffmpeg from the OS package manager** instead of ffmpeg-static, so base-image updates bring security patches.
- **Built for amd64 and arm64.** sharp ships native binaries per platform, and arm64 instances (such as AWS Graviton) are usually cheaper for CPU-bound image work.
- **Graceful shutdown** on `SIGTERM`: stop accepting connections, let in-flight requests finish, then exit, so deploys and scale-downs never cut off a response. Not implemented yet; it would be a few lines in `src/index.ts`.

### Cloud architecture

```mermaid
flowchart LR
  Client --> CDN["CDN + WAF<br/>(cache, rate limits)"]
  CDN --> LB[Load balancer]
  LB --> Images["Image service<br/>(autoscaled containers)"]
  LB --> Videos["Video service<br/>(separate pool)"]
  Images --> NAT["Egress: NAT + firewall<br/>(public internet only)"]
  Videos --> NAT
```

- **The CDN is the cache.** Transformations are deterministic, so responses get long `Cache-Control` lifetimes, and the CDN caches them keyed on the normalized query. Most traffic never reaches the service, which is the biggest cost and latency win. Object storage (such as S3) can act as a second cache tier behind it.
- **Signed URLs**: clients get transformation URLs signed with a secret (an HMAC of the parameters), as Cloudinary does. Without a valid signature a request is rejected at the edge. That stops the service being used as a free image proxy and stops attackers bypassing the cache with endless parameter variations.
- **Compute**: stateless containers on a managed platform (ECS Fargate, Cloud Run or Kubernetes), autoscaled on CPU and concurrent requests. Each instance caps concurrent sharp and ffmpeg jobs with a queue and answers `503` with `Retry-After` when it's full, so a burst degrades gracefully instead of running out of memory.
- **Videos run on a separate pool.** They are slower, larger and more memory-hungry, so a burst of video requests must not starve image requests. At higher volume, video thumbnails would become asynchronous jobs.
- **Network-level SSRF protection**, in addition to the application's:
  1. Egress firewall rules deny private and link-local ranges.
  2. The cloud metadata endpoint is locked down (on AWS, IMDSv2 with a hop limit of 1).
  3. The service's cloud role has **no permissions at all**, so even a complete bypass would find no credentials worth stealing.
- **Infrastructure as code** (Terraform or OpenTofu) for all of the above, changed through pull requests that show the plan output, and applied from the pipeline rather than from laptops.

### Observability

- **Structured JSON logs** (for example with pino) with a request ID taken from or added to an `X-Request-Id` header, replacing `console.error`. For privacy, source URLs are logged as host plus a hash of the path, because query strings often carry access tokens.
- **Metrics**: request rate, errors by `code` and latency per route, plus per-stage timings (fetch, decode, encode, ffmpeg), source sizes, queue depth and CDN hit ratio.
- **Tracing** with OpenTelemetry, with a span per stage, so a slow request shows whether the source server or our own processing was slow.
- **SLOs with burn-rate alerts** rather than fixed thresholds, for example 99.9% of well-formed requests succeed and p95 latency on a cache miss stays under 1 s for images under 5 MB. Client errors (4xx) do not count against the SLO, and upstream failures are tracked separately, since neither is ours to fix.
- **Separate liveness and readiness checks**: `/health` shows the process is up, and a readiness check would also confirm sharp and ffmpeg load, so an instance with a broken image never receives traffic.
