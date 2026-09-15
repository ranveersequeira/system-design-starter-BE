import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 6,
  slug: 'database-scaling',
  title: 'Database Scaling',
  module: 'databases',
  estimatedMinutes: 35,
  summary: 'Scale a database by finding the resource that is actually exhausted. Compare query tuning, larger machines, read replicas, and data distribution while keeping consistency and recovery explicit.',
  objectives: [
    'Diagnose CPU, I/O, connection, and lock bottlenecks before choosing a scaling strategy.',
    'Explain what vertical scaling and read replicas can and cannot improve.',
    'Design read routing around replication lag and read-after-write requirements.',
    'Recognize when write or storage growth justifies partitioning across servers.',
  ],
  quickRevision: [
    'Measure query latency, throughput, resource saturation, and lock waits together.',
    'An index can remove more work than a larger server can execute.',
    'Vertical scaling buys simplicity but has hardware and cost ceilings.',
    'Connection pools bound concurrency; more connections do not create more capacity.',
    'Read replicas offload eligible reads while replaying the primary write stream.',
    'Asynchronous replication allows stale reads and a failover data-loss window.',
    'Read-after-write paths need deliberate routing or a replication-position check.',
    'Synchronous acknowledgment trades latency and availability for stronger durability.',
    'Sharding distributes writes and data but complicates transactions and routing.',
    'Test capacity with a failed node, cold caches, and realistic hot keys.',
  ],
  sections: [
    {
      id: 'measure-first', title: 'Find the work you can eliminate',
      body: `A database becoming slow does not tell you which resource has run out. A query scanning a million rows might consume CPU, storage bandwidth, or both. A transaction waiting for another transaction to release a lock might consume almost neither. Buying a larger machine helps the first situation more than the second. Start with request rate, latency percentiles, slow queries, connection counts, disk latency, and lock waits measured over the same interval.

Trace one important user request to the statements it runs. A product page making one query per review has an application access-pattern problem. Fetching the required reviews in a batch can reduce both round trips and database work. Inspect query plans using representative parameters; a plan that works for a small tenant may fail for a large tenant. Evaluate indexes against filtering, joining, and ordering requirements, and remember that each extra index also adds write work and storage.

Record a baseline before changing anything. Compare the same workload afterward, including a busy period and a large customer. The objective is useful requests completed within the latency target, not an impressive peak connection count.`,
      mentalModel: 'A restaurant first checks whether the queue is at the stove, the cashier, or one locked storeroom. Hiring chefs does not unlock the storeroom.',
      diagram: 'Slow request\n  -> query plan -> CPU / disk work\n  -> lock waits -> transaction contention\n  -> pool wait -> concurrency or slow queries',
      keyPoints: ['Locate the saturated resource.', 'Remove unnecessary work before adding capacity.', 'Compare realistic workloads before and after.'],
      checkpoint: { question: 'CPU is low, but updates to one inventory row wait for seconds. Should you double CPU?', answer: 'First inspect the transaction holding the row lock. Shorten its critical section and avoid network calls while holding the lock. More CPU does not remove serialized access to the same row.' },
    },
    {
      id: 'vertical-and-pools', title: 'Scale one server and control concurrency',
      body: `Vertical scaling adds resources to one database server: memory, CPU, faster disks, or storage capacity. Extra memory can keep a larger working set cached. Faster storage can reduce reads and log flush latency. More cores help when the workload can actually run in parallel. This option preserves a familiar data model and local transactions, which often makes it the cheapest engineering step even when the machine itself costs more.

Every resource has a ceiling. A single heavily contested row still serializes updates. A large data set still takes time to back up and restore. A resize can require maintenance or failover, depending on the deployment. Therefore, plan migration and rollback before the database reaches its limit.

Connection pooling is part of capacity control. If twenty application replicas each open a hundred database connections, the database receives two thousand potential competitors. A bounded pool queues work before it overwhelms the server. Set acquisition timeouts and observe pool waiting time so saturation is visible. Increasing the pool without measuring service time can turn a manageable queue into memory pressure and worse tail latency.`,
      mentalModel: 'A larger kitchen helps until everyone crowds the same counter. A host who limits entry can improve how quickly everyone is served.',
      diagram: '20 app instances\n  -> bounded connection pools\n  -> database: CPU + memory + storage\n  -> finite useful concurrency',
      keyPoints: ['Match the upgrade to the bottleneck.', 'Budget connections across all application instances.', 'Queue with deadlines instead of allowing unlimited work.'],
      checkpoint: { question: 'Autoscaling doubles application servers but database throughput falls. What should you inspect?', answer: 'Aggregate connection limits, pool waits, database memory, and lock contention. Each new app server may add connections and overwhelm the same database; coordinate pool budgets with application scaling.' },
    },
    {
      id: 'read-replicas', title: 'Replicate for reads without hiding staleness',
      body: `A read replica receives changes from a primary and applies them to its own copy of the data. Eligible reads can run there, leaving the primary more room for writes and freshness-sensitive operations. This is especially useful for dashboards, browsing, and reporting where a small freshness delay is acceptable. It does not automatically distribute writes: each replica still needs to process the incoming change stream.

Asynchronous replication creates a gap between a successful commit and visibility on a replica. Suppose a user saves a new display name and immediately loads their profile. If the second request goes to a lagging replica, the old name can appear. The write succeeded, but the product seems broken. Route that flow to the primary, keep a short-lived primary affinity with an explicit limitation, or wait until a replica has applied the required replication position when the infrastructure supports it.

Measure lag and establish a routing policy for lagging nodes. A replica serving long analytical queries can fall behind even while it responds successfully to health checks. A simple random choice among all replicas is therefore not a complete read strategy.`,
      mentalModel: 'Branch libraries copy the main catalog. They make browsing easier, but the receipt for a just-added book should be checked against the main desk.',
      diagram: 'Writes -> primary -> replication stream -> replica A\n                  \---------------------> replica B\nFresh reads -> primary     Tolerant reads -> replicas',
      keyPoints: ['Offload reads that tolerate the consistency contract.', 'Monitor replay lag as well as health.', 'Read replicas do not multiply primary write capacity.'],
      checkpoint: { question: 'Can a healthy replica return an old account setting immediately after a successful save?', answer: 'Yes. Health and freshness are different. An asynchronous replica may not have replayed the commit; route the confirmation read to the primary or use a supported position-based freshness check.' },
    },
    {
      id: 'durability-and-failover', title: 'Choose what a successful write promises',
      body: `Replication also supports recovery, but replicas are not a complete backup strategy. An accidental deletion can be faithfully copied to every replica. Keep independently recoverable backups and exercise restores, including the steps needed to reconnect applications. Recovery time includes detection, promotion, routing changes, and recovery of warm working sets, not just the database process starting.

With asynchronous replication, the primary can acknowledge a write before another server receives it. If that primary disappears permanently, a promoted replica may lack acknowledged changes. Synchronous configurations can require a standby acknowledgment before reporting success, with the exact guarantee depending on whether acknowledgment means receipt, durable flush, or application of the record. More coordination can increase latency and can stop writes when the required standby is unavailable.

Failover must prevent two servers from independently accepting authoritative writes. Fence the old primary and make client routing follow the elected writer. Reconnecting a pool is only one step; retrying an ambiguous operation also needs idempotency or a way to discover whether the original transaction committed. Pick these guarantees from the business requirements before advertising high availability.`,
      mentalModel: 'A signed receipt might mean one clerk filed the document, or that a second office filed a copy too. Decide which promise the signature carries.',
      keyPoints: ['Replicas propagate mistakes; backups provide another recovery path.', 'Synchronous acknowledgment has several possible durability levels.', 'Fence the former primary and handle ambiguous retries.'],
      checkpoint: { question: 'Why is promoting a replica not enough to make failover safe?', answer: 'The former primary must be unable to accept conflicting writes, clients must reach the new writer, and potentially unreplicated commits and ambiguous retries must be handled according to the chosen durability contract.' },
    },
    {
      id: 'when-to-distribute', title: 'Know when one writer is no longer enough',
      body: `Eventually the optimized workload may outgrow a single writer or its storage envelope. First ask whether independent workloads can be separated: analytics can use a derived store, old records can be archived, and unrelated domains may use different databases. These changes can relieve pressure without requiring every request to understand a distributed data model.

Sharding assigns different subsets of the data to different servers. A tenant identifier can keep one customer's records together, while a hash of an entity identifier can spread traffic more evenly. The choice changes which queries are local. A transaction within one shard remains relatively straightforward; a transfer across shards requires additional coordination or a deliberately weaker workflow. A query without the shard key may fan out to many servers.

Capacity planning must include skew and failures. Ten shards do not provide ten times useful capacity if one customer generates half the traffic. Measure per-shard load and design how to split or move a hot shard. Practice routing updates, data movement, and verification while the system continues to serve requests. The next chapter examines these distribution choices in more detail.`,
      mentalModel: 'Opening several branches works only if customers and inventory can be assigned sensibly. One celebrity event can still overwhelm a single branch.',
      keyPoints: ['Separate workloads before distributing every transaction.', 'Choose shard keys from access patterns and skew.', 'Include rebalancing and failure headroom in the design.'],
      checkpoint: { question: 'A database is mostly writes and already has five read replicas. Why might a sixth replica have little benefit?', answer: 'All writes still reach the primary, and each replica replays that write stream. Optimize or separate writes, upgrade the writer if appropriate, or distribute data and writes using a suitable shard strategy.' },
    },
  ],
  quiz: [
    { type: 'mcq', id: 'q1', difficulty: 2, question: 'What is the best first response to rising database latency?', options: ['Double the connection pool', 'Add five replicas', 'Correlate slow queries, resource saturation, and lock waits', 'Shard by a random column'], answerIndex: 2, explanation: 'The observed bottleneck determines the useful intervention. Connections, replicas, or sharding can add cost without addressing it.' },
    { type: 'mcq', id: 'q2', difficulty: 2, question: 'Which workload is a good initial replica candidate?', options: ['A stale-tolerant sales dashboard', 'A balance check enforcing a debit', 'A primary-key insert', 'A transaction taking a write lock'], answerIndex: 0, explanation: 'The dashboard can explicitly tolerate delayed data. Writes and transactional invariants belong on the authoritative write path.' },
    { type: 'mcq', id: 'q3', difficulty: 3, question: 'Why can adding application instances worsen database latency?', options: ['It disables indexes', 'It necessarily duplicates rows', 'It makes all reads synchronous', 'It increases aggregate concurrent database connections'], answerIndex: 3, explanation: 'Per-instance pools multiply. Too much concurrency increases contention and memory demand without increasing the database service rate.' },
    { type: 'mcq', id: 'q4', difficulty: 2, question: 'Which change most directly increases the number of independent write owners?', options: ['A read-only replica', 'Sharding data across writers', 'A longer connection timeout', 'A larger query result'], answerIndex: 1, explanation: 'Shards own different subsets of writes. Replicas receive the existing write stream, and timeouts do not add capacity.' },
    { type: 'multi', id: 'q5', difficulty: 2, question: 'Which measurements help diagnose a database bottleneck?', options: ['Lock wait duration', 'Disk latency', 'Query plans for representative inputs', 'Only the number of deployed application servers'], answerIndices: [0, 1, 2], explanation: 'Waits, storage latency, and plans reveal where work spends time. Application replica count alone does not identify the database limit.' },
    { type: 'truefalse', id: 'q6', difficulty: 1, statement: 'A read replica is always current as soon as the primary acknowledges a write.', answer: false, explanation: 'Asynchronous replication permits delay between commit and replay. Even synchronous settings must be interpreted by their acknowledgment semantics.' },
    { type: 'truefalse', id: 'q7', difficulty: 2, statement: 'Replicas alone protect against an accidental deletion applied by the primary.', answer: false, explanation: 'Replication normally copies the deletion too. Independent backups and recovery procedures are needed.' },
    { type: 'truefalse', id: 'q8', difficulty: 1, statement: 'Adding an index can increase write cost even when it improves reads.', answer: true, explanation: 'Writes must maintain relevant indexes, consuming additional CPU, I/O, and storage.' },
    { type: 'short', id: 'q9', difficulty: 3, question: 'Design the read path after a user changes their profile in a replicated database.', modelAnswer: 'Commit the update on the primary and return the accepted value. Route the immediate confirmation read to the primary, or use a replication-position mechanism that proves a chosen replica has replayed the write. Other browsing reads can use replicas under a documented staleness limit. Observe replica lag and remove unsuitable replicas from that route.', rubric: ['Authoritative primary write', 'Explicit read-after-write strategy', 'Lag monitoring and routing policy'] },
    { type: 'short', id: 'q10', difficulty: 3, question: 'How would you decide whether to shard a slow database?', modelAnswer: 'Measure resource and lock bottlenecks, optimize expensive access patterns, and evaluate vertical scaling or separating analytical reads. If write or storage demand still exceeds one server, choose a shard key based on locality and skew. Estimate cross-shard operations and test rebalancing and node-loss capacity before migrating.', rubric: ['Evidence before architecture changes', 'Simpler scaling alternatives considered', 'Shard key and cross-shard cost', 'Failure and rebalancing plan'] },
  ],
  flashcards: [
    { id: 'f1', front: 'Vertical scaling', back: 'Increase resources of one server. Simple data ownership remains, but hardware ceilings and contended records still limit growth.' },
    { id: 'f2', front: 'Read replica', back: 'A copy receiving the primary change stream and serving eligible reads. It does not independently own primary writes.' },
    { id: 'f3', front: 'Replication lag', back: 'Delay between a primary change and its receipt or application on a replica. Specify which stage a metric measures.' },
    { id: 'f4', front: 'Read-after-write requirement', back: 'A client must observe its accepted change on subsequent reads. Route to the writer or establish that a replica has applied the required position.' },
    { id: 'f5', front: 'Connection pool purpose', back: 'Reuse connections and bound concurrency. An oversized pool can increase contention instead of useful throughput.' },
    { id: 'f6', front: 'Why inspect lock waits?', back: 'A slow operation may be waiting for another transaction rather than lacking CPU. Shorter transactions can help more than a larger machine.' },
    { id: 'f7', front: 'Index tradeoff', back: 'Indexes reduce selected read work but consume space and require maintenance on relevant writes.' },
    { id: 'f8', front: 'Asynchronous failover risk', back: 'A promoted replica can lack writes acknowledged by the lost primary but not yet replicated.' },
    { id: 'f9', front: 'Synchronous replication cost', back: 'Acknowledgment waits for configured standby progress, adding coordination latency and potentially reducing write availability.' },
    { id: 'f10', front: 'Why replicas are not backups', back: 'They usually apply the same accidental deletion or corrupting update. Recovery needs independently retained historical data.' },
    { id: 'f11', front: 'Sharding', back: 'Assign subsets of data and writes to different servers. It trades capacity for routing, rebalancing, and cross-shard complexity.' },
    { id: 'f12', front: 'Failure headroom', back: 'Reserve enough capacity to meet targets when a server fails or traffic shifts; steady-state peak throughput is not the availability budget.' },
  ],
  feynman: [
    { id: 'fe1', concept: 'Read scaling versus write scaling', prompt: 'Explain why copying a database helps browsing more than checkout writes.', modelExplanation: 'Imagine one office keeps the official order book. Several branches receive copies so customers can browse without lining up at that office. This spreads reading work across people and buildings. But all new orders still go through the official clerk, and every branch must copy those changes. Adding branches does not create additional official clerks. To spread writes, we must assign different orders or customers to different offices, then decide how work spanning offices is coordinated. Copies also arrive later: a branch may not yet know about the order you just placed. That is why a confirmation screen needs a deliberate freshness rule even when ordinary browsing works well from a replica.', mustMention: ['Replicas offload reads', 'One primary still owns writes', 'Copies can lag', 'Sharding introduces distinct owners'] },
    { id: 'fe2', concept: 'Measure before scaling', prompt: 'Explain database diagnosis using a busy restaurant, including why more connections can hurt.', modelExplanation: 'A long restaurant queue has several possible causes. Cooking may be slow, the cashier may be overloaded, or one employee may be holding the storeroom key. The answer depends on where people are waiting. A database is similar: queries may consume disk or CPU, or wait for another transaction. An index is like organizing ingredients so the chef stops searching every cupboard. A larger server is like a larger kitchen. A connection pool is the host limiting how many people crowd the workspace. Letting everyone inside at once can slow every order. Measure the queue, the work, and the waiting before picking a change, then repeat the same busy service to check whether completed orders actually increased.', mustMention: ['Identify resource or lock bottleneck', 'Remove unnecessary work', 'Bound concurrency', 'Verify against the same workload'] },
  ],
  memoryPalace: { setting: 'Walk through a restaurant from the entrance queue to its new branch office.', stops: [
    { locus: 'Entrance thermometer', concept: 'Measure first', image: 'A giant thermometer measures CPU while a stopwatch times a locked pantry; the chef refuses to guess which is broken.' },
    { locus: 'Organized pantry', concept: 'Query optimization', image: 'A golden index points directly to one spice jar instead of spilling every shelf onto the floor.' },
    { locus: 'Host desk', concept: 'Connection pooling', image: 'The host admits ten tiny cooks and stops a thousand more from piling into the oven.' },
    { locus: 'Copying counter', concept: 'Read replicas', image: 'Three menus roll out of a copier, but the newest dessert remains only on the original chalkboard.' },
    { locus: 'Receipt vault', concept: 'Durability and backups', image: 'Two clerks stamp a receipt together while an independent time capsule preserves yesterday’s ledger.' },
    { locus: 'Branch map', concept: 'Sharding', image: 'Different neighborhoods get different kitchens, but one enormous customer bends a single branch pin.' },
  ] },
  interviewQuestions: ['How would you diagnose a slow database before changing its topology?', 'What can read replicas improve, and what remains on the primary?', 'How would you guarantee read-after-write behavior?', 'How do synchronous replication and failover affect acknowledged writes?', 'When would you choose sharding over a larger database server?'],
}

export default chapter
