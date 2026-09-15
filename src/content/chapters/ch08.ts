import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 8,
  slug: 'non-relational-databases',
  title: 'Non Relational Databases',
  module: 'databases',
  estimatedMinutes: 40,
  summary:
    'NoSQL is not one thing but four families of stores, each shaped around a specific access pattern: documents, key-value pairs, wide columns and graphs. They trade the relational model\'s joins, schema enforcement and ACID guarantees for horizontal scale, flexible schemas and predictable latency at a specific workload. This chapter explains each family, the BASE and CAP ideas that describe their behaviour, why denormalisation is the price of admission, and when MongoDB, Redis, DynamoDB, Cassandra or Neo4j is the right call.',
  objectives: [
    'Describe the four NoSQL families (document, key-value, wide-column, graph) and the access pattern each is optimised for.',
    'Explain BASE and the CAP theorem accurately, including what a partition actually forces you to choose between.',
    'Explain why NoSQL stores denormalise data and what that costs on writes and consistency.',
    'Map real products (MongoDB, Redis, DynamoDB, Cassandra, Neo4j) to workloads where they shine and where they fail.',
    'Argue when a relational database is still the better default.',
  ],
  quickRevision: [
    'NoSQL = not one model but several: document, key-value, wide-column, graph. Each is optimised for one access pattern and weak elsewhere.',
    'Document stores (MongoDB, Couchbase) hold JSON-like documents; whole aggregate in one read; flexible schema; secondary indexes; weak at cross-document joins.',
    'Key-value stores (Redis, DynamoDB core, Memcached) do get/put by key at sub-millisecond latency; no queries on values.',
    'Wide-column stores (Cassandra, HBase, Bigtable, ScyllaDB) partition by a row key and sort by clustering columns; huge write throughput; you design one table per query.',
    'Graph stores (Neo4j, Neptune, JanusGraph) make relationships first-class; traversals are O(edges touched), not O(join size).',
    'BASE = Basically Available, Soft state, Eventually consistent: the pragmatic opposite of ACID for distributed stores.',
    'CAP: during a network partition a distributed store must choose between staying available (AP) and staying consistent (CP). Without a partition you can have both.',
    'CP examples: ZooKeeper, etcd, HBase, MongoDB with majority writes. AP examples: Cassandra, DynamoDB (default), CouchDB, Riak.',
    'Tunable consistency (Cassandra QUORUM, DynamoDB strongly consistent reads) lets you slide between AP and CP per request.',
    'NoSQL scales by sharding on a partition key; the key decides both distribution and which queries are cheap.',
    'Denormalisation: store data the way it is read, duplicated as needed. Reads become one lookup; writes must update every copy.',
    'Schema-less means schema-on-read: the application, not the database, now enforces structure.',
    'Pick NoSQL for a known, narrow access pattern at large scale; pick relational for evolving, join-heavy, transactional data.',
  ],
  sections: [
    {
      id: 'why-nosql',
      title: 'Why NoSQL exists: the relational bargain and its limits',
      body: `A relational database makes a specific bargain: you normalise data into tables, and in return you get **joins, arbitrary queries, a strict schema and ACID transactions**. That bargain is excellent until two things happen.

First, **scale**. Joins and transactions are cheap when all the data is on one machine. Spread the tables across servers (chapter 7) and joins become scatter-gather, transactions become 2PC, and the database\'s biggest strengths become its biggest costs. Relational engines were designed around a single node; horizontal scaling was bolted on later.

Second, **shape**. Some data is not tabular. A product with 40 optional attributes that differ per category, a user\'s activity feed, a social graph with billions of edges, or a time series of sensor readings all fit awkwardly into normalised tables and require many joins to reassemble.

Around 2005-2010, Google (Bigtable), Amazon (Dynamo) and Facebook (Cassandra) published designs that made a different bargain: **give up joins and general queries; get linear horizontal scale and predictable latency for a known access pattern.** The open-source world followed with MongoDB, Redis, Riak, HBase and Neo4j.

The umbrella term "NoSQL" is misleading. These systems share only what they are *not*. What matters is that each family is **optimised for one shape of access**:

- Document: fetch or update one aggregate (an order with its line items) by id.
- Key-value: get or set one opaque value by key, as fast as possible.
- Wide-column: append and range-scan enormous volumes keyed by partition and time.
- Graph: walk relationships many hops deep.

The design consequence: with SQL you model the *data* and then write any query. With NoSQL you model the *queries* and then lay out the data to serve them. Chapter 9 turns that into a decision framework.`,
      mentalModel:
        'A relational database is a Swiss Army knife: it does everything reasonably. Each NoSQL store is a specialised tool: a chef\'s knife, a saw, a scalpel. Faster and better at one job, useless or dangerous at another.',
      diagram: `Relational bargain             NoSQL bargain
+-------------------------+    +-------------------------------+
| normalise into tables   |    | model around the queries       |
| joins, ad-hoc SQL       |    | one aggregate / key / partition|
| strict schema, ACID     |    | flexible schema, BASE          |
| scale UP (one node)     |    | scale OUT (shard by key)       |
+-------------------------+    +-------------------------------+

Families:  Document | Key-Value | Wide-Column | Graph
           MongoDB  | Redis     | Cassandra   | Neo4j
           Couchbase| DynamoDB  | HBase       | Neptune`,
      keyPoints: [
        'Relational databases trade horizontal scale for joins, schema and ACID.',
        'NoSQL emerged from Bigtable, Dynamo and Cassandra to scale out by giving up joins and general queries.',
        '"NoSQL" is four different data models, each tuned to one access pattern.',
        'SQL: model the data, then query anything. NoSQL: model the queries, then lay out the data.',
      ],
      checkpoint: {
        question:
          'A team says "we chose NoSQL because it scales". What follow-up question exposes whether that is a good decision?',
        answer:
          'Which access pattern are you optimising for, and what queries will you no longer be able to run cheaply? NoSQL scales a known, narrow pattern by giving up joins and ad-hoc queries; if their queries are varied and evolving, "it scales" is buying capacity they may not need with flexibility they will miss.',
      },
    },
    {
      id: 'document-and-kv',
      title: 'Document stores and key-value stores',
      body: `**Key-value stores** are the simplest model: a dictionary. \`GET key\`, \`PUT key value\`, \`DELETE key\`. The value is opaque to the store, so it cannot query inside it, but that opacity is what lets it be blindingly fast and trivially sharded by hashing the key.

- **Redis** keeps everything in RAM with optional persistence, and adds rich value types: lists, sets, sorted sets, hashes, streams, HyperLogLog. Sub-millisecond latency and 100k+ ops/sec per node make it the default for sessions, caches, rate-limit counters, leaderboards and pub/sub. Cost: data must fit in memory (expensive), and durability is weaker than a disk-based store.
- **DynamoDB** is a managed, disk-backed key-value/document store with single-digit-millisecond latency at any scale, pay-per-request pricing and automatic partitioning. Cost: every query must be by partition key (plus optional sort key or a secondary index); anything else is a full scan.
- **Memcached** is a pure volatile cache, simpler than Redis and multi-threaded.

**Document stores** extend key-value by making the value a structured document (JSON/BSON) that the database understands. You can index fields inside the document, query by them, and update part of a document atomically.

- **MongoDB** is the canonical example: collections of documents, secondary indexes on any field, an aggregation pipeline, and native sharding with a chosen shard key. Since 4.0 it offers multi-document ACID transactions, though they are slower than single-document writes.
- **Couchbase** and **CouchDB** are similar with different replication stories.

The document model shines when one entity and everything the UI needs about it can be stored together as an **aggregate**: an order document containing its line items, shipping address snapshot and payment status. One read replaces a five-table join. The pain appears when data is shared between aggregates: a product name embedded in a million order documents must be updated a million times if it changes, or accepted as a historical snapshot.

Schema flexibility is real but double-edged. Adding a field requires no migration, so product teams move fast; but three years later a collection may hold five silent versions of the same document shape, and every reader must handle all of them. The schema did not disappear; it moved into the application code.`,
      mentalModel:
        'A key-value store is a coat check: hand over a ticket, get your coat, no questions about what is in the pockets. A document store is a filing cabinet of folders: each folder holds everything about one case, and the clerk can find folders by any label you asked them to track.',
      diagram: `Key-Value
  "session:8f3a" -> { user:42, exp:1712345 }   opaque blob
  GET / SET / DEL by key only

Document (MongoDB)
  orders: {
    _id: "o-981", customer: 42,
    items: [ {sku:"A1", qty:2, name:"Mug"},
             {sku:"B7", qty:1, name:"Pen"} ],
    status: "PAID"
  }
  index on customer, status  ->  findable by field
  whole aggregate in one read; no join needed`,
      keyPoints: [
        'Key-value: opaque value, hash-sharded by key, fastest possible get/put; Redis (in-memory), DynamoDB (managed, disk), Memcached.',
        'Document: structured value with secondary indexes and partial updates; MongoDB, Couchbase.',
        'Model documents as aggregates so one read serves one screen.',
        'Shared data embedded in many documents must be updated everywhere or accepted as a snapshot.',
        'Schema-less means the schema lives in your code and versions silently over time.',
      ],
      checkpoint: {
        question:
          'You store a blog post as one MongoDB document with all its comments embedded. Predict what breaks when a post gets 50,000 comments.',
        answer:
          'The document grows huge (MongoDB caps documents at 16 MB), every read of the post loads all comments, and every new comment rewrites a giant document. The fix is to split comments into their own collection keyed by post_id with pagination, embedding only the latest few in the post. Aggregates should be bounded in size.',
      },
    },
    {
      id: 'wide-column-and-graph',
      title: 'Wide-column stores and graph databases',
      body: `**Wide-column stores** descend from Google\'s Bigtable paper. Data is organised into tables, but a "row" is really a **partition** identified by a partition key, containing many **cells** sorted by clustering columns. Different rows may have completely different columns, hence "wide".

- **Cassandra** (and its C++ rewrite **ScyllaDB**) is masterless: every node is equal, data is placed by consistent hashing, and replication factor plus per-query consistency level (ONE, QUORUM, ALL) are tunable. Writes are append-only into an LSM tree, so write throughput is enormous and linear with node count. Netflix, Apple and Discord (before its move to ScyllaDB) run clusters of hundreds of nodes.
- **HBase** sits on HDFS and is CP, with a single region server owning each range at a time.
- **Bigtable** is the Google original, used for Search, Maps and Gmail.

The wide-column design rule is **one table per query**. To show "messages in channel X, newest first" you create a table partitioned by \`channel_id\` and clustered by \`message_id DESC\`. To show "messages by user Y" you create *another* table with the same data partitioned by \`user_id\`. Writes are duplicated; reads are a single sequential partition scan. There are no joins and, in Cassandra, no efficient queries that do not start with the partition key. Partitions must also stay bounded (rule of thumb: under 100 MB or ~100k cells) or you get hot, slow partitions.

**Graph databases** invert the relational join. In SQL, following a relationship means an index lookup per hop, and a five-hop query ("friends of friends of friends who like X") multiplies join cost. In a native graph store like **Neo4j**, each node physically holds pointers to its edges, so traversal cost depends on how many edges you actually walk, not on the total size of the graph. This is called *index-free adjacency*.

Graph stores fit social networks, fraud rings (who shares a device or address with whom), recommendation ("users who bought this also bought"), knowledge graphs and dependency analysis. **Neo4j** (Cypher query language), **Amazon Neptune**, **JanusGraph** and **TigerGraph** are common. Their weakness is bulk analytics over all nodes and horizontal write scaling; sharding a graph is a hard research problem because edges cross shard boundaries.`,
      mentalModel:
        'A wide-column store is a warehouse of long shelves: the shelf label is the partition key, items on a shelf are sorted, and you always walk to one shelf and read along it. A graph database is a city map where every junction already has arrows to its neighbours, so you never consult an index to find the next street.',
      diagram: `Wide-column (Cassandra) : one table per query
 messages_by_channel        PARTITION KEY = channel_id
 channel 7 | msg 105 | msg 104 | msg 103 | ...   (sorted DESC)
 channel 9 | msg 88  | msg 61  | ...

 messages_by_user           same data, different partition key
 user 42   | msg 105 | msg 88 | ...

Graph (Neo4j): pointers, not joins
 (Alice)-[:FRIEND]->(Bob)-[:FRIEND]->(Cara)-[:LIKES]->(Jazz)
 3 hops = follow 3 pointers, independent of total graph size`,
      keyPoints: [
        'Wide-column: partition key + clustering columns, LSM append-only writes, linear write scaling; Cassandra, ScyllaDB, HBase, Bigtable.',
        'Design rule: one table per query pattern, with data duplicated across tables.',
        'Queries must start with the partition key; keep partitions bounded.',
        'Graph: index-free adjacency makes multi-hop traversals cheap; Neo4j, Neptune, JanusGraph.',
        'Graphs are hard to shard because edges cross machine boundaries.',
      ],
      checkpoint: {
        question:
          'In Cassandra you model sensor readings with partition key = sensor_id and clustering key = timestamp. A sensor emits 1 reading/sec for 3 years. What goes wrong and how do you fix it?',
        answer:
          'One partition accumulates ~95 million cells, far past the ~100k cell / 100 MB guideline, making reads and compaction slow and creating a hot node. Use a compound partition key such as (sensor_id, day) or (sensor_id, month) so each partition stays bounded; queries for a time range then touch a few consecutive partitions.',
      },
    },
    {
      id: 'cap',
      title: 'CAP: what a partition actually forces you to choose',
      body: `The CAP theorem (Brewer 2000, proved by Gilbert and Lynch 2002) is quoted constantly and usually wrong. The precise statement: a distributed data store cannot simultaneously guarantee **Consistency** (every read sees the latest write, i.e. linearizability), **Availability** (every request to a non-failed node gets a non-error response) and **Partition tolerance** (the system keeps operating when messages between nodes are lost).

The misreading is "pick two of three". Network partitions are not optional in a distributed system; cables get cut and switches fail. So the real choice is: **when a partition happens, do you refuse some requests (CP) or serve possibly stale data (AP)?** When there is no partition, a well-built system offers both C and A.

Picture two replicas, R1 and R2, that can no longer talk. A client writes X=5 to R1. Another client reads X from R2.

- **CP**: R2 cannot confirm it has the latest value, so it returns an error or blocks until the partition heals. Consistent, but unavailable on R2\'s side. ZooKeeper, etcd, HBase, and MongoDB with majority write concern behave this way; a minority side of a partition stops accepting writes.
- **AP**: R2 returns its last known value (X=3). Available, but stale. Cassandra at consistency ONE, DynamoDB eventually consistent reads, CouchDB and Riak behave this way, then reconcile with last-write-wins, vector clocks or CRDTs after the partition heals.

Many systems are **tunable**. Cassandra with replication factor 3 and QUORUM for both reads and writes (2 + 2 > 3) guarantees a read overlaps the latest write, so it behaves as CP for that operation; drop to ONE and it is AP. DynamoDB offers a strongly consistent read flag at double the cost.

CAP also says nothing about **latency**, which is what actually drives most designs. Daniel Abadi\'s PACELC extension captures it: during a Partition choose A or C, Else (in normal operation) choose between Latency and Consistency. Most AP systems are AP/EL: they prefer speed even when healthy.

Relational databases on a single node are simply "CA": no partition can occur inside one machine. That is why they need not make this choice, and why the choice appears the moment you replicate or shard.`,
      mentalModel:
        'Two bank tellers in different branches lose their phone line. A CP bank locks the account until the line is back ("come back later"). An AP bank lets each teller work from their own ledger and sorts out the mess when the line returns, possibly discovering an overdraft.',
      diagram: `          client A: write X=5        client B: read X
               |                          |
           +---v---+     ~~ PARTITION ~~  +---v---+
           |  R1   |  X====X====X====X    |  R2   |
           | X = 5 |  (no messages)       | X = 3 |
           +-------+                      +-------+

  CP: R2 answers "unavailable" / blocks   -> consistent, not available
  AP: R2 answers X = 3 (stale)            -> available, not consistent

  No partition: both C and A are achievable.`,
      keyPoints: [
        'CAP is about behaviour during a network partition, not a free "pick two".',
        'CP: refuse or block rather than return stale data (ZooKeeper, etcd, HBase).',
        'AP: always answer, possibly stale, reconcile later (Cassandra ONE, Dynamo, Riak).',
        'Tunable consistency (QUORUM, strongly consistent reads) moves one system between CP and AP per request.',
        'PACELC adds the latency-vs-consistency choice during normal operation.',
      ],
      checkpoint: {
        question:
          'Cassandra with replication factor 3. You write at consistency ONE and read at consistency ONE. Can a read miss a successful write? What settings fix it?',
        answer:
          'Yes. The write is acknowledged once one replica has it; the read may hit one of the other two before replication catches up, returning old data. Use QUORUM (2) for both reads and writes so 2 + 2 > 3 guarantees overlap, or write ALL and read ONE. The price is higher latency and lower availability when a node is down.',
      },
    },
    {
      id: 'base',
      title: 'BASE: the consistency model most NoSQL stores actually offer',
      body: `ACID (Atomic, Consistent, Isolated, Durable) describes what a single-node relational transaction promises. Distributed NoSQL systems generally promise **BASE** instead, a deliberately playful acronym:

- **Basically Available**: the system responds to every request, even during failures, even if the answer is stale or a partial result. This is the AP choice from CAP applied as a design philosophy.
- **Soft state**: the state of the system may change over time *without new input*, because replicas are still converging. A value you read now might differ from one you read a second later even though nobody wrote in between.
- **Eventually consistent**: if writes stop, all replicas will converge to the same value within some bounded time. Amazon\'s Dynamo paper reports 99.94% of reads seeing a single version, but the 0.06% that see divergence must be handled.

Why accept this? Because coordination is expensive. Guaranteeing that every replica agrees before acknowledging a write means every write waits for the slowest replica, and a single slow or partitioned node blocks everyone. Dropping to eventual consistency lets each node accept writes locally and gossip them later, which is how Cassandra and DynamoDB deliver predictable low latency and near-linear scaling across regions.

The application must now deal with consequences that ACID hid:

- **Read-your-own-writes** may fail: a user posts a comment, refreshes, and it is gone for a second. Fixes: read from the same replica you wrote to, or use session consistency (MongoDB, Cosmos DB offer this).
- **Conflicting concurrent writes**: two replicas accept different values. Resolution strategies include last-write-wins (Cassandra, simple but loses data), vector clocks with client-side merge (Dynamo), or CRDTs that merge automatically (Riak, Redis Enterprise).
- **Non-monotonic reads**: a user sees a new value, then an older one from a lagging replica. Sticky sessions or monotonic-read guarantees prevent it.

Eventual consistency is not "no consistency". It is a contract with a window, and good designs make the window small (milliseconds within a region) and make the UI tolerant (optimistic updates, "posting..." states). Where the business rule cannot tolerate any window, such as a bank balance or seat inventory, you need stronger guarantees: quorum operations, conditional writes, or a CP store.`,
      mentalModel:
        'ACID is a notary who will not stamp a document until every party has signed in the same room. BASE is email: everyone gets the memo eventually, a few read an old draft, and if two people edit at once someone has to merge.',
      keyPoints: [
        'BASE = Basically Available, Soft state, Eventually consistent; the AP philosophy as a data model.',
        'Eventual consistency buys low latency and availability by avoiding coordination on every write.',
        'Anomalies to handle: missing read-your-writes, write conflicts, non-monotonic reads.',
        'Conflict resolution: last-write-wins, vector clocks, CRDTs.',
        'Stronger guarantees (quorum, conditional writes, CP stores) where a staleness window is unacceptable.',
      ],
    },
    {
      id: 'denormalisation',
      title: 'Denormalisation: store data the way you read it',
      body: `Normalisation removes duplication so each fact lives in exactly one place; joins reassemble it at read time. That is the right trade when storage is precious and writes are as common as reads. NoSQL stores flip it: **duplicate freely so that each read is one lookup.** This is denormalisation, and it is not a shortcut but the fundamental technique of NoSQL modelling.

Consider a social feed. Normalised: \`posts(author_id, text)\`, \`users(id, name, avatar)\`, \`follows(follower, followee)\`. Rendering a timeline means: find who I follow, fetch their latest posts, join each post to its author for name and avatar. At Twitter scale that is thousands of joins per second per user.

Denormalised: each post document embeds \`author_name\` and \`author_avatar\`. Better, a **fan-out on write** precomputes each user\'s timeline: when Alice posts, the system appends the post id into the timeline list of each of her followers (Redis lists or a Cassandra table partitioned by \`viewer_id\`). Reading a timeline is one partition read. Twitter does this for most users and switches to fan-out on read for celebrities with tens of millions of followers, because writing 100M timeline entries per tweet is too expensive.

The costs are exactly the things normalisation protected you from:

1. **Write amplification.** One logical write becomes N physical writes. Alice changes her avatar; every embedded copy is now stale unless you update or accept it.
2. **Consistency drift.** Copies are updated at different times; readers may briefly see mixed states.
3. **Storage.** Duplication can multiply size by an order of magnitude. Disk is cheap, but memory (Redis) is not.
4. **Query rigidity.** You built tables for the queries you knew. A new query the product team invents next quarter may need a new table and a backfill of all historical data.

The discipline: enumerate the queries first, then design one read path per query, then decide for each duplicated field whether to propagate updates (worth it for avatars), accept snapshots (correct for the price on an order), or recompute periodically (fine for follower counts).`,
      mentalModel:
        'A normalised database is a library with one copy of each book and a catalogue that tells you where to find every fact. A denormalised store is a pre-packed bag for each reader with photocopies of every page they will want, ready to grab and go. Fast to read, but when a page changes you must reprint every bag that contains it.',
      diagram: `Normalised (join at read)          Denormalised (join at write)
 posts   users   follows            timeline[viewer=Bob]
   |       |        |                 [ {post 91, "Alice", av.png},
   +---JOIN+---JOIN-+                   {post 88, "Cara", cara.png},
           |                            ... ]
   timeline for Bob                   one partition read
   (3 lookups + merge per view)
                                    Alice posts -> write into every
                                    follower's timeline (fan-out)`,
      keyPoints: [
        'Denormalise to make each read a single lookup on one partition or document.',
        'Fan-out on write precomputes read paths (timelines); fan-out on read is used for celebrities.',
        'Costs: write amplification, consistency drift, storage, rigid query set.',
        'Per duplicated field decide: propagate updates, keep as snapshot, or recompute periodically.',
      ],
      checkpoint: {
        question:
          'An e-commerce order document embeds product name and price at purchase time. The product\'s price changes a week later. Should the order document be updated? Why?',
        answer:
          'No. The price is a historical snapshot: the customer paid the old price and the invoice must reflect it. This is a case where denormalised duplication is not merely acceptable but correct. Product name is a judgement call; many systems keep the snapshot too so the order matches the receipt.',
      },
    },
    {
      id: 'when-nosql-fits',
      title: 'When NoSQL fits: matching the store to the job',
      body: `The right store is the one whose native access pattern matches your dominant query. Concrete pairings:

**Redis (key-value, in-memory).** Sessions, caches, rate limiters, leaderboards (sorted sets), distributed locks, real-time counters, pub/sub. Fits when latency must be sub-millisecond and the dataset fits in RAM. Wrong when data is the system of record and must survive with strict durability, or is larger than memory budgets allow.

**DynamoDB (managed key-value/document).** Shopping carts, user profiles, device state, order lookups by id, any workload with a clear partition key and predictable access. Fits when you want zero operations and pay-per-request at any scale. Wrong when queries are ad hoc: each new access pattern needs a Global Secondary Index (extra cost, eventual consistency) or a scan.

**MongoDB (document).** Product catalogues with heterogeneous attributes, content management, user-generated content, rapid prototyping where the schema is still evolving. Fits when entities are natural aggregates read as a whole. Wrong when the data is highly relational with many-to-many relationships crossing aggregates, or when you need strict multi-row transactions as the norm.

**Cassandra / ScyllaDB (wide-column).** Time-series and event data, messaging history (Discord stored trillions of messages this way), IoT telemetry, activity logs, anything write-heavy with queries by partition key and time range, especially multi-region. Fits when writes dominate and availability matters more than immediate consistency. Wrong for ad-hoc analytics, small datasets, or anything needing joins or transactions.

**Neo4j / Neptune (graph).** Social graphs, fraud detection across shared attributes, recommendations, permission hierarchies, network topology, knowledge graphs. Fits when queries are multi-hop traversals. Wrong for high-volume simple lookups or whole-graph aggregations, which are better served by a warehouse.

**Postgres / MySQL (relational) remain the default** when the access pattern is not yet known, when data has many relationships queried in varied ways, when transactions across entities are frequent (payments, inventory, bookings), and when the scale fits one primary plus replicas, which covers most businesses. Postgres with JSONB columns even absorbs many "document" use cases.

The mature pattern is **polyglot persistence**: Postgres as the system of record, Redis for caching and sessions, Elasticsearch for search, Cassandra or ClickHouse for events, and a graph store only if traversals are central. Each additional store is an operational and consistency burden, so add one only when its access pattern is dominant enough to justify it.`,
      mentalModel:
        'Choosing a database is choosing a vehicle for a known route. Redis is a motorbike: fastest through the city, carries little. Cassandra is a freight train: enormous volume along fixed tracks. Neo4j is a helicopter for hopping between rooftops. Postgres is a sensible car: goes almost anywhere, which is why most trips start in one.',
      diagram: `Dominant access pattern            -> store
 get/set by key, sub-ms, in RAM     -> Redis / Memcached
 get by key, managed, any scale     -> DynamoDB
 read/update one aggregate by id    -> MongoDB
 append + range-scan by key & time  -> Cassandra / ScyllaDB / HBase
 multi-hop relationship traversal   -> Neo4j / Neptune
 varied joins, transactions, unsure -> Postgres / MySQL (default)`,
      keyPoints: [
        'Redis: sessions, caches, counters, leaderboards; in-memory and sub-millisecond.',
        'DynamoDB: key-based workloads at scale with zero ops; each new query pattern costs an index.',
        'MongoDB: aggregate-shaped entities and evolving schemas; weak at cross-aggregate relations.',
        'Cassandra/ScyllaDB: write-heavy time-series and messaging with partition-key queries; AP and multi-region.',
        'Neo4j/Neptune: multi-hop traversals; poor at bulk aggregation and horizontal writes.',
        'Relational remains the default; add specialised stores only for a dominant pattern (polyglot persistence).',
      ],
      checkpoint: {
        question:
          'A ride-hailing app needs: (a) driver locations updated every 3 seconds and queried by proximity, (b) completed trip receipts queried by rider and date, (c) payments. Assign a store type to each and justify.',
        answer:
          '(a) Redis with geospatial indexes (GEOADD/GEOSEARCH): high write rate, in-memory, ephemeral, sub-millisecond proximity lookups. (b) Cassandra or DynamoDB partitioned by rider_id and clustered by trip time: write-heavy, append-only, queried by key and range. (c) Postgres: money needs ACID transactions, exact balances and audits; volume is modest.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Which pairing of NoSQL family and product is correct?',
      options: [
        'Graph: Cassandra',
        'Wide-column: Neo4j',
        'Document: MongoDB',
        'Key-value: HBase',
      ],
      answerIndex: 2,
      explanation:
        'MongoDB is the canonical document store. Cassandra and HBase are wide-column stores, and Neo4j is a graph database.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'What does the "E" in BASE stand for, and what does it mean?',
      options: [
        'Exclusive: only one writer at a time',
        'Eventually consistent: replicas converge if writes stop',
        'Encrypted: data is encrypted at rest',
        'Elastic: nodes can be added freely',
      ],
      answerIndex: 1,
      explanation:
        'BASE is Basically Available, Soft state, Eventually consistent. The last means all replicas reach the same value given enough time without new writes; it says nothing about encryption or elasticity.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'According to CAP, what is the choice a distributed store actually has to make?',
      options: [
        'Pick any two of consistency, availability and partition tolerance at design time',
        'During a network partition, either return possibly stale data or refuse/block some requests',
        'Choose between consistency and durability',
        'Choose between SQL and NoSQL',
      ],
      answerIndex: 1,
      explanation:
        'Partitions are unavoidable in distributed systems, so partition tolerance is not optional. The real choice arises during a partition: stay available with stale data (AP) or stay consistent by refusing requests (CP). Without a partition, both C and A are achievable.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which of these systems are typically classified as CP (favour consistency during a partition)? Select all that apply.',
      options: ['ZooKeeper', 'Cassandra at consistency ONE', 'etcd', 'HBase', 'CouchDB'],
      answerIndices: [0, 2, 3],
      explanation:
        'ZooKeeper and etcd are consensus-based coordination stores that reject writes on the minority side; HBase has a single owner per region. Cassandra at ONE and CouchDB accept writes anywhere and reconcile later, which is AP.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement: 'In Cassandra with replication factor 3, writing and reading at QUORUM guarantees that a read observes the most recent acknowledged write.',
      answer: true,
      explanation:
        'QUORUM is 2 of 3 replicas. Any two-replica write set and any two-replica read set must overlap in at least one node (2 + 2 > 3), so the read sees the latest write. At ONE/ONE this guarantee is lost.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 2,
      question: 'What is the key modelling rule in a wide-column store such as Cassandra?',
      options: [
        'Normalise into third normal form and join at read time',
        'Design one table per query pattern, duplicating data as needed, with queries starting from the partition key',
        'Store every entity as one large JSON document',
        'Use foreign keys to enforce referential integrity',
      ],
      answerIndex: 1,
      explanation:
        'Cassandra has no joins and only efficient partition-key lookups, so each query gets its own table. Normalisation and foreign keys are relational tools; big JSON documents are the document-store pattern.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question: 'A fraud team must find accounts connected within 4 hops through shared devices, addresses or cards, in real time. Which store fits best and why?',
      options: [
        'Redis, because it is the fastest store',
        'A graph database such as Neo4j, because multi-hop traversal cost depends on edges walked, not total data size',
        'Cassandra, because it scales writes linearly',
        'MongoDB, because documents are flexible',
      ],
      answerIndex: 1,
      explanation:
        'Multi-hop relationship queries are exactly what index-free adjacency in a graph store makes cheap. In relational or document stores each hop is another join or lookup that grows with dataset size. Speed of Redis or write scale of Cassandra does not help traversal.',
    },
    {
      type: 'mcq',
      id: 'q8',
      difficulty: 2,
      question: 'What is the primary cost of denormalising author name and avatar into every post document?',
      options: [
        'Reads become slower',
        'When the author changes their avatar, every copy must be updated or will be stale (write amplification)',
        'The database can no longer be sharded',
        'Documents can no longer be indexed',
      ],
      answerIndex: 1,
      explanation:
        'Denormalisation makes reads faster (one lookup) at the price of updating many copies on change. Sharding and indexing are unaffected.',
    },
    {
      type: 'truefalse',
      id: 'q9',
      difficulty: 1,
      statement: 'A "schema-less" document store means the application no longer needs to care about data structure.',
      answer: false,
      explanation:
        'The schema moves from the database into the application code (schema-on-read). Over time a collection accumulates multiple document versions, and every reader must handle all of them, which is often harder than a migration.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 3,
      question:
        'Twitter precomputes most users\' timelines on write but not for celebrities with 50M followers. Why the exception?',
      options: [
        'Celebrities demand stronger consistency',
        'Fan-out on write would require tens of millions of timeline inserts per tweet, so their tweets are merged in at read time instead',
        'Graph databases cannot store celebrity accounts',
        'Redis cannot store lists longer than 1,000 items',
      ],
      answerIndex: 1,
      explanation:
        'Fan-out on write costs one insert per follower; for 50M followers that is prohibitive per tweet. A hybrid fetches celebrity tweets at read time and merges them, trading a little read latency for enormous write savings.',
    },
    {
      type: 'mcq',
      id: 'q11',
      difficulty: 3,
      question: 'Which workload is the weakest fit for DynamoDB?',
      options: [
        'Shopping cart lookups by user_id',
        'IoT device state keyed by device_id',
        'Analysts running new, unpredictable ad-hoc queries across all columns each week',
        'Session storage keyed by session token',
      ],
      answerIndex: 2,
      explanation:
        'DynamoDB excels at key-based access; every new query pattern needs a secondary index or an expensive full scan. Ad-hoc analytics belong in a warehouse or relational store. The other three are textbook key-value workloads.',
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 3,
      question:
        'A user posts a comment on a Cassandra-backed forum, refreshes immediately and does not see it. Explain the cause and give two fixes with their trade-offs.',
      modelAnswer: `**Cause:** the write was acknowledged at a low consistency level (e.g. ONE) by one replica, and the refresh read hit a different replica that had not yet received it: eventual consistency violating read-your-own-writes.

**Fixes:**
1. **Raise consistency**: write and read at QUORUM (or LOCAL_QUORUM). Guarantees overlap, at the cost of higher latency and reduced availability if a replica is down.
2. **Session or sticky routing**: route a user\'s reads to the replica that took their write, or use a client-side session token (MongoDB and Cosmos DB offer session consistency). Cheap, but only protects that user, not other viewers.
3. **UI optimism**: render the comment locally as "posted" without waiting for the read. Hides the window rather than closing it; fine for comments, wrong for balances.`,
      rubric: [
        'Identifies eventual consistency / replica lag as the cause.',
        'Names read-your-own-writes as the violated guarantee.',
        'Proposes quorum-level consistency and states its latency/availability cost.',
        'Proposes a session/sticky or UI-level fix and notes its limits.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 2,
      question:
        'Explain in your own words why NoSQL databases encourage duplicating data, and how you decide what to do when a duplicated value changes.',
      modelAnswer: `NoSQL stores cannot join cheaply across partitions or documents, so they store data pre-assembled in the shape each query reads it. That means the same fact (a product name, an author\'s avatar) appears in many places. Reads become a single lookup; the price is that one logical update becomes many physical updates.

For each duplicated field ask: does the reader need the current value or the historical one? Prices on an order are snapshots and must not change. Avatars should propagate, typically via an async job or event that rewrites copies. Aggregates like follower counts can simply be recomputed on a schedule. If a field changes often and must always be current, do not embed it: reference it and pay for the second lookup.`,
      rubric: [
        'Explains lack of joins as the reason for duplication.',
        'States the read-speed vs write-amplification trade-off.',
        'Distinguishes snapshot fields from propagated fields.',
        'Mentions async propagation or periodic recomputation as mechanisms.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Four NoSQL families', back: 'Document (MongoDB), key-value (Redis, DynamoDB), wide-column (Cassandra, HBase, Bigtable), graph (Neo4j, Neptune). Each optimised for one access pattern.' },
    { id: 'f2', front: 'Core trade of NoSQL vs relational', back: 'Give up joins, ad-hoc queries and cross-entity ACID; gain horizontal scale, flexible schema and predictable latency for a known access pattern.' },
    { id: 'f3', front: 'Key-value store characteristics', back: 'Opaque value, get/put/delete by key, hash-sharded, sub-ms (Redis in RAM) or single-digit ms (DynamoDB). No queries on values.' },
    { id: 'f4', front: 'Document store characteristics', back: 'JSON-like documents with secondary indexes and partial updates. Model as bounded aggregates. MongoDB caps documents at 16 MB.' },
    { id: 'f5', front: 'Wide-column store structure', back: 'Partition key selects a node; clustering columns sort cells within the partition. LSM append-only writes. One table per query.' },
    { id: 'f6', front: 'Index-free adjacency', back: 'Graph DB property: each node stores direct pointers to its edges, so traversal cost depends on edges walked, not total graph size.' },
    { id: 'f7', front: 'CAP theorem (precise)', back: 'During a network partition a distributed store must choose availability (serve stale) or consistency (refuse/block). Without a partition, both are achievable.' },
    { id: 'f8', front: 'CP vs AP examples', back: 'CP: ZooKeeper, etcd, HBase, MongoDB majority writes. AP: Cassandra at ONE, DynamoDB eventual reads, CouchDB, Riak.' },
    { id: 'f9', front: 'Quorum rule for strong reads', back: 'With N replicas, W + R > N guarantees a read overlaps the latest write. RF=3: QUORUM (2) for both reads and writes.' },
    { id: 'f10', front: 'BASE', back: 'Basically Available, Soft state, Eventually consistent. The pragmatic opposite of ACID for distributed stores.' },
    { id: 'f11', front: 'PACELC', back: 'If Partition: choose A or C. Else: choose Latency or Consistency. Captures that most AP systems also prefer speed when healthy.' },
    { id: 'f12', front: 'Eventual-consistency anomalies', back: 'Missing read-your-own-writes, conflicting concurrent writes, non-monotonic reads. Fixes: quorum, session consistency, sticky replicas, CRDTs.' },
    { id: 'f13', front: 'Conflict resolution strategies', back: 'Last-write-wins (simple, loses data), vector clocks with client merge (Dynamo), CRDTs that merge automatically (Riak, Redis Enterprise).' },
    { id: 'f14', front: 'Denormalisation in NoSQL', back: 'Store data pre-assembled per query; duplicate freely. Reads: one lookup. Costs: write amplification, drift, storage, rigid query set.' },
    { id: 'f15', front: 'Fan-out on write vs on read', back: 'On write: push a post into every follower timeline (fast reads). On read: merge at view time (used for celebrities to avoid millions of inserts).' },
    { id: 'f16', front: 'When Cassandra fits', back: 'Write-heavy time-series, messaging history, IoT, logs; partition-key + time-range queries; multi-region AP. Not for ad-hoc analytics or joins.' },
    { id: 'f17', front: 'When to keep relational', back: 'Unknown or evolving access patterns, many-to-many relations, frequent multi-entity transactions (payments, inventory), scale fits one primary + replicas.' },
    { id: 'f18', front: 'Polyglot persistence', back: 'Using several stores, each for its dominant pattern: Postgres record, Redis cache, Elasticsearch search, Cassandra events. Each adds ops and consistency burden.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'The CAP theorem',
      prompt: 'Explain the CAP theorem to a developer who has only used a single Postgres server, and correct the common "pick two" misunderstanding.',
      modelExplanation: `On one Postgres server there is no CAP problem: one machine always agrees with itself. The trouble starts when you copy data to two servers in different places so that you survive failures. Now a network cable between them can fail, and each server keeps running without knowing what the other one did. That is a partition.

During a partition you face a real choice. If a client asks server B for a value that may have just been updated on server A, B can either answer with what it has, which might be stale, or refuse until the network heals. Answering is "available"; refusing is "consistent". You cannot do both while the link is down.

The "pick two of three" version is misleading because partitions are not a choice; they happen. So every distributed store is really choosing how to behave when they do. ZooKeeper refuses; Cassandra answers. And when the network is healthy, a good system gives you both consistency and availability, so CAP only describes the bad moments.`,
      mustMention: [
        'Single node has no partition, hence no CAP trade-off',
        'Partition = nodes cannot communicate',
        'During partition: serve stale (available) or refuse (consistent)',
        'Partitions are not optional, so it is not a free "pick two"',
        'Concrete CP and AP examples',
      ],
    },
    {
      id: 'fe2',
      concept: 'Why NoSQL denormalises',
      prompt: 'Explain why a Cassandra or MongoDB schema looks so different from a normalised SQL schema, using a social feed as the example.',
      modelExplanation: `In SQL you store each fact once: a users table, a posts table, a follows table. To show someone\'s feed you join them together at read time. The database does that join quickly because everything is on one machine with indexes.

NoSQL stores spread data across many machines by key. A join across machines means asking several servers and stitching results, which is slow and gets slower as you grow. So instead of joining at read time, you join at write time: when Alice posts, you copy her post, her name and her avatar directly into a "timeline" record for each of her followers. Showing Bob\'s feed is then one read of one record on one machine.

The price is duplication. Alice\'s avatar now exists in millions of places, and changing it means rewriting them all, or accepting that some are stale for a while. You also only get the queries you designed for; a brand new query may need a new table and a backfill. That is the NoSQL bargain: fast, predictable reads for the queries you know, paid for with heavier writes and less flexibility.`,
      mustMention: [
        'Joins across machines are expensive',
        'Join at write time instead of read time',
        'Fan-out into per-viewer timelines',
        'Duplication causes write amplification and staleness',
        'Only the queries you designed for are cheap',
      ],
    },
    {
      id: 'fe3',
      concept: 'Choosing between the NoSQL families',
      prompt: 'A colleague asks "should we use MongoDB, Redis or Cassandra?" Explain how you would decide, in plain terms.',
      modelExplanation: `The question to ask is not which is best but what the main read and write pattern looks like. If you need to grab or update one thing by a key extremely fast and it can live in memory, such as a session, a counter, or a cache, that is Redis. If you have entities that are naturally self-contained, like a product with all its attributes or an order with its line items, and you want to fetch and index them as whole documents while the schema is still changing, that is MongoDB. If you are writing enormous streams of events, messages or sensor readings and reading them back by an id and a time range, possibly across regions, and you can accept slightly stale reads, that is Cassandra.

Then check the failure cases. Redis is limited by RAM and is not a durable system of record. MongoDB struggles when data is shared between many documents. Cassandra cannot do ad-hoc queries or joins at all. If the honest answer is "our queries are varied and still changing", none of them fit yet and Postgres is the safer start.`,
      mustMention: [
        'Decide by dominant access pattern, not by popularity',
        'Redis: key lookups, in-memory, sub-millisecond',
        'MongoDB: self-contained aggregates, evolving schema',
        'Cassandra: write-heavy, key + time-range reads, AP',
        'Postgres when patterns are unknown or varied',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a night market with four very different stalls, then past the broken bridge that splits the market in two. Each stop anchors one idea about non-relational databases.',
    stops: [
      { locus: 'The coat-check booth at the entrance', concept: 'Key-value stores', image: 'A lightning-fast attendant snatches your numbered ticket and hurls back your coat before you finish blinking. She refuses to tell you what is in any pocket: "I only know tickets, not contents." A neon sign above reads REDIS, and the booth is visibly hot because everything is kept in a glowing memory chest.' },
      { locus: 'The folder stall', concept: 'Document stores', image: 'A vendor sells fat manila folders, each holding everything about one order: receipts, addresses, photos stapled inside. Some folders are so overstuffed with comments that they burst at a red line marked 16 MB.' },
      { locus: 'The endless shelf warehouse', concept: 'Wide-column stores', image: 'Behind a tarp, shelves stretch to the horizon. Each shelf is labelled with a partition key and items are sorted by time. A forklift stacks the same crates onto three different shelves labelled by_channel, by_user, by_date: one shelf per question.' },
      { locus: 'The rope bridge web', concept: 'Graph databases', image: 'Stalls are connected by ropes with arrows: FRIEND, BOUGHT, LIVES_WITH. A detective swings from rope to rope four hops deep, never once consulting a map, tracking a fraud ring in seconds.' },
      { locus: 'The collapsed footbridge in the middle of the market', concept: 'CAP theorem', image: 'The market is split by a fallen bridge. On the left, a vendor shouts stale prices from memory and keeps selling (AP). On the right, a vendor has locked her till and refuses to trade until the bridge is rebuilt (CP). A banner reads: WITHOUT THE BRIDGE DOWN, BOTH SIDES AGREE.' },
      { locus: 'The rumour mill fountain', concept: 'BASE and eventual consistency', image: 'Prices ripple outwards from the fountain by whispered gossip. For a few seconds, two stalls quote different numbers for the same mango. Eventually the whispers settle and every chalkboard matches.' },
      { locus: 'The photocopier kiosk', concept: 'Denormalisation', image: 'A frantic clerk photocopies one poster of a celebrity a million times and pins a copy inside every shopper\'s bag so nobody needs to walk to the noticeboard. When the celebrity changes hairstyle, the clerk faints at the pile of bags to update.' },
      { locus: 'The vehicle rental at the exit', concept: 'Matching store to job', image: 'A rental lot offers a motorbike (Redis), a freight train (Cassandra), a helicopter (Neo4j), a filing van (MongoDB) and a sensible sedan (Postgres) with a sign: "Not sure where you are going? Take the sedan."' },
    ],
  },
  interviewQuestions: [
    'What are the main categories of NoSQL databases and what access pattern is each optimised for?',
    'Explain the CAP theorem precisely and give a CP and an AP system with reasons.',
    'What does BASE mean and what anomalies must an application handle under eventual consistency?',
    'How does data modelling in Cassandra differ from modelling in Postgres?',
    'When would you choose MongoDB over Postgres, and when would you not?',
    'Why do NoSQL systems denormalise, and how do you handle updates to duplicated data?',
    'Explain how tunable consistency (QUORUM) works and what W + R > N guarantees.',
    'Design the storage for a chat application: which stores would you use for messages, presence and user profiles?',
  ],
}

export default chapter
