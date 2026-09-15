import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 4,
  slug: 'relational-databases',
  title: 'Relational Databases',
  module: 'databases',
  estimatedMinutes: 40,
  summary:
    'Relational databases such as Postgres and MySQL are the default storage engine for most systems because they combine a rigid, well-understood data model with ACID transactions, flexible querying through joins, and B-tree indexes that make lookups fast. This chapter explains how those pieces actually work under the hood, what they cost, and when a relational store is the right call versus when its guarantees become the bottleneck.',
  objectives: [
    'Explain each ACID property, the mechanism that implements it (WAL, locks, constraints) and the failure it prevents.',
    'Describe how a B-tree index answers a query, what it costs on writes, and how composite and covering indexes work.',
    'Use transactions correctly: boundaries, keeping them short, and why long transactions hurt.',
    'Reason about how joins execute (nested loop, hash, merge) and avoid the N+1 pattern.',
    'Apply normalisation and deliberate denormalisation, and decide when a relational database is the right choice.',
  ],
  quickRevision: [
    'Relational = data in tables with a fixed schema; rows identified by a primary key; relationships via foreign keys; queried with SQL.',
    'ACID: Atomicity (all or nothing), Consistency (constraints hold), Isolation (concurrent transactions do not interfere), Durability (committed = survives crash).',
    'Atomicity and durability come from the write-ahead log (WAL / redo log): changes are logged and fsynced before commit is acknowledged.',
    'Isolation comes from locks and MVCC; the isolation level (chapter 5) decides how much interference is tolerated.',
    'A B-tree index is a balanced, sorted tree of pages; lookups, range scans and ORDER BY on the indexed columns cost O(log n) page reads, typically 3-4 for billions of rows.',
    'Every index speeds some reads and slows every write and consumes disk; index the access patterns you actually have.',
    'Composite index (a, b) serves WHERE a = ? and WHERE a = ? AND b = ? and ORDER BY a, b; it does not serve WHERE b = ? alone (leftmost-prefix rule).',
    'Covering index: all columns the query needs are in the index, so the table is never touched (index-only scan).',
    'InnoDB stores the table clustered by primary key; secondary indexes hold the PK. Postgres stores a heap; every index holds a physical row pointer.',
    'Joins execute as nested loop (good with an index on the inner side), hash join (big unsorted sets), or merge join (both sorted).',
    'N+1 queries: one query for a list then one per item; fix with a join or an IN batch. This kills more latency budgets than slow joins do.',
    'Normalisation (1NF-3NF) removes redundancy so a fact is stored once and update anomalies cannot occur; denormalise deliberately for read speed and accept the write complexity.',
    'Keep transactions short: long transactions hold locks, block vacuum, and bloat MVCC versions.',
    'Relational wins when data is relational, correctness matters, queries are ad hoc, and scale fits one primary plus replicas; that covers most products.',
  ],
  sections: [
    {
      id: 'relational-model',
      title: 'The relational model and why a rigid schema helps',
      body: `A relational database stores data in **tables** (relations). Each table has a fixed set of typed **columns** and holds **rows**; each row is identified by a **primary key**. Relationships between tables are expressed by **foreign keys**: an \`orders.user_id\` column that must match a \`users.id\`. You query with **SQL**, a declarative language: you say *what* you want and the planner decides *how* to get it.

The schema is enforced **on write**. Insert a string into an integer column, omit a NOT NULL field, or reference a user who does not exist, and the database rejects the write. This feels restrictive until you have operated a system without it: schema-less stores accumulate half-migrated documents, every reader must defend against missing fields, and the "schema" ends up scattered across application code in five services. A relational schema is a single, enforced contract for what the data means.

Constraints are part of that contract: **UNIQUE** (no two users with the same email), **CHECK** (\`balance >= 0\`), **NOT NULL**, and **FOREIGN KEY** with cascading rules. Because the database enforces them atomically, they hold even when two application servers race, something application-level checks cannot guarantee without their own locking.

The model's other strength is **query flexibility**. Because data is stored by entity, not by access pattern, you can ask questions you did not anticipate: "customers who ordered twice in March but never in April" is one SQL statement, with no new table or code deployed. Compare a key-value store, where every query must have been designed into a key.

Real systems on this model: Instagram ran on sharded Postgres for years; Uber, Facebook, GitHub and Shopify run vast MySQL fleets; Stripe's ledger is relational. The engines have had 30 years of tuning, and the operational knowledge is everywhere. That is why "start with Postgres" is the default advice.`,
      mentalModel:
        'A relational schema is a form with fixed labelled boxes. Everyone fills in the same form, so anyone can read any record without guessing, and the clerk (the database) refuses forms with a box left blank or filled with nonsense.',
      diagram: `users                      orders
+----+----------+------+    +----+---------+--------+----------+
| id | email    | name |    | id | user_id | amount | status   |
+----+----------+------+    +----+---------+--------+----------+
| 1  | a@x.com  | Ana  |<---| 10 | 1       | 49.00  | paid     |
| 2  | b@x.com  | Bo   |<---| 11 | 2       | 12.50  | pending  |
+----+----------+------+    +----+---------+--------+----------+
 PK id, UNIQUE email          PK id, FK user_id -> users.id
                              CHECK amount >= 0`,
      keyPoints: [
        'Tables, typed columns, rows, primary keys and foreign keys, queried declaratively via SQL.',
        'Schema enforced on write is a single contract for what data means; constraints hold under concurrency.',
        'Storing data by entity rather than by access pattern gives ad hoc query flexibility.',
        'Postgres and MySQL power Instagram, Uber, GitHub, Shopify and Stripe; the default choice for good reason.',
      ],
    },
    {
      id: 'acid',
      title: 'ACID: the four promises and how they are kept',
      body: `ACID is the set of guarantees a relational transaction gives you. Each protects against a specific disaster, and each is implemented by a specific mechanism.

**Atomicity: all or nothing.** A transfer debits one account and credits another. If the server crashes between the two writes, atomicity guarantees that after restart either both happened or neither did. Mechanism: the **write-ahead log (WAL)** in Postgres, the **redo/undo log** in InnoDB. Every change is written to the log before the data pages; on commit the log record is flushed. On crash recovery the engine replays committed transactions and rolls back incomplete ones using undo information.

**Consistency: constraints always hold.** No transaction can leave the database violating a UNIQUE, CHECK, NOT NULL or FOREIGN KEY constraint, or a trigger-enforced invariant. If the credit would push a CHECK \`balance >= 0\` negative, the whole transaction fails. (Note: this "C" is about integrity constraints; it is different from consistency in CAP or replication.) Mechanism: constraint checks at statement or commit time inside the transaction.

**Isolation: concurrent transactions do not see each other's half-done work.** Two transfers touching the same account must behave as if run one after the other. Mechanism: locks and MVCC (multi-version concurrency control), tuned by the isolation level. Chapter 5 is entirely about this, because the default levels are weaker than most engineers assume.

**Durability: committed means safe.** Once COMMIT returns, the data survives a power loss. Mechanism: the log is **fsynced** to disk before acknowledging commit. This is why commit latency is bounded below by disk flush time (about 1 ms on SSD, 10 ms on spinning disk) and why turning off fsync for speed is trading durability for throughput. For protection against losing the whole machine, durability extends to synchronous replication (chapter 6).

Why this matters for design: ACID lets the application be simple. Without it, every multi-row update needs compensating logic, every read must tolerate half-written state, and correctness bugs appear only under concurrent load, which is exactly when they are hardest to reproduce. ACID moves that complexity into one heavily tested engine.`,
      mentalModel:
        'A notary handling a property sale: both signatures or the deed is void (atomicity), the deed must satisfy the law (consistency), other sales in the room cannot peek at your half-signed pages (isolation), and once stamped it is filed in a fireproof vault (durability).',
      diagram: `Transaction: transfer 100 from A to B
  BEGIN
  UPDATE accounts SET bal = bal - 100 WHERE id = A   --> WAL record
  UPDATE accounts SET bal = bal + 100 WHERE id = B   --> WAL record
  COMMIT  --> WAL fsync to disk  --> ack to client
                    |
        crash here? replay WAL: both applied
        crash before fsync?   : neither applied (undo)`,
      keyPoints: [
        'Atomicity and durability are implemented by the write-ahead log plus fsync on commit.',
        'Consistency means integrity constraints hold at commit; not the CAP meaning.',
        'Isolation is delivered by locks and MVCC and is configurable via isolation levels.',
        'Commit latency is bounded by disk flush; disabling fsync trades durability for speed.',
        'ACID moves concurrency and failure complexity out of application code.',
      ],
      checkpoint: {
        question:
          'A system disables fsync on its Postgres to double write throughput. What specific guarantee is lost, and describe the exact failure scenario.',
        answer:
          'Durability. COMMIT returns before the WAL is on disk, so on a power loss or kernel crash the last seconds of committed transactions vanish even though clients were told they succeeded. A payment could be acknowledged to the user and then not exist. A plain Postgres process crash is survivable (the OS still has the pages), but a machine-level failure is not.',
      },
    },
    {
      id: 'transactions',
      title: 'Transactions in practice: boundaries and keeping them short',
      body: `A transaction groups statements between \`BEGIN\` and \`COMMIT\` (or \`ROLLBACK\`) into one atomic, isolated unit. Using them well is mostly about choosing boundaries.

**Draw the boundary around the invariant.** If "an order and its line items exist together" is the rule, the inserts for both go in one transaction. If "inventory never goes negative" is the rule, the read of stock and the decrement must be in the same transaction, with the right isolation or a \`SELECT ... FOR UPDATE\` lock; otherwise two buyers both read stock = 1 and both succeed.

**Keep transactions short.** A transaction that stays open holds row locks (blocking other writers on those rows), keeps its snapshot alive (so MVCC cannot clean up old row versions, bloating tables in Postgres and growing the undo log in InnoDB), and pins a connection from the pool. The classic mistake is opening a transaction, then calling an external payment API that takes 3 seconds, then committing. During those 3 seconds every other transaction touching those rows waits. Do external calls *outside* the transaction and write the result in a second, short one, using an idempotency key to reconcile.

**Do not hold transactions across user think time.** "Begin, show the form, wait for the user, commit" holds locks for minutes. Use optimistic concurrency instead: read a version number, let the user edit, then \`UPDATE ... WHERE id = ? AND version = ?\` and fail if zero rows matched.

**Batch, but not infinitely.** Inserting 1 M rows in one transaction is faster than 1 M autocommits (one fsync instead of a million), but a single giant transaction holds locks and bloats logs. Batches of 1,000-10,000 rows are the usual compromise.

**Handle retries.** Under SERIALIZABLE or on deadlock the database will abort a transaction with a retryable error (Postgres SQLSTATE 40001 or 40P01). Application code must be written so the whole transaction can be re-run.

**Autocommit is a transaction too.** Each standalone statement is its own transaction, so a multi-statement update without explicit BEGIN can be left half done by a crash. If two statements must succeed together, wrap them.`,
      mentalModel:
        'A transaction is holding a table at a busy restaurant. Order, eat, pay, leave quickly and the room flows; hold the table while you go home to fetch your wallet and everyone else waits at the door.',
      keyPoints: [
        'Place transaction boundaries exactly around the invariant that must hold.',
        'Short transactions: no external calls, no user think time inside BEGIN...COMMIT.',
        'Long transactions hold locks, block MVCC cleanup (bloat), and pin connections.',
        'Use optimistic version checks for long-lived edits; batch bulk writes in the thousands.',
        'Write transactions to be retryable on serialization failures and deadlocks.',
      ],
      checkpoint: {
        question:
          'Checkout code does: BEGIN; decrement stock; call payment gateway (2-5 s); insert order; COMMIT. What goes wrong at 200 checkouts/s on a popular item, and how do you restructure it?',
        answer:
          'Every checkout holds a row lock on the popular item for 2-5 s, so they serialise: at most a fraction of a checkout per second on that item succeeds, the rest queue and time out, and connections pile up. Restructure: transaction 1 reserves stock (short); call the gateway outside any transaction with an idempotency key; transaction 2 records payment and confirms the order, or releases the reservation on failure or timeout.',
      },
    },
    {
      id: 'indexes-btree',
      title: 'Indexes: how a B-tree turns a scan into a few page reads',
      body: `Without an index, \`SELECT * FROM users WHERE email = ?\` reads every row: a full table scan, O(n), which on a 100 M row table is seconds of I/O per query. An index is a separate, sorted structure that lets the engine jump to matching rows.

The workhorse is the **B-tree** (B+ tree in practice). It is a balanced tree of fixed-size pages (8 KB in Postgres, 16 KB in InnoDB). Internal pages hold sorted keys and pointers to child pages; leaf pages hold keys plus pointers to rows and are linked left to right. Because each page holds hundreds of keys, the tree is extremely shallow: three or four levels index billions of rows. A point lookup reads 3-4 pages, and since the upper levels are almost always in memory, that is usually one disk read. A range query (\`created_at BETWEEN\`) walks down once, then follows the leaf chain: O(log n + k). Because leaves are sorted, an index also serves \`ORDER BY\` and \`MIN/MAX\` without sorting.

**Composite indexes** on (a, b) are sorted by a, then by b within a. They serve \`WHERE a = ?\`, \`WHERE a = ? AND b = ?\`, \`WHERE a = ? ORDER BY b\`, and range on b after equality on a. They do *not* serve \`WHERE b = ?\` alone: the leftmost-prefix rule. Column order in the index is a design decision driven by your queries; put equality columns first, then the range or sort column.

**Covering indexes** contain every column the query needs (Postgres \`INCLUDE\`, or simply all selected columns), so the engine never visits the table: an index-only scan.

**Clustered vs heap storage.** InnoDB stores the table itself as a B-tree ordered by primary key; secondary indexes store the PK, so a secondary lookup is two tree traversals, and a random UUID primary key scatters inserts across the tree. Postgres stores rows in an unordered heap; every index leaf holds a physical row pointer (ctid), and any update that changes an indexed column must update the index.

**The cost.** Every index must be updated on every INSERT and on UPDATE of indexed columns, consumes disk (often as much as the table), and slows bulk loads. A write-heavy table with ten indexes spends most of its time maintaining them. Index the access patterns you have; run \`EXPLAIN ANALYZE\` to confirm the planner uses them (it will not for low-selectivity predicates like \`status = 'active'\` on 95% of rows, where a scan is cheaper).

Other index types exist for other shapes: hash (equality only), GIN (arrays, JSONB, full text), GiST/R-tree (geospatial), BRIN (huge naturally ordered tables). B-tree is the default because it covers equality, range and ordering at once.`,
      mentalModel:
        'A B-tree is the thumb index on a dictionary: a few tabs get you to the right page, and the pages are in order so you can read forward for a range. Composite indexes are a dictionary sorted by surname then first name: useless if you only know the first name.',
      diagram: `B-tree on users(email), 3 levels, 8KB pages
                    [ m | t ]                 root (in RAM)
                   /    |    \\
          [ d | h ]  [ n | q ]  [ v | x ]     internal (in RAM)
          /   |   \\
 [a..c] [d..g] [h..l] -> ... -> [x..z]        leaves: key + row ptr
   |                                          linked for range scan
   v
 heap row (Postgres) / clustered PK row (InnoDB)

lookup email='h@x' : root -> internal -> leaf -> row  = 3-4 page reads`,
      keyPoints: [
        'A B-tree is a shallow balanced tree of sorted pages; point lookups cost 3-4 page reads even for billions of rows.',
        'Indexes serve equality, range and ORDER BY on their leading columns; leftmost-prefix rule for composites.',
        'Covering indexes avoid touching the table; InnoDB clusters by PK, Postgres uses a heap with pointers.',
        'Each index taxes every write and uses disk; index actual access patterns and verify with EXPLAIN.',
        'Low-selectivity predicates will not use an index because scanning is cheaper.',
      ],
      checkpoint: {
        question:
          'You have an index on orders(user_id, created_at). Which of these queries can use it efficiently: (a) WHERE user_id = 5 ORDER BY created_at DESC LIMIT 20, (b) WHERE created_at > now() - interval \'1 day\', (c) WHERE user_id = 5 AND created_at > ?',
        answer:
          '(a) yes: equality on the leading column, then the index is already sorted by created_at, so no sort is needed and it stops after 20 rows. (c) yes: equality then range on the second column. (b) no: created_at is not the leftmost column, so the engine would need a full scan or a separate index on created_at.',
      },
    },
    {
      id: 'joins',
      title: 'Joins: how the engine combines tables, and the N+1 trap',
      body: `Joins are the payoff of normalisation: data lives once, and queries stitch it together. Understanding how the planner executes a join tells you why some are instant and some melt the server.

Three physical join algorithms:

- **Nested loop join.** For each row of the outer table, look up matches in the inner table. Cheap when the outer side is small and the inner side has an index on the join column (each probe is a 3-4 page B-tree lookup). Terrible when the inner side has no index: O(n x m).
- **Hash join.** Build a hash table on the smaller input keyed by the join column, then stream the larger input and probe. O(n + m), needs memory for the hash table (\`work_mem\` in Postgres); spills to disk if it does not fit. The default for large unsorted inputs with equality predicates.
- **Merge join.** If both inputs are sorted on the join key (because of an index or an explicit sort), walk them together like merging two sorted lists. O(n + m), excellent for large sorted inputs and range joins.

The planner picks based on table statistics (row counts, value distributions gathered by \`ANALYZE\`). Stale statistics or missing indexes on foreign keys are the top two causes of a join suddenly taking minutes. Rule: **index every foreign key column** that you join or filter on; the FK constraint does not create an index automatically in Postgres.

**The N+1 problem** is not a slow join; it is the absence of one. ORMs make it easy: fetch 50 orders, then for each order fetch its user, producing 51 round trips. Each round trip costs a network hop (0.5-1 ms in the same data centre) plus planning, so 51 queries take 50 ms where one join or one \`WHERE id IN (...)\` takes 2 ms. At scale N+1 is usually the single largest source of latency in application code. Fix with a join, a batched IN query, or the ORM's eager-loading feature.

**Join cost at scale.** Joins across large tables are fine when indexed and selective; a join that touches 100 M rows on both sides is an analytics query and belongs in a warehouse or a precomputed table, not on the request path. Joins are also the first casualty of sharding: you cannot join rows that live on different nodes, which is why denormalisation appears the moment you partition.

Read plans with \`EXPLAIN (ANALYZE, BUFFERS)\`: look for sequential scans on big tables, nested loops with large row estimates, and estimated versus actual row counts that differ by orders of magnitude.`,
      mentalModel:
        'Nested loop is looking up each guest\'s name in a phone book one at a time (fast with the book\'s index, hopeless without). Hash join is writing all names on sticky notes on a wall and checking each guest against the wall. Merge join is two sorted guest lists read side by side.',
      diagram: `Nested loop (indexed inner):   for each order -> index probe users
   orders (50 rows) --> users.id B-tree    ~50 x 3 pages   fast

Hash join (big unsorted):      build hash(users) then stream orders
   users -> {id: row} in RAM;  orders --> probe       O(n + m)

Merge join (both sorted):      walk two sorted streams together
   orders sorted by user_id  ||  users sorted by id   O(n + m)

N+1:  SELECT * FROM orders LIMIT 50; then 50x SELECT * FROM users WHERE id=?
Fix:  SELECT ... FROM orders JOIN users ON users.id = orders.user_id`,
      keyPoints: [
        'Nested loop (small outer, indexed inner), hash join (big unsorted, equality), merge join (both sorted).',
        'Index every foreign key you join or filter on; Postgres does not do it for you.',
        'N+1 queries waste a network round trip per row; replace with a join or batched IN.',
        'Huge-on-huge joins are analytics; keep them off the request path.',
        'Use EXPLAIN ANALYZE and watch estimated vs actual rows and sequential scans.',
      ],
    },
    {
      id: 'normalization',
      title: 'Normalisation and deliberate denormalisation',
      body: `Normalisation is the discipline of arranging tables so that every fact is stored exactly once. Its purpose is to make certain bugs impossible, not to satisfy theory.

The practical ladder:

- **1NF**: atomic values, no repeating groups. Not \`tags = "a,b,c"\` in one column; a \`post_tags\` table instead. Otherwise you cannot index or query tags.
- **2NF**: every non-key column depends on the whole key. In an \`order_items(order_id, product_id, product_name)\` table, \`product_name\` depends only on \`product_id\`; move it to \`products\`.
- **3NF**: no non-key column depends on another non-key column. If \`orders\` stores \`customer_id\` and \`customer_city\`, city depends on customer, not on the order; move it.

What normalisation buys you: **no update anomalies**. If a customer's city is stored once, changing it is one UPDATE; if it is copied into 10,000 order rows, you must find and update all of them, and the day you miss one you have two truths. It also buys **smaller writes** and **a schema that matches the domain**, so new queries are natural joins rather than string parsing.

What it costs: **reads need joins**. Rendering an order page might join orders, customers, addresses, items and products. On indexed tables at OLTP scale that is a few milliseconds and perfectly fine. It becomes a problem at extreme read volume, across shards (no cross-node joins), or in analytics over billions of rows.

**Denormalisation** is copying or precomputing data to make reads cheaper, and it should be a *deliberate* decision with a stated reason and a plan for keeping copies in sync:

- Store \`order.total\` rather than summing items on every read; recompute in the same transaction that changes items.
- Keep \`post.like_count\` updated by trigger or async job instead of \`COUNT(*)\` per view.
- Snapshot \`product_name\` and \`price\` into \`order_items\` *on purpose*: the order must show what was bought at the time, even if the product changes later. This is historical correctness, not laziness.
- Maintain a read-optimised table or materialised view for the feed or dashboard, refreshed from the normalised truth.

The rule of thumb for iterative design: normalise first, because it is correct by construction and cheap to change. Denormalise only where a measured read pattern demands it, and always know which copy is the source of truth and how the others are refreshed.`,
      mentalModel:
        'Normalisation is keeping one master address book and pointing to it; denormalisation is photocopying an entry onto a hundred envelopes. Copies are faster to read at the door, but when someone moves, you must find every envelope.',
      keyPoints: [
        '1NF atomic values; 2NF depend on the whole key; 3NF no transitive dependencies between non-key columns.',
        'Normalisation stores each fact once, eliminating update anomalies and shrinking writes.',
        'The cost is joins on read, cheap at OLTP scale but painful across shards or at huge volume.',
        'Denormalise deliberately: counters, totals, historical snapshots, read-optimised views; always name the source of truth and the sync mechanism.',
        'Normalise first, denormalise where measurements demand.',
      ],
      checkpoint: {
        question:
          'An e-commerce team argues that copying product price into order_items is "bad denormalisation" and wants to join to products instead. Who is right?',
        answer:
          'Copying price is correct here, and it is not really a redundancy: the order must record the price at the moment of purchase, which is a different fact from the product\'s current price. Joining to products would silently rewrite history when prices change. Snapshotting is deliberate denormalisation for historical correctness.',
      },
    },
    {
      id: 'when-relational-wins',
      title: 'When relational wins, and when it does not',
      body: `Choosing a database is a requirements decision (chapter 9 goes deeper). Here is the relational side of the ledger.

**Relational wins when:**

- **Data is genuinely relational.** Users, orders, products, payments, permissions: entities with many-to-many relationships and queries that cross them. Joins and foreign keys model this directly.
- **Correctness matters more than raw write throughput.** Money, inventory, bookings, anything where two concurrent writes must not both succeed. ACID transactions and constraints do the hard work.
- **Queries are not fully known upfront.** Product teams ask new questions weekly; SQL answers them without schema redesign or code deploys.
- **Scale fits one primary plus replicas.** A well-tuned Postgres or MySQL on modern hardware handles tens of thousands of transactions per second and terabytes of data. That is the majority of businesses, forever.
- **You want mature operations.** Backups, point-in-time recovery, replication, monitoring, managed offerings (RDS, Cloud SQL, Aurora), and thirty years of collective debugging knowledge.

**Relational strains when:**

- **Write volume exceeds one node** and the data cannot be cheaply partitioned. Sharding a relational database is possible (Instagram, Uber, Shopify all did it) but you lose cross-shard joins and transactions and inherit routing and rebalancing work. At that point Cassandra or DynamoDB, designed for partitioning from the start, may be simpler.
- **The access pattern is a single key lookup at enormous rate** with no relationships: session storage, feature flags, caches. A key-value store (Redis, DynamoDB) does this faster and cheaper.
- **The schema is truly variable per record** (user-defined forms, event payloads). JSONB in Postgres covers a lot of this, but a document store may fit better if nothing is relational.
- **The workload is analytical**: scanning billions of rows for aggregates. Row-oriented storage is wrong for this; columnar warehouses (BigQuery, Snowflake, ClickHouse) are 10-100x faster.
- **Graph traversals of arbitrary depth** (friends of friends of friends) become recursive joins; a graph database handles them natively.

The mistake in both directions is choosing on fashion. Picking Cassandra for a 20 GB order system throws away transactions and joins to solve a scale problem you do not have. Picking Postgres for 2 M metric points per second and then fighting it is the reverse. State the access patterns and the numbers, then choose. When in doubt, the relational default is right far more often than it is wrong.`,
      mentalModel:
        'A relational database is a Swiss army knife with an excellent blade: it does almost every job well and is the right thing to carry by default. You buy a specialised tool only when one job dominates and the knife is measurably too slow at it.',
      keyPoints: [
        'Relational fits relational data, correctness-critical writes, ad hoc queries, and scale up to one primary plus replicas.',
        'It strains on write volume beyond one node, pure key-value access at extreme rate, highly variable schemas, analytics, and deep graph traversals.',
        'Sharding relational is possible but costs joins and cross-shard transactions.',
        'Decide from access patterns and numbers, never from fashion; the relational default is usually right.',
      ],
      checkpoint: {
        question:
          'A startup building a B2B invoicing product (10k customers, 1 M invoices/year) is debating Postgres vs DynamoDB. Make the call in three sentences.',
        answer:
          'Postgres. The data is relational (customers, invoices, line items, payments) and correctness-critical (money), the scale is tiny (1 M rows/year fits one node for decades), and finance teams will ask arbitrary reporting questions that SQL answers for free. DynamoDB would force every query to be designed as a key access upfront and would give up transactions across entities for a scale problem that does not exist.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Which mechanism primarily implements atomicity and durability in Postgres and InnoDB?',
      options: [
        'B-tree indexes',
        'The write-ahead / redo log flushed to disk before commit is acknowledged',
        'Foreign key constraints',
        'Read replicas',
      ],
      answerIndex: 1,
      explanation:
        'Changes are logged before data pages are modified and the log is fsynced at commit, so recovery can redo committed work and undo incomplete work. Indexes speed reads, constraints implement the C in ACID, and replicas are about availability, not transaction guarantees.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'A table has a composite index on (customer_id, created_at). Which query cannot use it efficiently?',
      options: [
        'WHERE customer_id = 7',
        'WHERE customer_id = 7 AND created_at > \'2024-01-01\'',
        'WHERE created_at > \'2024-01-01\'',
        'WHERE customer_id = 7 ORDER BY created_at DESC LIMIT 10',
      ],
      answerIndex: 2,
      explanation:
        'The index is sorted by customer_id first; created_at values are only ordered within a customer. A predicate on created_at alone has no leftmost prefix to seek on, so the planner needs a scan or a separate index. The other three all start with equality on customer_id.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Roughly how many page reads does a B-tree point lookup need on a table with 1 billion rows?',
      options: ['About 30 (log2 of a billion)', '3-4', 'About 1,000', 'One per row scanned'],
      answerIndex: 1,
      explanation:
        'B-tree pages hold hundreds of keys, so the fan-out is in the hundreds and the tree is 3-4 levels deep for a billion rows. log2 would apply to a binary tree, not a B-tree. Upper levels are cached, so it is typically a single disk read.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which of the following are real costs of adding an index? Select all that apply.',
      options: [
        'Every INSERT must also write to the index',
        'UPDATEs to indexed columns must update the index',
        'Additional disk space',
        'Slower point lookups on the indexed column',
        'Longer bulk load times',
      ],
      answerIndices: [0, 1, 2, 4],
      explanation:
        'Indexes are maintained on every write, take space (often comparable to the table), and slow bulk loads. They make lookups on the indexed column faster, not slower, so that option is wrong.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement: 'In Postgres, declaring a FOREIGN KEY automatically creates an index on the referencing column.',
      answer: false,
      explanation:
        'Postgres creates an index for PRIMARY KEY and UNIQUE constraints but not for foreign keys. Joins and deletes involving an unindexed FK column degrade to scans, one of the most common causes of slow joins. MySQL InnoDB does create one automatically.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question: 'An API lists 100 orders and, for each, runs a separate query to fetch the customer. Latency is 120 ms. What is the most likely cause and fix?',
      options: [
        'Slow hash join; increase work_mem',
        'N+1 queries; replace with a single JOIN or a batched WHERE id IN (...)',
        'Missing primary key on orders; add one',
        'Table bloat; run VACUUM FULL',
      ],
      answerIndex: 1,
      explanation:
        '101 round trips at roughly 1 ms each is the N+1 pattern. One join or one IN query returns the same data in a couple of milliseconds. There is no join happening at all, so work_mem is irrelevant, and bloat or missing keys would show different symptoms.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'Why should you avoid calling an external payment API inside an open database transaction?',
      options: [
        'The API call would be rolled back on failure',
        'Row locks and the MVCC snapshot are held for the whole call, blocking other transactions and delaying cleanup',
        'Postgres forbids network calls inside transactions',
        'It disables the write-ahead log',
      ],
      answerIndex: 1,
      explanation:
        'A multi-second external call keeps the transaction open, holding locks on touched rows, pinning a pool connection and preventing old-version cleanup. The database has no knowledge of the API call at all, so it cannot roll it back or forbid it; the damage is purely from the transaction staying open.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: 'Storing the product price in order_items at purchase time violates normalisation and should always be replaced by a join to products.',
      answer: false,
      explanation:
        'The purchase price is a different fact from the current product price; the order must record what was actually paid even after the product changes. This is deliberate denormalisation for historical correctness, and joining to products would rewrite history.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'A query joining a 200 M row events table to a 150 M row users table with no selective filter runs on the request path and takes 40 s. What is the right conclusion?',
      options: [
        'Add more indexes until it is fast',
        'Switch to a nested loop join',
        'This is an analytical query; move it to a warehouse or precompute the result, do not run it per request',
        'Increase the connection pool size',
      ],
      answerIndex: 2,
      explanation:
        'A join that touches hundreds of millions of rows on both sides is inherently heavy; indexes help selective lookups, not full-set joins, and a nested loop would be far worse. Such work belongs in a columnar warehouse or a periodically refreshed materialised table. Pool size does nothing for a single slow query.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'What does the "C" in ACID guarantee?',
      options: [
        'Every replica sees the same data at the same time',
        'The database moves from one state satisfying all integrity constraints to another',
        'Reads are served from cache when possible',
        'Transactions are committed in timestamp order',
      ],
      answerIndex: 1,
      explanation:
        'Consistency in ACID means constraints (UNIQUE, CHECK, FK, NOT NULL, triggers) hold at commit. Replica agreement is the CAP or replication sense of consistency, a different concept. Caching and ordering are unrelated.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design the indexes for a table messages(id, conversation_id, sender_id, created_at, body) that must support: (a) load the latest 50 messages in a conversation, (b) find all messages sent by a user in a date range, (c) fetch a message by id. Explain each choice and its write cost.',
      modelAnswer: `- **(c)** Primary key on \`id\` gives a B-tree lookup for free.
- **(a)** Composite index on \`(conversation_id, created_at DESC)\`: equality on conversation, then the leaf order already matches the sort, so the engine reads 50 leaf entries and stops. Optionally \`INCLUDE (sender_id, body)\` in Postgres for an index-only scan, at the cost of a much larger index; usually not worth it for large bodies.
- **(b)** Composite index on \`(sender_id, created_at)\`: equality then range.

An index on \`created_at\` alone is not needed; both composites serve their range through the leading equality. Write cost: three B-tree updates per insert (PK plus two secondaries). At high message rates, monotonic ids (bigserial or time-ordered UUIDv7) keep PK inserts appending to the rightmost leaf instead of splitting random pages.`,
      rubric: [
        'Composite index with conversation_id first and created_at second for (a).',
        'Explains that the index order removes the need for a sort.',
        'Composite (sender_id, created_at) for (b).',
        'Mentions write cost per index and avoids redundant indexes.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain the difference between how InnoDB and Postgres store a table and its secondary indexes, and one practical consequence of each.',
      modelAnswer: `InnoDB stores the table as a clustered B-tree ordered by the primary key; the row data lives in the leaf pages of the PK index. Secondary indexes store the PK value, so a secondary lookup is two traversals (secondary tree, then PK tree). Consequence: random primary keys (UUIDv4) cause inserts to land on random pages, splitting and fragmenting the clustered tree; monotonic keys are strongly preferred.

Postgres stores rows in an unordered heap; every index, including the primary key, is a separate B-tree whose leaves point to a physical location (ctid). Consequence: any update that changes an indexed column produces a new row version and must update the indexes (HOT updates avoid this when no indexed column changes), and MVCC leaves dead tuples that VACUUM must clean.`,
      rubric: [
        'InnoDB: clustered by PK, secondaries hold PK, two traversals.',
        'Postgres: heap plus separate indexes with row pointers.',
        'Consequence for InnoDB: random PKs fragment the tree.',
        'Consequence for Postgres: dead tuples/VACUUM or index maintenance on updates.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'ACID (expand and one-line each)', back: 'Atomicity: all or nothing. Consistency: constraints hold. Isolation: concurrent transactions do not interfere. Durability: committed data survives crashes.' },
    { id: 'f2', front: 'Mechanism behind atomicity and durability', back: 'Write-ahead log (Postgres WAL, InnoDB redo/undo log): changes logged and fsynced before commit ack; replay committed, undo incomplete on recovery.' },
    { id: 'f3', front: 'Why commit latency has a floor', back: 'COMMIT waits for the WAL fsync to disk: ~1 ms on SSD, ~10 ms on HDD. Disabling fsync trades durability for speed.' },
    { id: 'f4', front: 'ACID consistency vs CAP consistency', back: 'ACID C: integrity constraints hold at commit. CAP C: all nodes see the same data. Different concepts sharing a word.' },
    { id: 'f5', front: 'B-tree lookup cost', back: 'Balanced tree of sorted pages with fan-out in the hundreds: 3-4 levels for billions of rows, so 3-4 page reads, usually one disk read since upper levels are cached.' },
    { id: 'f6', front: 'What a B-tree index can serve', back: 'Equality, range (BETWEEN, >, <), ORDER BY, MIN/MAX on its leading columns; range scans follow the linked leaf pages.' },
    { id: 'f7', front: 'Leftmost-prefix rule', back: 'A composite index (a, b) serves predicates on a, or a and b, and ORDER BY a, b. It cannot serve a predicate on b alone.' },
    { id: 'f8', front: 'Covering index / index-only scan', back: 'The index contains every column the query needs (via INCLUDE or as key columns), so the heap or clustered table is never read.' },
    { id: 'f9', front: 'Clustered (InnoDB) vs heap (Postgres) storage', back: 'InnoDB: table is a B-tree ordered by PK; secondaries store the PK. Postgres: unordered heap; each index leaf holds a physical row pointer (ctid).' },
    { id: 'f10', front: 'Costs of an index', back: 'Extra write on every INSERT and on UPDATE of indexed columns, disk space comparable to the table, slower bulk loads. Index real access patterns only.' },
    { id: 'f11', front: 'Three join algorithms and when each fits', back: 'Nested loop: small outer, indexed inner. Hash join: large unsorted inputs with equality, needs memory. Merge join: both inputs sorted on the key.' },
    { id: 'f12', front: 'N+1 query problem', back: 'One query for a list, then one per item: N extra round trips at ~1 ms each. Fix with a JOIN, a batched WHERE id IN (...), or ORM eager loading.' },
    { id: 'f13', front: '1NF, 2NF, 3NF in one line each', back: '1NF: atomic values, no repeating groups. 2NF: non-key columns depend on the whole key. 3NF: no non-key column depends on another non-key column.' },
    { id: 'f14', front: 'What normalisation buys and costs', back: 'Buys: each fact stored once, no update anomalies, smaller writes. Costs: reads need joins; painful across shards or at huge read volume.' },
    { id: 'f15', front: 'Legitimate denormalisation examples', back: 'Stored totals and counters, historical snapshots (price at purchase), read-optimised or materialised views. Always name the source of truth and the sync mechanism.' },
    { id: 'f16', front: 'Why keep transactions short', back: 'Open transactions hold row locks, keep MVCC snapshots alive (bloat, undo growth), and pin pool connections. Never hold one across external calls or user think time.' },
    { id: 'f17', front: 'When relational wins', back: 'Relational data with cross-entity queries, correctness-critical writes, ad hoc querying, scale within one primary plus replicas, mature operations.' },
    { id: 'f18', front: 'When relational strains', back: 'Writes beyond one node without a cheap partition key, pure key-value at extreme rate, highly variable schemas, analytics over billions of rows, deep graph traversals.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'ACID transactions',
      prompt: 'Explain ACID to a frontend developer using a bank transfer, and say what would go wrong without each property.',
      modelExplanation: `Moving 100 from Ana to Bo is two writes: subtract from Ana, add to Bo. A transaction wraps them so they behave like one action.

Atomicity means both happen or neither. Without it, a crash between the writes makes 100 disappear. The database achieves this by writing a log of what it is about to do before doing it, so after a crash it can finish or undo.

Consistency means the rules always hold: if balances cannot go negative, a transfer that would break that fails entirely. Without it you get bad data that every screen must defend against.

Isolation means two transfers touching Ana at the same moment cannot see each other's half-done state. Without it, both could read the same balance and both subtract, and Ana pays once but the bank loses 100.

Durability means once the app is told "done", a power cut cannot undo it, because the log was forced to disk first. Without it, users see confirmations for transfers that never existed.`,
      mustMention: [
        'All-or-nothing via the write-ahead log',
        'Constraints enforced at commit',
        'Concurrent transactions isolated from half-done work',
        'Committed data survives crashes because the log is flushed',
      ],
    },
    {
      id: 'fe2',
      concept: 'B-tree indexes',
      prompt: 'Explain how a B-tree index makes a lookup fast and why you should not index every column, to a developer who only knows arrays.',
      modelExplanation: `Finding a user by email in an unsorted table means reading every row, like scanning an unsorted array. An index is a separate structure kept sorted by email. But instead of a flat sorted array, which is slow to insert into, the database uses a B-tree: a tree of pages where each page holds hundreds of sorted keys and pointers to child pages.

Because each level multiplies the reach by hundreds, a table with a billion rows needs only three or four levels. A lookup reads the root page, follows one pointer per level, and lands on the leaf that points to the row, so three or four page reads instead of a billion. The top pages stay in memory, so it is usually one disk read. The leaves are linked in order, so ranges and sorting come for free.

The catch is that every insert or update of an indexed column must also update every index on that table. Ten indexes means ten extra tree updates per write, plus disk space. So you create indexes for the queries you actually run and check with EXPLAIN that they are used.`,
      mustMention: [
        'Sorted tree of pages with large fan-out',
        'Three or four levels for billions of rows',
        'Leaves linked for range scans and ordering',
        'Every index is maintained on every write and costs disk',
      ],
    },
    {
      id: 'fe3',
      concept: 'Normalisation vs denormalisation',
      prompt: 'Explain to a product manager why the team normalised the schema, and why it is also fine that the orders table stores a copy of the product price.',
      modelExplanation: `Normalising means storing each fact in exactly one place. A customer's address lives in one row, and orders point to the customer rather than copying the address. The benefit is that changing the address is one edit and there is never a moment where two orders disagree about where a customer lives. It also keeps the data small and lets us answer new questions by joining tables instead of rewriting code.

The cost is that showing an order page means joining a few tables. On indexed tables that is a couple of milliseconds, which is fine at our scale.

The product price on the order looks like a copy but is actually a different fact: it is the price the customer paid, at that moment. If we looked up the current price instead, changing a price tomorrow would rewrite yesterday's invoices. So we store it deliberately, and we know which one is the truth for which purpose: the products table for today's price, the order row for history.`,
      mustMention: [
        'Each fact stored once prevents update anomalies',
        'Cost is joins on read, cheap at OLTP scale',
        'Snapshotting price is a distinct historical fact, not redundancy',
        'Denormalise deliberately with a named source of truth',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a grand old public library, from the entrance hall to the rare-books vault, and each room shows one idea about how a relational database works.',
    stops: [
      { locus: 'The entrance hall with identical registration forms', concept: 'Relational model and enforced schema', image: 'Every visitor fills the same form with fixed boxes. A stern clerk stamps REJECTED on any form with a blank box or "banana" written in the date field, and ties a red string from each form to the visitor\'s home-town card in a drawer (foreign key).' },
      { locus: 'The notary\'s desk with a fireproof ledger', concept: 'ACID via the write-ahead log', image: 'Before any book is moved, the notary writes the move in a ledger and slams it into a fireproof safe with a loud click (fsync). A fire breaks out; the notary reopens the safe and calmly redoes every completed entry and erases the half-written one.' },
      { locus: 'The reading-room tables with hourglasses', concept: 'Keep transactions short', image: 'Each table has an hourglass. A reader who leaves to fetch lunch while books are spread out blocks a queue of twenty people staring at the sand; a librarian sweeps his books away and shouts "no external calls inside a transaction!"' },
      { locus: 'The card catalogue with thumb tabs', concept: 'B-tree indexes', image: 'A giant catalogue where three flips of colossal thumb tabs land you on the exact card among a billion. The drawers are labelled "SURNAME then FIRST NAME"; a visitor who knows only a first name is sent away to scan every drawer (leftmost prefix). Every new book makes ten clerks update ten catalogues at once.' },
      { locus: 'The cross-reference room', concept: 'Joins and N+1', image: 'One researcher walks back and forth a hundred times, fetching one author card per book (N+1), sweating. Beside him a librarian lays two sorted lists side by side and zips them together in one pass (merge join), while another sticks names on a wall and checks each book against it (hash join).' },
      { locus: 'The single master address book on a pedestal', concept: 'Normalisation and denormalisation', image: 'One master address book on a pedestal, with strings running to every record (normalised). Next to it, a display case with old receipts, each stamped with the price paid that day, and a sign: "This copy is history, keep it" (deliberate denormalisation).' },
      { locus: 'The rare-books vault door', concept: 'When relational wins and when not', image: 'The vault door has a scale: on one side "money, relationships, ad hoc questions, fits one building"; on the other "a million scribbles per second, one-key lookups, mountains of statistics". The door swings open for the first side and points a sign reading "Cassandra, Redis, warehouse" for the other.' },
    ],
  },
  interviewQuestions: [
    'Explain ACID and describe the mechanism that implements each property.',
    'How does a B-tree index make a query fast, and what does it cost? When would the planner ignore an index?',
    'You have a composite index on (a, b). Which queries can use it and why?',
    'What is the N+1 query problem and how do you fix it?',
    'Compare nested loop, hash and merge joins. When does the planner choose each?',
    'When would you deliberately denormalise a schema, and how would you keep the copies consistent?',
    'Why are long-running transactions harmful in Postgres or MySQL?',
    'When would you choose a relational database over a NoSQL store, and vice versa?',
  ],
}

export default chapter
