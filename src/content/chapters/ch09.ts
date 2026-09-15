import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 9,
  slug: 'picking-the-right-database',
  title: 'Picking The Right Database',
  module: 'databases',
  estimatedMinutes: 35,
  summary:
    'Every database is a bundle of trade-offs, and choosing one is choosing which trade-offs your workload can afford. This chapter gives a repeatable framework: start from access patterns, then consistency needs, then scale, then query flexibility, and only then look at products. It then works through real use cases (payments, sessions, social graphs, time series, search, analytics, catalogues) to show the framework producing concrete, defensible picks.',
  objectives: [
    'Apply a four-step framework (access patterns, consistency, scale, query flexibility) to choose a database for a given feature.',
    'Justify why payments go to relational, sessions to key-value, social graphs to graph stores and time series to columnar or wide-column stores.',
    'Recognise polyglot persistence and explain the cost of every extra store you add.',
    'Spot the common anti-patterns: choosing by hype, premature sharding, and using one store for everything.',
    'Answer the interview question "which database and why" with a requirement-driven argument.',
  ],
  quickRevision: [
    'Framework order: access patterns -> consistency needs -> scale (reads, writes, size) -> query flexibility -> operational fit and cost -> product.',
    'Access pattern questions: read-heavy or write-heavy? Point lookup, range scan, aggregate fetch, traversal, full-text, or ad-hoc analytics?',
    'Consistency questions: can two users briefly see different values? Do multiple rows need to change atomically? Is read-your-writes required?',
    'Scale questions: QPS, data size, growth rate, and whether one primary plus replicas can carry it for the next 2-3 years.',
    'Query flexibility: known and fixed (NoSQL is fine) vs evolving and ad hoc (relational or a warehouse).',
    'Default answer: Postgres or MySQL until a specific pattern proves it wrong. Most systems never outgrow one primary with replicas and a cache.',
    'Payments, orders, inventory, bookings -> relational (ACID, constraints, exact balances, audit).',
    'Sessions, caches, rate limits, feature flags -> key-value in memory (Redis, Memcached); ephemeral, key-only, sub-millisecond.',
    'Social graph, fraud rings, recommendations by relationship -> graph store (Neo4j, Neptune) for multi-hop traversals.',
    'Metrics, logs, IoT, events -> time-series or columnar (TimescaleDB, InfluxDB, ClickHouse, Cassandra); append-heavy, time-range reads, compression.',
    'Full-text search and faceting -> Elasticsearch / OpenSearch, fed from the system of record; never the system of record itself.',
    'Analytics and BI -> columnar warehouse (BigQuery, Snowflake, Redshift, ClickHouse) fed by CDC or batch ETL.',
    'Large files -> object storage (S3) with metadata in a database; never blobs in the DB.',
    'Every additional store costs operations, consistency plumbing and expertise. Add one only for a dominant, proven access pattern.',
  ],
  sections: [
    {
      id: 'framework',
      title: 'The decision framework: questions before products',
      body: `Engineers tend to pick a database the way they pick a phone: by brand. The result is MongoDB for a ledger, or Cassandra for a 10 GB dataset. A better way is to answer four questions in order, and only then match products.

**1. Access patterns.** List the top 5-10 operations the feature performs, with rough frequencies. For each: is it a point lookup by key, a range scan, a fetch of a whole aggregate, a relationship traversal, a full-text search, or an aggregation over millions of rows? Is the workload read-heavy (100:1 is common for content sites) or write-heavy (telemetry, logs)? This step alone eliminates most candidates because each store family is fast at one or two of these and slow at the rest.

**2. Consistency needs.** For each write, ask: if a second user reads one second later from another replica, is a stale answer acceptable? Does this write need to change several rows or entities atomically (order + inventory + payment)? Are uniqueness or foreign-key constraints business-critical? Money, stock levels and bookings say "no staleness, yes atomicity". Likes, view counts and feeds say "stale is fine".

**3. Scale.** Estimate QPS for reads and writes, dataset size, growth rate, and the retention window. Then compare against what a single well-tuned primary offers: roughly tens of thousands of simple QPS, several TB on disk, plus read replicas. If the numbers fit for the next 2-3 years, horizontal scaling is not a requirement, and you should not pay for it.

**4. Query flexibility.** Will the queries change? A product team iterating on features will invent new questions every sprint; an event-ingestion pipeline will ask the same three questions forever. Fixed queries tolerate NoSQL\'s "one table per query" model. Evolving queries want SQL.

Only after these do you consider **operational fit**: team expertise, managed offerings in your cloud, licensing, backup and recovery tooling, and cost per GB and per request.

The output is not a product name but a sentence: "This workload is point lookups and small range scans by user, needs atomic multi-row updates, fits one primary for three years, and its queries are still evolving; therefore Postgres with read replicas, and we revisit at N."`,
      mentalModel:
        'Choosing a database is like choosing a vehicle. You do not start with "Toyota or Ford". You ask: how many passengers (scale), how far and over what roads (access pattern), can anyone be late (consistency), and will the route change (flexibility). Only then do you look at models.',
      diagram: `   1. Access patterns   what ops, how often, read vs write heavy?
            |
            v
   2. Consistency       staleness ok? multi-row atomicity needed?
            |
            v
   3. Scale             QPS, size, growth vs one primary + replicas
            |
            v
   4. Query flexibility fixed forever  vs  evolving / ad hoc
            |
            v
   5. Ops & cost        team skill, managed service, $/GB, $/req
            |
            v
      Product + a sentence that justifies it`,
      keyPoints: [
        'Order matters: access patterns first, products last.',
        'Access pattern type (lookup, range, aggregate, traversal, search, analytics) eliminates most families immediately.',
        'Consistency: ask about staleness tolerance and multi-entity atomicity per write.',
        'Scale only becomes a requirement when one primary plus replicas provably cannot carry 2-3 years of growth.',
        'The deliverable is a justification sentence, not a brand.',
      ],
      checkpoint: {
        question:
          'A product manager asks for "a database for the new loyalty points feature". Write the four questions you would ask before naming any product.',
        answer:
          '1) What are the operations: read balance by user, append a points transaction, redeem points, monthly statements? 2) Must a redemption be atomic with the order and never over-spend (yes, so strong consistency)? 3) How many users and transactions per day, and how big does the ledger grow per year? 4) Will we add new queries such as "top earners this month" or tier rules? The likely answer is relational, but the questions come first.',
      },
    },
    {
      id: 'access-patterns',
      title: 'Reading the access pattern: the single most predictive signal',
      body: `If you can only ask one question, ask how the data is read and written. Each database family is an engine built around one pattern.

**Point lookups by key** (get user 42, get session abc). Everything handles this, but key-value stores handle it fastest and cheapest: hash the key, go to one node, return. If this is the *only* pattern, relational is overkill and Redis or DynamoDB wins.

**Range scans on a sort key** (orders for customer 42 between two dates; last 100 messages in channel 7). B-tree indexes in Postgres and clustering columns in Cassandra or the sort key in DynamoDB serve this. The hazard is a sort key that spans many partitions, forcing scatter-gather.

**Aggregate fetch** (the whole order with items and address for one screen). Document stores are literally designed for this; relational needs a join or a JSONB column.

**Multi-hop traversals** (friends of friends who bought X). Graph databases; relational joins grow combinatorially with depth.

**Full-text search, fuzzy matching, faceting** (products matching "blue runing shoe" with brand filters). Inverted indexes in Elasticsearch or OpenSearch; Postgres full-text search is fine at small scale.

**Aggregations over millions of rows** (revenue by region by day). Columnar engines (ClickHouse, BigQuery, Snowflake, Redshift) read only the needed columns and compress them 10x; row stores read every byte of every row.

**Append-only with time-window reads** (metrics, logs, clickstreams). LSM-based stores (Cassandra) or time-series databases (TimescaleDB, InfluxDB) that compress by time and expire old chunks cheaply.

Read/write ratio matters too. Read-heavy workloads want indexes, replicas and caches. Write-heavy workloads want append-friendly storage (LSM trees) and few indexes, because every index is an extra write. A feature that is 99% reads on a 5 GB dataset should not be on Cassandra, whose whole design optimises writes.

The practical exercise is a table: operation, frequency, pattern type, latency target. Circle the top two by frequency; they choose the primary store. Any remaining pattern that the primary store handles badly is a candidate for a secondary, derived store fed from the primary.`,
      mentalModel:
        'A database is a road built for a traffic type. Highways for straight-line volume (append and scan), roundabouts for many small turns (key lookups), footbridges for hopping between islands (traversals). Driving a truck through a footbridge is the "wrong database" incident.',
      diagram: `Pattern                    Best-fit engine              Example
point lookup by key    ->  key-value / any indexed      Redis, DynamoDB
range scan on sort key ->  B-tree or clustering cols    Postgres, Cassandra
whole aggregate fetch  ->  document                     MongoDB, JSONB
multi-hop traversal    ->  graph                        Neo4j, Neptune
full-text / facets     ->  inverted index               Elasticsearch
big aggregations       ->  columnar                     ClickHouse, BigQuery
append + time windows  ->  LSM / time-series            Cassandra, Timescale`,
      keyPoints: [
        'Identify the top two operations by frequency; they choose the primary store.',
        'Each pattern type maps to an engine built for it; mismatches show up as latency and cost.',
        'Read-heavy: indexes, replicas, caches. Write-heavy: LSM storage, fewer indexes.',
        'Patterns the primary store handles badly go to derived secondary stores.',
      ],
      checkpoint: {
        question:
          'A dashboard runs "sum of sales by product category for the last 90 days" over 2 billion rows every time it loads. It currently hits the Postgres primary. Predict the problem and the fix.',
        answer:
          'Postgres is a row store: it reads every column of every row and competes with transactional traffic, so the query takes minutes and slows checkout. Replicate the sales rows via CDC or nightly batch into a columnar store (ClickHouse, BigQuery) where the same query reads two compressed columns in under a second, or precompute daily aggregates.',
      },
    },
    {
      id: 'consistency-and-scale',
      title: 'Consistency needs and scale: the two constraints that veto',
      body: `Access patterns nominate candidates; consistency and scale veto them.

**Consistency as a veto.** Ask of each write: what is the worst thing that happens if another reader sees the old value for two seconds? For a "like" counter, nothing. For available seats on a flight, an overbooking. For an account balance, a double spend and a regulator. If the answer involves money, inventory or legal records, you need **atomic multi-row updates, uniqueness constraints and strong reads**, which means a relational database or one of the few distributed SQL systems that keep serializable transactions (Spanner, CockroachDB, YugabyteDB). No amount of "eventually consistent at scale" is worth a negative balance.

Conversely, insisting on strong consistency where it is not needed is also a mistake: it forces synchronous replication, cross-region round trips and lower availability. A social feed that is 500 ms stale is a fine feed. Match the guarantee to the business rule, per write, not per system.

**Scale as a veto.** Numbers, not adjectives. Suppose an app has 10M daily users, each generating 20 events, so 200M events/day, about 2,300/sec average and perhaps 10k/sec at peak, each 500 bytes: 100 GB/day, 36 TB/year. That volume vetoes a single Postgres primary as the long-term event store, regardless of how nice SQL is. Cassandra, ClickHouse or S3 + a query engine enter the picture.

Compare with the same app\'s user table: 10M rows at 2 KB is 20 GB, updated a few times a day per user. That is trivially one Postgres instance forever. The two datasets in one product need two different answers.

Useful ceilings for one modern primary (rough, workload-dependent): tens of thousands of simple point-read QPS, low thousands to ~10k mixed writes/sec, several TB on NVMe before operations (vacuum, backups, restores) become painful. Read replicas multiply read capacity; a cache in front removes most reads entirely. Only writes and total size truly force horizontal scaling.

The trap on both axes is **imagining the requirement**: designing for a bank when you are building a blog, or for Netflix scale when you have 1,000 users. Write the numbers down and let them decide.`,
      mentalModel:
        'Access patterns are the shortlist of candidates; consistency and scale are the two bouncers at the door. One asks "can you afford to be wrong for a second?" and the other asks "how many of you are there, really?".',
      diagram: `                 staleness acceptable?
                    yes            no
             +-------------+-----------------+
  fits one   | Postgres or | Postgres/MySQL  |
  primary    | anything    | (ACID, simple)  |
             +-------------+-----------------+
  exceeds    | Cassandra,  | Spanner, Cockroach|
  one        | DynamoDB,   | Vitess/Citus with |
  primary    | ClickHouse  | careful shard key |
             +-------------+-----------------+`,
      keyPoints: [
        'Per write, ask what a two-second stale read would cost; money, stock and legal records demand ACID.',
        'Over-specifying consistency costs latency and availability; match the guarantee to the business rule.',
        'Turn scale into numbers: QPS, bytes/day, TB/year; compare to one primary plus replicas.',
        'Different datasets in one product often deserve different stores.',
        'Only sustained write volume and total size force horizontal scaling; reads are solved by replicas and caches.',
      ],
      checkpoint: {
        question:
          'A ticketing site sells 50,000 seats for a concert in 5 minutes. Which consistency property is non-negotiable, and what does it imply for the database choice?',
        answer:
          'No seat may be sold twice: a conditional, atomic decrement or row lock per seat with strong reads. That implies a relational database (or distributed SQL) for the inventory and order tables, likely with a Redis-based queue or token bucket in front to smooth the spike. The event history and analytics can live elsewhere.',
      },
    },
    {
      id: 'worked-examples',
      title: 'Worked examples: one product, many stores',
      body: `Take a food-delivery platform and run the framework feature by feature.

**Payments and orders -> Postgres.** Pattern: insert order, update status, read by order_id and by customer. Consistency: charging the card, creating the order and decrementing a promo code must be atomic; balances must be exact; audits are legal. Scale: 1M orders/day is 12/sec, trivial. Flexibility: finance will ask new questions constantly. Verdict: relational, one primary with replicas, partition the orders table by month.

**Sessions and auth tokens -> Redis.** Pattern: get/set by token on every request, expire after 30 minutes. Consistency: losing a session forces a re-login, annoying but harmless. Scale: 50k requests/sec at peak. Flexibility: none needed. Verdict: Redis with TTLs; sub-millisecond, cheap, replicated for availability.

**Restaurant catalogue and menus -> MongoDB or Postgres JSONB.** Pattern: fetch a whole restaurant with its menu sections and items as one document; menus differ wildly in structure. Consistency: a stale menu for a few seconds is fine. Verdict: document model; whether that is MongoDB or JSONB depends on whether the team already runs Postgres (usually keep it in Postgres).

**Live driver locations -> Redis geospatial.** Pattern: 200k drivers writing a position every 3 seconds (~70k writes/sec), queries for "drivers within 2 km". Consistency: a 3-second-old position is acceptable. Data is ephemeral. Verdict: Redis GEOADD/GEOSEARCH, in memory, no persistence needed.

**Order events and delivery tracking history -> Cassandra or DynamoDB.** Pattern: append events (placed, cooking, picked up, delivered), read the timeline for an order or a courier by time. Write-heavy, append-only, grows forever, multi-region. Verdict: wide-column partitioned by order_id, clustered by timestamp, TTL after a year.

**Restaurant search -> Elasticsearch.** Pattern: "thai near me open now rating > 4" with typo tolerance and facets. Verdict: inverted index fed by CDC from Postgres; Elasticsearch is never the system of record.

**Analytics and BI -> BigQuery or ClickHouse.** Pattern: revenue by city by hour, cohort retention, ad-hoc analyst SQL over billions of rows. Verdict: columnar warehouse loaded by streaming CDC.

**"Customers who ordered this also ordered" -> graph or precomputed.** At modest scale a nightly batch job into a Redis sorted set beats running Neo4j. A graph store earns its place only if multi-hop relationship queries are central to the product, as at LinkedIn or in fraud detection.

Notice the pattern: one system of record (Postgres), several **derived** stores each fed from it, and each chosen for one dominant pattern.`,
      mentalModel:
        'A restaurant kitchen does not cook everything in one pot. The system of record is the walk-in fridge where every ingredient is kept exactly once; the prep stations (search, cache, analytics) hold pre-chopped copies arranged for speed, and are refilled from the fridge.',
      diagram: `                 +-------------------+
                 |  Postgres (SoR)   |  orders, payments, users
                 +---------+---------+
                           | CDC / events
      +-----------+--------+--------+-----------+
      v           v                 v           v
 [Elasticsearch] [Redis cache]  [ClickHouse]  [Cassandra]
  search          sessions,      analytics     order event
  & facets        hot reads,     & BI          history
                  geo positions`,
      keyPoints: [
        'Payments/orders: relational for ACID, constraints and audit; volume is usually small.',
        'Sessions, rate limits, live positions: Redis; ephemeral, key-only, in memory.',
        'Catalogue-like aggregates: document model (MongoDB or Postgres JSONB).',
        'Append-only event history: Cassandra or DynamoDB with time clustering and TTL.',
        'Search and analytics: Elasticsearch and a columnar warehouse, both derived via CDC.',
        'One system of record; every other store is a derived, disposable view.',
      ],
    },
    {
      id: 'polyglot-cost',
      title: 'Polyglot persistence and the cost of every extra store',
      body: `Using several databases, each for what it does best, is called **polyglot persistence**. It is the correct end state for large products, and a trap for small ones, because every store you add carries costs that do not show up in the benchmark.

**Operational cost.** Each store needs provisioning, monitoring, alerting, backups, restore drills, upgrades, security patching and capacity planning. A team that runs Postgres well does not automatically run Cassandra well; the failure modes (compaction storms, tombstones, repair) are entirely different. Managed services (RDS, DynamoDB, Elastic Cloud, MongoDB Atlas) shrink this but do not remove it.

**Consistency plumbing.** The moment the same fact lives in two stores, you own the synchronisation. How does the search index learn that a product was deleted? Through CDC (Debezium reading the Postgres WAL into Kafka), dual writes (fragile: one succeeds, one fails), or periodic rebuilds. Each has lag and each can drift, so you also need reconciliation jobs and "rebuild the index from the source of truth" tooling.

**Cognitive cost.** Engineers must know several query languages, data models and failure behaviours. Onboarding slows. Debugging a bug that crosses three stores is much harder than one SQL trace.

**Cost of being wrong.** Migrating off a store later is a multi-quarter project. Adding it was a Tuesday.

The discipline that keeps polyglot honest:

1. **One system of record.** Exactly one store owns each fact. Everything else is a derived view that can be deleted and rebuilt.
2. **Add a store only for a dominant, measured pattern.** "We might need search someday" is not a reason; "search is 30% of requests and Postgres full-text is at 800 ms p99" is.
3. **Prefer extending what you run.** Postgres does JSONB, full-text search, pub/sub (LISTEN/NOTIFY), time partitioning (TimescaleDB extension) and even vector search (pgvector). Redis does caching, queues, geo and streams. Two well-understood stores cover a surprising amount.
4. **Derive, do not dual-write.** Feed secondary stores from the system of record\'s change log so they can always be rebuilt.

A useful sanity check: if your startup with 50k users runs six databases, you have imported the org chart of a company a thousand times your size.`,
      mentalModel:
        'Each database is a pet, not a tool. It needs feeding (capacity), vet visits (upgrades), a fence (security) and it will wake you at 3 a.m. Two pets is a household; six is a zoo that needs a full-time keeper.',
      keyPoints: [
        'Polyglot persistence is right at scale and premature for most small systems.',
        'Hidden costs: operations, sync plumbing, cognitive load, migration risk.',
        'Rules: one system of record; add stores only for measured dominant patterns; extend what you run; derive via CDC, never dual-write.',
        'Postgres + Redis cover most products for years.',
      ],
      checkpoint: {
        question:
          'A five-engineer team proposes Postgres, MongoDB, Cassandra, Elasticsearch and Neo4j for a v1 marketplace. Which two would you keep, and how would you handle the other needs?',
        answer:
          'Keep Postgres (system of record; JSONB for flexible listing attributes; built-in full-text search for v1) and Redis (sessions, cache, rate limits). Order event history can be a partitioned Postgres table for now; recommendations can be a nightly batch into Redis sorted sets. Revisit Elasticsearch when search latency or relevance measurably fails, and Cassandra when event volume exceeds what partitioned Postgres carries.',
      },
    },
    {
      id: 'anti-patterns',
      title: 'Anti-patterns and how to answer "which database?" in an interview',
      body: `Common failure modes, each with the framework step it skips:

**Choosing by hype or résumé.** "Cassandra because Netflix" skips access patterns and scale. Netflix has petabytes of write-heavy data across regions; a 20 GB dataset with complex queries is the opposite workload.

**Premature horizontal scaling.** Choosing a sharded NoSQL store for flexibility you have not lost yet and scale you do not have. You pay the join-less, transaction-less tax on day one for a benefit that may arrive in year four, if ever.

**One store for everything.** Storing images in Postgres bytea columns, using MySQL as a queue with polling, keeping 5 TB of logs in the transactional database. Each works until it does not, and then it takes the core system down with it. Blobs go to S3, queues to Kafka or RabbitMQ or Redis Streams, logs to a columnar or log store.

**Ignoring the operational team.** Picking a store nobody on call understands. The database that survives incidents is the one your team can debug at 3 a.m.

**Designing schema before queries in NoSQL.** Cassandra or DynamoDB tables designed like normalised SQL tables produce scatter-gather reads and hot partitions. Queries first, always.

**Answering the interview question.** When asked "which database would you use for X?", the weak answer is a product name. The strong answer follows the framework aloud:

1. State the access patterns you extracted from the requirements, with frequencies.
2. State the consistency requirement per major write and why.
3. Estimate scale with numbers and compare against one primary.
4. Note whether queries are fixed or evolving.
5. Name the store, then immediately name what it costs you and when you would revisit.

Example: "URL shortener: dominant operation is a point lookup by short code at maybe 50k reads/sec with 1% writes; a stale read after creation is tolerable for a second; data is 100M rows at 500 bytes, about 50 GB; queries are fixed. That is a key-value workload: DynamoDB or Redis-backed with Postgres as the durable record. The cost is no ad-hoc analytics, so we stream click events to a warehouse separately."

That answer shows judgement; the product name alone shows only memory.`,
      mentalModel:
        'The interviewer is not asking "what is the capital of Databases". They are asking to watch you drive: signal (requirements), check mirrors (trade-offs), then turn (decision).',
      diagram: `Weak:   "I would use MongoDB."

Strong: requirements -> patterns (lookup 50k/s, 1% writes)
                     -> consistency (stale 1s ok)
                     -> scale (50 GB, fits anywhere)
                     -> flexibility (fixed queries)
                     -> pick (KV store) + cost (no ad-hoc SQL)
                     -> revisit trigger (analytics need)`,
      keyPoints: [
        'Hype, premature scaling, one-store-for-everything and ignoring ops skills are the recurring mistakes.',
        'In NoSQL, queries come before schema; in SQL, schema can come first.',
        'Blobs to object storage, queues to brokers, logs to columnar stores; keep the transactional DB lean.',
        'Interview answer = patterns, consistency, scale, flexibility, pick, cost, revisit trigger.',
      ],
      checkpoint: {
        question:
          'Interviewer: "Which database for a leaderboard showing the top 100 players and each player\'s rank, updated in real time for 5M players?" Give the framework answer.',
        answer:
          'Patterns: increment a score and read top-N or a player\'s rank, tens of thousands of times per second. Consistency: a rank that is a second stale is fine. Scale: 5M entries at ~50 bytes is 250 MB, fits in memory. Queries: fixed. Pick: Redis sorted set (ZINCRBY, ZREVRANGE, ZREVRANK all O(log N)), persisted with AOF or periodically snapshotted to Postgres for durability. Cost: memory-bound and single-key hot spot for one global board; shard by region or season if it grows.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'In the database selection framework, what should you examine first?',
      options: [
        'Which databases the team has used before',
        'The dominant access patterns (what operations, how often, read vs write)',
        'The cost per GB of each managed service',
        'Whether the database supports JSON',
      ],
      answerIndex: 1,
      explanation:
        'Access patterns eliminate most candidate families immediately because each is engineered for particular operations. Team skill and cost matter but come later as operational fit; JSON support is a feature detail, not a driver.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'Which store type is the natural fit for user sessions that expire after 30 minutes and are read on every request?',
      options: ['Graph database', 'Columnar warehouse', 'In-memory key-value store such as Redis', 'Relational database with a sessions table'],
      answerIndex: 2,
      explanation:
        'Sessions are key-only lookups, ephemeral, latency-critical and tolerate loss. Redis with TTL is built for this. A relational table works at small scale but adds latency and write load for no benefit.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Why do payments and inventory almost always belong in a relational database?',
      options: [
        'Relational databases are the fastest for writes',
        'They need atomic multi-row updates, constraints and exact strongly consistent reads, and their volume is usually modest',
        'NoSQL databases cannot store decimal numbers',
        'Regulators require SQL',
      ],
      answerIndex: 1,
      explanation:
        'Money and stock require ACID transactions across rows, uniqueness constraints and no stale reads, and their write volume rarely exceeds one primary. Relational databases are not the fastest writers, and the other options are false.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 2,
      question: 'A query sums revenue by region over 3 billion rows and is run by analysts with new filters each week. Which store fits best?',
      options: [
        'Redis',
        'A columnar warehouse such as ClickHouse or BigQuery',
        'Cassandra',
        'Neo4j',
      ],
      answerIndex: 1,
      explanation:
        'Large aggregations over few columns with evolving filters are exactly what columnar engines do: they read only the needed columns, compress heavily, and accept ad-hoc SQL. Cassandra cannot do ad-hoc aggregations, Redis is memory-bound, and graph stores target traversals.',
    },
    {
      type: 'multi',
      id: 'q5',
      difficulty: 2,
      question: 'Which of these are legitimate reasons to add a second database to a system? Select all that apply.',
      options: [
        'Search latency on Postgres full-text is measured at 900 ms p99 and search is 30% of traffic',
        'The team read that Cassandra is web-scale',
        'Event ingestion is 40k writes/sec and the primary is at IOPS ceiling',
        'A new engineer prefers MongoDB',
        'Multi-hop relationship queries are the core product feature and take seconds in SQL',
      ],
      answerIndices: [0, 2, 4],
      explanation:
        'Each valid reason is a measured, dominant access pattern the current store handles badly. Hype and personal preference skip the framework entirely and import operational cost with no requirement behind it.',
    },
    {
      type: 'truefalse',
      id: 'q6',
      difficulty: 2,
      statement: 'Elasticsearch is a good choice as the system of record for product data because it can also serve search.',
      answer: false,
      explanation:
        'Elasticsearch is a derived index optimised for search, with weaker durability, transaction and consistency guarantees. Keep the system of record in a database and feed Elasticsearch via CDC so it can be rebuilt at any time.',
    },
    {
      type: 'truefalse',
      id: 'q7',
      difficulty: 1,
      statement: 'For most products, Postgres or MySQL with read replicas and a Redis cache is a reasonable default until a specific access pattern or scale requirement proves otherwise.',
      answer: true,
      explanation:
        'One primary handles tens of thousands of QPS and terabytes of data; replicas and caches absorb reads. Specialised stores are justified by measured, dominant patterns, not anticipated ones.',
    },
    {
      type: 'mcq',
      id: 'q8',
      difficulty: 3,
      question:
        'An app stores 200k drivers\' GPS positions updated every 3 seconds and answers "drivers within 2 km" queries. Which choice best fits, and why?',
      options: [
        'Postgres with PostGIS, because geospatial queries need a relational database',
        'Redis geospatial commands, because writes are ~70k/sec, data is ephemeral, and 3-second staleness is fine',
        'Cassandra, because it handles write-heavy workloads',
        'Neo4j, because drivers and riders form a graph',
      ],
      answerIndex: 1,
      explanation:
        'The data is hot, small, ephemeral and latency-sensitive: an in-memory geo index is ideal. PostGIS is excellent for durable geo data but 70k updates/sec of throwaway positions would hammer the primary. Cassandra cannot do radius queries natively, and there is no traversal here.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'Which of these is the strongest interview answer to "what database for a URL shortener?"',
      options: [
        'MongoDB, it is popular',
        'It is point lookups by code at high read volume with tiny writes, fixed queries and ~50 GB of data, so a key-value store like DynamoDB or Redis over Postgres; the cost is no ad-hoc analytics, so click events stream to a warehouse',
        'Cassandra, because it scales',
        'Postgres, because SQL is always safest',
      ],
      answerIndex: 1,
      explanation:
        'The strong answer walks the framework: pattern, consistency, scale, flexibility, pick, cost and mitigation. The other answers are a product name with no requirement behind it.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'Why should you feed secondary stores (search index, cache, warehouse) via change data capture from the system of record rather than dual-writing from the application?',
      options: [
        'CDC is faster than dual writes',
        'Dual writes can partially fail, leaving stores inconsistent; CDC derives from one source and lets you rebuild any store',
        'Dual writes require a graph database',
        'CDC removes the need for backups',
      ],
      answerIndex: 1,
      explanation:
        'With dual writes the app may succeed in one store and fail in another with no transaction to tie them. Deriving from the change log of a single system of record keeps every secondary store rebuildable and consistent (with lag).',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design the storage layer for a fitness app: user profiles, workout logs (10M users x 1 workout/day x 2 KB, kept for 5 years), a friends feed, and a monthly leaderboard. Assign stores and justify each in one line.',
      modelAnswer: `- **Profiles, auth, subscriptions -> Postgres.** Low volume, relational, billing needs ACID, queries evolve.
- **Workout logs -> Cassandra/ScyllaDB or DynamoDB**, partition (user_id, month), clustered by time. 10M/day = ~115 writes/sec average but 20 GB/day, 36 TB over 5 years: too large for the primary; access is by user and time range; append-only.
- **Friends feed -> fan-out on write into Redis lists (recent) backed by a Cassandra table (history)**, since reads are "latest N for viewer" and staleness is fine.
- **Monthly leaderboard -> Redis sorted set per month**, ZINCRBY on workout completion, top-N and rank in O(log N); snapshot to Postgres at month end.
- **Analytics -> BigQuery/ClickHouse via CDC** for ad-hoc questions.
- **Photos -> S3** with URLs in Postgres.

One system of record (Postgres) plus derived stores, each for one dominant pattern.`,
      rubric: [
        'Puts profiles/billing in a relational store with an ACID justification.',
        'Uses a numeric estimate for workout logs to justify a wide-column or key-value store with a time-based partition key.',
        'Chooses Redis sorted sets for the leaderboard with the operations named.',
        'Explains the feed as a fan-out/precomputed read path.',
        'Keeps one system of record and treats others as derived.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question:
        'List the hidden costs of adding a new database to a system, and the four rules that keep polyglot persistence manageable.',
      modelAnswer: `**Hidden costs:** operations (monitoring, backups, upgrades, on-call expertise for new failure modes), consistency plumbing (keeping copies in sync, drift, reconciliation), cognitive load (more query languages and data models to know), and the high cost of migrating away later.

**Rules:** (1) exactly one system of record per fact, everything else derived and rebuildable; (2) add a store only for a measured, dominant access pattern the current store handles badly; (3) extend what you already run first (Postgres JSONB, full-text, partitioning; Redis structures); (4) derive via CDC from the source of truth, never dual-write.`,
      rubric: [
        'Names operational and on-call cost.',
        'Names synchronisation/consistency cost between stores.',
        'States the one-system-of-record rule.',
        'States that stores are added for measured patterns, and prefers extending existing stores.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Database selection framework (order)', back: 'Access patterns -> consistency needs -> scale (QPS, size, growth) -> query flexibility -> operational fit and cost -> product plus justification sentence.' },
    { id: 'f2', front: 'Questions that define an access pattern', back: 'Which operations, how frequent, read- or write-heavy, and type: point lookup, range scan, aggregate fetch, traversal, full-text, or big aggregation.' },
    { id: 'f3', front: 'Two consistency questions per write', back: 'Can another reader see a stale value for a second? Must several rows/entities change atomically? Money and stock: no and yes.' },
    { id: 'f4', front: 'Rough ceiling of one modern primary', back: 'Tens of thousands of simple QPS, low thousands to ~10k writes/sec, several TB on NVMe, plus read replicas. Most products fit.' },
    { id: 'f5', front: 'Payments and inventory -> ?', back: 'Relational (Postgres/MySQL) or distributed SQL (Spanner, CockroachDB): ACID, constraints, exact reads, audits; volume is usually modest.' },
    { id: 'f6', front: 'Sessions, rate limits, feature flags -> ?', back: 'In-memory key-value (Redis, Memcached): key-only, ephemeral, sub-millisecond, TTL-based expiry.' },
    { id: 'f7', front: 'Social graph, fraud rings -> ?', back: 'Graph store (Neo4j, Neptune) when multi-hop traversals are central; otherwise precompute into Redis or Postgres.' },
    { id: 'f8', front: 'Metrics, logs, IoT events -> ?', back: 'Time-series or wide-column (TimescaleDB, InfluxDB, Cassandra) or columnar (ClickHouse): append-heavy, time-window reads, compression and cheap expiry.' },
    { id: 'f9', front: 'Full-text search -> ?', back: 'Elasticsearch/OpenSearch as a derived index fed by CDC; Postgres full-text for small scale. Never the system of record.' },
    { id: 'f10', front: 'Analytics / BI -> ?', back: 'Columnar warehouse (BigQuery, Snowflake, Redshift, ClickHouse) loaded by CDC or batch; reads only needed columns, compresses ~10x.' },
    { id: 'f11', front: 'Large files (images, videos) -> ?', back: 'Object storage (S3, GCS) with metadata and URL in the database. Never blobs in the transactional DB.' },
    { id: 'f12', front: 'Polyglot persistence', back: 'Several stores, each for its dominant pattern, with exactly one system of record and the rest derived and rebuildable.' },
    { id: 'f13', front: 'Hidden costs of an extra database', back: 'Operations and on-call, sync plumbing and drift, cognitive load, and expensive migration if wrong.' },
    { id: 'f14', front: 'CDC vs dual writes', back: 'Dual writes can partially fail and diverge. CDC (e.g. Debezium on the WAL) derives every secondary store from one source and allows rebuilds.' },
    { id: 'f15', front: 'Redis leaderboard commands', back: 'ZINCRBY to add score, ZREVRANGE for top-N, ZREVRANK for a player\'s rank; all O(log N). Snapshot to a durable store periodically.' },
    { id: 'f16', front: 'Strong interview answer structure', back: 'Patterns with numbers -> consistency need -> scale vs one primary -> fixed or evolving queries -> pick -> what it costs -> when to revisit.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'How to choose a database',
      prompt: 'A junior engineer asks "which database is the best?" Explain why that is the wrong question and what the right questions are.',
      modelExplanation: `There is no best database, only databases that are good at particular jobs. Every one of them makes trade-offs: some are brilliant at reading one record by key, some at scanning huge ranges, some at following relationships, some at big sums over billions of rows. Being great at one usually means being mediocre at another.

So the real question is "what does our workload look like?" First, list what the feature actually does: read by id, search by text, append events, sum numbers. Note how often each happens. Second, ask how wrong we can afford to be: if two users see different values for a second, is that a shrug or a lawsuit? Third, put numbers on it: how many requests, how many gigabytes, how fast is it growing, and does that fit one big server with copies for a few years? Fourth, will the questions we ask change often?

Answer those, and the database almost picks itself. Usually it is Postgres with a cache, and that is a good thing: boring is cheap to run.`,
      mustMention: [
        'Every database trades off strengths',
        'Start from access patterns and frequencies',
        'Consistency: cost of a stale read, need for atomic multi-row updates',
        'Scale in numbers vs one primary plus replicas',
        'Fixed vs evolving queries',
        'Default to relational plus cache',
      ],
    },
    {
      id: 'fe2',
      concept: 'Why one product uses several databases',
      prompt: 'Explain to a product manager why the engineering team wants Postgres, Redis and Elasticsearch for one app instead of a single database.',
      modelExplanation: `Different parts of the app ask very different things of storage. Orders and payments need to be exactly right: when a customer pays, the order, the charge and the discount must all update together or not at all, and nobody may ever see a wrong balance. Postgres is built for exactly that, and it is where the truth lives.

Sessions and the "who is logged in" check happen on every single click, thousands of times a second, and losing one only means a re-login. Keeping them in Redis, which lives in memory, answers in a fraction of a millisecond and keeps that load off the main database.

Search with typos, filters and ranking is a different kind of computation again; Postgres can do a basic version, but Elasticsearch is designed for it. Importantly, Elasticsearch is only a copy: it is fed from Postgres and can be wiped and rebuilt at any time.

The rule we follow is one source of truth and a small number of specialised copies, each earning its place with a measured need, because each extra system is another thing to run and keep in sync.`,
      mustMention: [
        'Different workloads have different needs',
        'Postgres as the single system of record for transactional data',
        'Redis for hot, ephemeral, key-based reads',
        'Elasticsearch as a derived, rebuildable index',
        'Each extra store has operational and sync cost',
      ],
    },
    {
      id: 'fe3',
      concept: 'Consistency as a veto',
      prompt: 'Explain why "eventually consistent" is fine for a like counter but unacceptable for seat inventory, and what that implies for the database choice.',
      modelExplanation: `Eventually consistent means copies of the data agree after a short while, but for a moment two people might see different values. For a like counter, if you see 1,041 and I see 1,040 for a second, nothing bad happens; the number catches up and nobody cares.

Seat inventory is different. If two people both see "one seat left" and both buy it, we have sold the same seat twice and someone is turned away at the door. The rule "never sell a seat twice" cannot tolerate even a brief disagreement. Enforcing it needs the database to check and decrement the seat count in one atomic step, with a lock or a conditional update, and to reject the second buyer.

That requirement points to a database with real transactions and strong reads, which in practice means a relational database such as Postgres, or a distributed SQL system if the volume is truly huge. The like counter can live in Redis. Same app, two different guarantees, two different stores.`,
      mustMention: [
        'Definition of eventual consistency and its window',
        'Harmless for counters, harmful for inventory',
        'Need for atomic check-and-decrement',
        'Implies relational or distributed SQL for inventory',
        'Different guarantees per feature can mean different stores',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a bustling food-delivery company office, from the front desk to the kitchen at the back. Each room holds one part of the product and the database that serves it.',
    stops: [
      { locus: 'The front desk with a four-question form', concept: 'The decision framework', image: 'A stern receptionist refuses to let anyone pass until they fill in a form with four huge boxes: HOW DO YOU READ IT? CAN IT BE STALE? HOW MUCH? WILL THE QUESTIONS CHANGE? Behind her, a rack of database logos stays locked until the form is stamped.' },
      { locus: 'The vault in the finance office', concept: 'Payments and orders -> relational', image: 'A bank vault with a giant elephant (Postgres) inside, stamping every transaction with three seals at once: ORDER, CHARGE, DISCOUNT. If any seal fails the elephant tears up the whole page. Nothing ever leaves this vault half-done.' },
      { locus: 'The coat-check by the lifts', concept: 'Sessions -> Redis', image: 'Thousands of people per second hand red tickets to a blur of an attendant who returns their coats instantly. Coats left more than 30 minutes evaporate into steam. A sign reads: IF LOST, JUST LOG IN AGAIN.' },
      { locus: 'The radar room', concept: 'Live driver positions -> Redis geospatial', image: 'A glowing map where 200,000 scooter dots twitch every three seconds. A dispatcher draws a 2 km circle and every dot inside lights up. Yesterday\'s positions do not exist; the screen holds only now.' },
      { locus: 'The endless conveyor belt corridor', concept: 'Event history -> Cassandra/DynamoDB', image: 'A conveyor belt carries a never-ending stream of stamped tickets: PLACED, COOKING, PICKED UP, DELIVERED. They slide into shelves labelled by order id and sorted by time, and old tickets fall off the end after a year.' },
      { locus: 'The library with a card index', concept: 'Search -> Elasticsearch', image: 'A librarian instantly finds "thai" even when you say "tai", flipping through an inverted card index. Behind her a pipe from the finance vault drips fresh copies of every menu change; a sign says COPY ONLY, CAN BE REBUILT.' },
      { locus: 'The analysts\' observatory', concept: 'Analytics -> columnar warehouse', image: 'Analysts peer through a telescope that shows only one column of a giant spreadsheet at a time, compressed so tightly that a billion rows fit on a single slide. They ask a new question every minute and get answers in seconds.' },
      { locus: 'The zoo in the back garden', concept: 'Cost of polyglot persistence', image: 'Behind the office is a small zoo: an elephant, a red bird, a yellow-shirted librarian and a few more exotic beasts. A tired zookeeper with a clipboard mutters "each one needs feeding, fences and a vet", and a sign on the gate says ONE SOURCE OF TRUTH; THE REST ARE COPIES.' },
    ],
  },
  interviewQuestions: [
    'How do you decide which database to use for a new feature? Walk me through your framework.',
    'Which database would you use for a payments ledger and why not a NoSQL store?',
    'Design the storage for a chat application: messages, presence, user profiles, and search.',
    'When does it make sense to add Elasticsearch, and how do you keep it in sync with the source of truth?',
    'What are the costs of polyglot persistence and how do you keep them under control?',
    'When would you choose Cassandra over Postgres, and what would you lose?',
    'How would you store time-series metrics for 100k servers reporting every 10 seconds?',
    'A startup wants to use five databases on day one. How would you respond?',
  ],
}

export default chapter
