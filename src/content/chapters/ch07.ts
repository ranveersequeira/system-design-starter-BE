import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 7,
  slug: 'sharding-and-partitioning',
  title: 'Sharding And Partitioning',
  module: 'databases',
  estimatedMinutes: 40,
  summary:
    'When a single database server can no longer hold the data or absorb the writes, you split the data. Partitioning is the act of dividing data into pieces; sharding is spreading those pieces over many servers. This chapter covers how to split (horizontal vs vertical), how to route (hash, range, directory), and the price you pay: hot shards, resharding pain, and the loss of cheap joins and transactions.',
  objectives: [
    'Distinguish partitioning from sharding and horizontal from vertical splitting.',
    'Compare hash, range and directory-based sharding and pick one for a given access pattern.',
    'Choose a shard key by reasoning about cardinality, distribution, query alignment and immutability.',
    'Explain why hot shards, resharding and cross-shard joins/transactions are the real cost of sharding.',
    'Argue when NOT to shard and what to exhaust first (indexes, caching, replicas, vertical scaling).',
  ],
  quickRevision: [
    'Partitioning = splitting one dataset into smaller pieces. Sharding = placing those pieces on different database servers.',
    'Horizontal partitioning splits rows (users 1-1M here, 1M-2M there); vertical partitioning splits columns or tables (profile vs billing).',
    'Hash sharding: shard = hash(key) mod N. Even spread, but range queries scatter to every shard and adding a shard remaps almost everything.',
    'Range sharding: contiguous key ranges per shard. Great range scans, but sequential keys (timestamps, auto-increment) pile all writes on the last shard.',
    'Directory-based sharding: a lookup table maps key -> shard. Maximum flexibility, but the directory is a hot dependency and single point of failure.',
    'A good shard key has high cardinality, even distribution, appears in most queries, and never changes.',
    'A hot shard is one that receives disproportionate traffic (a celebrity user, today\'s date). Fix with salting, compound keys or splitting.',
    'Resharding with mod N moves ~all keys. Use consistent hashing or pre-create many logical shards (e.g. 4096) mapped onto few physical nodes.',
    'Cross-shard joins become scatter-gather in the application; cross-shard transactions need 2PC or sagas. Both are slow and complex.',
    'The best sharding scheme makes almost every query hit exactly one shard (single-shard queries).',
    'Shard as late as possible: indexes, caching, read replicas, vertical scaling and archiving usually buy years first.',
    'Real systems: Instagram pre-sharded Postgres into thousands of logical shards; Vitess shards MySQL for YouTube; MongoDB and Cassandra shard natively.',
  ],
  sections: [
    {
      id: 'partitioning-vs-sharding',
      title: 'Partitioning vs sharding: two words, two decisions',
      body: `The two words are often used interchangeably, but they name **two different decisions**.

**Partitioning** is a *logical* decision: you split a large dataset into smaller, independent pieces called partitions. Postgres table partitioning by month is partitioning. So is splitting a 500 GB \`orders\` table into ten 50 GB pieces. The data may still live on **one** server; you gain smaller indexes, cheaper maintenance (drop an old month instead of deleting 100M rows), and faster queries that touch only one partition.

**Sharding** is a *physical* decision: you place partitions on **different database servers**, each with its own CPU, RAM and disk. Now you have more total capacity for reads, writes and storage. A *shard* is one such server (or replica set) and typically holds many partitions.

Why does the distinction matter? Because the costs are wildly different. Partitioning on a single node keeps ACID transactions, joins and a single connection string. The moment data crosses a server boundary, a query that needs rows from two shards must be assembled by the application, a transaction spanning two shards needs a distributed protocol, and the database can no longer enforce a foreign key across them.

So the honest sequence is: first partition (cheap), then, only if one machine truly cannot cope, shard (expensive). Many teams jump straight to sharding at 200 GB, when a single modern Postgres instance with 1 TB of NVMe and good indexes could serve them for years.

Do not confuse either with **replication**: replicas hold *copies* of the same data for availability and read scaling. Shards hold *different* data. Production systems combine them: each shard is itself a primary with two replicas.`,
      mentalModel:
        'Partitioning is splitting a huge encyclopaedia into volumes A-D, E-H, and so on. Sharding is putting those volumes in different libraries across town. The first makes each volume easier to lift; the second means a reader who needs both "Apple" and "Zebra" has to travel.',
      diagram: `Partitioning (one server, many pieces)
+------------------------------------------+
|  DB server                               |
|  orders_2024_01 | orders_2024_02 | ...   |
+------------------------------------------+

Sharding (many servers, disjoint data)
+-------------+   +-------------+   +-------------+
| Shard 0     |   | Shard 1     |   | Shard 2     |
| users 0-1M  |   | users 1M-2M |   | users 2M-3M |
+-------------+   +-------------+   +-------------+

Replication (many servers, SAME data)
+-------------+   +-------------+
| Primary     |-->| Replica     |   copies, not pieces
+-------------+   +-------------+`,
      keyPoints: [
        'Partitioning splits data logically; sharding distributes partitions across servers.',
        'Partitioning on one node keeps joins and ACID; sharding gives them up for capacity.',
        'A shard usually hosts many partitions and is itself replicated for availability.',
        'Replication copies the same data; sharding spreads different data.',
      ],
      checkpoint: {
        question:
          'A team partitions its 2 TB events table by month inside one Postgres server. Have they sharded? What did they gain, and what did they not gain?',
        answer:
          'No, they partitioned, not sharded. They gained smaller indexes, faster month-scoped queries and cheap deletion of old months. They did not gain more write throughput or storage beyond that one machine; the single server is still the ceiling.',
      },
    },
    {
      id: 'horizontal-vs-vertical',
      title: 'Horizontal vs vertical partitioning',
      body: `There are two axes along which a table (or a whole schema) can be cut.

**Horizontal partitioning** cuts by **rows**. Every piece has the same columns but a different subset of rows: users with id 1-1M in one piece, 1M-2M in another. This is what people almost always mean by "sharding". It scales writes and storage linearly with the number of pieces because each piece sees only its slice of the traffic.

**Vertical partitioning** cuts by **columns or tables**. You move the rarely-used, large \`bio\` and \`avatar_blob\` columns out of \`users\` into a \`user_profiles\` table, or you move whole tables belonging to one feature (billing, analytics) onto their own database. The hot \`users\` table becomes narrow, so more rows fit in each page and in RAM, and the billing team can tune its database independently.

Vertical splitting is often the **first** split a growing company makes, and it usually happens along service boundaries: the Orders service gets its own MySQL, the Catalogue service another. It is easy because each table still lives whole on one server, so within a service, joins and transactions still work. The trade-off is that cross-service queries ("all orders for products in category X") become API calls or need a denormalised copy.

Vertical splitting has a hard ceiling, though: the single largest table eventually outgrows a machine, and no amount of column moving fixes that. Then you cut horizontally.

Real example: an e-commerce company will typically split vertically first (orders DB, catalogue DB, user DB), then horizontally shard just the orders DB by \`customer_id\` because it grows fastest.`,
      mentalModel:
        'A spreadsheet is your table. Horizontal partitioning tears it into stacks of rows. Vertical partitioning tears it into groups of columns. You can tear along both axes, but the row stack is the one that grows forever.',
      diagram: `Table: users(id, name, email, bio, avatar, last_login)

Vertical split (by column / feature):
+----------------------+   +------------------------+
| users_core           |   | users_profile          |
| id, name, email,     |   | id, bio, avatar        |
| last_login  (hot)    |   |            (cold, big) |
+----------------------+   +------------------------+

Horizontal split (by row):
+----------------------+   +----------------------+
| users  id 1..1M      |   | users  id 1M..2M     |
| all columns          |   | all columns          |
+----------------------+   +----------------------+`,
      keyPoints: [
        'Horizontal = split rows; scales writes and storage; this is "sharding" in common usage.',
        'Vertical = split columns or tables; usually along feature/service boundaries; the easier first step.',
        'Vertical keeps each table whole so joins inside a service still work.',
        'The biggest table eventually forces a horizontal split regardless.',
      ],
      checkpoint: {
        question:
          'Your users table has 40 columns, but 90% of queries touch only 5 of them, and the table barely fits in RAM. Which split do you try first and why?',
        answer:
          'Vertical: move the 35 cold columns into a side table. The hot table becomes narrow, far more rows fit in the buffer pool, and you keep single-server joins and transactions. Horizontal sharding is a much bigger operational step and is not yet needed.',
      },
    },
    {
      id: 'sharding-strategies',
      title: 'Hash, range and directory-based sharding',
      body: `Once you split rows, you need a **routing rule**: given a key, which shard holds it? Three families exist.

**Hash-based.** \`shard = hash(key) mod N\`. Because a good hash scatters keys uniformly, load spreads evenly even when keys are sequential. Point lookups by key hit exactly one shard. The price: any **range query** ("orders from last week") must ask every shard and merge, and **adding a shard** changes N so almost every key moves. Cassandra and DynamoDB hash the partition key; many hand-rolled MySQL setups use \`user_id mod 16\`.

**Range-based.** Each shard owns a contiguous range: A-F, G-M, N-Z, or timestamps by month. Range scans touch one or two shards, and adding a shard means splitting only one range. The price: **skew**. If the key is a timestamp or auto-increment id, *all* current writes land on the last shard, and the others idle. HBase and Bigtable are range-partitioned; MongoDB supports both ranged and hashed shard keys.

**Directory-based.** A separate lookup service stores an explicit \`key -> shard\` map. You can place any tenant anywhere, move a noisy customer to a dedicated shard, and rebalance without a formula. The price: every request first consults the directory, so it must be extremely fast, highly available and cached; it is a new single point of failure. Multi-tenant SaaS products often use this: \`tenant_id -> cluster\`.

In practice systems blend them: hash the key onto thousands of *logical* partitions, then keep a small directory mapping logical partitions to physical nodes. That gives hash uniformity plus directory flexibility, which is roughly what consistent hashing with virtual nodes achieves.`,
      mentalModel:
        'Hash sharding is a coat check that assigns hooks by ticket number: fair, but you cannot ask for "all the blue coats" without checking every hook. Range sharding files coats by owner surname: easy to find all the Smiths, but the S rail overflows. Directory sharding is a clerk with a notebook who can put any coat anywhere but must be asked every time.',
      diagram: `Hash:      key --> hash(key) mod 3 --> shard 0|1|2
           uniform spread; range scans hit ALL shards

Range:     key 'a'..'h' -> shard 0
           key 'i'..'p' -> shard 1
           key 'q'..'z' -> shard 2
           cheap range scans; sequential keys => hot tail

Directory: key --> [lookup table] --> shard X
                    k1 -> s2
                    k2 -> s0     flexible; directory is critical`,
      keyPoints: [
        'Hash: uniform, single-shard point lookups, terrible range queries, painful to add nodes.',
        'Range: efficient range scans, easy to split, but sequential keys create a hot last shard.',
        'Directory: total flexibility (move tenants at will) at the cost of a critical lookup dependency.',
        'Hybrid: hash to many logical partitions, directory maps logical -> physical.',
      ],
      checkpoint: {
        question:
          'You range-shard an IoT readings table by timestamp. Sensors write 50k rows/sec. What goes wrong, and which strategy change fixes it?',
        answer:
          'Every new reading has a "now" timestamp, so 100% of writes hit the shard owning the current range while others sit idle: a hot tail. Fix by sharding on hash(sensor_id) (or a compound key sensor_id + time) so writes spread, and keep time as a clustering order within each shard for range scans.',
      },
    },
    {
      id: 'shard-key',
      title: 'Choosing the shard key: the decision you cannot undo cheaply',
      body: `The shard key determines which shard a row lives on. It is the most consequential decision in a sharded design, and changing it later means rewriting every row. Four properties matter.

**1. High cardinality.** A key with 3 possible values (\`country\` = US/UK/IN) can create at most 3 shards. \`user_id\` with 500M values can be split any way you like.

**2. Even distribution.** Cardinality is not enough. \`user_id\` is fine; \`follower_count\` is high-cardinality but skewed. A key where 1% of values receive 60% of traffic produces hot shards no matter how you hash.

**3. Query alignment.** The key should appear in the WHERE clause of most queries so each request is a **single-shard query**. If you shard orders by \`order_id\` but the app always asks "orders for customer C", every such request becomes a scatter-gather across all shards. Shard by \`customer_id\` instead: all of one customer\'s orders co-locate.

**4. Immutability.** If the key changes, the row must physically move. Shard by \`email\` and every email change becomes a cross-shard migration. Prefer synthetic, stable ids.

There is a tension between 2 and 3. Sharding by \`tenant_id\` gives perfect query alignment for a SaaS app, but a whale tenant with 40% of all data becomes one giant hot shard. The usual answer is a **compound key**: \`(tenant_id, hash(entity_id) mod 8)\` splits large tenants across 8 sub-shards while small tenants stay on one.

Finally, think about **co-location**: rows that are joined together should share a shard key. Put a user, their orders and their addresses under \`user_id\` and the whole "my account" page is one shard, one connection, one local transaction.`,
      mentalModel:
        'Choosing a shard key is like choosing how to sort a filing cabinet you will never re-sort. Sort by the thing you look up most (alignment), that has many distinct values (cardinality), spreads evenly across drawers (distribution), and that never changes on a file (immutability).',
      keyPoints: [
        'Four tests: cardinality, distribution, query alignment, immutability.',
        'Aim for single-shard queries; scatter-gather is the failure mode to avoid.',
        'Compound keys tame whale tenants without losing alignment.',
        'Co-locate rows that are joined together under the same key.',
        'Changing a shard key means moving every row: decide carefully, decide early.',
      ],
      checkpoint: {
        question:
          'A chat app shards messages by hash(message_id). The main query is "load the last 50 messages of conversation X". Predict the problem and propose a better key.',
        answer:
          'Every conversation load fans out to all shards because message_id says nothing about the conversation: pure scatter-gather. Shard by conversation_id (optionally salted for very large group chats) so one conversation lives on one shard, and order by time within it.',
      },
    },
    {
      id: 'hot-shards',
      title: 'Hot shards and the celebrity problem',
      body: `A **hot shard** receives far more traffic than its peers. The cluster has capacity on average but is bottlenecked on one node, and the p99 latency of the whole system is the latency of that node.

Hot shards come from three sources:

- **Skewed keys.** Twitter\'s early problem: sharding tweets or followers by \`user_id\` means Justin Bieber\'s data is one row-set with 100M readers. This is the *celebrity problem*.
- **Temporal keys.** Sharding by date puts all of today\'s writes on one shard, and yesterday\'s shard goes cold.
- **Poor hashing or low cardinality.** \`hash(country)\` yields a handful of buckets.

Mitigations, in increasing order of effort:

**Salting.** Append a small random or derived suffix to the hot key so \`bieber\` becomes \`bieber#0\` to \`bieber#15\`, spreading writes across 16 shards. Reads must fan out to those 16 and merge; you pay on the read side to fix the write side.

**Compound keys.** \`(user_id, month)\` or \`(tenant_id, bucket)\` breaks a big entity into pieces along a second dimension.

**Isolate the whale.** With directory-based routing, move the single hottest tenant to its own dedicated shard. Many SaaS companies do exactly this for their top 10 customers.

**Cache in front.** A celebrity\'s profile is read millions of times but written rarely; a Redis cache absorbs the reads so the shard only sees writes.

**Split the shard.** Range-sharded systems (HBase, MongoDB) auto-split a region when it exceeds a size or load threshold, moving half elsewhere.

Monitoring matters here: track per-shard QPS, CPU and p99. A cluster that is 30% busy on average and 100% on one node is a sharding bug, not a capacity problem.`,
      mentalModel:
        'Ten supermarket checkouts, but one cashier is a famous actor. Every shopper queues at that lane while nine sit empty. Adding more empty lanes does nothing; you have to split the actor\'s fans across lanes (salting) or give the actor a separate signing table (isolate the whale).',
      diagram: `Shard load (QPS)
 s0 |####                       hot shard: celebrity user
 s1 |###                        cluster avg 30%, s5 at 100%
 s2 |####
 s3 |###
 s4 |####
 s5 |########################## <-- p99 of the whole system
 s6 |###
 s7 |####

Salting: key 'bieber' -> 'bieber#0'..'bieber#15'
         writes spread over 16 shards; reads fan out and merge`,
      keyPoints: [
        'Hot shards come from skewed, temporal or low-cardinality keys.',
        'The whole system\'s tail latency equals the hottest shard\'s latency.',
        'Salting trades read fan-out for write spread.',
        'Compound keys, whale isolation, caching and auto-splitting are the other levers.',
        'Watch per-shard metrics; average utilisation hides hot spots.',
      ],
    },
    {
      id: 'resharding',
      title: 'Resharding: adding nodes without moving the world',
      body: `Data grows, so one day you need shard number N+1. With naive \`hash(key) mod N\`, changing N from 8 to 9 remaps roughly 8/9 of all keys. Moving 90% of a multi-terabyte dataset while serving traffic is a nightmare. Three techniques avoid it.

**Consistent hashing.** Place shards and keys on a ring; a key belongs to the next shard clockwise. Adding a shard steals keys only from its neighbour, moving about 1/N of the data. Virtual nodes smooth the distribution. Cassandra, DynamoDB and Riak use this internally, and chapter 23 covers it in depth.

**Pre-sharding into logical shards.** Decide up front on a large fixed number of *logical* shards, say 4096, and hash keys onto them. Map logical shards to physical servers with a small table. Starting with 4 servers, each owns 1024 logical shards. To add a fifth, move ~820 whole logical shards (each a self-contained table or schema) rather than re-hashing rows. Instagram famously did this with Postgres: thousands of logical schemas spread across a modest number of machines, with ids that encode the logical shard. Vitess (YouTube, Slack) and Citus follow similar ideas.

**Range splitting.** Range-sharded stores split a hot or oversized range in two and move one half; only that range\'s data moves.

Whatever the scheme, the **online migration** procedure is similar:

1. Provision the new shard.
2. Start **double-writing** to old and new locations (or stream the change log via CDC such as Debezium).
3. Backfill historical rows in batches, throttled.
4. Verify checksums / row counts.
5. Flip reads to the new shard, then stop writes to the old one.
6. Delete the old copy after a soak period.

The whole process can take days for large tables, so resharding should be a rehearsed, automated runbook, not a heroic weekend.`,
      mentalModel:
        'Mod-N hashing is a classroom where seating is "roll number mod rows". Add one row and everyone stands up and moves. Pre-sharding is assigning every student a fixed numbered desk, then wheeling whole desks between rooms when a room fills up.',
      diagram: `mod N (N: 4 -> 5): almost every key changes shard
 key  h  h%4  h%5
 A   13   1    3   moved
 B   22   2    2   stays
 C   35   3    0   moved
 D   41   1    1   stays   ~80% moved

Pre-sharding: 4096 logical shards -> few physical nodes
 logical 0..1023    -> node A
 logical 1024..2047 -> node B      add node E:
 logical 2048..3071 -> node C      move ~205 logical shards
 logical 3072..4095 -> node D      from each of A..D to E`,
      keyPoints: [
        'hash mod N remaps almost everything when N changes.',
        'Consistent hashing moves ~1/N of keys when adding a node.',
        'Pre-sharding: many fixed logical shards mapped to few physical nodes; move whole logical shards.',
        'Online migration = double-write or CDC, backfill, verify, flip reads, retire old.',
        'Automate and rehearse resharding; it is routine maintenance, not an emergency.',
      ],
      checkpoint: {
        question:
          'You have 8 MySQL shards using user_id mod 8 and need to go to 12. Roughly what fraction of users move, and how would pre-sharding have helped?',
        answer:
          'Going from mod 8 to mod 12, a key stays put only if h mod 8 == h mod 12, which happens for about 1/3 of keys, so roughly two thirds of all users move. With, say, 1024 logical shards mapped onto 8 nodes, you would instead move about 1024 * (1/8 - 1/12) * 8 = ~341 whole logical shards, about one third of the data, and each move is a clean copy of a self-contained schema rather than a row-by-row re-hash.',
      },
    },
    {
      id: 'cross-shard',
      title: 'Cross-shard joins and transactions: what you lose',
      body: `On one server, \`JOIN\` and \`BEGIN ... COMMIT\` are free features of the database. Across shards they become **your** problem.

**Cross-shard joins.** "Show orders with product names" where orders are sharded by \`customer_id\` and products live elsewhere. Options:

- **Scatter-gather**: query every shard, merge in the application. Latency is the slowest shard, and load multiplies by shard count. Fine for rare admin queries, fatal for hot paths.
- **Denormalise**: store \`product_name\` inside the order row at write time. Reads are single-shard; the cost is stale names if products are renamed and more storage.
- **Reference tables**: small, rarely-changing tables (countries, product categories) are copied to *every* shard so local joins work. Citus calls these reference tables.
- **Push analytics elsewhere**: stream changes via CDC into a warehouse (BigQuery, Snowflake, ClickHouse) where joins are cheap and staleness of minutes is acceptable.

**Cross-shard transactions.** Transferring money from user A (shard 1) to user B (shard 4) must debit and credit atomically.

- **Two-phase commit (2PC)**: a coordinator asks all shards to prepare, then commit. Atomic, but blocking: if the coordinator dies after prepare, participants hold locks indefinitely. Latency doubles. Google Spanner and CockroachDB implement it well, but hand-rolled 2PC on MySQL is a famous source of pain.
- **Sagas**: a sequence of local transactions with compensating actions (debit A; credit B; if credit fails, refund A). Eventually consistent; the application must tolerate intermediate states and design idempotent compensations.
- **Avoid it by design**: choose a shard key so entities that transact together co-locate. A ledger sharded by \`account_id\` still needs cross-shard transfers, but an e-commerce checkout sharded by \`customer_id\` keeps cart, order and payment on one shard.

The rule of thumb: a design where more than a small percentage of queries or transactions cross shards has the wrong shard key, or should not be sharded yet.`,
      mentalModel:
        'On one server the database is a single accountant who can look at any two ledgers at once. Sharded, you have accountants in different cities who must phone each other, agree, and both write at the same moment. Possible, but slow and fragile; better to keep related ledgers in the same office.',
      diagram: `Cross-shard join (scatter-gather)
  app ---> shard0 --+
      ---> shard1 --+--> merge in app   latency = slowest shard
      ---> shard2 --+

Two-phase commit
  coordinator -> prepare? -> shard1 (locks held)
              -> prepare? -> shard4 (locks held)
              <- yes/yes
              -> commit   -> shard1, shard4
  coordinator crash between phases => locks stuck

Saga
  debit A (local tx) -> credit B (local tx)
                        fail? -> compensate: refund A`,
      keyPoints: [
        'Joins across shards become scatter-gather, denormalisation, reference tables or offline analytics.',
        'Transactions across shards need 2PC (atomic, blocking, slow) or sagas (eventual, compensations).',
        'The best fix is prevention: co-locate rows that are queried and updated together.',
        'If many operations cross shards, the shard key is wrong or sharding was premature.',
      ],
    },
    {
      id: 'when-to-shard',
      title: 'When to shard, and what to exhaust first',
      body: `Sharding is the most expensive scaling move a team can make, because it changes the application, the operations and the failure modes permanently. Before sharding, exhaust the cheaper levers:

1. **Fix the queries.** Missing indexes and N+1 patterns account for most "the database is slow" incidents.
2. **Cache.** A Redis layer in front of hot reads can remove 90% of database load.
3. **Read replicas.** If the bottleneck is reads, replicas scale them almost linearly.
4. **Vertical scaling.** A single cloud instance today offers 128+ cores, terabytes of RAM and millions of IOPS. Boring, but it buys years.
5. **Archive and partition.** Move cold rows to cheap storage; partition big tables so working sets shrink.
6. **Vertical split by service.** Give each domain its own database.

Shard when a **single primary cannot absorb the write volume** or the **dataset cannot fit on one machine** even after all the above. Typical triggers: sustained write IOPS at the hardware ceiling, tables past several TB, replication lag that never catches up.

When you do shard, prefer a system that has already solved the hard parts: **Vitess** (MySQL, used by YouTube, Slack, GitHub), **Citus** (Postgres extension), **MongoDB** sharded clusters, **Cassandra** or **DynamoDB** (sharding is the default and invisible), **CockroachDB** or **Spanner** (sharded but with SQL and transactions). Hand-rolled application-level sharding works (Instagram, Pinterest, Uber all did it), but you will write your own routing, resharding tooling and cross-shard logic.

In an interview, the strong answer is never "we shard from day one". It is "one primary plus replicas and a cache serve us to roughly X writes/sec and Y TB; beyond that we shard by Z because most queries are keyed by Z, and we pre-create logical shards so growing is a move, not a re-hash."`,
      mentalModel:
        'Sharding is moving your family into three houses in three cities because the kitchen is crowded. Before you do that, try a bigger fridge, eating in shifts, and clearing out the garage. Move only when the house is genuinely too small, and pick the cities so nobody has to commute for dinner.',
      keyPoints: [
        'Exhaust indexes, caching, replicas, vertical scaling, archiving and vertical splits first.',
        'Shard when writes or data size exceed one primary, not when it feels grown-up.',
        'Prefer Vitess, Citus, MongoDB, Cassandra, DynamoDB, CockroachDB over hand-rolled routing where possible.',
        'Interview answer: name the threshold, the key, the query alignment and the resharding plan.',
      ],
      checkpoint: {
        question:
          'A startup with 150 GB of data and 800 writes/sec proposes sharding Postgres across 4 nodes. What do you ask, and what do you probably recommend?',
        answer:
          'Ask where the actual bottleneck is (CPU, IOPS, lock contention, slow queries) and whether indexes, a cache and read replicas have been tried. 150 GB and 800 writes/sec are well within one well-tuned Postgres primary on modern hardware. Recommend fixing queries, adding a cache and replicas, and partitioning big tables; revisit sharding at several TB or when write IOPS saturate.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Which statement correctly distinguishes partitioning from sharding?',
      options: [
        'Partitioning copies data to replicas; sharding deletes old data',
        'Partitioning splits data into pieces; sharding places those pieces on different servers',
        'Partitioning is for NoSQL only; sharding is for relational databases only',
        'They are identical terms with no difference',
      ],
      answerIndex: 1,
      explanation:
        'Partitioning is the logical act of splitting a dataset; sharding is physically distributing the partitions across machines. Replication (copies) is a different concept, and both techniques apply to SQL and NoSQL alike.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'Moving the rarely used bio and avatar columns of a users table into a separate table is an example of:',
      options: ['Horizontal partitioning', 'Vertical partitioning', 'Hash sharding', 'Replication'],
      answerIndex: 1,
      explanation:
        'Splitting by columns is vertical partitioning. Horizontal partitioning splits by rows. Hash sharding is a routing rule for horizontal shards, and replication copies data rather than splitting it.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Which is the main weakness of hash-based sharding?',
      options: [
        'It produces uneven load for uniformly random keys',
        'Range queries must be sent to every shard and merged',
        'It cannot support point lookups by key',
        'It requires a central lookup service for every request',
      ],
      answerIndex: 1,
      explanation:
        'Hashing destroys key ordering, so a range like "last 7 days" touches all shards. Hashing actually spreads load evenly, point lookups are its strength, and no directory is required (that is directory-based sharding).',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 2,
      question: 'A table is range-sharded by an auto-incrementing order_id. What is the most likely production problem?',
      options: [
        'Reads are slow because ids are unpredictable',
        'All new inserts land on the shard owning the highest range, creating a hot shard',
        'Range queries require scatter-gather',
        'The directory service becomes a bottleneck',
      ],
      answerIndex: 1,
      explanation:
        'Monotonic keys mean every insert goes to the last range. Range sharding makes range queries cheap (not scatter-gather), and there is no directory involved.',
    },
    {
      type: 'multi',
      id: 'q5',
      difficulty: 2,
      question: 'Which properties make a good shard key? Select all that apply.',
      options: [
        'High cardinality',
        'Frequently changes so data stays fresh',
        'Appears in most queries so they hit a single shard',
        'Low cardinality so there are fewer shards to manage',
        'Even distribution of traffic across values',
      ],
      answerIndices: [0, 2, 4],
      explanation:
        'Cardinality, distribution and query alignment are the core tests, plus immutability. A key that changes forces rows to migrate between shards, and low cardinality caps how many shards you can ever have.',
    },
    {
      type: 'truefalse',
      id: 'q6',
      difficulty: 2,
      statement: 'Adding a ninth shard to a cluster that routes with hash(key) mod 8 moves roughly one eighth of the keys.',
      answer: false,
      explanation:
        'Changing the modulus remaps almost every key (roughly 8/9 of them move). It is consistent hashing that limits movement to about 1/N. This is exactly why pre-sharding into many logical shards or consistent hashing is used.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question:
        'A multi-tenant SaaS shards by tenant_id. One tenant holds 45% of all rows and traffic. Which fix preserves single-shard queries for small tenants while spreading the whale?',
      options: [
        'Switch entirely to hash(row_id) sharding',
        'Use a compound key (tenant_id, hash(entity_id) mod k) so large tenants span k sub-shards',
        'Add more read replicas to the hot shard',
        'Range-shard by created_at instead',
      ],
      answerIndex: 1,
      explanation:
        'A compound key keeps small tenants co-located while splitting the whale across k shards. Pure hash(row_id) makes every tenant query scatter-gather. Replicas do not help write load, and created_at creates a hot tail.',
    },
    {
      type: 'mcq',
      id: 'q8',
      difficulty: 2,
      question: 'What is the principal risk of two-phase commit for cross-shard transactions?',
      options: [
        'It is eventually consistent',
        'If the coordinator fails after the prepare phase, participants hold locks indefinitely',
        'It cannot guarantee atomicity',
        'It requires denormalised data',
      ],
      answerIndex: 1,
      explanation:
        '2PC is atomic but blocking: a coordinator crash between prepare and commit leaves participants locked and uncertain. Eventual consistency and compensations are properties of sagas, not 2PC.',
    },
    {
      type: 'truefalse',
      id: 'q9',
      difficulty: 1,
      statement: 'Salting a hot key spreads its writes across several shards but makes reads for that key fan out to all of the salted variants.',
      answer: true,
      explanation:
        'Salting appends a suffix (key#0..key#15) so writes go to 16 places. A read for the logical key must now query all 16 and merge, which is the trade you make to fix write hot spots.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 3,
      question:
        'Instagram pre-created thousands of logical Postgres schemas and mapped them onto a small number of physical servers. What problem does this primarily solve?',
      options: [
        'It eliminates the need for replication',
        'It lets them add servers by moving whole logical shards instead of re-hashing every row',
        'It makes cross-shard joins free',
        'It removes the need to choose a shard key',
      ],
      answerIndex: 1,
      explanation:
        'Pre-sharding fixes the logical shard count, so growth is a matter of relocating self-contained schemas. It says nothing about replication or joins, and a shard key is still required to pick the logical shard.',
    },
    {
      type: 'mcq',
      id: 'q11',
      difficulty: 3,
      question:
        'An orders table is sharded by order_id. The dominant query is "all orders for customer C" and a checkout must atomically create an order and update the customer\'s loyalty points. What is the strongest critique?',
      options: [
        'order_id has too low cardinality',
        'The key does not align with queries or transactions; sharding by customer_id would make both single-shard',
        'They should use range sharding by order_id instead',
        'They should add a directory service',
      ],
      answerIndex: 1,
      explanation:
        'Both the hot query and the transaction are keyed by customer, so sharding by customer_id co-locates orders and loyalty rows and avoids scatter-gather and 2PC. order_id has plenty of cardinality; range sharding by it would add a hot tail.',
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 3,
      question:
        'Describe an online procedure to move data from 8 shards to 12 with no downtime. Name the steps and the main risks.',
      modelAnswer: `1. **Provision** the 4 new shards (with replicas).
2. **Dual-write or CDC**: every write to an affected key goes to old and new locations, or a change-data-capture stream (e.g. Debezium) replays the binlog into the new shards.
3. **Backfill** historical rows in throttled batches so production latency is unaffected.
4. **Verify**: compare row counts and checksums per key range; fix drift.
5. **Flip reads** to the new topology behind a routing flag, monitor error rates and p99.
6. **Stop writes** to old locations, soak for days, then delete.

**Risks:** writes lost during the flip if dual-write is not idempotent; hot spots during backfill; a routing bug sending some keys to the wrong shard; the migration taking days for TB-scale data. Pre-sharding into logical shards makes this a schema move instead of a row re-hash.`,
      rubric: [
        'Mentions dual-writes or CDC to keep old and new in sync.',
        'Includes a throttled backfill and a verification step.',
        'Flips reads before retiring the old shards (no big-bang cutover).',
        'Names at least two concrete risks.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 2,
      question:
        'A colleague wants to shard a 300 GB Postgres database that serves 1,200 writes/sec because "it will not scale". List what you would check or try before agreeing.',
      modelAnswer: `First find the real bottleneck: CPU, disk IOPS, lock contention, or slow queries. Then, in order: add missing indexes and fix N+1 queries; put Redis in front of hot reads; add read replicas if reads dominate; scale the instance vertically (modern instances have 100+ cores and TBs of RAM); partition large tables by time and archive cold data; split by service (orders DB vs catalogue DB). 300 GB and 1,200 writes/sec are well within a single tuned primary. Shard only when write IOPS or storage genuinely exceed one machine, and then choose a key aligned with the dominant queries.`,
      rubric: [
        'Identifies the actual bottleneck before choosing a fix.',
        'Lists cheaper levers: indexes, cache, replicas, vertical scaling, partitioning.',
        'Recognises 300 GB / 1,200 writes/sec fits one primary.',
        'States a concrete trigger for when sharding becomes justified.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Partitioning vs sharding', back: 'Partitioning: split data into pieces (logical, may stay on one server). Sharding: place pieces on different servers (physical, more capacity, loses cheap joins/transactions).' },
    { id: 'f2', front: 'Horizontal vs vertical partitioning', back: 'Horizontal: split by rows, same columns, scales writes/storage. Vertical: split by columns or tables, often along service boundaries.' },
    { id: 'f3', front: 'Hash sharding: pro and con', back: 'Pro: even spread, single-shard point lookups. Con: range queries scatter to all shards; changing N remaps nearly all keys.' },
    { id: 'f4', front: 'Range sharding: pro and con', back: 'Pro: efficient range scans, easy to split one range. Con: sequential keys (time, auto-increment) create a hot last shard.' },
    { id: 'f5', front: 'Directory-based sharding', back: 'A lookup table maps key -> shard. Flexible placement and rebalancing, but the directory is a critical, must-be-cached dependency.' },
    { id: 'f6', front: 'Four properties of a good shard key', back: 'High cardinality, even distribution, query alignment (appears in most WHERE clauses), immutability.' },
    { id: 'f7', front: 'Hot shard', back: 'A shard receiving disproportionate load, e.g. a celebrity user or today\'s date. It sets the whole system\'s p99.' },
    { id: 'f8', front: 'Salting a key', back: 'Append a suffix (key#0..key#k) to spread one hot key over k shards. Writes spread; reads must fan out to k places and merge.' },
    { id: 'f9', front: 'Why hash mod N is bad for resharding', back: 'Changing N remaps almost every key (about (N)/(N+1) of them), forcing a near-total data move.' },
    { id: 'f10', front: 'Pre-sharding (logical shards)', back: 'Create many fixed logical shards (e.g. 4096) and map them to few physical nodes. Grow by moving whole logical shards. Used by Instagram, Vitess.' },
    { id: 'f11', front: 'Online resharding steps', back: 'Provision; dual-write or CDC; throttled backfill; verify counts/checksums; flip reads; stop old writes; retire after soak.' },
    { id: 'f12', front: 'Options for cross-shard joins', back: 'Scatter-gather in app; denormalise at write time; replicate small reference tables to every shard; CDC into an analytics warehouse.' },
    { id: 'f13', front: '2PC vs saga for cross-shard transactions', back: '2PC: atomic but blocking; coordinator crash leaves locks held. Saga: sequence of local transactions with compensations; eventually consistent.' },
    { id: 'f14', front: 'Compound shard key', back: 'Combine a tenant/entity key with a hash bucket, e.g. (tenant_id, hash(id) mod 8), to split whale tenants while keeping small ones co-located.' },
    { id: 'f15', front: 'What to exhaust before sharding', back: 'Indexes and query fixes, caching, read replicas, vertical scaling, partitioning/archiving, vertical split by service.' },
    { id: 'f16', front: 'Sharding tools worth naming', back: 'Vitess (MySQL), Citus (Postgres), MongoDB sharded clusters, Cassandra/DynamoDB (native), CockroachDB/Spanner (sharded SQL with transactions).' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Sharding and why it is expensive',
      prompt: 'Explain to a junior developer what sharding is, why a team would do it, and why it is usually the last scaling step rather than the first.',
      modelExplanation: `Imagine one database server holding every user. Eventually it runs out of disk, or it cannot write fast enough, no matter how big the machine. Sharding means splitting the users across several servers: users 1 to 10 million here, 10 to 20 million there. Each server handles only its slice, so together they can store and write far more.

The catch is that the database stops being one thing. If you want to join orders with products and they live on different servers, the database cannot do it; your code has to ask both and stitch the answers. A transaction touching two servers needs a slow, fragile protocol. And when you add a server, you have to move data around while users are still online.

So sharding is expensive to build and to live with. That is why you first try cheaper things: better indexes, a cache, read replicas, a bigger machine, archiving old data. You shard when a single primary genuinely cannot keep up with writes or storage, and you pick the split key so that almost every query still lands on one server.`,
      mustMention: [
        'Splitting rows across separate servers for write and storage capacity',
        'Loss of cross-shard joins and transactions',
        'Difficulty of resharding when adding nodes',
        'Cheaper alternatives to try first',
        'Choosing a key so most queries are single-shard',
      ],
    },
    {
      id: 'fe2',
      concept: 'Hash vs range sharding',
      prompt: 'Explain the difference between hash-based and range-based sharding and when you would choose each.',
      modelExplanation: `Both answer the question "which server holds this key?". Hash sharding runs the key through a hash function and uses the result to pick a server. Because hashes look random, load spreads evenly, even if the keys themselves arrive in order. But that randomness destroys neighbourhoods: "all orders from last week" are scattered everywhere, so you must ask every server.

Range sharding keeps neighbours together: server 1 holds January, server 2 holds February. Range queries are cheap, and splitting a full range is easy. The downside shows up when the key grows in order, like timestamps: every new write goes to the newest range, so one server is slammed while the rest idle.

Choose hash when your access is mostly point lookups by key and you need even load, as in user profiles or sessions. Choose range when range scans dominate and keys are not monotonic, or combine them: hash on an entity id to pick the shard, then sort by time within the shard.`,
      mustMention: [
        'Hash spreads load evenly but breaks range queries',
        'Range keeps neighbours together but monotonic keys create a hot tail',
        'Point lookups favour hash; range scans favour range',
        'Combining: hash to choose shard, time ordering within shard',
      ],
    },
    {
      id: 'fe3',
      concept: 'Choosing a shard key',
      prompt: 'Explain how you would choose a shard key for a food-delivery app\'s orders table, and what could go wrong with a bad choice.',
      modelExplanation: `The shard key decides which server a row lives on, and it is very hard to change later. I want a key that has lots of distinct values, spreads traffic evenly, shows up in most queries, and never changes.

For orders, the hot queries are "my orders" for a customer and "active orders" for a restaurant, plus writes during checkout. Sharding by customer_id makes the customer view a single-server query and keeps the checkout transaction (order plus payment plus loyalty points) local. The restaurant view becomes a fan-out, so I would keep a separate denormalised copy keyed by restaurant_id for that read path.

A bad choice, like order_id, spreads data evenly but every customer query hits all shards. Sharding by city gives too few values and a hot shard for the biggest city. Sharding by created_at sends every new order to one shard. Each of these is a real production incident waiting to happen.`,
      mustMention: [
        'Cardinality, distribution, query alignment, immutability',
        'Aligning with dominant queries and transactions',
        'Denormalised secondary copies for other access patterns',
        'Concrete bad keys: order_id (scatter), city (low cardinality), created_at (hot tail)',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You tour a city library system that has outgrown its single grand building: first the main hall, then the branch libraries scattered across town. Each stop anchors one sharding idea.',
    stops: [
      { locus: 'The main hall with its encyclopaedia split into volumes', concept: 'Partitioning vs sharding', image: 'One enormous encyclopaedia has been sawn into volumes A-D, E-H and so on, but all still sit on one groaning shelf. A sign reads: PARTITIONED, NOT YET SHARDED. Outside, moving vans wait to carry volumes to other branches.' },
      { locus: 'The card catalogue torn two ways', concept: 'Horizontal vs vertical partitioning', image: 'A librarian tears a giant ledger horizontally into stacks of rows, while another slices it vertically so the fat "biography" column falls out into a separate skinny book that nobody reads.' },
      { locus: 'Three branch entrances', concept: 'Hash, range and directory routing', image: 'Branch one: a spinning roulette wheel decides where each book goes (hash). Branch two: shelves labelled A-H, I-P, Q-Z, with the Z shelf collapsing under new arrivals (range). Branch three: a clerk with a fat notebook pointing each visitor to a specific room (directory).' },
      { locus: 'The engraved brass key on the wall', concept: 'Shard key properties', image: 'A giant brass key engraved with four words: MANY, EVEN, ASKED, FIXED. It is welded to the wall; a plaque warns that removing it means re-shelving every book in the city.' },
      { locus: 'The celebrity reading room', concept: 'Hot shards', image: 'One tiny branch is mobbed by a screaming crowd wanting the same pop star biography, while the other branches are empty and echoing. Staff frantically photocopy the book into sixteen copies with different coloured stickers (salting).' },
      { locus: 'The numbered rolling shelves', concept: 'Resharding with logical shards', image: 'Every shelf has a fixed number from 0 to 4095 and wheels. When a new branch opens, staff simply roll whole numbered shelves down the street instead of re-sorting each book.' },
      { locus: 'The telephone exchange between branches', concept: 'Cross-shard joins and transactions', image: 'Two librarians in different branches hold phones, each with a hand on a ledger, shouting PREPARED? and COMMIT! One line goes dead and both stand frozen, unable to let go of their ledger (2PC blocking).' },
      { locus: 'The exit sign', concept: 'Shard as late as possible', image: 'Above the exit a checklist glows: INDEX, CACHE, REPLICATE, BIGGER BUILDING, ARCHIVE. Only after every box is ticked does the door to the moving vans unlock.' },
    ],
  },
  interviewQuestions: [
    'What is the difference between partitioning, sharding and replication?',
    'Compare hash-based and range-based sharding. When would you pick each?',
    'How would you choose a shard key for a messaging application, and what properties matter?',
    'What is a hot shard and how can you mitigate it?',
    'Why is hash(key) mod N problematic when adding nodes, and what are the alternatives?',
    'How do you handle a transaction that spans two shards?',
    'Describe how you would reshard a live database with zero downtime.',
    'At what point would you recommend sharding, and what would you try first?',
  ],
}

export default chapter
