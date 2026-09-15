import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 10,
  slug: 'caching',
  title: 'Caching',
  module: 'caching',
  estimatedMinutes: 40,
  summary:
    'A cache keeps a copy of expensive-to-compute or expensive-to-fetch data somewhere faster and closer, so that repeated reads skip the slow path. It is the single highest-leverage performance tool in system design and also the source of the hardest bugs: stale data, invalidation races and stampedes. This chapter covers what a cache is, hits and misses, TTLs and eviction, the four write/read strategies and their trade-offs, and the classic failure modes.',
  objectives: [
    'Explain what a cache is, why it works (locality and skew), and how hit ratio translates into latency and load savings.',
    'Choose a TTL and an eviction policy (LRU, LFU, FIFO, random) for a given workload and justify it.',
    'Compare cache-aside, read-through, write-through and write-back/write-behind, including consistency and durability implications.',
    'Explain why cache invalidation is hard and describe the common races and their mitigations.',
    'Recognise a thundering herd or cache stampede and outline how to prevent it.',
  ],
  quickRevision: [
    'A cache is a faster, smaller copy of data placed in front of a slower, larger source. It works because access is skewed: a small fraction of keys gets most reads.',
    'Hit = found in cache; miss = fetch from source and (usually) store. Hit ratio = hits / (hits + misses). 90% hits on a 10 ms DB with a 0.5 ms cache gives ~1.45 ms average.',
    'Every cached value is potentially stale; a cache is a deliberate consistency trade for speed.',
    'TTL bounds staleness and memory; short TTL = fresher but more misses; long TTL = fewer misses but staler.',
    'Eviction decides what to drop when full: LRU (recency), LFU (frequency), FIFO, random. Redis uses approximate LRU/LFU by sampling.',
    'Cache-aside (lazy loading): app checks cache, on miss reads DB and writes cache. Most common; only requested data is cached; first read is slow.',
    'Read-through: the cache itself loads from the DB on a miss. Same behaviour as cache-aside, less app code, needs a cache that supports loaders.',
    'Write-through: writes go to cache and DB synchronously. Cache is always fresh; writes are slower; cold data pollutes cache.',
    'Write-back / write-behind: write to cache, flush to DB later. Fastest writes, absorbs bursts; risk of data loss if cache dies before flush.',
    'Cache invalidation is hard because updating DB and cache is not atomic; races leave stale values that live for the whole TTL.',
    'Prefer "delete cache key after DB write" over "update cache key", and add a short TTL as a safety net for missed invalidations.',
    'Thundering herd / stampede: a hot key expires, thousands of requests miss at once and all hit the DB. Mitigate with locks, request coalescing, jittered TTLs, early refresh.',
    'Cache penetration: repeated misses for keys that do not exist; cache the negative result or use a Bloom filter.',
    'Measure hit ratio, p99 latency on hit and miss, eviction rate and memory; a cache below ~80% hits is usually mis-sized or mis-keyed.',
  ],
  sections: [
    {
      id: 'what-is-a-cache',
      title: 'What a cache is and why it works',
      body: `A **cache** is a copy of data stored somewhere faster or closer than its source, so that a repeated request can be served without repeating the expensive work. The source might be a database query (10 ms), a remote API call (200 ms), a rendered HTML page (50 ms of CPU) or a machine-learning inference (500 ms). The cache is typically RAM: an in-process map, or a shared store such as **Redis** or **Memcached** answering in well under a millisecond over the network.

Caches work for two reasons:

**Latency hierarchy.** Reading from L1 CPU cache takes about 1 ns, RAM about 100 ns, an SSD about 100 us, a network round trip in one data centre about 500 us, a disk-bound database query 1-10 ms, and a cross-region call 50-150 ms. Each level is 10-100x slower than the one above it, so moving data one level up is a large win.

**Skewed access.** Real traffic follows a power law: a small fraction of items receives most of the requests. On a news site, today\'s ten stories get 80% of the reads. Caching the hot 1% of keys can serve the majority of traffic, which is why a cache can be tiny compared with the database and still be effective.

Two costs come attached. **Staleness:** a copy can diverge from its source the instant the source changes; the rest of this chapter is largely about managing that. **Memory:** RAM costs roughly 10-20x more per GB than SSD, so you cache the working set, not the dataset.

Beyond speed, caches protect the source. If Redis absorbs 90% of reads, the database sees a tenth of the load, needs fewer replicas, and has headroom for spikes. This is why a cache outage often feels like a database outage: the database suddenly receives ten times its normal traffic and falls over.

Where can you cache? Everywhere along the request path: browser, CDN, reverse proxy (Nginx, Varnish), application memory, a distributed cache (Redis), the database\'s own buffer pool. Chapter 12 covers the levels; this chapter focuses on the application-level cache in front of a database.`,
      mentalModel:
        'A cache is the sticky note on your monitor with the five phone numbers you dial every day. The full directory still exists, but you almost never open it. The risk: someone changes their number and your sticky note is now wrong.',
      diagram: `Latency ladder (approx.)
  L1 cache     ~1 ns
  RAM          ~100 ns
  SSD read     ~100 us
  DC network   ~500 us      <-- Redis / Memcached live here
  DB query     1-10 ms      <-- what we are trying to avoid
  cross-region 50-150 ms

Request path
  client -> app --hit?--> [cache] --yes--> return (0.5 ms)
                              |
                             miss
                              v
                           [ DB ] --> fill cache --> return (10 ms)`,
      keyPoints: [
        'A cache is a faster copy in front of a slower source; RAM is the usual medium.',
        'It works because of the latency hierarchy and heavily skewed access (hot keys).',
        'Costs: staleness (the copy can be wrong) and memory (cache the working set only).',
        'Caches also shield the source from load; losing the cache can overload the database.',
      ],
      checkpoint: {
        question:
          'A product page takes 40 ms, of which 30 ms is a database query. You add a cache with a 95% hit ratio and 1 ms lookup. Estimate the new average page time.',
        answer:
          'Average query cost = 0.95 * 1 ms + 0.05 * (1 + 30) ms = 0.95 + 1.55 = 2.5 ms. Page time drops from 40 ms to roughly 12.5 ms. The 5% of misses still pay the full price, so p99 barely improves unless the miss path is also addressed.',
      },
    },
    {
      id: 'hits-misses-ttl',
      title: 'Hits, misses, hit ratio and TTL',
      body: `A **hit** means the requested key was present and valid; a **miss** means it was absent or expired and the source must be consulted. The **hit ratio** is hits divided by total lookups, and it is the primary health metric of any cache.

Average latency follows directly: \`avg = hit_ratio * cache_latency + (1 - hit_ratio) * (cache_latency + source_latency)\`. The formula shows something counter-intuitive: going from 90% to 99% hits cuts source load by **10x** (10% of requests to 1%), while going from 50% to 90% cuts it only 5x. Small improvements at the top matter enormously for the database behind the cache.

Misses come in three kinds: **cold** (first request for a key, unavoidable), **capacity** (the key was evicted because memory was full; fix by sizing or better eviction) and **staleness** (the key expired by TTL; fix by tuning TTL or refreshing proactively). Splitting miss metrics by cause tells you which knob to turn.

**TTL (time to live)** is the expiry stamped on each entry. It serves two purposes: bounding how stale a value can be, and reclaiming memory for keys nobody asks for again. Choosing a TTL is a trade:

- **Short TTL** (seconds): fresher data, more misses, more load on the source, more stampede risk at expiry.
- **Long TTL** (hours, days): higher hit ratio, but stale data can linger and memory fills with rarely used keys.

The right value depends on how often the data changes and how much staleness the business tolerates. Product prices might use 60 seconds with explicit invalidation on change; a user\'s avatar URL might use 24 hours; an exchange rate might use 5 minutes; a session token exactly its validity period.

Two refinements are widely used. **Jittered TTL**: add a random 10-20% to each TTL so keys written together do not expire together (chapter 11 explains why this prevents stampedes). **Soft and hard TTL**: serve a value past its soft expiry while refreshing it in the background, but never past its hard expiry. This keeps hit ratio high without letting data become arbitrarily old.

Finally, Redis expiry is lazy plus sampled: expired keys are removed when accessed or when a background job samples and deletes them, so memory is not reclaimed the instant a TTL passes.`,
      mentalModel:
        'TTL is the "best before" date on milk. Short dates mean frequent shopping trips (misses) but fresh milk; long dates mean fewer trips but the occasional sour surprise (staleness).',
      diagram: `hit ratio vs source load (per 1000 requests)
  50% hits  -> 500 to DB
  90% hits  ->  50 to DB   (10x less than 50%)
  99% hits  ->   5 to DB   (10x less than 90%)

TTL trade
  short TTL |=====> fresher, more misses, stampede-prone
  long  TTL |=====> more hits, staler, memory bloat

soft/hard TTL
  0 ---------- soft (refresh in background) ------ hard (miss)`,
      keyPoints: [
        'Hit ratio is the primary cache metric; average latency is a weighted mix of hit and miss paths.',
        'Moving from 90% to 99% hits reduces source load 10x; the top end matters most.',
        'Classify misses as cold, capacity or staleness to know which knob to tune.',
        'TTL trades freshness against hit ratio and memory; choose per data type.',
        'Jitter TTLs and consider soft/hard expiry with background refresh.',
      ],
      checkpoint: {
        question:
          'Your cache shows 85% hits and a high eviction rate. Memory is at the configured limit. Which kind of miss dominates and what is the fix?',
        answer:
          'Capacity misses: hot keys are being evicted to make room. Fixes: increase memory, reduce value size (compress, store only needed fields), shorten TTLs on cold data so it leaves sooner, or switch to an eviction policy (LFU) that protects frequently read keys better.',
      },
    },
    {
      id: 'eviction',
      title: 'Eviction: what to throw away when memory is full',
      body: `A cache is smaller than its source by design, so it must continually decide which entries to drop. The **eviction policy** is that decision rule, and it determines the hit ratio for a given memory size.

**LRU (Least Recently Used).** Evict the entry that has gone longest without being read. It bets on temporal locality: if you read it recently, you will read it again soon. It is the default almost everywhere because it is simple and good for most workloads. Weakness: a one-time scan over many keys (a batch job, a crawler) pushes every genuinely hot key out, a problem called *cache pollution*.

**LFU (Least Frequently Used).** Evict the entry with the fewest accesses. It protects steadily popular items from scans, but a key that was hot yesterday and dead today can linger for a long time unless counts decay. Redis\'s LFU uses a logarithmic counter with decay to handle this.

**FIFO.** Evict the oldest inserted, regardless of use. Cheap and predictable but ignores popularity; mostly used in simple embedded caches.

**Random.** Evict any entry. Surprisingly competitive for uniform workloads and trivial to implement; Redis\'s "approximate LRU" is essentially random sampling of 5 keys and evicting the least recently used among them, which gets very close to true LRU without a linked list.

**TTL-based.** Evict entries closest to expiry first (Redis \`volatile-ttl\`).

Redis exposes these as \`maxmemory-policy\`: \`allkeys-lru\`, \`allkeys-lfu\`, \`volatile-lru\` (only among keys with a TTL), \`allkeys-random\`, \`volatile-ttl\`, and \`noeviction\` (return errors when full, appropriate when Redis is a primary store, not a cache). Memcached uses a segmented LRU.

Advanced policies exist because pure LRU and LFU each fail somewhere. **ARC** adapts between recency and frequency. **W-TinyLFU** (used by Caffeine on the JVM) admits a new key only if it is likely to be more useful than the key it would evict, which crushes scan pollution and is the state of the art for in-process caches.

Choose by workload: LRU for general web traffic; LFU when a stable set of items is popular and scans are common (a product catalogue with crawlers); TTL-based when freshness matters more than popularity; noeviction when data loss is unacceptable. Whatever you choose, watch the **eviction rate**: a high rate means the working set does not fit, and no policy fixes an undersized cache.`,
      mentalModel:
        'Your wardrobe has limited hangers. LRU throws out whatever you have not worn longest. LFU throws out what you have worn least often, so your favourite jacket is safe even if you skipped it this week. A big one-off costume party (a scan) can wreck an LRU wardrobe by pushing your everyday clothes out.',
      diagram: `LRU: access order   A  B  C  A  D  B   (capacity 3)
     after D:   evict C (least recently used)   cache = A D B

LFU: counts  A:5  B:1  C:3  D:1
     evict B or D (least frequently used); A survives scans

Scan pollution (LRU): read 1000 unique keys once
     -> every hot key evicted; hit ratio collapses
     LFU / W-TinyLFU: one-time keys never gain frequency,
     hot set survives`,
      keyPoints: [
        'Eviction policy determines hit ratio for a given memory size.',
        'LRU: recency-based default; vulnerable to scan pollution.',
        'LFU: frequency-based; resists scans; needs decay to forget old favourites.',
        'Redis policies: allkeys-lru/lfu, volatile-lru/ttl, random, noeviction; sampled approximations, not exact.',
        'A high eviction rate means the working set does not fit; size first, then tune policy.',
      ],
      checkpoint: {
        question:
          'A nightly report job reads every product once. The next morning the product cache hit ratio is 30% instead of 92%. Diagnose and fix.',
        answer:
          'Scan pollution: the job pushed the hot products out of an LRU cache with a million one-time keys. Fixes: route the job to bypass the cache (read from a replica directly), give job-loaded keys a very short TTL, or switch to LFU / W-TinyLFU so single-access keys cannot displace frequently read ones.',
      },
    },
    {
      id: 'read-strategies',
      title: 'Cache-aside vs read-through: who fills the cache?',
      body: `The first design decision is who is responsible for loading data into the cache on a miss.

**Cache-aside (lazy loading).** The application owns the logic:

1. Look up the key in the cache.
2. On hit, return it.
3. On miss, query the database, write the result into the cache with a TTL, return it.

This is the most common pattern with Redis and Memcached. Its virtues: only data that is actually requested is cached, so memory is spent on the working set; the cache is a dumb key-value store with no knowledge of the database; if the cache dies, the application still works (slowly) by going to the database. Its costs: every miss pays cache lookup + DB query + cache write; the first request for any key is slow; and the application code for lookup-then-fill is duplicated across services unless wrapped in a library. Data model mismatch is also on you: the cache holds whatever shape you stored, and the database may change underneath it.

**Read-through.** The cache sits in the request path and knows how to load from the source itself. The application asks the cache; the cache fetches from the database on a miss, stores it and returns it. Behaviour is identical to cache-aside from the outside, but the loading logic lives in one place. In-process caches such as **Caffeine** and **Guava** do this via a loader function; **DAX** in front of DynamoDB and some CDN configurations are read-through at infrastructure level. The cost: the cache must be configured with data-source access, and a cache failure now blocks reads unless a fallback exists.

Both patterns share the fundamental read-path weakness: they only *load* on a miss, so they know nothing about *updates*. If a row changes in the database, the cache serves the old value until it expires or something invalidates it. That is why cache-aside is always paired with an invalidation strategy on the write path, covered next.

A subtle point about cache-aside: on a miss you should store the value with a TTL even if you also invalidate on writes. The TTL is the safety net for the invalidation you forgot, the message that was lost, or the deploy that happened between the DB write and the cache delete.`,
      mentalModel:
        'Cache-aside is a student who checks their notes, and if the answer is missing, looks it up in the textbook and copies it into the notes. Read-through is a librarian who does the looking-up for you: you only ever ask the librarian.',
      diagram: `Cache-aside                         Read-through
 app --get--> cache                  app --get--> cache
   miss                                          | miss
 app --query--> DB                             cache --query--> DB
 app --set--> cache                            cache stores
 app returns                                   cache returns
 (app owns loading logic)            (cache owns loading logic)`,
      keyPoints: [
        'Cache-aside: app checks cache, loads from DB on miss and fills cache; most common with Redis.',
        'Read-through: the cache loads from the source itself; less duplicated code, cache becomes a hard dependency.',
        'Both cache only requested data (lazy) and pay a slow first read.',
        'Neither knows about updates; pair them with write-path invalidation and a TTL safety net.',
      ],
    },
    {
      id: 'write-strategies',
      title: 'Write-through vs write-back: what happens on a write?',
      body: `The second decision is what the application does with the cache when data changes.

**Write-around (invalidate).** Write to the database only, and **delete** the cache key. The next read misses and reloads fresh data. Simple, and the natural partner of cache-aside. The cost: the read after every write is a miss, and there is a race window discussed in the next section.

**Write-through.** Every write goes to the cache **and** the database synchronously, in the same request, before returning success. The cache never holds stale data for keys written this way, and reads following a write hit immediately. The costs: write latency now includes both systems; every written key occupies cache memory even if never read again (write pollution); and if the two writes are not atomic you still need to handle the case where one succeeds and the other fails. Write-through is a good fit when read-after-write freshness matters and the written keys are also the hot keys, such as a user editing their own profile.

**Write-back (write-behind).** Write to the cache only and acknowledge immediately; a background process flushes dirty entries to the database later, individually or in batches. Writes become as fast as a cache operation, and bursts (a like counter, view counts, game state) are absorbed and coalesced: 1,000 increments to the same counter can become one database update. The cost is **durability**: if the cache node dies before flushing, those writes are gone. Write-back is acceptable for data you can afford to lose (metrics, counters, presence) or when the cache is itself replicated and persistent (Redis with AOF and replicas), and it is exactly what CPU caches and OS page caches do with dirty pages.

In practice most web systems use **cache-aside for reads plus write-around invalidation for writes**, because it keeps the cache optional and the database authoritative. Write-through appears where read-your-own-write matters. Write-back appears for high-volume, loss-tolerant counters.

One more cross-cutting choice: on a write, should you *update* the cached value or *delete* it? Deleting is safer. Updating requires computing the exact new cached representation in the write path, and two concurrent updates can land in the cache in the opposite order from the database, leaving the cache wrong until TTL. Deleting forces the next reader to load the truth.`,
      mentalModel:
        'Write-through is paying with a debit card: the bank and your wallet update together, slower but always in sync. Write-back is a bar tab: fast to order, settled later in one payment, and if the bartender loses the tab nobody knows what you owe.',
      diagram: `Write-around (invalidate)   Write-through          Write-back
 app --write--> DB          app --write--> cache    app --write--> cache
 app --DEL---> cache        app --write--> DB       ack immediately
 next read: miss, reload    ack after both          cache --flush later--> DB
 simple; safe               fresh; slower writes    fastest; risk of loss`,
      keyPoints: [
        'Write-around: write DB, delete cache key; simple, next read misses.',
        'Write-through: write cache and DB synchronously; always fresh, slower writes, write pollution.',
        'Write-back: write cache, flush to DB later; fastest, absorbs bursts, data loss if cache fails first.',
        'Default combo: cache-aside reads + write-around invalidation.',
        'Prefer deleting cache entries over updating them to avoid ordering races.',
      ],
      checkpoint: {
        question:
          'A video platform increments a view counter 50,000 times per second on a viral video. Which write strategy fits, and what must you accept?',
        answer:
          'Write-back: INCR in Redis and flush the total to the database every few seconds. The database sees one write per video per flush instead of 50k. You accept that a Redis crash loses up to a few seconds of counts, which is fine for view counts and unacceptable for money.',
      },
    },
    {
      id: 'invalidation',
      title: 'Why cache invalidation is hard',
      body: `"There are only two hard things in computer science: cache invalidation and naming things." The joke is accurate because the cache and the database are two systems with no shared transaction, so updating both is a **distributed consistency problem** hidden inside a simple feature.

Consider the innocent sequence *write DB, then update cache*. Two concurrent writers:

1. Writer A sets price = 10 in DB.
2. Writer B sets price = 12 in DB.
3. Writer B sets cache = 12.
4. Writer A (delayed by GC or network) sets cache = 10.

The database says 12, the cache says 10, and it will say 10 until the TTL expires. This is why **delete, do not update** is the standard advice: a stale delete is harmless.

But *write DB, then delete cache* has its own race with a concurrent reader:

1. Reader R misses the cache and reads price = 10 from DB.
2. Writer W sets price = 12 in DB and deletes the cache key.
3. Reader R (slow) writes its stale 10 into the cache.

Now the cache holds 10 for a full TTL. The window is small (a read must straddle a write and finish after the delete) but at millions of requests per day it happens. Mitigations:

- **Short TTL as a bound.** Guarantees the damage is limited to, say, 60 seconds.
- **Delayed double delete.** Delete the key, write DB, then delete again after ~500 ms to catch any stale fill that slipped in.
- **Versioned keys / compare-and-set.** Store a version with the value; a fill is rejected if a newer version is present.
- **Leases (Facebook\'s memcached).** A miss hands the reader a lease token; the fill is accepted only if no delete occurred since the token was issued.
- **Invalidate from the database change stream (CDC).** A Debezium or binlog consumer deletes cache keys after commits, so invalidation cannot be forgotten by an application path and is ordered by the database log.

The alternative order, *delete cache then write DB*, is worse: a reader between the two steps refills the old value and the write then lands in the DB unseen by the cache.

Beyond races, invalidation is hard because of **fan-out**: one database row can be embedded in many cached objects (a user\'s name appears in cached posts, comments and search results). You need a map from source entity to every derived key, or you accept TTL-bounded staleness for derived data. Tag-based invalidation (Varnish, Fastly surrogate keys) implements this at the HTTP layer.

The pragmatic rule: invalidate explicitly where correctness matters, always set a TTL, and never rely on the two being unnecessary.`,
      mentalModel:
        'Two people are updating a shared whiteboard (cache) from a ledger (DB) without talking. If they both copy at once, whoever finishes last wins, regardless of who read the ledger last. Erasing the whiteboard instead of rewriting it means the next reader has to consult the ledger.',
      diagram: `Race: write-DB-then-delete vs concurrent reader
 time  Reader R                 Writer W
  1    miss; read DB -> 10
  2                             DB := 12
  3                             DEL cache
  4    SET cache := 10  <-- stale until TTL

Fixes: short TTL | delayed 2nd DEL | versioned CAS |
       leases | invalidate from DB change stream (CDC)`,
      keyPoints: [
        'Cache and DB have no shared transaction, so updating both is a consistency problem.',
        'Update-cache-after-write races reorder values; delete-after-write races with slow readers.',
        'Mitigations: TTL bound, delayed double delete, versioned CAS, leases, CDC-driven invalidation.',
        'Delete-then-write is the worst order; write-then-delete plus TTL is the sane default.',
        'Fan-out: one row can live in many cached objects; track derived keys or accept TTL staleness.',
      ],
      checkpoint: {
        question:
          'An engineer proposes: "on update, delete the cache key first, then write the database, so no one sees stale data". Find the flaw.',
        answer:
          'Between the delete and the DB write, a reader misses, reads the OLD value from the DB and refills the cache. The DB write then lands, and the cache serves the old value for a full TTL. Write to the DB first, then delete (and optionally delete again after a short delay), and keep a TTL as a bound.',
      },
    },
    {
      id: 'thundering-herd',
      title: 'Thundering herd and other cache failure modes',
      body: `**Thundering herd** (also called **cache stampede** or dog-piling) happens when a hot key becomes unavailable and every concurrent request for it misses at the same time. Picture a home-page payload cached for 60 seconds and requested 5,000 times per second. At the instant it expires, all in-flight requests miss, and 5,000 identical queries hit the database within milliseconds. The database, sized for 5% of that traffic, stalls; requests queue; latency climbs; the app tier runs out of threads; more requests time out. A single expiry has become an outage.

The same shape appears when a **cache node restarts** (every key is cold simultaneously), on a **deploy that changes key names** (all keys miss), and on the **cold start** of a new region.

Chapter 11 covers mitigations in depth; the ideas are:

- **Locking / single-flight**: only the first misser fetches from the source; others wait for it or serve the stale value. Redis \`SET key lock NX PX 3000\` is the usual mutex.
- **Request coalescing**: the application deduplicates identical in-flight requests (Go\'s \`singleflight\`, Nginx \`proxy_cache_lock\`).
- **Jittered TTLs**: keys set together do not expire together.
- **Early / probabilistic refresh**: refresh the value slightly before expiry so it never actually goes missing.
- **Serve stale while revalidating**: return the expired value while one background refresh runs.

Two other failure modes deserve names:

**Cache penetration.** Requests for keys that do not exist in the database (deleted items, malicious random ids) always miss and always hit the database, bypassing the cache entirely. Fix by caching negative results (\`key -> NULL\` with a short TTL) or by placing a **Bloom filter** in front (chapter 22) that says "definitely not present" without touching the database.

**Cache avalanche.** Many keys expire together because they were loaded together with the same TTL (for example, after a warm-up job). Jittering TTLs is the primary fix, along with multi-level caching so a Redis outage still leaves an in-process cache.

Operationally, a cache is only "just a cache" if the system survives without it. Test that: turn off the cache in staging under production-like load and watch whether the database holds. If it does not, you have a hard dependency and need capacity, rate limiting or load shedding at the miss path.`,
      mentalModel:
        'A stadium with one open turnstile is fine when fans trickle in. When the gates all open at once (a hot key expiring), the whole crowd hits that turnstile together and the fence goes down. Locks are stewards letting one through at a time; jitter is opening gates a few seconds apart.',
      diagram: `Thundering herd
  t=59.99s  5,000 req/s all HIT  cache -> DB idle
  t=60.00s  key expires
  t=60.01s  5,000 req MISS  -----> 5,000 queries hit DB
                                    DB saturates, latency spikes
Fixes
  lock / single-flight :  1 fetch, 4,999 wait or serve stale
  jittered TTL         :  keys expire spread over time
  early refresh        :  refresh at 55s, key never missing
  negative caching     :  key -> NULL stops penetration`,
      keyPoints: [
        'Thundering herd: many concurrent misses on the same hot key overwhelm the source.',
        'Triggers: TTL expiry, cache restart, key-name change, cold start.',
        'Mitigations: locking/single-flight, request coalescing, jittered TTL, early refresh, stale-while-revalidate.',
        'Penetration (non-existent keys): negative caching or Bloom filter.',
        'A cache is optional only if the system survives its loss; test it.',
      ],
      checkpoint: {
        question:
          'Attackers request /product/{random-uuid} 20,000 times per second. Every request misses the cache and hits the database. Name the failure mode and two fixes.',
        answer:
          'Cache penetration. Fixes: cache negative results (store "not found" for that id with a short TTL, such as 30 s) so repeats hit the cache; put a Bloom filter of valid product ids in front to reject unknown ids without any lookup; and rate-limit by client to blunt the attack.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Why can a cache that holds only 1% of the data serve most of the reads?',
      options: [
        'Because caches compress data 100x',
        'Because access is heavily skewed: a small set of hot keys receives most requests',
        'Because databases are slow at reading',
        'Because TTLs refresh data automatically',
      ],
      answerIndex: 1,
      explanation:
        'Real-world access follows a power law; the hot working set is tiny relative to the dataset. Compression, database speed and TTLs do not explain the effect.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'A cache moves from a 90% to a 99% hit ratio. By what factor does load on the backing database fall?',
      options: ['About 1.1x', 'About 2x', 'About 10x', 'It does not change'],
      answerIndex: 2,
      explanation:
        'Database load is proportional to the miss rate: 10% vs 1% is a 10x difference. The hit ratio itself only rose 9 points, which is why the top end of hit ratio matters so much.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'A one-off batch job reads every row once and afterwards the cache hit ratio collapses. Which eviction policy is most vulnerable to this and which resists it?',
      options: [
        'LFU is vulnerable; LRU resists',
        'LRU is vulnerable; LFU or W-TinyLFU resist',
        'Random is vulnerable; FIFO resists',
        'All policies behave identically',
      ],
      answerIndex: 1,
      explanation:
        'LRU evicts by recency, so a scan of many one-time keys pushes the hot set out (scan pollution). Frequency-aware policies do not let single-access keys displace frequently used ones.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 1,
      question: 'In the cache-aside pattern, who loads data into the cache on a miss?',
      options: ['The database', 'The cache itself', 'The application', 'A background scheduler'],
      answerIndex: 2,
      explanation:
        'Cache-aside means the application checks the cache, queries the database on a miss and writes the result back. When the cache does the loading itself that is read-through.',
    },
    {
      type: 'multi',
      id: 'q5',
      difficulty: 2,
      question: 'Which statements about write-back (write-behind) caching are true? Select all that apply.',
      options: [
        'Writes are acknowledged after both cache and database are updated',
        'It can coalesce many updates to the same key into one database write',
        'A cache failure before flushing can lose acknowledged writes',
        'It is well suited to view counters and metrics',
        'It guarantees the database is never behind the cache',
      ],
      answerIndices: [1, 2, 3],
      explanation:
        'Write-back acknowledges after the cache write only and flushes later, so it coalesces bursts and suits loss-tolerant counters, but risks losing unflushed data. Synchronous double writes describe write-through.',
    },
    {
      type: 'truefalse',
      id: 'q6',
      difficulty: 2,
      statement: 'On a data update, updating the cached value is safer than deleting the cache key.',
      answer: false,
      explanation:
        'Two concurrent writers can land their cache updates in the opposite order from their database writes, leaving the cache wrong until TTL. Deleting forces the next read to reload the truth and cannot be "wrong".',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question:
        'Reader R misses and reads value 10 from the DB. Writer W then writes 12 to the DB and deletes the cache key. R, delayed, then writes 10 into the cache. Which mitigation directly addresses this race?',
      options: [
        'Switch from LRU to LFU eviction',
        'A delayed second delete a few hundred milliseconds after the write, or versioned/lease-based fills',
        'Increase the TTL to reduce misses',
        'Use write-back caching',
      ],
      answerIndex: 1,
      explanation:
        'The stale fill happens after the delete; a delayed second delete removes it, and versioned or lease-based fills reject it. Eviction policy is unrelated, a longer TTL makes the stale value live longer, and write-back does not address read-fill races.',
    },
    {
      type: 'mcq',
      id: 'q8',
      difficulty: 2,
      question: 'What is a thundering herd in the context of caching?',
      options: [
        'Too many keys stored in the cache',
        'Many concurrent requests missing on the same hot key at once and all hitting the source',
        'A cache that evicts keys too aggressively',
        'A database replica lagging behind the primary',
      ],
      answerIndex: 1,
      explanation:
        'When a hot key expires or a cache restarts, all in-flight requests miss simultaneously and stampede the database. The other options describe unrelated problems.',
    },
    {
      type: 'truefalse',
      id: 'q9',
      difficulty: 1,
      statement: 'Caching a "not found" result for a short time is a valid technique to stop repeated misses for non-existent keys.',
      answer: true,
      explanation:
        'Negative caching stops cache penetration: repeated requests for missing ids hit the cached NULL rather than the database. A Bloom filter is the other common defence.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 3,
      question:
        'A user edits their own profile and immediately reloads the page, expecting to see the change. Reads are cache-aside with a 10-minute TTL and writes only touch the DB. Which strategy change fixes the complaint with the least risk?',
      options: [
        'Reduce TTL to 1 second for all keys',
        'Delete (or write-through) the profile cache key on update so the next read reloads fresh data',
        'Switch to write-back caching',
        'Disable the cache for profile pages',
      ],
      answerIndex: 1,
      explanation:
        'Invalidating on write, or writing through for this hot-after-write key, gives read-your-own-writes. A 1 s TTL destroys the hit ratio for everyone, write-back does not fix read staleness, and disabling the cache removes the benefit entirely.',
    },
    {
      type: 'mcq',
      id: 'q11',
      difficulty: 2,
      question: 'Which Redis maxmemory-policy would you choose when Redis is the primary store for data that must not be silently dropped?',
      options: ['allkeys-lru', 'volatile-ttl', 'noeviction', 'allkeys-random'],
      answerIndex: 2,
      explanation:
        'noeviction returns errors on writes when memory is full rather than discarding data. Every other policy silently evicts keys, which is right for a cache but wrong for a system of record.',
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 3,
      question:
        'Your home page payload is cached with a 60-second TTL and requested 4,000 times per second. Every minute the database CPU spikes to 100% for a second. Explain what is happening and propose a layered fix.',
      modelAnswer: `**Diagnosis:** a thundering herd. At each expiry, all ~4,000 concurrent requests in that instant miss and each runs the expensive home-page query, saturating the database for as long as it takes the first fill to land.

**Fix, layered:**
1. **Single-flight / lock**: on a miss, acquire \`SET homepage:lock 1 NX PX 2000\`; only the winner queries the DB and refills; others wait briefly (poll or subscribe) or serve the previous value.
2. **Stale-while-revalidate**: keep a soft TTL of 60 s and a hard TTL of 120 s; serve the value after 60 s while one background refresh runs, so no request ever waits on the DB.
3. **Early refresh**: a scheduled job refreshes the key every 50 s so it never expires under load.
4. **Jitter**: if many similar keys exist (per-locale home pages), add random 10-20% to TTLs.

Result: the DB sees one query per refresh interval instead of thousands per expiry.`,
      rubric: [
        'Identifies the periodic spike as a thundering herd at TTL expiry.',
        'Proposes a lock or request coalescing so only one request refills.',
        'Proposes serving stale or refreshing early so the key never actually goes missing.',
        'Mentions jitter for multiple related keys.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 2,
      question:
        'Compare write-through and write-back caching. Give one workload where each is the right choice and explain the deciding factor.',
      modelAnswer: `**Write-through** writes to the cache and the database synchronously; the cache is always fresh and the write is durable, but each write is slower and every written key consumes cache memory. Right for a user editing their own profile or settings: the same key is read immediately afterwards and must be correct, and write volume is low.

**Write-back** writes to the cache and flushes to the database later, often batching many updates into one. Writes are fastest and bursts are absorbed, but a cache failure before the flush loses data. Right for view counters, likes or presence heartbeats: extremely high write rates and the loss of a few seconds of counts is acceptable.

**Deciding factor:** can you tolerate losing recently acknowledged writes? If no, write-through (or write-around). If yes and write volume is high, write-back.`,
      rubric: [
        'Correctly describes synchronous dual write vs deferred flush.',
        'Names durability risk as the core cost of write-back.',
        'Gives a low-volume, correctness-sensitive example for write-through.',
        'Gives a high-volume, loss-tolerant example for write-back.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'What is a cache?', back: 'A faster, smaller copy of data placed in front of a slower source so repeated reads skip the expensive path. Trades staleness and memory for latency and reduced source load.' },
    { id: 'f2', front: 'Why caching works', back: 'Latency hierarchy (RAM ~100 ns vs DB ms) and skewed access: a small hot set of keys receives most requests.' },
    { id: 'f3', front: 'Hit ratio and average latency', back: 'hit_ratio = hits / total. avg = h * cache_lat + (1 - h) * (cache_lat + source_lat). 90% -> 99% hits cuts source load 10x.' },
    { id: 'f4', front: 'Three kinds of miss', back: 'Cold (first request), capacity (evicted for space), staleness (TTL expired). Each points to a different fix.' },
    { id: 'f5', front: 'TTL trade-off', back: 'Short TTL: fresher, more misses, stampede-prone. Long TTL: more hits, staler, memory bloat. Choose per data type; add jitter.' },
    { id: 'f6', front: 'Soft vs hard TTL', back: 'Past soft TTL, serve the value but refresh in background; past hard TTL, treat as a miss. Keeps hit ratio high with bounded staleness.' },
    { id: 'f7', front: 'LRU vs LFU', back: 'LRU evicts least recently used (recency; scan pollution risk). LFU evicts least frequently used (frequency; needs decay). Redis implements sampled approximations.' },
    { id: 'f8', front: 'Scan pollution', back: 'A one-time read of many keys pushes the hot set out of an LRU cache. Fix: bypass cache for scans, short TTL for scan keys, or LFU / W-TinyLFU.' },
    { id: 'f9', front: 'Redis maxmemory policies', back: 'allkeys-lru, allkeys-lfu, volatile-lru, volatile-ttl, allkeys-random, noeviction (errors when full; use when Redis is a primary store).' },
    { id: 'f10', front: 'Cache-aside', back: 'App checks cache; on miss reads DB, writes cache with TTL, returns. Lazy, caches only requested data, cache is optional. Most common pattern.' },
    { id: 'f11', front: 'Read-through', back: 'Cache loads from the source itself on a miss (Caffeine loader, DAX). Same behaviour as cache-aside; loader logic centralised; cache becomes a hard dependency.' },
    { id: 'f12', front: 'Write-through', back: 'Write cache and DB synchronously. Always fresh, read-your-writes; slower writes and write pollution.' },
    { id: 'f13', front: 'Write-back / write-behind', back: 'Write cache, flush to DB later (batched). Fastest, absorbs bursts; loses unflushed data if cache fails. For counters, metrics.' },
    { id: 'f14', front: 'Write-around', back: 'Write DB, delete cache key; next read misses and reloads. Default partner of cache-aside.' },
    { id: 'f15', front: 'Why "delete, do not update" the cache', back: 'Concurrent updates can land in the cache in a different order than in the DB, leaving it wrong until TTL. A delete can never be stale.' },
    { id: 'f16', front: 'Write-then-delete race and fixes', back: 'Slow reader refills stale value after the delete. Fixes: TTL bound, delayed second delete, versioned CAS, leases, CDC-driven invalidation.' },
    { id: 'f17', front: 'Thundering herd / cache stampede', back: 'Hot key expires; all concurrent requests miss and hit the DB at once. Fix: lock/single-flight, coalescing, jittered TTL, early refresh, stale-while-revalidate.' },
    { id: 'f18', front: 'Cache penetration', back: 'Repeated requests for non-existent keys bypass the cache. Fix: negative caching (key -> NULL, short TTL) or a Bloom filter of valid keys.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'What a cache is and its fundamental trade-off',
      prompt: 'Explain caching to a junior developer, including why it makes things faster and what it can get wrong.',
      modelExplanation: `A cache is a copy of an answer kept somewhere quick to reach, so the next time the same question comes up you do not redo the slow work. Looking up a product in the database might take 10 milliseconds; keeping the result in Redis, which is memory across the network, makes the second lookup take half a millisecond.

It works because people ask the same questions over and over. A tiny fraction of products gets most of the views, so keeping just those in memory serves most requests. The database then handles a tenth of the traffic and stops being the bottleneck.

The catch is that a copy can be out of date. If the price changes in the database, the cache still holds the old price until you either delete that entry or it expires. Every cached value comes with a time-to-live so staleness is bounded, and important changes should also explicitly remove the cache entry. The second catch is memory: RAM is expensive, so the cache is small and has to throw things out, usually whatever was used least recently. Caching is a trade: speed and reduced load in exchange for the risk of stale data and one more system to run.`,
      mustMention: [
        'A copy in a faster place (RAM, Redis)',
        'Works due to repeated, skewed access',
        'Reduces load on the source',
        'Staleness bounded by TTL and invalidation',
        'Limited memory requires eviction',
      ],
    },
    {
      id: 'fe2',
      concept: 'Cache-aside, write-through and write-back',
      prompt: 'Explain the three main caching strategies and how you would pick one for a given feature.',
      modelExplanation: `Cache-aside is the everyday pattern: the application asks the cache first, and if the answer is missing it goes to the database, stores the result in the cache and returns it. Only data people actually ask for gets cached, and if the cache goes down the app still works, just slower. When data changes, you write the database and delete the cache entry so the next reader fetches a fresh copy.

Write-through changes the write side: each write updates the cache and the database together before returning. The cache is never stale for those keys, which is great when the same user reads their own change a second later, but every write is slower and the cache fills with things that may never be read.

Write-back goes the other way: writes land only in the cache and get flushed to the database later, possibly many merged into one. It is the fastest and absorbs huge bursts like view counters, but if the cache crashes before flushing you lose those writes.

Pick by asking: is the data read far more than written (cache-aside), must a writer immediately see their change (write-through), or is it a torrent of loss-tolerant updates (write-back)?`,
      mustMention: [
        'Cache-aside: app loads on miss, invalidates on write',
        'Write-through: synchronous dual write, always fresh, slower',
        'Write-back: deferred flush, fastest, durability risk',
        'Selection based on read/write ratio and loss tolerance',
      ],
    },
    {
      id: 'fe3',
      concept: 'Why cache invalidation is hard',
      prompt: 'Explain to a colleague why "just delete the cache key when the row changes" can still leave stale data, and what you would do about it.',
      modelExplanation: `Deleting the key on every update sounds airtight, but the cache and the database are two separate systems with no shared transaction, and requests overlap in time. Imagine a reader misses the cache and reads the old price from the database. A moment later a writer updates the price and deletes the cache key. Then the slow reader, which still holds the old price in memory, writes it into the cache. The cache now has the old price and nothing will fix it until the entry expires.

The window is tiny, but at millions of requests it happens every day. So I do three things. I always set a TTL so any stale entry has a bounded life. For important data I delete the key again a few hundred milliseconds after the write to catch stale fills. And where correctness really matters, I drive invalidation from the database change log with a tool like Debezium so it cannot be forgotten by a code path, or I use versioned writes so an older value cannot overwrite a newer one. Invalidation is a distributed-systems problem, so I treat it like one.`,
      mustMention: [
        'No shared transaction between cache and DB',
        'Concrete read-then-stale-fill race',
        'TTL as a bound on damage',
        'Delayed double delete or versioning',
        'CDC-driven invalidation for critical data',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a busy neighbourhood coffee shop from the counter to the back office. Each spot anchors one caching idea.',
    stops: [
      { locus: 'The chalkboard behind the counter', concept: 'What a cache is', image: 'Instead of consulting the thick recipe binder in the back for every order, the barista glances at a chalkboard listing the five most-ordered drinks. Orders fly out ten times faster, but one price on the board is smudged and wrong.' },
      { locus: 'The tally counter by the till', concept: 'Hits, misses and hit ratio', image: 'Every order clicks a green counter (hit) or a red counter (miss). The manager stares at the red one, muttering that going from 90 to 99 percent green means the kitchen works ten times less.' },
      { locus: 'The milk fridge', concept: 'TTL', image: 'Every carton has an exaggerated "best before" sticker; some say 30 seconds, some say 24 hours. A barista pours a random extra splash of time onto each sticker so they never all expire together.' },
      { locus: 'The overflowing pastry case', concept: 'Eviction (LRU vs LFU)', image: 'The case is full. One assistant removes whatever pastry was touched least recently (LRU); another counts the tally marks under each and keeps the croissant everyone buys, even if nobody bought one this hour (LFU). A tour bus that samples every pastry once wrecks the first assistant\'s system.' },
      { locus: 'The order window', concept: 'Cache-aside vs read-through', image: 'At one window the customer checks the chalkboard, and if the drink is missing, walks to the kitchen and then writes it on the board themselves (cache-aside). At the other window a waiter does the trip for you (read-through).' },
      { locus: 'The payment counter', concept: 'Write-through vs write-back', image: 'One cashier records every sale in the ledger and the till at the same instant, slow but exact (write-through). The other scribbles sales on a napkin and enters them in the ledger every ten minutes; a gust of wind blows the napkin away (write-back loss).' },
      { locus: 'The whiteboard tug-of-war', concept: 'Invalidation races', image: 'Two staff race to update the price of a latte. One erases, the other rewrites the old price a second later. The manager shouts "ERASE, do not rewrite!" and sets a timer to erase again in a moment.' },
      { locus: 'The front door at opening time', concept: 'Thundering herd', image: 'The board is wiped at exactly 8:00 and a thousand customers stampede through the door at once, all demanding the same drink from a single barista. A steward lets one person order and hands everyone else yesterday\'s cup while they wait.' },
    ],
  },
  interviewQuestions: [
    'What is a cache and what are the costs of adding one?',
    'Explain cache-aside, read-through, write-through and write-back with a use case for each.',
    'How do you choose a TTL, and what is the effect of TTL on hit ratio and staleness?',
    'Compare LRU and LFU eviction. When does LRU fail badly?',
    'Why is cache invalidation hard? Describe a concrete race and how you would mitigate it.',
    'What is a thundering herd and how do you prevent it?',
    'How would you handle repeated requests for keys that do not exist in the database?',
    'Your cache cluster goes down. What happens to the database, and how would you design for that?',
  ],
}

export default chapter
