import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 32,
  slug: 'designing-pastebin',
  title: 'Designing PasteBin',
  module: 'case-studies',
  estimatedMinutes: 40,
  summary:
    'PasteBin looks like a URL shortener with a text box attached, but the moment pastes can be megabytes long, expire, be private, and be read millions of times, it becomes a lesson in separating small hot metadata from large cold content. This chapter designs the whole system: key generation, blob storage versus database rows, TTL cleanup, read-heavy caching with a CDN, and abuse controls.',
  objectives: [
    'Justify storing paste metadata in a database and paste content in blob storage, and state when a single store is enough.',
    'Design a collision-free, unguessable key generation scheme and compare pre-generated keys with hash-and-check.',
    'Design expiry with TTL: lazy deletion on read plus background sweeper jobs, and explain why both are needed.',
    'Build a read path that survives a viral paste using cache, CDN, and immutable-content headers.',
    'Enumerate abuse vectors (spam, malware, enumeration, oversized uploads) and the controls for each.',
  ],
  quickRevision: [
    'PasteBin = URL shortener + large immutable content; the split is metadata (small, hot, queried) vs content (large, cold, streamed).',
    'Store metadata (key, owner, size, expiry, visibility, content pointer) in Postgres/DynamoDB; store bytes in S3/GCS keyed by the paste key.',
    'Pastes are immutable after creation, which makes caching and CDN trivially safe: cache forever, invalidate only on delete.',
    'Keys: 8 chars of base62 gives 62^8 = 218 trillion combinations; random keys are unguessable, sequential ones are enumerable.',
    'Use a Key Generation Service (KGS) that pre-generates unique keys into a pool, or generate randomly and INSERT with a unique constraint and retry on conflict.',
    'Enforce size limits at the edge (Nginx client_max_body_size) and in the app; typical limits are 512 KB free, 10 MB paid.',
    'Expiry needs two mechanisms: lazy check on read (return 404 if expires_at < now) and a background sweeper that deletes expired rows and blobs in batches.',
    'Read:write ratio is often 10:1 to 100:1, so the read path gets a Redis cache for metadata plus CDN caching for content.',
    'A viral paste is a hot-key problem: CDN absorbs it; without CDN, a single origin blob is fetched millions of times.',
    'Private pastes: unlisted (unguessable URL only) vs owner-only (auth required); burn-after-read needs an atomic read-and-delete.',
    'Syntax highlighting is done client-side (highlight.js / Prism) so the server stores and serves raw text only, keeping content cacheable and cheap.',
    'Abuse controls: rate limit creates per IP, content scanning (malware, secrets, spam URLs), report-and-takedown, and CAPTCHA for anonymous users.',
    'Back-of-envelope: 1M pastes/day at 10 KB avg = 10 GB/day = 3.6 TB/year of blob storage, trivially cheap on S3 (~USD 80/month/year of data).',
  ],
  sections: [
    {
      id: 'requirements-and-shape',
      title: 'Requirements: what makes PasteBin different from a URL shortener',
      body: `A PasteBin lets a user submit a block of text (code, logs, notes), get back a short URL, and share it. Anyone with the URL can read it. That sounds like a URL shortener where the "long URL" is a text blob, and the key-generation problem is indeed identical. Everything else differs because of one property: **the payload is large and variable**. A shortened URL is 100 bytes; a paste can be 10 MB of log output.

**Functional requirements**
- Create a paste from text; optionally set a title, syntax language, expiry (10 min, 1 hour, 1 day, 1 week, never) and visibility (public, unlisted, private).
- Read a paste by its key; render raw or highlighted.
- Delete a paste (owner or admin).
- Optional: user accounts to list "my pastes"; burn-after-read pastes.

**Non-functional requirements**
- Highly available for reads; a paste linked from a popular forum thread must not 503.
- Low latency reads, ideally p99 under 100 ms globally, which only a CDN achieves.
- Durable: a paste that says "never expire" must survive disk failures. This is exactly what blob stores with 11 nines durability sell.
- Read-heavy: a typical ratio is 10 to 100 reads per write.
- Content is **immutable** after creation. PasteBin does not let you edit; you make a new paste. This single decision makes caching, CDN, and replication dramatically simpler because nothing ever needs invalidation except deletion.

**Estimation (interview-scale numbers)**
- 1 million new pastes/day, about 12 writes/sec average, 50/sec peak.
- 100 million reads/day, about 1,200 reads/sec average, 5,000/sec peak; a viral paste can add 10,000/sec on one key.
- Average paste 10 KB, so ingress is 10 GB/day and 3.6 TB/year. Over 5 years, 18 TB of content and 1.8 billion metadata rows (each about 200 bytes, so 360 GB of metadata).

The shape follows from the numbers: metadata is small enough for a single well-indexed database with replicas; content is large, cold, and immutable, so it belongs in object storage behind a CDN.`,
      mentalModel:
        'A library catalogue card versus the book. The card (title, shelf number, due date) is tiny and constantly searched; the book is heavy and read only when someone actually pulls it. You would never store books in the card index.',
      keyPoints: [
        'Same key-generation problem as a URL shortener; different storage problem because payloads are large.',
        'Immutability of content is the design decision that makes everything downstream cheap.',
        'Read-heavy (10:1 to 100:1) and bursty on individual keys (viral pastes).',
        'Estimate: ~12 writes/sec, ~1,200 reads/sec, 3.6 TB of content per year.',
      ],
      checkpoint: {
        question:
          'If pastes were editable in place, which parts of the design would become harder? Name at least two.',
        answer:
          'CDN and cache invalidation (you would need to purge on every edit instead of caching forever), concurrent edits (last-writer-wins or versioning), and the blob store would need versioned objects or copy-on-write. Immutability avoids all three.',
      },
    },
    {
      id: 'storage-split',
      title: 'Metadata in a database, content in blob storage',
      body: `The central storage decision: do you put the paste text in the same row as its metadata, or in a separate blob store?

**Option A: everything in one database row.** A \`pastes\` table with a \`content TEXT\` column. Simple, transactional, one round trip. This is fine up to a few hundred GB. Beyond that it hurts: large TEXT/BLOB columns bloat pages and make every scan slower, backups and replication ship gigabytes of content that is almost never read, and the database (the most expensive storage per GB you run) fills with cold bytes. Postgres TOAST stores large values out of line, which helps, but the replication and backup cost remains.

**Option B: metadata in a database, content in S3 (or GCS, Azure Blob, MinIO).** The database row holds key, creator, created_at, expires_at, visibility, size, language, and a content pointer (bucket + object key, typically just the paste key). The bytes live in object storage at roughly USD 0.023/GB/month with 99.999999999% durability and effectively unlimited capacity. The read path becomes two hops (metadata lookup, then blob fetch), but the blob hop can be served straight from the CDN.

**Option C: hybrid by size.** Inline content under, say, 4 KB in the row (one round trip for the common tiny paste) and spill larger content to S3. Real systems do this; it complicates code paths and is a later optimisation.

For the metadata store, Postgres or MySQL is the natural pick: the queries are simple point lookups by key plus "list pastes by user ordered by created_at". At 1.8 billion rows over 5 years you would shard by key hash or use DynamoDB/Cassandra with the paste key as partition key. DynamoDB is attractive here because it has native TTL deletion of items, which maps directly onto paste expiry.

Why not store metadata in S3 too? Because you need indexed queries (by user, by expiry time) and atomic conditional writes (unique key insertion), which object storage does not provide well.

Store content **compressed** (gzip or zstd) in the blob store: log dumps and source code compress 5-10x, which cuts storage and egress cost. Serve with \`Content-Encoding: gzip\` so browsers decompress natively.`,
      mentalModel:
        'The database is the front desk with a ledger; S3 is the warehouse behind it. The front desk never keeps the crates, only the ticket that says which shelf they are on.',
      diagram: `            write paste
                |
                v
+-----------+   +-----------------+    +---------------------+
| API       |-->| Postgres/Dynamo |    | S3 bucket           |
| server    |   | pastes table    |    | key -> gz bytes     |
|           |   | key,owner,size, |    | 10 KB avg, immutable|
|           |   | expires_at,vis, |    +---------------------+
|           |   | blob_ptr        |              ^
+-----------+   +-----------------+              |
      |                                          |
      +------------ PUT s3://pastes/<key> --------+`,
      keyPoints: [
        'Small, hot, queried fields go to the database; large, cold, streamed bytes go to object storage.',
        'S3 gives 11 nines durability and ~USD 0.023/GB/month, far cheaper than database disk and replication.',
        'The row stores a pointer (bucket/key); the paste key itself is the natural object key.',
        'DynamoDB TTL or Postgres plus a sweeper handle expiry; object storage cannot do the indexed queries.',
        'Compress content at write time; source and logs shrink 5-10x.',
      ],
      checkpoint: {
        question:
          'A write does an INSERT into the pastes table and a PUT to S3. What is the right order, and what happens if the second operation fails?',
        answer:
          'PUT the blob first, then INSERT the metadata. If the PUT fails, nothing is visible and the user gets an error. If the INSERT fails after a successful PUT, you have an orphan object in S3 that no row points to; a periodic reconciliation job (list objects, check rows) or an S3 lifecycle rule on a "pending" prefix cleans it up. Doing INSERT first would risk a row pointing at nothing, which is a visible 404 for a paste the user was told succeeded.',
      },
    },
    {
      id: 'key-generation',
      title: 'Key generation: unique, short, unguessable',
      body: `The paste key is the part of the URL after the domain: \`pastebin.com/aB3xY9kL\`. It must be unique, reasonably short, and, because unlisted pastes rely on the URL being secret, **unguessable**.

**How long?** Base62 (a-z, A-Z, 0-9) with 8 characters gives 62^8 = 218 trillion keys. At 1 million pastes/day for 10 years you consume 3.65 billion, which is 0.0017% of the space. Random 8-char keys collide with probability roughly n^2 / (2 * 62^8); after 3.65 billion keys that is about 3%, so collisions are rare but not impossible, and you must handle them.

**Approach 1: random key plus unique constraint.** Generate 8 random base62 characters from a CSPRNG, INSERT with a UNIQUE index on key, and on a duplicate-key error regenerate and retry. Simple, stateless, no coordination. Works for any database that supports conditional insert (Postgres unique index, DynamoDB \`attribute_not_exists\` condition).

**Approach 2: Key Generation Service (KGS).** A separate service pre-generates millions of unique keys into a \`unused_keys\` table, and hands them out in batches of 1,000 to each API server, which keeps them in memory. No collision check at write time, and the write path never retries. Costs: another service to run, and a batch handed to a server that crashes is lost (acceptable: keyspace is huge). Twitter Snowflake-style IDs are another option but produce time-sortable, therefore **enumerable**, keys.

**Approach 3: hash the content.** MD5/SHA-256 of content, take the first 8 base62 chars. Deduplicates identical pastes for free but leaks that two users pasted the same thing, and identical content with different expiry or visibility breaks. Avoid for PasteBin.

**Why never sequential IDs?** An auto-increment ID base62-encoded is short and collision-free, but an attacker can enumerate every paste by incrementing: unlisted pastes become public. If you want sequential IDs for database locality, keep them internal and expose a separate random public key.

**Custom aliases** (\`pastebin.com/my-config\`) are a UNIQUE insert on the alias column with a reserved-word blocklist (admin, api, login).`,
      mentalModel:
        'Hotel room keys. Sequential numbering lets a thief try every door in order. A random 8-character code per guest means there are more codes than atoms in a truckload of sand, and trying doors is hopeless.',
      diagram: `Approach 1 (random + unique index)       Approach 2 (KGS pool)
                                             +-----------+
 gen 8 base62 chars                          | KGS       |
      |                                      | pregen    |
      v                                      | keys ---> | unused_keys
 INSERT ... key UNIQUE                       +-----------+
      |                                            |
 dup? ---yes---> regenerate, retry        batch of 1000 to
      |                                    each API server
      no                                   (kept in memory)
      v                                            |
    done                                    INSERT never collides`,
      keyPoints: [
        '8 base62 chars = 218 trillion keys; more than enough for decades.',
        'Random keys from a CSPRNG plus a unique constraint and retry is the simplest correct scheme.',
        'A KGS pre-generates keys, removing write-time retries at the cost of another service.',
        'Never expose sequential IDs: enumeration turns unlisted pastes into public ones.',
        'Content hashing dedups but leaks information and breaks per-paste settings.',
      ],
      checkpoint: {
        question:
          'Your KGS hands 1,000 keys to an API server which then crashes. Is anything broken? What about two servers being handed the same batch?',
        answer:
          'A crashed server simply loses 1,000 keys out of 218 trillion, which is harmless. Two servers receiving the same batch would be a real bug (duplicate keys), so the KGS must hand out batches atomically, e.g. DELETE ... RETURNING in one transaction or a SELECT FOR UPDATE SKIP LOCKED, and a KGS replica must not share the pool without that coordination.',
      },
    },
    {
      id: 'expiry',
      title: 'Expiry and TTL: lazy deletion plus a sweeper',
      body: `Users set an expiry when they create a paste. The system must guarantee two things: an expired paste is **never served**, and its storage is **eventually reclaimed**. These are different problems and need different mechanisms.

**Lazy expiry on read.** Every read fetches metadata and checks \`expires_at < now()\`. If expired, return 404 and optionally delete the row and blob right there. This guarantees correctness instantly with no background machinery. It does not reclaim storage for pastes nobody reads again, which is most of them.

**Background sweeper.** A scheduled job (cron, Kubernetes CronJob, or a Celery/Sidekiq periodic task) runs every few minutes: \`SELECT key, blob_ptr FROM pastes WHERE expires_at < now() LIMIT 1000\`, deletes the S3 objects (batched: S3 DeleteObjects accepts 1,000 keys per call), then deletes the rows. Requirements for a safe sweeper:
- **Index on expires_at** so the query is a range scan, not a full scan over 1.8 billion rows.
- **Batch and pace**: deleting millions of rows in one transaction bloats WAL and locks; do 1,000 at a time with a short sleep.
- **Idempotent**: if the job crashes midway, re-running must be harmless. Delete blob first, then row; a row pointing at a missing blob is handled by the read path returning 404.
- **Single runner or partitioned**: two sweepers racing on the same rows waste work but are not incorrect if deletes are idempotent. Use \`FOR UPDATE SKIP LOCKED\` or partition by key prefix across workers.

**Managed TTL.** DynamoDB TTL deletes items within about 48 hours of expiry for free, and S3 lifecycle rules can expire objects by prefix or tag. Combine them: tag objects with an expiry class (\`1d\`, \`7d\`) and let S3 lifecycle handle blob deletion while the read path enforces correctness.

**Why both?** Lazy alone leaks storage. Sweeper alone has a window (up to its interval) where an expired paste is still readable, which is a correctness bug for a "10 minute" paste. Lazy gives correctness; the sweeper gives reclamation.

**Burn-after-read** is expiry after one view. It needs an atomic read-and-mark: \`UPDATE pastes SET burned = true WHERE key = ? AND burned = false RETURNING blob_ptr\`. If the UPDATE affects zero rows, someone already read it. Without atomicity, two simultaneous readers both see it. Also disable caching entirely for such pastes, or the CDN will happily serve the "burned" content.`,
      mentalModel:
        'Milk in a fridge. You check the date before pouring (lazy check, always correct). Once a week someone throws out everything past its date (sweeper, reclaims space). Neither alone keeps the fridge both safe and uncluttered.',
      diagram: `Read path (lazy)                 Sweeper (every 5 min)
GET /p/aB3xY9kL                  SELECT key, blob_ptr
   |                               FROM pastes
   v                              WHERE expires_at < now()
metadata lookup                   ORDER BY expires_at LIMIT 1000
   |                                    |
expires_at < now()? --yes--> 404        v
   |                          S3 DeleteObjects (batch 1000)
   no                                   |
   v                                    v
serve content                  DELETE FROM pastes WHERE key IN (...)
                                        |
                                  sleep 200ms, repeat`,
      keyPoints: [
        'Lazy check on read guarantees an expired paste is never served, instantly.',
        'Sweeper reclaims storage: indexed range query on expires_at, batches of ~1,000, idempotent deletes.',
        'Delete blob before row; the read path already tolerates a row whose blob is gone.',
        'DynamoDB TTL and S3 lifecycle rules can replace hand-written sweepers.',
        'Burn-after-read requires an atomic conditional UPDATE and must bypass all caches.',
      ],
      checkpoint: {
        question:
          'The sweeper runs DELETE FROM pastes WHERE expires_at < now() with no LIMIT, on a table of 1.8 billion rows where 50 million just expired. What goes wrong?',
        answer:
          'A single 50-million-row delete holds locks for a long time, generates tens of GB of WAL, can bloat replication lag to minutes, and if it fails midway it rolls back everything. Batching with LIMIT 1000 and pacing keeps each transaction short and lets replicas keep up.',
      },
    },
    {
      id: 'read-path',
      title: 'The read path: cache, CDN, and the viral paste',
      body: `Reads dominate, and they are bursty per key. A paste linked from the front page of Hacker News gets 10,000 requests/sec for an hour and then nothing. Design the read path to never hit origin for the same bytes twice.

**Layer 1: CDN for content.** Because content is immutable, serve \`GET /raw/<key>\` through CloudFront, Cloudflare or Fastly with \`Cache-Control: public, max-age=31536000, immutable\`. The first request per edge location fetches from S3 (or from the app), every subsequent one is served from the edge in tens of milliseconds worldwide. A viral paste costs origin one fetch per edge, perhaps 200 requests total instead of 36 million.

**Layer 2: Redis for metadata.** The HTML page needs title, language, created time and visibility before rendering. Cache the metadata row in Redis keyed by paste key with a TTL equal to the paste's remaining life (\`EXPIREAT expires_at\`), so the cache never outlives the paste. Cache misses go to the database; a cache-aside pattern is enough because rows never change except by deletion.

**Expiry interaction.** If a paste expires while its content is in the CDN, the raw URL still serves for the remaining edge TTL. Options: set the CDN max-age to \`min(1 year, expires_at - now)\` at response time, so short-lived pastes get short edge TTLs; or put expiry in the URL path so the app can 404 the HTML page while the raw object quietly ages out. Most systems accept a few minutes of over-serving for expired content but purge the CDN explicitly on **delete**, since deletion is usually a takedown and must be immediate.

**Private pastes cannot go through a shared cache** unless the cache key includes the authenticated user, or you serve them with \`Cache-Control: private, no-store\`. Signed URLs (S3 presigned, CloudFront signed URLs with a 5-minute expiry) let you still use the CDN for authorised users.

**Syntax highlighting client-side.** Serve raw text plus a language hint and let highlight.js or Prism colour it in the browser. Server-side highlighting would mean one rendered HTML per language/theme combination, uncacheable per user preference, and 10x the bytes. Raw text is one cacheable object. The only server-side rendering worth doing is a plain HTML shell that embeds the raw URL.

**Hot-key at the database.** Redis handles a hot metadata key at 100k+ ops/sec on a single node; if even that is a concern, add a short (1-2 second) in-process cache in the API servers so a hot key costs one Redis call per server per second.`,
      mentalModel:
        'A newspaper. The printing press (origin) prints once; newsstands (CDN edges) sell thousands of copies. Nobody re-runs the press for each reader, and because the paper never changes after printing, there is nothing to reprint.',
      diagram: `                 GET /aB3xY9kL (HTML shell)
Browser ------------------------------------> API server
   |                                              |
   |                                       Redis: meta:aB3xY9kL
   |                                         miss -> Postgres
   |  <-- HTML with <script src=highlight.js> and raw URL
   |
   |  GET cdn.pastebin.com/raw/aB3xY9kL
   +--------------------> CDN edge ---miss---> S3 pastes/aB3xY9kL
                            |  hit (99.9%)
                            v
                  Cache-Control: immutable, max-age=1y
                  browser highlights client-side`,
      keyPoints: [
        'Immutable content plus max-age=1y, immutable headers means the CDN absorbs viral traffic almost entirely.',
        'Redis caches metadata with a TTL equal to the paste\'s remaining lifetime.',
        'Delete must purge the CDN; expiry can tolerate a short over-serve or use a computed shorter max-age.',
        'Private pastes need no-store or signed URLs; never let a shared cache serve them.',
        'Client-side highlighting keeps one cacheable raw object instead of many rendered variants.',
      ],
      checkpoint: {
        question:
          'A user deletes a paste that is currently viral. Which layers still hold the content, and in what order do you clear them?',
        answer:
          'Database row, Redis metadata, S3 object, CDN edges, and browser caches. Delete the row (or mark deleted) first so the HTML page 404s, DEL the Redis key, delete the S3 object, then issue a CDN purge for /raw/<key>. Browser caches you cannot purge, which is why immutable max-age is a trade-off; for legal takedowns the CDN purge is the important step.',
      },
    },
    {
      id: 'size-limits-and-write-path',
      title: 'Size limits and the write path',
      body: `A paste of 10 MB of logs is legitimate; a paste of 5 GB is an attack or a mistake. Limits must be enforced at every layer because each layer fails differently.

**At the edge.** Nginx \`client_max_body_size 10m\` (or the load balancer's equivalent) rejects oversized bodies with 413 before they consume application memory. This is your first and cheapest defence.

**In the application.** Re-check \`Content-Length\` and count bytes as you stream; a client can lie about Content-Length or use chunked encoding. Reject at the limit rather than buffering the full upload.

**Per tier.** Anonymous users get 512 KB, free accounts 1 MB, paid 10 MB or more. Store the limit as a property of the user tier and check it before the S3 PUT.

**Direct-to-S3 uploads for large pastes.** For anything over a few MB, avoid streaming through your API servers at all: the client requests a presigned S3 POST URL with a size condition (\`content-length-range\`), uploads straight to S3, then calls \`POST /pastes/finalize\`. The API server never touches the bytes, and S3 enforces the size. The metadata row is created in a \`pending\` state at presign time and flipped to \`active\` at finalize; a lifecycle rule deletes pending objects older than an hour.

**Write path in order.**
1. Validate size, visibility, expiry, language; rate-limit the creator (token bucket in Redis, e.g. 10 pastes/min per IP for anonymous).
2. Obtain a key (random + unique insert, or from KGS batch).
3. Compress content, PUT to S3 with \`Content-Type: text/plain; charset=utf-8\` and \`Content-Encoding: gzip\`.
4. INSERT metadata row.
5. Return \`201 Created\` with the URL.

Total latency is dominated by the S3 PUT (20-50 ms in-region) and the database insert (a few ms); the user sees roughly 100 ms.

**Idempotency.** A client retrying a slow POST would create two pastes. Accept an \`Idempotency-Key\` header, store it in Redis for 24 hours mapped to the created paste key, and return the same result on retry.

**Encoding.** Normalise to UTF-8 and reject invalid byte sequences, or store as opaque bytes and label as \`application/octet-stream\`. Mixed handling here is a classic source of corrupted "raw" downloads.`,
      mentalModel:
        'A post office with a scale at the counter (edge limit), a second scale in the sorting room (app check), and parcel-size rules that differ for regular and premium customers (tiers). Very large parcels go straight to the freight depot (direct-to-S3) instead of over the counter.',
      keyPoints: [
        'Enforce size limits at Nginx, in the app while streaming, and per user tier.',
        'Large uploads should go direct to S3 with a presigned URL and a content-length-range condition.',
        'Write order: validate, key, PUT blob, INSERT row, respond; pending-then-active state handles partial failures.',
        'Rate limit creates per IP/user with a Redis token bucket; support Idempotency-Key for safe retries.',
        'Compress and set Content-Encoding so browsers decompress natively.',
      ],
    },
    {
      id: 'abuse-and-privacy',
      title: 'Abuse, privacy, and operational concerns',
      body: `Anonymous free text storage is a magnet for abuse. Real PasteBin services spend more engineering on this than on the core storage.

**Spam and malware hosting.** Attackers use pastes as command-and-control payloads, credential dumps, and phishing landing pages. Controls: scan content on creation with a rules engine (regexes for known malware patterns, base64-encoded executables, known phishing kits), integrate a URL reputation check for links inside pastes (Google Safe Browsing API), and push suspicious pastes to a review queue instead of publishing them. Serve raw content with \`Content-Type: text/plain\` and \`X-Content-Type-Options: nosniff\` so browsers never execute it as HTML or JavaScript.

**Secret leakage.** Developers paste config files containing AWS keys and database passwords. Run secret-pattern detection (the same regexes GitHub uses for its secret scanning) and warn or block on obvious matches. It protects your users and reduces the incentive for scrapers.

**Scrapers and enumeration.** Bots scrape the "recent public pastes" feed to harvest leaked credentials. Rate limit the listing endpoint aggressively, require a CAPTCHA above thresholds, and never expose sequential keys. Unlisted pastes are safe only because keys are random.

**Takedowns.** DMCA and legal requests need a fast path: mark the row \`removed\` with a reason, purge the CDN, and serve a 451 or 404. Keep the row for audit rather than hard deleting.

**Rate limiting the write path.** Token bucket in Redis per IP and per account: 10/min anonymous, 60/min authenticated. Also cap total storage per account so one user cannot fill a bucket.

**Privacy levels**
- Public: appears in listings and search.
- Unlisted: reachable only by URL. Security depends entirely on the key being random and the URL not leaking (referrer headers, so set \`Referrer-Policy: no-referrer\` on paste pages).
- Private: requires the owner's session; served with \`Cache-Control: private, no-store\` or via signed URLs.
- Password-protected: store a bcrypt hash of the password in metadata; content itself can additionally be encrypted client-side (zero-knowledge pastebins like PrivateBin do this, so the server never sees plaintext).

**Observability.** Track creates/sec, reads/sec, cache hit ratio, CDN hit ratio, S3 error rate, sweeper backlog (\`count(*) where expires_at < now()\`), and the review queue depth. A sweeper backlog that grows is the earliest sign that the system is falling behind.`,
      mentalModel:
        'A public noticeboard in a town square. Anyone can pin a note, so the town hires a warden who reads new notes for scams (content scanning), limits how many notes one person can pin per hour (rate limits), takes down notes on complaint (takedowns), and uses a locked glass case for private notices (auth and no-store).',
      keyPoints: [
        'Serve raw content as text/plain with nosniff so pastes can never execute as HTML/JS.',
        'Scan on create: malware patterns, phishing URLs, leaked secrets; route suspicious content to a review queue.',
        'Rate limit creates and listings; CAPTCHA anonymous bursts; never expose enumerable keys.',
        'Takedown = mark removed, purge CDN, keep row for audit.',
        'Privacy tiers: public, unlisted (random key), private (auth, no-store), password/encrypted (zero-knowledge).',
      ],
      checkpoint: {
        question:
          'An unlisted paste page includes a link to an external site. What header prevents that site from learning the paste URL, and why does it matter?',
        answer:
          'Referrer-Policy: no-referrer (or strict-origin). Without it the browser sends the full paste URL in the Referer header when the user clicks the link, leaking the secret key to the third-party site\'s logs and making the unlisted paste effectively public.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Why does a PasteBin design store paste content in S3 rather than in the metadata database row?',
      options: [
        'S3 supports SQL queries on text',
        'Content is large, cold and immutable; object storage is far cheaper and more durable per GB, and keeps the database small and fast',
        'Databases cannot store text longer than 4 KB',
        'S3 provides automatic syntax highlighting',
      ],
      answerIndex: 1,
      explanation:
        'Metadata is small and queried often; content is large and read rarely relative to its size. Putting bytes in S3 keeps the database lean, cuts replication and backup volume, and buys 11 nines durability at ~USD 0.023/GB. Databases can store large text (Postgres TOAST), it is simply the wrong cost/performance fit at scale.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'How many unique keys does an 8-character base62 key space provide?',
      options: ['62 x 8 = 496', '8^62', '62^8, about 218 trillion', '2^64'],
      answerIndex: 2,
      explanation:
        '62 symbols in each of 8 positions gives 62^8 = 218,340,105,584,896. At 1M pastes/day you would use a tiny fraction over decades.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Why must unlisted paste keys be random rather than base62-encoded auto-increment IDs?',
      options: [
        'Random keys are shorter',
        'Auto-increment keys let anyone enumerate every paste by counting up, making unlisted pastes discoverable',
        'Databases cannot index sequential strings',
        'Random keys compress better in S3',
      ],
      answerIndex: 1,
      explanation:
        'Unlisted means "secret URL". A sequential key is trivially guessable, so the secrecy is gone. Random CSPRNG keys make guessing hopeless. Key length and indexing are unaffected.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which properties must a paste expiry sweeper have? Select all that apply.',
      options: [
        'An index on expires_at',
        'Deleting all expired rows in one transaction for atomicity',
        'Batching (e.g. 1,000 rows per iteration) with pacing',
        'Idempotent deletes so a crashed run can be re-run safely',
        'Deleting the database row before the S3 object',
      ],
      answerIndices: [0, 2, 3],
      explanation:
        'The sweeper needs an index for a cheap range query, batching to keep transactions short and replication healthy, and idempotency for safe retries. One giant transaction is exactly what to avoid. Delete the blob first: a row pointing at a missing blob is handled by the read path, whereas an orphan blob with no row is invisible and leaks storage.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement:
        'Because expired pastes are deleted by a background sweeper, the read path does not need to check expires_at.',
      answer: false,
      explanation:
        'The sweeper runs on an interval, so there is always a window where an expired paste still exists. The read path must check expires_at (lazy expiry) to guarantee correctness; the sweeper only reclaims storage.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A paste is linked from a viral tweet and receives 20,000 reads/sec. Which single design element most reduces load on your origin?',
      options: [
        'Adding more database read replicas',
        'Serving raw content through a CDN with Cache-Control: immutable and a one-year max-age',
        'Sharding the pastes table by key',
        'Running the sweeper more frequently',
      ],
      answerIndex: 1,
      explanation:
        'Content is immutable, so every edge can cache it indefinitely; origin is hit roughly once per edge location. Replicas and sharding help general throughput but a single hot key still hammers one row/blob; the CDN removes the traffic entirely.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'Why is syntax highlighting done in the browser rather than on the server?',
      options: [
        'Servers cannot parse programming languages',
        'It keeps one small cacheable raw object per paste instead of many rendered HTML variants, and offloads CPU to the client',
        'Browsers highlight faster than servers',
        'It is required by the highlight.js licence',
      ],
      answerIndex: 1,
      explanation:
        'Server-side rendering would multiply cached variants (language x theme x line numbers) and inflate bytes ~10x. Serving raw text and highlighting client-side keeps content cacheable and cheap.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 3,
      statement:
        'A burn-after-read paste can be implemented safely with SELECT to read the content followed by DELETE.',
      answer: false,
      explanation:
        'Two concurrent readers can both SELECT before either DELETEs, so both see the content. You need an atomic conditional write, e.g. UPDATE ... SET burned=true WHERE key=? AND burned=false RETURNING blob_ptr, and the zero-rows case means someone already read it. Caches must also be bypassed.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question:
        'On paste creation the server PUTs the blob to S3 and then INSERTs the metadata row. The INSERT fails. What is the consequence and remedy?',
      options: [
        'The user sees a working paste with missing content',
        'An orphan S3 object exists that no row references; a reconciliation job or lifecycle rule on a pending prefix removes it, and the user receives an error',
        'The database automatically rolls back the S3 PUT',
        'Nothing; S3 objects without rows are served directly',
      ],
      answerIndex: 1,
      explanation:
        'S3 and the database are not in one transaction. PUT-then-INSERT means failure leaves an invisible orphan blob (cheap, cleanable) rather than a visible row pointing at nothing (a user-facing 404 on a paste they were told succeeded).',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'Which header prevents a browser from executing a raw paste as HTML or JavaScript?',
      options: [
        'Content-Type: text/plain with X-Content-Type-Options: nosniff',
        'Cache-Control: no-store',
        'Referrer-Policy: no-referrer',
        'Content-Encoding: gzip',
      ],
      answerIndex: 0,
      explanation:
        'text/plain tells the browser it is text; nosniff stops browsers from guessing it is HTML based on content. no-store and Referrer-Policy address caching and URL leakage respectively; gzip is compression.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Estimate storage for a PasteBin with 1 million pastes/day, 10 KB average, 5 years of retention, and describe how you would store metadata vs content at that scale.',
      modelAnswer: `**Content:** 1M x 10 KB = 10 GB/day, 3.65 TB/year, about 18 TB over 5 years (roughly 4-6 TB after gzip). In S3 Standard at USD 0.023/GB/month that is under USD 500/month even uncompressed.

**Metadata:** 1.8 billion rows x ~200 bytes = about 360 GB plus indexes (key, user_id+created_at, expires_at), perhaps 600 GB total.

**Storage choice:** content in S3 keyed by paste key, gzipped, behind a CDN. Metadata in Postgres sharded by key hash (or DynamoDB with key as partition key and native TTL). Read replicas for the "my pastes" listing. Redis cache-aside for hot metadata.`,
      rubric: [
        'Computes daily and multi-year content volume (order of 10 GB/day, ~18 TB over 5 years).',
        'Estimates metadata row count and size separately (billions of rows, hundreds of GB).',
        'Places content in object storage and metadata in an indexed database.',
        'Mentions compression, CDN or sharding as scale levers.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Compare random-key-with-unique-index against a Key Generation Service for paste keys.',
      modelAnswer: `**Random + unique index:** generate 8 CSPRNG base62 chars, INSERT with a UNIQUE constraint, retry on duplicate. Stateless, no extra service, collisions are rare (about 3% cumulative after billions of keys) and handled by retry. Cost: occasional retry on the write path and reliance on the database enforcing uniqueness.

**KGS:** a service pre-generates unique keys into a pool and hands atomic batches (e.g. 1,000) to API servers. The write path never collides or retries. Cost: another service to run and monitor; keys in a crashed server\'s batch are lost (harmless); batch handout must be atomic to avoid duplicates.

For most PasteBins the random approach is sufficient; KGS is justified when write latency variance matters or the store lacks cheap conditional inserts.`,
      rubric: [
        'Describes both mechanisms accurately.',
        'Mentions collision handling for the random approach.',
        'Mentions atomic batch handout and lost-batch tolerance for KGS.',
        'Gives a recommendation tied to a requirement.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question:
        'A user reports that an unlisted paste they shared privately with a colleague has appeared in a search engine. List three plausible leak paths and the control for each.',
      modelAnswer: `1. **Referrer leakage:** the paste page linked to an external site and the browser sent the paste URL in the Referer header. Control: Referrer-Policy: no-referrer on paste pages.
2. **Enumerable keys:** keys were sequential or derived from a low-entropy source, so a crawler guessed them. Control: CSPRNG random 8+ character keys.
3. **Listing or sitemap exposure:** unlisted pastes were included in "recent pastes", RSS, or a sitemap, or the page lacked noindex. Control: exclude unlisted from all listings and add a noindex robots meta / X-Robots-Tag header.
Also consider the colleague simply reposting the link; server-side you cannot prevent that, which is why truly private pastes need authentication.`,
      rubric: [
        'Identifies referrer leakage and Referrer-Policy.',
        'Identifies key enumeration and random keys.',
        'Identifies listings/sitemaps/noindex.',
        'Notes the limits of unlisted vs authenticated private.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Core storage split in PasteBin', back: 'Small hot metadata (key, owner, expiry, visibility, size, blob pointer) in Postgres/DynamoDB; large cold immutable content in S3/GCS keyed by paste key.' },
    { id: 'f2', front: 'Why immutability matters for PasteBin', back: 'Content never changes after creation, so CDN and caches can hold it indefinitely; only deletion requires invalidation. Simplifies replication too.' },
    { id: 'f3', front: 'Key space of 8 base62 characters', back: '62^8 = about 218 trillion keys; 1M pastes/day for 10 years uses 0.0017% of it.' },
    { id: 'f4', front: 'Random key + unique index scheme', back: 'Generate 8 CSPRNG base62 chars, INSERT with UNIQUE constraint (or DynamoDB attribute_not_exists), retry on duplicate. Stateless and simple.' },
    { id: 'f5', front: 'Key Generation Service (KGS)', back: 'Pre-generates unique keys into a pool; hands atomic batches (~1,000) to API servers so writes never collide. Lost batches are harmless.' },
    { id: 'f6', front: 'Why never expose sequential IDs', back: 'They are enumerable: an attacker walks every paste by incrementing, making unlisted pastes public.' },
    { id: 'f7', front: 'Lazy expiry vs sweeper', back: 'Lazy: read path checks expires_at and 404s, guaranteeing correctness. Sweeper: periodic batched job deletes expired blobs then rows to reclaim storage. Need both.' },
    { id: 'f8', front: 'Safe sweeper properties', back: 'Index on expires_at, LIMIT ~1,000 per batch with pacing, idempotent, delete blob before row, S3 DeleteObjects batches of 1,000.' },
    { id: 'f9', front: 'Burn-after-read implementation', back: 'Atomic conditional UPDATE ... SET burned=true WHERE key=? AND burned=false RETURNING blob_ptr; zero rows means already read. Bypass all caches.' },
    { id: 'f10', front: 'Read path caching layers', back: 'CDN for /raw/<key> with Cache-Control: public, max-age=1y, immutable; Redis cache-aside for metadata with TTL = remaining paste lifetime.' },
    { id: 'f11', front: 'Handling a viral paste', back: 'CDN edges absorb it: origin fetches once per edge. Redis holds hot metadata; optional 1-2s in-process cache per API server.' },
    { id: 'f12', front: 'Why client-side syntax highlighting', back: 'One cacheable raw text object instead of many rendered variants; ~10x fewer bytes; CPU offloaded to browser (highlight.js, Prism).' },
    { id: 'f13', front: 'Size limit enforcement layers', back: 'Nginx client_max_body_size (413 at edge), app streams and counts bytes, per-tier caps, presigned S3 POST with content-length-range for large uploads.' },
    { id: 'f14', front: 'Write path order', back: 'Validate + rate limit -> obtain key -> gzip + PUT to S3 -> INSERT metadata -> 201. PUT first so failure leaves an invisible orphan, not a broken row.' },
    { id: 'f15', front: 'Headers for safe raw serving', back: 'Content-Type: text/plain; charset=utf-8, X-Content-Type-Options: nosniff, Referrer-Policy: no-referrer, Content-Encoding: gzip.' },
    { id: 'f16', front: 'Privacy tiers', back: 'Public (listed), unlisted (random URL only), private (owner auth, no-store or signed URLs), password/encrypted (bcrypt hash; optional client-side encryption).' },
    { id: 'f17', front: 'Abuse controls', back: 'Rate limit creates per IP/user, content scanning (malware, phishing URLs, secrets), review queue, CAPTCHA, takedown = mark removed + CDN purge.' },
    { id: 'f18', front: 'Back-of-envelope PasteBin numbers', back: '1M pastes/day ~12 writes/s; 100M reads/day ~1,200 reads/s; 10 KB avg -> 10 GB/day, 3.6 TB/year; 1.8B metadata rows over 5 years.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Metadata vs content storage',
      prompt: 'Explain to a junior developer why PasteBin keeps paste text in S3 and only a pointer in the database, even though one table would be simpler.',
      modelExplanation: `Imagine a library. The catalogue card says the title, author and shelf number and is looked up constantly; the book itself is heavy and only pulled when someone reads it. You would never staple books into the card index.

A paste is the same. The metadata (who made it, when it expires, whether it is private) is a few hundred bytes and is checked on every request. The content can be megabytes and is only streamed to whoever actually opens it. If you put both in one database row, every backup, every replica and every index page carries those cold megabytes, and the database, your most expensive storage, fills with bytes nobody queries.

So the row keeps a pointer, and the bytes live in S3, which costs about two cents per GB per month, promises eleven nines of durability, and can be fronted by a CDN. The read path becomes two hops, but the second hop is served from an edge cache almost every time.`,
      mustMention: [
        'Metadata is small and queried often; content is large and read rarely relative to size',
        'Database storage and replication are expensive per GB; S3 is cheap and durable',
        'The row stores a pointer to the object',
        'Content is immutable so the CDN can cache it',
      ],
    },
    {
      id: 'fe2',
      concept: 'Expiry with lazy check plus sweeper',
      prompt: 'Explain why paste expiry needs both a check on read and a background job, using a plain analogy.',
      modelExplanation: `Think of milk in a shared fridge. Before you pour, you look at the date; that is the lazy check on read. It guarantees nobody ever drinks expired milk, instantly, with no coordination. But it does not empty the fridge: cartons nobody touches sit there forever.

So once a week someone sweeps the fridge and bins everything past its date. That is the sweeper job. It reclaims space but it runs on a schedule, so between sweeps an expired carton is still on the shelf. If you relied on the sweeper alone, a "10 minute" paste could be readable for 15.

In PasteBin the read path compares expires_at with now and returns 404 if past; the sweeper runs every few minutes, selects up to a thousand expired rows using an index on expires_at, deletes their S3 objects in a batch and then the rows. Small batches keep transactions short so replicas do not lag, and idempotent deletes make a crashed run safe to repeat.`,
      mustMention: [
        'Lazy check guarantees correctness immediately',
        'Sweeper reclaims storage on a schedule',
        'Sweeper alone leaves a window where expired content is served',
        'Batching, indexing on expires_at, idempotency',
      ],
    },
    {
      id: 'fe3',
      concept: 'Surviving a viral paste',
      prompt: 'Explain how the read path is designed so that a paste receiving 20,000 reads per second does not take down the service.',
      modelExplanation: `A paste never changes after it is created. That one fact is the whole trick. Because the bytes are frozen, we can tell every cache in the world to keep them forever: the raw content is served with Cache-Control: public, max-age one year, immutable, through a CDN like CloudFront or Cloudflare.

When the paste goes viral, the first reader near each CDN edge triggers one fetch from S3; every other reader at that edge gets the cached copy in a few milliseconds. Twenty thousand requests per second becomes perhaps a couple of hundred origin fetches in total, one per edge location.

The HTML shell still needs the title and language, which come from a Redis cache in front of the database, with a TTL equal to the paste\'s remaining lifetime. Redis handles a single hot key at over 100,000 operations per second, and a one-second in-process cache in each API server makes even that negligible. Syntax colouring happens in the browser, so there is exactly one object to cache rather than one per language and theme.`,
      mustMention: [
        'Immutability allows indefinite caching',
        'CDN with immutable max-age absorbs traffic; origin fetched once per edge',
        'Redis for hot metadata, optionally in-process cache',
        'Client-side highlighting keeps one cacheable object',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through an old-fashioned post office that has been converted into a giant clipboard warehouse. From the front counter to the loading dock, each stop anchors one PasteBin design decision.',
    stops: [
      { locus: 'The front counter with two scales', concept: 'Size limits at every layer', image: 'A brass scale on the counter (Nginx) rejects a parcel with a loud 413 BUZZ. Behind it a second scale (the app) weighs again. A sign lists parcel limits by customer tier: 512 KB, 1 MB, 10 MB, in gold letters.' },
      { locus: 'The card catalogue drawers', concept: 'Metadata in the database', image: 'Endless tiny drawers, each card 200 bytes: key, owner, expiry, visibility, and a shelf number. The drawers hum because they are searched a thousand times a second. Not a single parcel is inside them.' },
      { locus: 'The warehouse behind the wall', concept: 'Content in S3', image: 'Through a door: an infinite warehouse of vacuum-packed (gzipped) parcels on shelves labelled with 8-character codes. A plaque reads "eleven nines" and a price tag says "2 cents per GB".' },
      { locus: 'The lottery ball machine', concept: 'Random key generation', image: 'A glass sphere tumbles 62 kinds of balls and spits out 8 at a time onto a tray labelled UNIQUE. Occasionally a duplicate rolls out, a buzzer sounds, and the machine spins again. Next to it a clerk counts pre-drawn keys into envelopes of 1,000 (the KGS).' },
      { locus: 'The wall of ticking egg timers', concept: 'Expiry: lazy check plus sweeper', image: 'Every parcel has an egg timer. The counter clerk glances at the timer before handing anything over (lazy). A janitor with a wheelbarrow walks the aisles every five minutes, sweeping exactly one thousand expired parcels at a time into the incinerator, never more.' },
      { locus: 'The newspaper printing press and newsstands', concept: 'CDN and immutable caching', image: 'One press prints a paste once; a hundred newsstands around the world hand out copies stamped IMMUTABLE, MAX-AGE 1 YEAR. A crowd of twenty thousand rushes the stands; the press does not even warm up.' },
      { locus: 'The colouring desk by the exit', concept: 'Client-side syntax highlighting', image: 'Customers receive plain black-and-white pages and sit at a desk of coloured pencils to highlight them themselves. The staff refuse to colour anything: "one plain copy is all we store".' },
      { locus: 'The security office at the loading dock', concept: 'Abuse controls', image: 'A guard with a magnifying glass scans every parcel for poison (malware), fake coupons (phishing URLs) and leaked keys (secrets). A turnstile clicks: ten parcels per minute per person. A shredder marked TAKEDOWN sits beside a megaphone that shouts PURGE at the newsstands.' },
    ],
  },
  designPractice: {
    problem:
      'Design PasteBin: users submit text (up to 10 MB) and receive a short URL; anyone with the URL can read the paste. Support expiry (10 min to never), public/unlisted/private visibility, and deletion. Expect 1 million new pastes and 100 million reads per day, with occasional viral pastes.',
    steps: [
      {
        title: 'Functional requirements',
        prompt: 'List the core features PasteBin must support and explicitly call out what you are leaving out of scope. Decide whether pastes are editable.',
        reference: `**In scope**
- Create a paste: text body, optional title, optional syntax language, expiry (10m, 1h, 1d, 1w, never), visibility (public, unlisted, private), optional custom alias.
- Read a paste by key: HTML view with client-side highlighting and a \`/raw/<key>\` plain-text endpoint.
- Delete a paste (owner via account or a delete token issued at creation for anonymous users).
- Anonymous and authenticated creation; authenticated users can list their pastes.
- Optional: burn-after-read, password protection.

**Explicitly out of scope**
- Editing pastes: **pastes are immutable**. Editing creates a new paste (optionally linked as a "fork"). This makes caching and CDN trivially safe.
- Comments, search over content, real-time collaboration.

**Key decisions to state up front**
- Content is immutable.
- Unlisted security relies on unguessable keys.
- Private requires authentication and bypasses shared caches.`,
      },
      {
        title: 'Non-functional requirements & estimation',
        prompt: 'State availability, latency, durability and consistency targets. Estimate QPS, storage per year, bandwidth, and the read:write ratio. Identify the hot spots these numbers imply.',
        reference: `**Targets**
- Availability: 99.9% for writes, 99.99% for reads (reads are what people link to).
- Latency: p99 read under 100 ms globally (needs CDN), p99 write under 500 ms.
- Durability: no acknowledged paste lost; rely on S3\'s 11 nines and a replicated metadata DB.
- Consistency: read-your-writes for the creator (they immediately open the URL); eventual is fine for everyone else.

**Estimation**
- Writes: 1M/day = ~12/s average, plan for 50/s peak.
- Reads: 100M/day = ~1,160/s average, 5,000/s peak; a viral paste can add 10,000-20,000/s on one key.
- Read:write about 100:1, so optimise the read path.
- Content: 10 KB average x 1M = 10 GB/day, 3.65 TB/year, ~18 TB over 5 years (4-6 TB gzipped).
- Metadata: 200 B/row, 365M rows/year, 1.8B rows over 5 years = ~360 GB plus indexes.
- Egress: 100M reads x 10 KB = 1 TB/day, mostly served by CDN.
- Redis metadata cache: 20% hot set of a year\'s pastes = 73M rows x 300 B = ~22 GB, fits on a small cluster.

**Implied hot spots**
- Per-key read bursts (viral) -> CDN plus Redis.
- expires_at range scans for the sweeper -> dedicated index.
- Write-path uniqueness on key -> unique index or KGS.`,
      },
      {
        title: 'API design',
        prompt: 'Design the REST endpoints for create, read (HTML and raw), delete, and list. Include request/response shapes, status codes, and idempotency and rate-limiting behaviour.',
        reference: `\`\`\`
POST /api/v1/pastes
  Headers: Authorization (optional), Idempotency-Key (optional)
  Body: { content: string, title?: string, language?: string,
          expires_in?: "10m"|"1h"|"1d"|"1w"|"never",
          visibility?: "public"|"unlisted"|"private",
          burn_after_read?: boolean, alias?: string }
  201 -> { key: "aB3xY9kL", url: "https://pb.io/aB3xY9kL",
           raw_url: "https://cdn.pb.io/raw/aB3xY9kL",
           expires_at: "2026-09-16T10:00:00Z",
           delete_token: "..." (anonymous only) }
  400 invalid, 413 too large, 429 rate limited

POST /api/v1/pastes/presign          (large pastes)
  Body: { size: number, ... same options }
  200 -> { key, upload: { url, fields }, finalize_url }
POST /api/v1/pastes/{key}/finalize   -> 201 as above

GET  /{key}                 HTML shell; 404 if missing/expired/removed
GET  /raw/{key}             text/plain; Cache-Control immutable for
                            public/unlisted, no-store for private
GET  /api/v1/pastes/{key}   metadata JSON

DELETE /api/v1/pastes/{key}
  Headers: Authorization or X-Delete-Token
  204; purges CDN

GET /api/v1/users/me/pastes?cursor=&limit=50
  200 -> { items: [...], next_cursor }
\`\`\`

**Behaviour notes**
- Rate limits: anonymous 10 creates/min per IP, authenticated 60/min; listing endpoints 60/min. Return 429 with Retry-After.
- Idempotency-Key stored in Redis for 24h mapped to the created key; replay returns the same 201.
- Raw responses carry \`Content-Type: text/plain; charset=utf-8\`, \`X-Content-Type-Options: nosniff\`, \`Content-Encoding: gzip\`, \`Referrer-Policy: no-referrer\`.
- Private pastes: 401/403 instead of 404 only when the requester is authenticated as a non-owner; anonymous requests get 404 to avoid confirming existence.`,
      },
      {
        title: 'Data model & storage',
        prompt: 'Design the metadata schema with indexes, choose the content store and object layout, and explain your choice of database. Cover how TTL, visibility and deletion are represented.',
        reference: `**Metadata (Postgres, or DynamoDB at very large scale)**
\`\`\`
pastes
  key          VARCHAR(16) PRIMARY KEY     -- base62, random
  alias        VARCHAR(64) UNIQUE NULL
  user_id      BIGINT NULL                 -- NULL for anonymous
  title        VARCHAR(256) NULL
  language     VARCHAR(32) NULL
  visibility   SMALLINT                    -- 0 public,1 unlisted,2 private
  size_bytes   INT
  content_ptr  VARCHAR(256)                -- s3://pastes/ab/aB3xY9kL.gz
  created_at   TIMESTAMPTZ
  expires_at   TIMESTAMPTZ NULL            -- NULL = never
  state        SMALLINT                    -- 0 pending,1 active,2 removed
  burn_after_read BOOLEAN, burned BOOLEAN
  delete_token_hash BYTEA NULL
  password_hash BYTEA NULL

INDEX pastes_expires_idx ON pastes(expires_at) WHERE expires_at IS NOT NULL
INDEX pastes_user_idx    ON pastes(user_id, created_at DESC)

idempotency (Redis): idem:<user|ip>:<key> -> paste key, TTL 24h
\`\`\`

**Why Postgres:** point lookups by key, simple secondary queries (by user, by expiry), unique constraints for key/alias, transactional state flips. At 1.8B rows shard by key hash (Citus, Vitess-style for MySQL) or move to DynamoDB with \`key\` as partition key, a GSI on \`user_id\`+\`created_at\`, and native TTL on \`expires_at\`.

**Content (S3)**
- Bucket \`pastes\`, object key \`<first 2 chars>/<key>.gz\` (prefixing spreads request load across partitions; S3 handles 3,500 PUT / 5,500 GET per prefix per second).
- Stored gzipped; metadata headers Content-Type and Content-Encoding set at PUT time so CloudFront serves them as-is.
- Lifecycle: objects under \`pending/\` deleted after 1 day; optional tag-based expiry classes.
- Versioning off (immutable objects), server-side encryption on.

**Deletion and expiry representation**
- Expiry: \`expires_at\` checked on read, swept in background.
- Delete/takedown: \`state = removed\` (soft) plus S3 delete and CDN purge; row retained for audit, hard-deleted after 90 days.`,
      },
      {
        title: 'High-level design',
        prompt: 'Draw the component diagram: clients, CDN, load balancer, API servers, metadata DB, cache, blob store, key generation, and background jobs. Trace the write path and the read path.',
        reference: `\`\`\`
 Browser/CLI
   |  HTML + API                       |  /raw/<key>
   v                                   v
 [Load balancer / Nginx]          [CDN: CloudFront]
   |  client_max_body_size 10m         |  miss
   v                                   v
 [API servers (stateless, N)] -----> [S3: pastes bucket]
   |        |          |
   |        |          +--> [Redis: meta cache, rate limits, idem keys]
   |        +--> [Postgres primary + replicas: pastes table]
   +--> [KGS (optional): unused_keys pool]

 [Sweeper CronJob] --> Postgres (expires_at index) --> S3 DeleteObjects
 [Content scanner workers] <-- Kafka/SQS "paste.created" --> review queue
\`\`\`

**Write path**
1. Nginx enforces body size; API validates, checks rate limit in Redis.
2. Obtain key (random + unique insert, or from KGS batch).
3. gzip content, PUT to S3 with headers.
4. INSERT row (state active), emit \`paste.created\` for async scanning.
5. Return 201 with URL. Creator immediately reads from the primary (read-your-writes) by routing reads for keys created in the last few seconds to the primary, or simply since the metadata is cached in Redis on write.

**Read path**
1. \`GET /<key>\`: API checks Redis for metadata, falls back to a replica; verifies state, expiry, visibility; renders HTML shell with the raw URL and highlight.js.
2. Browser fetches \`/raw/<key>\` from CDN; edge miss goes to S3 (or through the API for private pastes with a signed URL).

**Why stateless API servers:** all state is in Postgres, Redis, S3, so horizontal scaling behind the load balancer is trivial and any server can serve any key.`,
      },
      {
        title: 'Deep dive & bottlenecks',
        prompt: 'Pick the three hardest problems (key generation under concurrency, expiry cleanup at scale, viral read bursts) and design each in detail with numbers.',
        reference: `**1. Key generation under concurrency**
- 50 writes/s peak with random 8-char keys: collision probability per insert is n / 62^8; even at 3.65B existing keys that is 1.7 x 10^-5, so retries are negligible. Unique index on \`key\` enforces correctness across all API servers.
- If moving to a KGS: pool table with 100M pre-generated keys; \`DELETE FROM unused_keys WHERE key IN (SELECT key FROM unused_keys LIMIT 1000 FOR UPDATE SKIP LOCKED) RETURNING key\` hands out atomic batches. Servers refill at 20% remaining. Monitor pool size; refill worker keeps it above 10M.

**2. Expiry cleanup at scale**
- Daily expiries: if 70% of 1M pastes have an expiry, ~700k deletions/day, ~8/s. Trivial in steady state, but bursts happen (a bot created 5M 1-hour pastes).
- Sweeper: partial index on \`expires_at WHERE expires_at IS NOT NULL\`; loop \`SELECT ... WHERE expires_at < now() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED\`, S3 DeleteObjects (1,000 keys/call), then DELETE rows, sleep 100 ms. One worker clears 10k/s worst case; run 2-4 workers with SKIP LOCKED for bursts.
- Alert on backlog: \`SELECT count(*) WHERE expires_at < now() - interval '10 minutes'\` above 100k means the sweeper is behind.
- Alternative: DynamoDB TTL (free, within 48h) plus lazy read check for correctness.

**3. Viral read bursts**
- 20,000 reads/s on one key. CDN hit ratio for immutable objects is above 99.9%; origin sees ~20/s at most during warm-up. S3 sustains 5,500 GET/s per prefix, so even a cold CDN is fine.
- HTML shell path: Redis single-key hot spot at 20k ops/s is well within one node\'s 100k+; add a 1-second in-process LRU in each API server to make it ~N requests/s to Redis where N is the number of servers.
- Bandwidth: 20k x 10 KB = 200 MB/s = 1.6 Gbps served by the CDN, not by you.

**Other bottlenecks**
- Database write IOPS: 50 inserts/s is nothing; the real concern is index bloat from deletes; schedule VACUUM or use partitioning by created_at month so old partitions can be dropped.
- S3 PUT latency (20-50 ms) dominates write latency; acceptable.
- Content scanning must be async; never block the write path on a 300 ms malware check.`,
      },
      {
        title: 'Failure modes & trade-offs',
        prompt: 'For each component (S3, Postgres, Redis, CDN, sweeper, KGS) describe what happens when it fails or is slow, and how the design degrades. Then list the top trade-offs you made and the alternatives you rejected.',
        reference: `**Failure modes**
- **S3 unavailable (regional):** writes fail (return 503, clients retry); reads served from CDN for cached objects, uncached objects 404/503. Mitigation: cross-region replication to a second bucket and CDN origin failover.
- **Postgres primary down:** writes fail until failover (Patroni, RDS Multi-AZ, ~30-60 s). Reads continue from Redis and replicas. Read-your-writes for the creator briefly breaks.
- **Redis down:** metadata reads fall through to Postgres replicas (~10x more load; replicas sized for it), rate limiting fails open or closed per policy (fail open for reads, fail closed for anonymous creates). Idempotency lost for 24h window; duplicates possible.
- **CDN outage:** raw reads go to origin; S3 and API must sustain 5,000/s baseline, which they can, but a viral paste during a CDN outage will saturate egress. Accept.
- **Sweeper stuck:** correctness intact thanks to lazy expiry; storage grows. Alert on backlog.
- **KGS pool empty:** writes fail; fall back to random-key generation with unique insert (keep the code path).
- **Partial write (PUT ok, INSERT fails):** orphan object; reconciliation job lists \`pending/\` and deletes objects older than 1 day.

**Trade-offs made**
- **Immutability over editing:** buys indefinite caching and no invalidation; costs a feature users sometimes want (solved with forks).
- **Two-store (DB + S3) over one:** buys cheap durable storage and a lean DB; costs a two-hop write, orphan handling, and no single transaction.
- **Random keys over sequential:** buys unguessability; costs collision handling and worse B-tree locality (random inserts scatter across index pages).
- **CDN over-serving expired content for minutes vs computing exact max-age:** simpler headers; short pastes may linger at the edge. Mitigated by capping max-age at remaining life.
- **Client-side highlighting:** one cacheable object; costs a JS dependency and no-JS users see plain text.
- **Lazy + sweeper vs managed TTL:** portability across databases vs less code; DynamoDB TTL is the pragmatic choice if already on AWS.

**Rejected alternatives**
- Content hashing for keys: leaks equality between users\' pastes; breaks per-paste expiry.
- Storing content inline in Postgres: fine to ~100 GB, then backup/replication cost dominates.
- Server-side rendered highlighted HTML: kills cacheability and multiplies bytes.`,
      },
    ],
  },
  interviewQuestions: [
    'Design PasteBin. How is it different from a URL shortener, and how does that change the storage design?',
    'Where would you store paste content and metadata, and why not in the same place?',
    'How do you generate paste keys? Compare random keys with a unique constraint, a Key Generation Service, and content hashing.',
    'How do you implement paste expiry so that expired pastes are never served and storage is reclaimed?',
    'A paste goes viral with 20,000 reads per second. Walk me through what happens at each layer.',
    'How do you support private and burn-after-read pastes without breaking your caching strategy?',
    'What abuse vectors does an anonymous PasteBin face and how do you mitigate them?',
    'Estimate storage and bandwidth for 1 million pastes/day over 5 years.',
  ],
}

export default chapter
