import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 12,
  slug: 'caching-at-different-levels',
  title: 'Caching At Different Levels',
  module: 'caching',
  estimatedMinutes: 40,
  summary:
    'A request can be answered from a cache at many points on its journey: the browser, a CDN edge, a reverse proxy, the application process, a shared Redis cluster, the database buffer pool, or the operating system page cache. This chapter walks the whole ladder, explains what each level is good at, what it costs in staleness and complexity, and gives you a framework for deciding where a given piece of data should be cached.',
  objectives: [
    'Name the seven caching levels between a user and a disk and state the latency and scope of each.',
    'Read and write HTTP cache headers (Cache-Control, ETag, Vary) to control browser and CDN behaviour.',
    'Choose between an in-process cache and a distributed cache for a given piece of data, and justify the choice.',
    'Explain what a database buffer pool and the OS page cache do and why the query cache was removed from MySQL.',
    'Apply a decision framework (personalisation, change rate, hotness, blast radius of staleness) to pick a cache level.',
  ],
  quickRevision: [
    'Cache ladder from user to disk: browser -> CDN -> reverse proxy/LB -> in-process -> distributed (Redis) -> DB buffer pool -> OS page cache.',
    'The closer to the user a cache sits, the lower the latency and the harder it is to invalidate.',
    'Cache-Control: max-age controls freshness; no-store forbids caching; private restricts to the browser; public allows shared caches such as CDNs.',
    'ETag + If-None-Match lets a client revalidate cheaply: a 304 Not Modified carries no body.',
    'CDNs cache by cache key (URL + selected headers); a wrong Vary header or a query-string cache-buster destroys the hit ratio.',
    'Micro-caching (TTL of 1-5 s) at Nginx or Varnish collapses thundering herds on hot dynamic pages.',
    'In-process caches (Caffeine, Guava, a Go map) cost ~100 ns per hit but are duplicated and inconsistent per instance.',
    'Distributed caches (Redis, Memcached) cost ~0.3-1 ms per hit but are shared, so one invalidation is visible to every instance.',
    'A common pattern is L1 in-process (tiny TTL) in front of L2 Redis in front of the database.',
    'Postgres shared_buffers and MySQL InnoDB buffer pool cache data pages; if the working set fits in RAM the DB rarely touches disk.',
    'MySQL removed its query cache in 8.0 because a single global lock and invalidate-on-any-write made it a bottleneck.',
    'The OS page cache means a "disk read" is often a memory copy; the DB and OS may double-cache the same page.',
    'Cache public, rarely-changing, hot data near the user; cache personalised, fast-changing data near the data.',
    'Every extra cache level multiplies the invalidation problem; the question is not "should we cache" but "at which level, with what staleness budget".',
  ],
  sections: [
    {
      id: 'the-cache-ladder',
      title: 'The cache ladder: where a request can stop',
      body: `Think about a single GET for a product page. It leaves the phone, crosses the internet, enters your data centre, hits an application server, which queries a database that reads from disk. At every hop there is an opportunity to answer the request without going further. That is what "caching at different levels" means: each level is a place where the journey can end early.

From the user inward the levels are:

1. **Client / browser cache** - the response never leaves the device. Latency: ~0 ms.
2. **CDN edge** - a point of presence a few milliseconds from the user. Latency: 5-30 ms.
3. **Reverse proxy / load balancer cache** - Nginx, Varnish or an API gateway in your data centre. Latency: ~1 ms plus the network to your DC.
4. **In-process application cache** - a map in the memory of the service. Latency: ~100 ns.
5. **Distributed cache** - Redis or Memcached shared by all instances. Latency: 0.3-1 ms.
6. **Database caches** - the buffer pool holding hot pages in RAM. Latency: microseconds instead of a disk seek.
7. **OS page cache and disk caches** - the kernel keeping recently read file blocks in memory.

Two things change as you move inward. **Scope widens**: a browser cache serves one user; Redis serves every instance; the buffer pool serves every query. **Freshness gets easier**: invalidating a Redis key is one command; invalidating a browser cache on a million phones is impossible, so you must rely on TTLs and versioned URLs.

The design task is to place each kind of data at the outermost level where its staleness is acceptable. Public images belong at the edge with a one-year TTL. A user's cart belongs in Redis or nowhere. The rest of the chapter takes each level in turn.`,
      mentalModel:
        'A request is a customer walking into a shop asking a question. The doorman (browser) might answer. If not, the receptionist (CDN), then the floor manager (proxy), then the clerk (app), then the shared filing cabinet (Redis), then the archive room (database) and finally the basement (disk). Each answer from a closer person is faster but more likely to be out of date.',
      diagram: `User
 |  browser cache        ~0 ms     scope: one user
 v
[CDN edge]               5-30 ms   scope: one region
 |
 v
[LB / reverse proxy]     ~1 ms     scope: one data centre
 |
 v
[App instance]           ~100 ns   scope: one process
 |  in-process cache
 v
[Redis / Memcached]      ~0.5 ms   scope: all instances
 |
 v
[DB buffer pool]         ~10 us    scope: all queries
 |
 v
[OS page cache -> disk]  50 us - 10 ms`,
      keyPoints: [
        'Seven levels: browser, CDN, reverse proxy, in-process, distributed, DB buffer pool, OS/disk cache.',
        'Moving outward lowers latency but shrinks scope and makes invalidation harder.',
        'Moving inward widens scope and makes invalidation a single command.',
        'Place each piece of data at the outermost level whose staleness you can tolerate.',
      ],
      checkpoint: {
        question:
          'A logged-in user\'s notification count changes every few seconds and is different for every user. Which levels are clearly wrong for caching it, and which is the first plausible one?',
        answer:
          'CDN and shared reverse-proxy caches are wrong: the value is per-user and changes constantly, so a shared cache would leak one user\'s data to another or be stale immediately. The browser could hold it for a couple of seconds at most. The first solid candidate is a distributed cache such as Redis keyed by user id, refreshed on write, because a single invalidation is visible to every app instance.',
      },
    },
    {
      id: 'client-and-browser-cache',
      title: 'Client and browser caching with HTTP headers',
      body: `The browser cache is the cheapest cache you will ever have: it costs you nothing to run and a hit has zero network latency. You control it entirely through HTTP response headers.

**Cache-Control** is the main dial.
- \`max-age=31536000\` - the response is fresh for one year. Used with **versioned file names** (\`app.3f9c2a.js\`) so that a new deploy produces a new URL and the old cache is simply never asked again. This is how every modern front-end ships assets.
- \`no-cache\` - the browser may store it but must **revalidate** with the server before reuse.
- \`no-store\` - never write it to disk. Use for bank statements and anything under a privacy regime.
- \`private\` vs \`public\` - private means only the end user's browser may cache it; public allows shared caches (CDN, proxies). A personalised HTML page must be private.
- \`stale-while-revalidate=60\` - serve the stale copy instantly and refresh in the background. Great for latency on rarely-changing API responses.

**Revalidation** is the second mechanism. The server sends an **ETag** (a hash or version of the body) or **Last-Modified**. The client later sends \`If-None-Match: "<etag>"\`. If nothing changed the server answers **304 Not Modified** with an empty body. You still pay a round trip, but not the bytes, which for a 2 MB JSON payload on a mobile network is the difference between 20 ms and 2 s.

Mobile apps do the same by hand: SQLite or a key-value store on the device holding the last feed, shown instantly while a refresh happens. Service workers let web apps do offline-first in the same spirit.

**Why not always cache in the client?** Because you cannot reach into a device to invalidate. If a price is cached for an hour and you cut it, users see the old price for an hour and you have no lever. Client caching is therefore for immutable or clearly TTL-bounded data.`,
      mentalModel:
        'The browser cache is a sticky note the shop hands the customer: "the answer is X, valid until Friday". After Friday the customer can phone and ask "still X?" (revalidation) instead of asking the whole question again.',
      keyPoints: [
        'Cache-Control max-age + versioned URLs is the standard way to cache static assets for a year.',
        'no-cache means revalidate; no-store means never persist; private blocks shared caches.',
        'ETag / If-None-Match and 304 responses save bytes even when freshness has expired.',
        'stale-while-revalidate hides refresh latency from the user.',
        'Client caches cannot be invalidated remotely, so only cache what has a safe TTL or a versioned key.',
      ],
      checkpoint: {
        question:
          'You deploy a new JavaScript bundle at the same URL /static/app.js with Cache-Control: max-age=86400. What goes wrong and what is the fix?',
        answer:
          'Users who loaded the site in the last 24 hours keep running the old bundle against the new backend for up to a day, causing API mismatches. Fix: put a content hash in the file name (app.9d1e.js) and reference it from an HTML page served with no-cache or a very short max-age. New deploy, new URL, no stale hits.',
      },
    },
    {
      id: 'cdn-edge-cache',
      title: 'CDN: caching at the edge of the internet',
      body: `A **Content Delivery Network** (Cloudflare, Akamai, CloudFront, Fastly) runs hundreds of points of presence (PoPs) worldwide. Your DNS points users at the nearest PoP; the PoP serves from its cache or fetches from your origin. A user in Mumbai hitting an origin in Virginia pays ~250 ms of round trip; a Mumbai PoP answers in 10 ms.

**What CDNs are great at.** Static assets (images, video segments, JS, CSS) and anything public and shared: a product image is the same bytes for everyone. Netflix, YouTube and every large e-commerce site push well over 90% of their bytes through a CDN; the origin sees only misses.

**The cache key.** By default the key is the URL. Two traps:
- A cache-busting query string (\`?t=1694000000\`) makes every request unique and the hit ratio collapses.
- The **Vary** header widens the key. \`Vary: Cookie\` on a page effectively disables caching, because every user has a different cookie. \`Vary: Accept-Encoding\` is fine (two variants: gzip and br).

**TTL and purge.** Static files get long TTLs plus versioned names. Semi-dynamic content (a news home page, a product listing) gets a short TTL (30-300 s) and an explicit **purge** API call when content changes. Fastly can purge globally in ~150 ms using surrogate keys (tags), which lets you invalidate "everything about product 42" in one call.

**Origin shield and request collapsing.** When a popular item expires, thousands of PoPs would all miss and stampede the origin. CDNs offer an intermediate "shield" PoP so only one request per object reaches you, and they collapse concurrent misses into a single origin fetch.

**Dynamic content at the edge.** Modern CDNs run code at the PoP (Cloudflare Workers, Lambda@Edge) to assemble personalised pages from cached fragments, or to cache API responses with \`Cache-Control: public, s-maxage=30\` (s-maxage applies to shared caches only).

**Costs.** Egress fees, a second place to debug ("is this stale at the edge?"), and the risk of leaking private data if you mark a personalised response public. Rule: never cache anything on a CDN that depends on who is asking unless the cache key includes that identity.`,
      mentalModel:
        'A CDN is a chain of neighbourhood kiosks stocked from one central warehouse. Everyone buys the same newspaper from the nearest kiosk; only the kiosk ever drives to the warehouse, and only when it runs out.',
      diagram: `   users (Mumbai)     users (London)     users (NYC)
        |                  |                 |
   [PoP Mumbai]       [PoP London]      [PoP NYC]     hit: 5-30 ms
        \\                 |                 /
         \\           [Origin shield]      /           one miss per object
          \\ ______________|______________/
                          |
                     [Your origin]   (Virginia)      miss: 100-300 ms`,
      keyPoints: [
        'CDN PoPs cut round-trip latency from hundreds of ms to tens and absorb the vast majority of bytes.',
        'The cache key is URL plus Vary headers; cache-busters and Vary: Cookie kill the hit ratio.',
        'Use long TTL + versioned names for static; short TTL + purge (surrogate keys) for semi-dynamic.',
        'Origin shield and request collapsing protect the origin from stampedes on expiry.',
        's-maxage controls shared caches separately from the browser max-age.',
        'Never mark a per-user response public.',
      ],
      checkpoint: {
        question:
          'Your CDN hit ratio for product images is only 40% even though the images rarely change. Name two likely causes.',
        answer:
          'Most likely: (1) the image URLs carry a changing query string or per-session token, so each request is a new cache key; (2) the origin sends a short max-age or Cache-Control: private / Vary: Cookie, forcing the CDN to revalidate or bypass. Less commonly, the long tail of images is so large that each PoP evicts them before reuse, which an origin shield helps with.',
      },
    },
    {
      id: 'reverse-proxy-cache',
      title: 'Reverse proxy and load balancer caching',
      body: `Between the CDN and your application sits a reverse proxy: Nginx, HAProxy, Envoy, Varnish, or an API gateway such as Kong. It is the last shared hop before your code runs, so it is a natural place to cache **whole HTTP responses** for the entire data centre.

**Why cache here when a CDN exists?** Three reasons. First, not everything goes through a CDN: internal APIs, service-to-service calls, and private deployments. Second, the proxy is under your full control: instant purge, custom cache keys, no egress fees. Third, it protects the application tier from the CDN's own misses, which can still be thousands per second across hundreds of PoPs.

**Micro-caching.** The most valuable trick at this level is a very short TTL, 1-5 seconds, on hot dynamic endpoints. Suppose a live cricket score API is hit 50,000 times per second. Caching the response for one second turns 50,000 backend calls into one, and nobody notices a score that is one second old. Nginx does this with \`proxy_cache_valid 200 1s\` plus \`proxy_cache_lock on\`, which makes concurrent misses wait for a single upstream fetch instead of stampeding (the same request-collapsing idea as the CDN).

**Varnish** is a dedicated HTTP cache with its own configuration language (VCL) that lets you rewrite cache keys, strip cookies for anonymous users, and do Edge Side Includes, where a mostly-static page embeds a small personalised fragment fetched separately.

**API gateways** add response caching per route, often keyed by path plus selected headers or the API key, which is how you give each tenant their own cached view.

**Limits.** Proxy caches understand HTTP, not your domain. They cannot cache "the result of this function"; only "the response to this URL". They are also per data centre: two regions hold independent caches. And exactly like the CDN, a response that varies by user must either include the user in the key or bypass the cache.

Trade-off summary: proxy caching gives you a shared, instantly purgeable cache with no code changes, at the cost of only working for cacheable HTTP semantics and adding one more layer that can serve stale data.`,
      mentalModel:
        'The reverse proxy cache is the receptionist who keeps the answer to the most common question on a whiteboard and rewrites it every second. Fifty people asking at once all read the whiteboard; only the receptionist walks back to ask.',
      keyPoints: [
        'Reverse proxies cache whole HTTP responses for the entire data centre, with instant purge.',
        'Micro-caching (1-5 s TTL) plus cache locking collapses thundering herds on hot endpoints.',
        'Varnish and API gateways add key rewriting, cookie stripping and per-tenant keys.',
        'Only HTTP-cacheable, non-personalised responses fit here unless identity is in the key.',
      ],
    },
    {
      id: 'in-process-cache',
      title: 'Application-level (in-process) caching',
      body: `Inside your service, the fastest cache is a data structure in the process's own heap: a Java \`ConcurrentHashMap\`, Caffeine or Guava cache, a Go \`sync.Map\`, a Python \`functools.lru_cache\`. A hit is a pointer dereference, roughly 100 nanoseconds, three to four orders of magnitude faster than a Redis round trip. There is no serialisation, no network, no extra infrastructure.

**What belongs here.** Data that is small, read extremely often, and either rarely changes or tolerates being a little stale per instance: configuration, feature flags, country and currency tables, compiled templates, the result of an expensive pure computation, the top 100 hottest product records. Also a **negative cache** of ids that do not exist, to stop repeated futile database lookups.

**The costs are structural, not performance.**

1. **Duplication.** Fifty instances hold fifty copies. A 500 MB cache becomes 25 GB of RAM across the fleet, and each instance still has to warm up on its own after a deploy.
2. **Inconsistency.** When a value changes, each instance discovers it independently when its own TTL expires. Two consecutive requests from one user, load-balanced to two instances, can see two different values. For a feature flag flipping over 30 seconds that is fine; for a price it is a support ticket.
3. **Memory pressure.** The cache competes with the application for heap; in garbage-collected runtimes a large cache means longer GC pauses. Always bound the size (Caffeine's \`maximumSize\` with W-TinyLFU eviction) rather than letting it grow.
4. **No cross-instance invalidation** unless you add one: a Redis pub/sub channel on which writers publish "key X changed" and every instance evicts locally. That works well and is how many teams get 99% of Redis's consistency at in-process speed.

**The L1/L2 pattern.** The standard compromise is a tiny in-process L1 with a TTL of a few seconds in front of a shared Redis L2 with a longer TTL, in front of the database. L1 absorbs the hottest keys and the burst; L2 provides fleet-wide consistency; the database is hit only on true misses.`,
      mentalModel:
        'An in-process cache is the note in your own pocket. Reading it is instant, but every colleague has their own pocket note, and when the fact changes each of them finds out separately.',
      diagram: `Request -> [App instance A]                    [App instance B]
             | L1 map (TTL 5s) ~100 ns              | L1 map
             | miss                                 | miss
             v                                      v
           [ Redis L2 (TTL 10 min) ]  ~0.5 ms, shared by A and B
             | miss
             v
           [ Database ]
Writer: UPDATE db -> DEL redis key -> PUBLISH "invalidate key" -> A,B evict L1`,
      keyPoints: [
        'In-process hits cost ~100 ns; no network, no serialisation, no infrastructure.',
        'Costs: duplicated memory, per-instance inconsistency, GC pressure, cold start per instance.',
        'Always bound the size and use a good eviction policy (LRU, W-TinyLFU).',
        'Use pub/sub invalidation or a short TTL to keep instances roughly aligned.',
        'L1 in-process + L2 Redis + DB is the standard layered pattern.',
      ],
      checkpoint: {
        question:
          'A team caches user permission sets in-process with a 10-minute TTL to avoid Redis calls. An admin revokes a user\'s access. What is the worst case and how would you fix it without giving up the local cache?',
        answer:
          'Worst case the revoked user keeps access for up to 10 minutes on every instance that had them cached, and different instances deny or allow inconsistently. Fix: on revoke, write to the DB, delete the Redis key, and publish an invalidation message on a channel every instance subscribes to so each evicts the local entry immediately; keep the TTL as a safety net. Alternatively cache with a TTL of a few seconds only.',
      },
    },
    {
      id: 'distributed-cache',
      title: 'Distributed caching with Redis and Memcached',
      body: `A distributed cache is a separate tier of memory servers shared by every application instance. Redis and Memcached dominate. A hit costs a network round trip inside the data centre, typically 0.3-1 ms, plus serialisation, but in exchange the cache is **one logical place**: write a key once and every instance sees it; delete it once and every instance misses.

**Why it is the workhorse level.** It sits at the boundary between "things the application knows" and "things the database knows", so it can cache exactly what your code needs: a user object, a rendered feed, a session, a rate-limit counter, a computed leaderboard. Redis adds data structures (hashes, sorted sets, sets, streams) so you cache *structures*, not just blobs: ZINCRBY on a sorted set gives you a live leaderboard with no database at all.

**Scaling it.** A single Redis node handles roughly 100k-200k simple operations per second and is limited by one core and its RAM. Beyond that you shard by key. Redis Cluster uses 16,384 hash slots spread across nodes; Memcached clients use consistent hashing so adding a node moves only 1/N of the keys. Read replicas take read load; Sentinel or Cluster handles failover.

**Failure modes to design for.**
- **Hot keys.** A celebrity's profile or a flash-sale item can concentrate 30% of traffic on one shard. Mitigations: an in-process L1 in front, or replicate the key under several suffixes (\`item:42:0\` .. \`item:42:9\`) and read a random one.
- **Cache stampede on expiry.** Use per-request locks, probabilistic early refresh, or stale-while-revalidate semantics in your client.
- **Big keys.** A 50 MB value blocks the single-threaded Redis event loop for everyone; split or compress.
- **Cache down = database overload.** If Redis fails and 95% of reads that used to hit it fall on the database, the database dies too. Treat the cache as critical infrastructure with replicas, and consider load shedding when the hit ratio collapses.

**Memcached vs Redis.** Memcached is multi-threaded, simpler, and slightly more memory-efficient for pure string caching. Redis offers data structures, persistence, replication, Lua scripting, pub/sub and streams. Most teams pick Redis for flexibility; Facebook-scale pure key-value caching still uses Memcached.

**When not to use it.** When the data is small and static enough for an in-process cache (why pay 0.5 ms for a country list?) or when the request pattern is so uniform that the database buffer pool already serves it from RAM.`,
      mentalModel:
        'Redis is the shared filing cabinet in the middle of the office. Walking to it takes a few seconds (the network hop) but everyone reads the same file, and when someone updates it, the old version is gone for everybody at once.',
      keyPoints: [
        'Shared across all instances: one write or delete is visible everywhere; cost is ~0.5 ms per hit.',
        'Redis data structures let you cache computed structures (leaderboards, counters, sessions), not just blobs.',
        'Scale by sharding keys (Redis Cluster hash slots, consistent hashing) and adding read replicas.',
        'Design for hot keys, stampedes, big keys, and the database overload that follows a cache outage.',
        'Memcached: simple, multi-threaded strings. Redis: rich structures, persistence, replication.',
      ],
    },
    {
      id: 'database-and-os-caches',
      title: 'Database buffer pools, query caches and the OS page cache',
      body: `Even with no cache of your own, the database is caching furiously. Understanding this tells you when an extra cache tier is redundant and when it is essential.

**The buffer pool.** Postgres (\`shared_buffers\`) and MySQL InnoDB (\`innodb_buffer_pool_size\`) keep recently used **data and index pages** in RAM. A query whose pages are all in the pool never touches disk: the cost is CPU and a few microseconds of memory access. A page miss costs a disk read: 50-100 us on NVMe, 5-10 ms on spinning disk. The single most impactful sizing decision for a database is whether the **working set** (the pages actually touched in a typical hour) fits in the buffer pool. If it does, your "read from database" is already a memory read, and a Redis layer buys you mostly network savings and reduced CPU on the primary, not orders of magnitude.

**The query cache and why MySQL removed it.** MySQL 5.x had a cache mapping exact query text to result sets. It sounded ideal and was a disaster at scale: a single global mutex serialised every query's lookup, and **any write to a table invalidated every cached result touching that table**. On a busy OLTP system the cache was thrashing constantly and the lock was a bottleneck, so MySQL 8.0 deleted it. The lesson generalises: caching *results* inside the database is wrong because the database cannot know your staleness budget; a result cache belongs in the application tier where you decide the TTL.

**Materialised views** are the sane version of a result cache: a precomputed table you refresh on your own schedule (Postgres \`REFRESH MATERIALIZED VIEW CONCURRENTLY\`).

**The OS page cache.** Below the database, Linux keeps recently read file blocks in free RAM. Postgres deliberately relies on it: a common recommendation is shared_buffers at 25% of RAM, letting the page cache hold more. InnoDB instead uses \`O_DIRECT\` to bypass the page cache and avoid holding the same page twice. Kafka goes to the other extreme and uses almost no application memory, trusting the page cache entirely, which is why a Kafka broker with 32 GB of RAM can serve recent messages without touching disk.

**Disk caches.** SSDs and RAID controllers have their own DRAM write caches. A database's durability guarantee depends on them being battery-backed or on fsync actually reaching persistent media; a lying disk cache is a classic cause of "committed" data vanishing after a power loss.

Design implication: measure buffer pool hit ratio (Postgres \`pg_stat_database.blks_hit / (blks_hit + blks_read)\`) before adding a cache. Below ~99% on a read-heavy workload, first check whether more RAM or better indexes fix it.`,
      mentalModel:
        'The buffer pool is the archive clerk keeping the most-requested folders on their desk instead of in the basement. The OS page cache is the trolley of folders parked in the corridor. Both are invisible to the customer and both are why the "slow archive" is usually not slow at all.',
      diagram: `SQL query
   |
   v
[Buffer pool: hot data + index pages in RAM]   hit: ~10 us
   | miss
   v
[OS page cache: recently read file blocks]     hit: ~50 us (copy)
   | miss                                       (InnoDB bypasses with O_DIRECT)
   v
[Disk controller / SSD DRAM cache]
   |
   v
[Persistent media]                             NVMe ~100 us, HDD ~5-10 ms`,
      keyPoints: [
        'Buffer pools cache data and index pages; if the working set fits in RAM, reads are already memory reads.',
        'MySQL removed its query cache because of a global lock and invalidate-on-any-write thrashing.',
        'Result caching belongs in the application tier or in materialised views you refresh deliberately.',
        'Postgres leans on the OS page cache; InnoDB bypasses it with O_DIRECT; Kafka relies on it entirely.',
        'Check the buffer pool hit ratio before adding a cache tier; RAM and indexes may be the real fix.',
      ],
      checkpoint: {
        question:
          'A read-heavy Postgres database has a 99.8% buffer cache hit ratio and 40% CPU. The team wants to add Redis to "make reads faster". What will Redis actually change, and is it worth it?',
        answer:
          'Reads are already served from RAM, so per-query latency will improve mainly by removing query parsing, planning and execution CPU, and the network to the DB, perhaps from 2 ms to 0.5 ms. The bigger win is offloading CPU from the primary so it can absorb growth. It is worth it if the DB CPU is the scaling limit or if the same objects are read many times; it is not worth the staleness and operational cost just to shave a millisecond.',
      },
    },
    {
      id: 'choosing-the-level',
      title: 'Deciding where to cache: a framework',
      body: `With seven levels available, the design question is placement. Four properties of the data decide it.

**1. Who is it for?** Public data (product images, a public profile, an article) can live at any level, including the CDN. Personalised data (cart, inbox, recommendations) can only live in caches keyed by identity: the user's own browser, or Redis / in-process keyed by user id. Never in a shared cache without identity in the key.

**2. How often does it change, and how bad is staleness?** Immutable content (a versioned asset, a sent message) gets a year at the edge. Content changing hourly gets minutes. Content changing per second gets micro-caching or no caching. Ask "what is the cost of a user seeing a value N seconds old?" A stale like-count costs nothing; a stale account balance costs trust; a stale inventory count costs an oversell, which is a business decision, not a caching one.

**3. How hot is it?** A key read 10,000 times per second belongs as close to the user as its personalisation allows, and probably at two levels (L1 + L2). A key read once a minute does not deserve a cache at all: the buffer pool already has it.

**4. How large is the blast radius of a wrong answer?** A CDN misconfiguration serves the wrong data to everyone in a region and cannot be fixed instantly. An in-process bug affects one instance for one TTL. Higher blast radius demands shorter TTLs and explicit purge paths.

**Putting it together.**
- Public + rarely changes + hot -> CDN with long TTL and versioned URLs (images, JS, video).
- Public + changes every few seconds + very hot -> reverse proxy micro-cache (scores, home page).
- Small + read on every request + changes rarely -> in-process (config, flags, lookups).
- Per-user or computed + hot + must be consistent across instances -> Redis (sessions, feeds, counters).
- Everything else -> rely on the database buffer pool, and add indexes or RAM before caches.

**The multiplication problem.** Every level you add is another place a stale value can hide. A price cached at CDN (60 s), proxy (5 s), L1 (5 s) and Redis (10 min) has a worst-case staleness of the sum, and debugging "why does this user see the old price" now means checking four systems. Add levels deliberately, document the TTL at each, and build one purge tool that clears all of them for a given entity.`,
      mentalModel:
        'Placing a cache is like deciding where to keep a spare key. Under the doormat (CDN) is convenient for everyone, including strangers. In your pocket (browser) is fastest but only helps you. In the office safe (Redis) is shared with people you trust and can be changed in one place.',
      keyPoints: [
        'Four questions: who is it for, how often does it change, how hot is it, how big is the blast radius of staleness.',
        'Public + static + hot -> CDN. Public + dynamic + very hot -> micro-cache. Small + universal -> in-process. Per-user + shared -> Redis.',
        'Cold or uniform data does not need a cache; the buffer pool already has it.',
        'Staleness across levels adds up; build a single purge path per entity.',
      ],
      checkpoint: {
        question:
          'Place each of these at a cache level and give the TTL: (a) a 4 MB hero image, (b) the homepage "trending now" list refreshed every minute, (c) the currency conversion table updated daily, (d) a user\'s shopping cart.',
        answer:
          '(a) CDN, versioned URL, max-age 1 year. (b) Reverse proxy or CDN with s-maxage 30-60 s plus purge on refresh; it is public and very hot. (c) In-process with a 5-15 minute TTL or an invalidation message on update; it is tiny and read on every price render. (d) Redis keyed by user id (or the DB), no shared HTTP cache; it is per-user and changes on every click.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Which Cache-Control directive tells browsers and CDNs that a response must never be written to any cache?',
      options: ['no-cache', 'private', 'no-store', 'max-age=0'],
      answerIndex: 2,
      explanation:
        'no-store forbids storing the response anywhere. no-cache is the tempting wrong answer: it allows storing but requires revalidation before reuse. private only restricts caching to the end user\'s browser, and max-age=0 marks it stale immediately but still cacheable.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'Roughly how much faster is an in-process cache hit than a Redis hit inside the same data centre?',
      options: ['About 2x', 'About 10x', 'About 1,000-10,000x', 'They are the same; both are in memory'],
      answerIndex: 2,
      explanation:
        'An in-process hit is a memory dereference (~100 ns); a Redis hit is a network round trip plus serialisation (~0.3-1 ms). Both are "in memory" but the network hop dominates, so the gap is three to four orders of magnitude.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'A personalised dashboard HTML page is accidentally served with Cache-Control: public, max-age=300 through a CDN. What is the most serious consequence?',
      options: [
        'The page loads slightly slower for everyone',
        'One user\'s private dashboard is served to other users hitting the same URL for up to 5 minutes',
        'The CDN refuses to cache HTML',
        'The origin receives more traffic',
      ],
      answerIndex: 1,
      explanation:
        'public allows shared caches to store the response under the URL key, so the next user requesting that URL from the same PoP receives the first user\'s personal data. This is a data leak, far worse than any latency effect. Personalised responses must be private or include identity in the cache key.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 2,
      question: 'Why did MySQL remove the query cache in version 8.0?',
      options: [
        'It used too much disk space',
        'A global lock and invalidation of all cached results on any write to a table made it a bottleneck under OLTP load',
        'Redis replaced it as an official component',
        'It returned incorrect results for JOIN queries',
      ],
      answerIndex: 1,
      explanation:
        'The query cache was protected by a single mutex and any write invalidated every cached result for the touched table, so on write-heavy systems it thrashed and serialised queries. Result caching moved to the application tier where staleness can be controlled. It never used disk and had no correctness bug with joins.',
    },
    {
      type: 'multi',
      id: 'q5',
      difficulty: 2,
      question: 'Which of these are legitimate costs of an in-process (local) cache compared to a distributed cache? Select all that apply.',
      options: [
        'Each instance holds its own copy, multiplying memory use',
        'Instances can hold different values for the same key at the same time',
        'A hit requires a network round trip',
        'A large cache increases garbage-collection pauses in managed runtimes',
        'Every instance must warm up independently after a deploy',
      ],
      answerIndices: [0, 1, 3, 4],
      explanation:
        'Duplication, per-instance inconsistency, GC pressure and cold starts are the real costs of local caching. A network round trip is the cost of the distributed cache, not the local one; the local hit is the fast path.',
    },
    {
      type: 'truefalse',
      id: 'q6',
      difficulty: 2,
      statement: 'If a database\'s working set fits entirely in its buffer pool, adding a Redis cache in front of it will typically not reduce read latency by orders of magnitude.',
      answer: true,
      explanation:
        'With a high buffer pool hit ratio the database already serves reads from RAM in a few milliseconds; Redis saves query parsing, planning and DB network but not a disk seek, so the gain is a few milliseconds and mainly CPU offload, not 100x. The 100x wins come when the database is disk-bound.',
    },
    {
      type: 'truefalse',
      id: 'q7',
      difficulty: 1,
      statement: 'A 304 Not Modified response includes the full response body so the browser can compare it with its cached copy.',
      answer: false,
      explanation:
        'A 304 has no body; that is the entire point. The client sent If-None-Match with its ETag, the server confirmed nothing changed, and the client reuses its cached body. You pay the round trip but not the bytes.',
    },
    {
      type: 'mcq',
      id: 'q8',
      difficulty: 3,
      question: 'A live-score API is hit 40,000 times per second by anonymous users and its response changes every few seconds. Which single caching decision gives the largest backend relief with negligible user impact?',
      options: [
        'Cache the response in each user\'s browser for 10 minutes',
        'Micro-cache the response at Nginx/CDN for 1 second with request collapsing',
        'Store scores in an in-process cache with a 1-hour TTL',
        'Disable caching so scores are always exact',
      ],
      answerIndex: 1,
      explanation:
        'A one-second shared cache turns 40,000 requests into roughly one backend call per second, and a one-second-old score is imperceptible. Browser caching for 10 minutes makes scores badly stale; an hour-long in-process TTL is worse; no caching leaves the backend to absorb 40k QPS for identical answers.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'A product\'s price is cached at four levels: CDN (60 s), reverse proxy (5 s), in-process L1 (5 s), Redis (600 s). The price changes. Without explicit purges, what is the worst-case time before every user sees the new price?',
      options: ['60 seconds', '600 seconds', 'About 670 seconds', 'Immediately, because Redis is authoritative'],
      answerIndex: 2,
      explanation:
        'Staleness across chained caches adds up in the worst case: the proxy may refresh from a stale L1 which refreshed from a stale Redis, and the CDN then caches that for another 60 s. 600 + 5 + 5 + 60 = 670 s. This is why multi-level caching needs one purge tool that clears every level for an entity.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'Your CDN hit ratio for a product image endpoint is poor. Which header is most likely to be the culprit if it is present on the origin response?',
      options: ['Vary: Accept-Encoding', 'Vary: Cookie', 'ETag', 'Content-Type: image/webp'],
      answerIndex: 1,
      explanation:
        'Vary: Cookie makes every distinct cookie value a separate cache entry, so nearly every request misses. Vary: Accept-Encoding only produces a couple of variants (gzip, br) and is normal. ETag helps revalidation and Content-Type is irrelevant to the key.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design the caching for a news site home page that is public, updated by editors a few times an hour, and receives 20,000 requests per second at peak. Name the level(s), TTLs and how you handle an editor publishing a correction.',
      modelAnswer: `**Levels.** CDN edge with \`Cache-Control: public, s-maxage=60, stale-while-revalidate=30\` so PoPs serve instantly and refresh in the background; behind it an Nginx/Varnish micro-cache (2-5 s with cache lock) to protect the origin from the CDN's misses across hundreds of PoPs; the browser gets \`max-age=0, no-cache\` or a few seconds so a reload always revalidates. Static assets referenced by the page are versioned with a one-year TTL.

**Correction path.** The CMS publish hook calls the CDN purge API using a surrogate key such as \`page:home\` (Fastly purges globally in well under a second) and the proxy purge endpoint. Editors see the change within seconds without waiting for the 60 s TTL.

**Numbers.** 20k QPS at a 98% edge hit ratio leaves ~400 QPS reaching the shield; the 2 s micro-cache reduces origin renders to roughly one every couple of seconds per variant.

**Personalisation.** Any logged-in fragment (name, saved articles) is loaded by a separate authenticated XHR marked private, or assembled client side, so the page itself stays fully public and cacheable.`,
      rubric: [
        'Uses a CDN with a short shared TTL (tens of seconds) and distinguishes s-maxage from browser max-age.',
        'Adds an origin-side micro-cache or origin shield to absorb CDN misses.',
        'Describes an explicit purge on publish (surrogate keys / tags) rather than waiting for TTL.',
        'Keeps personalised fragments out of the shared cache.',
        'Gives a rough estimate of origin load after caching.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question:
        'Explain the L1/L2 caching pattern (in-process plus Redis) and how you keep the L1 consistent when the underlying data changes.',
      modelAnswer: `**Pattern.** Each app instance keeps a small, size-bounded in-process cache (L1) with a short TTL of a few seconds. On miss it reads a shared Redis cache (L2) with a longer TTL, and on L2 miss it reads the database and populates both. L1 absorbs the hottest keys at ~100 ns and protects Redis from hot-key concentration; L2 gives every instance the same view and takes the bulk of misses off the database.

**Consistency.** On write: update the database, delete (not update) the Redis key, then publish an invalidation message on a Redis pub/sub channel (or Kafka topic) that every instance subscribes to; each instance evicts the key from its L1. The short L1 TTL is a safety net for missed messages. This bounds staleness to roughly the propagation delay of the invalidation, typically milliseconds, while keeping the speed of local reads.`,
      rubric: [
        'Describes L1 as small, bounded, short TTL and L2 as shared Redis with longer TTL.',
        'Explains why L1 helps (latency, hot keys) and why L2 helps (shared view, DB offload).',
        'Describes an invalidation mechanism: delete L2 key plus pub/sub eviction of L1.',
        'Mentions TTL as a fallback for missed invalidations.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 2,
      question: 'What does a database buffer pool cache, and what single metric tells you whether adding more RAM would help a read-heavy database?',
      modelAnswer: `The buffer pool (Postgres shared_buffers, InnoDB buffer pool) caches **data pages and index pages** in RAM so that repeated reads never go to disk. It does not cache query results.

The key metric is the **buffer cache hit ratio**: hits / (hits + disk reads), for example from Postgres \`pg_stat_database.blks_hit\` and \`blks_read\`, or InnoDB's \`Innodb_buffer_pool_read_requests\` vs \`Innodb_buffer_pool_reads\`. On a read-heavy OLTP system you want above ~99%. A ratio well below that means the working set does not fit; more RAM (or narrower indexes, or archiving cold data) will help directly. A ratio already at 99.9% means reads are memory-bound and an external cache buys CPU offload and network savings rather than disk avoidance.`,
      rubric: [
        'States that pages (data and index), not results, are cached.',
        'Names the buffer cache hit ratio and how to compute it.',
        'Gives a target (~99%) and interprets high vs low values.',
        'Mentions alternatives to RAM such as better indexes or archiving.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'The seven cache levels from user to disk', back: 'Browser -> CDN edge -> reverse proxy/LB -> in-process -> distributed (Redis/Memcached) -> DB buffer pool -> OS page cache / disk cache.' },
    { id: 'f2', front: 'Cache-Control: no-cache vs no-store', back: 'no-cache: may store, must revalidate before reuse. no-store: never persist anywhere (sensitive data).' },
    { id: 'f3', front: 'Cache-Control: private vs public', back: 'private: only the end user\'s browser may cache. public: shared caches (CDN, proxies) may cache too. Personalised responses must be private.' },
    { id: 'f4', front: 'ETag / If-None-Match flow', back: 'Server sends ETag. Client later sends If-None-Match. If unchanged, server returns 304 Not Modified with no body; client reuses cached copy.' },
    { id: 'f5', front: 'How to cache static assets for a year safely', back: 'Content-hashed file names (app.9d1e.js) with max-age=31536000; the HTML that references them uses no-cache or a short TTL.' },
    { id: 'f6', front: 'What decides a CDN cache key', back: 'The URL (including query string) plus any headers named in Vary. Cache-busting query strings and Vary: Cookie destroy hit ratio.' },
    { id: 'f7', front: 's-maxage', back: 'Freshness lifetime for shared caches (CDN, proxy) only; overrides max-age there. Lets the CDN cache longer or shorter than the browser.' },
    { id: 'f8', front: 'Micro-caching', back: 'Caching a hot dynamic response at Nginx/Varnish/CDN for 1-5 s with request collapsing, turning tens of thousands of QPS into ~1 origin call per second.' },
    { id: 'f9', front: 'Origin shield', back: 'An intermediate CDN layer so that many PoPs missing the same object produce one origin fetch instead of hundreds.' },
    { id: 'f10', front: 'In-process cache: latency and main costs', back: '~100 ns per hit. Costs: memory duplicated per instance, per-instance inconsistency, GC pressure, cold start after deploy, no built-in cross-instance invalidation.' },
    { id: 'f11', front: 'Distributed cache: latency and main benefit', back: '~0.3-1 ms per hit. One logical cache: a single write or delete is visible to every instance.' },
    { id: 'f12', front: 'L1/L2 cache pattern', back: 'Small in-process L1 (seconds TTL) -> shared Redis L2 (minutes TTL) -> DB. Invalidate by deleting the Redis key and publishing an eviction message to all instances.' },
    { id: 'f13', front: 'Hot key mitigations in Redis', back: 'In-process L1 in front; replicate the key under N suffixes and read a random one; move the hottest keys to a dedicated shard.' },
    { id: 'f14', front: 'Database buffer pool', back: 'RAM cache of data and index pages (Postgres shared_buffers, InnoDB buffer pool). If the working set fits, reads never hit disk. Target hit ratio > 99%.' },
    { id: 'f15', front: 'Why MySQL 8.0 removed the query cache', back: 'A single global mutex plus invalidation of all results on any write to a table made it thrash and serialise queries under OLTP load.' },
    { id: 'f16', front: 'OS page cache and databases', back: 'Kernel caches file blocks in free RAM. Postgres relies on it (shared_buffers ~25% RAM); InnoDB bypasses it with O_DIRECT; Kafka depends on it almost entirely.' },
    { id: 'f17', front: 'Four questions for choosing a cache level', back: 'Who is it for (public/personal)? How often does it change and how bad is staleness? How hot is it? How big is the blast radius of a wrong answer?' },
    { id: 'f18', front: 'Staleness across chained caches', back: 'Worst case is the sum of TTLs at every level (CDN + proxy + L1 + L2). Build one purge tool that clears all levels for an entity.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Why cache at multiple levels',
      prompt: 'Explain to a junior developer why a request might be answered from a cache in seven different places, and what changes as you move from the browser toward the disk.',
      modelExplanation: `Imagine a request as a question travelling from a phone to a hard disk. At every stop along the way, someone might already know the answer. The browser might have it from last time. The CDN server in the user's city might have it because someone nearby asked. The proxy in front of your servers might have it from a second ago. Your application process might have it in memory. Redis, which all your servers share, might have it. Even the database keeps hot pages in RAM so it does not read the disk.

As you move outward toward the user, answers get faster: zero milliseconds in the browser, tens at the CDN, sub-millisecond in Redis. But they also get harder to correct, because a browser cache on a million phones cannot be told "forget that". As you move inward, the cache is shared by more people and a single delete fixes everyone. So the job is to push each piece of data as far out as you can while still being able to live with how stale it might get.`,
      mustMention: [
        'Lists several distinct levels (browser, CDN, proxy, in-process, Redis, buffer pool)',
        'Latency decreases toward the user',
        'Invalidation gets harder toward the user, easier toward the data',
        'Place data at the outermost level whose staleness is acceptable',
      ],
    },
    {
      id: 'fe2',
      concept: 'HTTP cache headers',
      prompt: 'Explain Cache-Control, ETag and 304 responses to someone who has only ever set a TTL in Redis.',
      modelExplanation: `In Redis you set a TTL and the key disappears. HTTP does the same with the Cache-Control header, but the "key" lives in the user's browser or in a CDN, so you describe the rules in the response and they follow them. \`max-age=3600\` says "this is good for an hour". \`no-store\` says "never keep this". \`private\` says "only the user's own browser may keep it, not a shared CDN", which is essential for anything personal.

HTTP adds one thing Redis lacks: cheap revalidation. The server can attach an ETag, a fingerprint of the content. When the hour is up, the browser does not re-download; it asks "I have version abc123, is that still current?" If yes, the server replies 304 Not Modified with an empty body, and the browser reuses what it has. You pay one small round trip instead of the whole payload. For static files we go further and put the fingerprint in the file name, set max-age to a year, and simply change the name when the content changes.`,
      mustMention: [
        'max-age controls freshness lifetime',
        'no-store and private and what they protect',
        'ETag / If-None-Match revalidation producing a 304 with no body',
        'Versioned file names to make long TTLs safe',
      ],
    },
    {
      id: 'fe3',
      concept: 'In-process vs distributed cache',
      prompt: 'Explain when you would cache inside the application process and when you would use Redis, with the trade-off in each direction.',
      modelExplanation: `An in-process cache is a map inside your running service. Reading it is basically free, a hundred nanoseconds, because there is no network. But every copy of your service has its own map. If you run fifty instances you have fifty caches that fill up separately, use fifty times the memory, and can disagree with each other: after a change, each one keeps its old value until its own timer expires.

Redis is a separate cache server that all fifty instances share. Reading it costs a network trip, about half a millisecond, thousands of times slower than local memory but still far faster than most database queries. The payoff is that there is one copy: delete a key once and everybody misses at the same time.

So: tiny, universal, slow-changing data such as config, feature flags and lookup tables goes in-process. Per-user or frequently changing data that must look the same from every instance goes in Redis. For the hottest keys you do both: a few-second local layer in front of Redis, with a pub/sub message to evict local copies when something changes.`,
      mustMention: [
        'In-process is ~100 ns with no network; Redis is ~0.5 ms',
        'Local caches are duplicated per instance and can be inconsistent',
        'Redis is a single shared copy so one delete is visible everywhere',
        'Config/flags/lookups locally; per-user and shared-consistency data in Redis',
        'L1/L2 layering with pub/sub invalidation for hot keys',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You are a letter travelling from a customer\'s front door, down the street, into a post office, past the counter, into the back rooms and finally down to the basement archive. Each place you pass is a cache level that might already hold your answer.',
    stops: [
      { locus: 'The customer\'s own front door', concept: 'Browser cache and Cache-Control headers', image: 'A sticky note on the door reads "ANSWER: 42. Valid until FRIDAY (max-age)". A red stamp says NO-STORE on a second note that dissolves the instant you read it. A tiny tag hangs from the handle: ETag abc123.' },
      { locus: 'The corner newspaper kiosk', concept: 'CDN edge cache', image: 'Hundreds of identical kiosks line the street, each stocked from one distant warehouse. A kiosk owner shouts "same URL, same paper!" and refuses to stock papers with a different cookie stapled on: Vary: Cookie makes every paper unique.' },
      { locus: 'The post office receptionist\'s whiteboard', concept: 'Reverse proxy micro-cache', image: 'The receptionist rewrites the cricket score on a whiteboard once every second. Fifty thousand people read the board simultaneously; only she walks to the back, and only once per second.' },
      { locus: 'The clerk\'s shirt pocket', concept: 'In-process cache', image: 'Every clerk has a note in their pocket. Reading it is instant, but when the fact changes each clerk finds out separately; two clerks at neighbouring windows give different answers to the same customer.' },
      { locus: 'The giant shared filing cabinet', concept: 'Distributed cache (Redis)', image: 'A single enormous glowing cabinet in the centre of the room. Clerks jog to it (the network hop). One drawer is red hot from too many hands (hot key); someone has made ten photocopies of it and spread them around.' },
      { locus: 'The archivist\'s desk', concept: 'Database buffer pool', image: 'The archivist keeps the most-requested folders piled on the desk instead of in the basement. A meter on the wall reads "99.8% found on desk". Next to it a smashed machine labelled QUERY CACHE with a single giant padlock on it: MySQL threw it out.' },
      { locus: 'The corridor trolley', concept: 'OS page cache', image: 'A trolley of folders parked in the corridor between the desk and the basement stairs; the kernel janitor quietly restocks it. Kafka lives entirely off this trolley and never goes downstairs.' },
      { locus: 'The basement stairs sign', concept: 'Choosing the level', image: 'A sign with four questions in flashing neon: WHO IS IT FOR? HOW OFTEN DOES IT CHANGE? HOW HOT? HOW BAD IF WRONG? Below it, a single big red button: PURGE ALL LEVELS FOR ENTITY.' },
    ],
  },
  interviewQuestions: [
    'Walk me through every place a GET request for a product page could be served from a cache, from the browser to the disk.',
    'How would you cache static assets so they can be served for a year yet update instantly on deploy?',
    'When would you choose an in-process cache over Redis, and how do you keep instances consistent?',
    'What is the danger of marking a response Cache-Control: public, and how does Vary interact with CDN cache keys?',
    'Why did MySQL remove its query cache, and where should result caching live instead?',
    'A read-heavy database already has a 99.9% buffer pool hit ratio. Does adding Redis help? What does it actually change?',
    'How do you prevent a thundering herd at the CDN and reverse-proxy levels when a hot object expires?',
    'You cache a price at four levels. How stale can it get, and how do you design the purge path?',
  ],
}

export default chapter
