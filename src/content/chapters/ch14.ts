import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 14,
  slug: 'message-streams-and-kafka-essentials',
  title: 'Message Streams And Kafka Essentials',
  module: 'messaging',
  estimatedMinutes: 45,
  summary:
    'Kafka is a distributed, replicated, append-only log, and almost every property people love or curse about it follows from that one design choice. This chapter builds Kafka up from the log: topics and partitions, offsets and consumer groups, replication with in-sync replicas, retention and log compaction, and the producer and consumer settings that decide whether you lose, duplicate or exactly-once-process a record. It ends with when Kafka beats a queue, when it does not, and how Kinesis and Pulsar differ.',
  objectives: [
    'Explain why an append-only partitioned log gives Kafka sequential I/O, replay and multi-consumer fan-out that queues lack.',
    'Choose a partition key and partition count for a topic and predict the ordering and hot-partition consequences.',
    'Describe how consumer groups, offset commits and rebalancing distribute partitions and where duplicates come from.',
    'Configure acks, min.insync.replicas and replication factor to hit a stated durability goal and explain the throughput cost.',
    'Explain log compaction, idempotent producers and transactions, and decide when Kafka is the right tool versus a queue.',
  ],
  quickRevision: [
    'Kafka topic = named stream split into partitions; each partition is an ordered, immutable, append-only log on disk.',
    'Offset = position of a record within one partition; consumers track offsets, the broker never deletes on read.',
    'Ordering is guaranteed only within a partition; records with the same key hash to the same partition, so choose the key by what must be ordered.',
    'Partition count sets the max parallelism of a consumer group: one partition is read by at most one consumer in a group.',
    'Consumer groups each keep their own committed offsets in __consumer_offsets; many groups read the same topic independently.',
    'Consumer lag = latest offset minus committed offset; it is the primary health metric of a stream consumer.',
    'Replication: each partition has one leader and N-1 followers; the ISR is the set of replicas caught up with the leader.',
    'acks=all + min.insync.replicas=2 + replication.factor=3 means a write is acknowledged only when at least 2 replicas have it: survives one broker loss without data loss.',
    'Retention is by time or size (e.g. 7 days) regardless of consumption; log compaction instead keeps the latest record per key forever.',
    'Idempotent producer (enable.idempotence=true) uses a producer id plus sequence numbers so broker-side retries do not duplicate records within a partition.',
    'Kafka transactions give exactly-once for read-process-write loops inside Kafka (Kafka Streams); side effects outside Kafka still need consumer idempotency.',
    'Kafka wins when you need replay, many independent consumers, high throughput (millions/s) or an event log; a queue wins for per-message ack/retry, delays, priorities and small scale.',
    'Kinesis: managed, shards with 1 MB/s in and 2 MB/s out each, 24 h to 365 days retention. Pulsar: separates serving (brokers) from storage (BookKeeper), tiered storage, built-in multi-tenancy.',
  ],
  sections: [
    {
      id: 'the-log',
      title: 'Kafka is a distributed log, not a queue',
      body: `Everything about Kafka follows from one decision: the fundamental data structure is an **append-only log**. A **topic** is a named stream of records. Each topic is split into **partitions**, and each partition is a sequence of records on disk where new records are only ever appended at the end and each record gets a monotonically increasing **offset**: 0, 1, 2, 3.

Compare that to a queue. A queue tracks which messages are in flight, which are acked, which to redeliver; deleting a message is a random-access mutation. A log tracks nothing about consumers. It just appends. Consumers **read forward from an offset** and remember where they are. The broker's job is to write bytes at the end of a file and serve bytes from anywhere in the file.

That simplicity is why Kafka is fast and why it can do things queues cannot:

**Sequential I/O.** Appending to a file and reading ranges of it are the two things disks and SSDs do best, hundreds of MB/s even on spinning disks. Kafka also leans on the OS **page cache** rather than its own heap: recent records are in RAM courtesy of the kernel, and \`sendfile\` (zero-copy) pushes bytes from page cache to the network socket without touching user space. A modest three-broker cluster moves hundreds of MB/s and millions of small records per second.

**Replay.** Because reading does not delete, a consumer can reset its offset to yesterday and reprocess. A new team can join months later and read from the beginning. A bug in your indexer means "rewind and rerun", not "restore from backup".

**Fan-out without copies.** Ten different applications read the same partition bytes; each just keeps its own offset. A queue would need ten copies of every message.

**Batching everywhere.** Producers batch records per partition (\`linger.ms\`, \`batch.size\`); brokers write batches; consumers fetch batches. Per-record overhead disappears, which is why Kafka throughput is measured in MB/s rather than messages/s.

The cost of the log model is that Kafka has **no per-message acknowledgement**. You cannot say "I failed on record 1,042, redeliver just that one". Progress is a single offset per partition: either you are past 1,042 or you are not. Retrying one record while continuing with the rest is your problem to solve (retry topics, a DLQ topic, or in-consumer retry). This one gap is the source of most "Kafka is hard" stories, and it is inherent, not a bug.`,
      mentalModel:
        'A queue is a stack of paper tickets that a clerk hands out and throws away. A log is a ledger book: entries are written on the next blank line, never erased, and each reader keeps a bookmark. Ten readers, one book.',
      diagram: `Topic "orders", 3 partitions

P0: | 0 | 1 | 2 | 3 | 4 | 5 | 6 | --> append here
P1: | 0 | 1 | 2 | 3 |             --> append
P2: | 0 | 1 | 2 | 3 | 4 | 5 |     --> append
          ^                 ^
   group "billing"     group "analytics"
   offset P0=1         offset P0=5
   (both read the same bytes; nothing is deleted on read)`,
      keyPoints: [
        'Topic = partitions = append-only logs; records have offsets; the broker never deletes on read.',
        'Sequential I/O, page cache and zero-copy make Kafka move MB/s, not just messages/s.',
        'Replay and multi-group fan-out fall out of "consumers keep their own bookmark".',
        'No per-message ack: progress is one offset per partition, so per-record retry is the consumer\'s job.',
      ],
      checkpoint: {
        question:
          'Two teams, billing and analytics, both need every OrderPlaced event. With SQS you would need two queues fed by SNS. What do you need with Kafka, and what happens if analytics is down for a day?',
        answer:
          'One topic, two consumer groups. Each group keeps its own committed offset. If analytics is down for a day, its offset simply stops advancing; when it returns it reads from where it left off, as long as retention (say 7 days) has not expired. Billing is unaffected and no messages were copied.',
      },
    },
    {
      id: 'partitions-and-keys',
      title: 'Partitions, keys and ordering',
      body: `A partition is Kafka's unit of **parallelism**, **ordering** and **placement**. Getting the partitioning right is most of Kafka design.

**How records land in a partition.** A producer sends a record with an optional **key**. With a key, the default partitioner computes \`murmur2(key) mod numPartitions\`, so all records with the same key go to the same partition, forever (until you change the partition count). Without a key, records are spread round-robin or, in newer clients, in **sticky** batches to whichever partition the current batch is filling.

**Ordering is per partition, full stop.** Within a partition, offset order is append order, and a consumer sees records in that order. Across partitions there is no ordering at all. So the rule is: **the key is whatever must be ordered**. For "OrderStatusChanged" the key is the order id, so created -> paid -> shipped for one order is always seen in sequence. For "UserActivity" the key is the user id. If nothing needs ordering, use no key and enjoy perfect balance.

**Partition count sets maximum consumer parallelism.** In one consumer group each partition is assigned to exactly one consumer. Twelve partitions means at most twelve active consumers; a thirteenth sits idle. You can add partitions later, but doing so changes \`hash mod N\`, so existing keys start landing on different partitions and per-key ordering across the boundary is lost. Choose generously up front: a common heuristic is target throughput divided by per-consumer throughput, rounded up with headroom, often 12-50 for a busy business topic. Too many partitions (thousands per broker) cost memory, file handles, longer leader elections and more end-to-end latency because batches per partition are smaller.

**Hot partitions.** Hashing on a skewed key concentrates load. If one merchant produces 40% of orders and the key is merchant id, one partition and one consumer carry 40% of the traffic while others idle. Options: pick a finer key (order id rather than merchant id), add a salt to hot keys when ordering does not span them, or accept and give that partition a dedicated consumer.

**Placement.** Partitions are spread across brokers, so a topic's traffic and storage are spread across the cluster. A single partition, however, must fit on one broker's disk and is served by one leader, so a partition is also the unit of vertical limit: roughly tens of MB/s and a few hundred GB comfortably.

Design consequence: think of the partition count as a semi-permanent schema decision, and the key as the answer to "what has to happen in order?".`,
      mentalModel:
        'Partitions are supermarket checkout lanes. Each lane is strictly first-come-first-served (ordered), and you choose the lane by hashing something (a family always goes to the same lane so their items stay together). More lanes means more parallel checkouts, but if one family is doing a month of shopping, their lane crawls.',
      diagram: `producer: key=order-42 -> murmur2("order-42") mod 3 = 1 -> P1
          key=order-42 -> always P1  (ordered: created, paid, shipped)
          key=order-99 -> P0
          key=null     -> sticky/round-robin

Consumer group "billing" (3 consumers):
   P0 -> c1     P1 -> c2     P2 -> c3     (a 4th consumer would idle)`,
      keyPoints: [
        'Same key -> same partition (hash mod N); ordering exists only inside a partition.',
        'Key = the thing that must be ordered (order id, user id); no key when order is irrelevant.',
        'Partition count = max consumers in a group; adding partitions later breaks per-key placement.',
        'Skewed keys create hot partitions; pick finer keys or salt.',
        'A partition lives on one broker, so it is also the unit of storage and throughput limit.',
      ],
      checkpoint: {
        question:
          'A topic has 6 partitions keyed by user id. Traffic doubles and you want 12 consumers, so you raise the partition count to 12. What just happened to ordering for existing users?',
        answer:
          'hash(user) mod 6 and hash(user) mod 12 differ for most users, so a user\'s new events land on a different partition from their old ones. A consumer may process a new event before an old one still sitting in the original partition, breaking per-user order across the transition. Mitigate by draining consumers to the end before switching, or by over-provisioning partitions from the start.',
      },
    },
    {
      id: 'consumer-groups-and-offsets',
      title: 'Consumer groups, offsets and rebalancing',
      body: `A **consumer group** is a set of consumers sharing a \`group.id\` that together read a topic, with each partition owned by exactly one member. This is how Kafka gets queue-like work distribution (many consumers splitting the load) while keeping per-partition ordering. Different groups are fully independent: each has its own set of **committed offsets**, stored by the broker in the internal topic \`__consumer_offsets\`.

**Offsets and commits.** A consumer polls a batch (\`poll()\`), processes it, then **commits** the offset of the next record to read. On restart it resumes from the committed offset. Where you commit decides your delivery semantics, exactly as ack timing does for queues:

- \`enable.auto.commit=true\` commits every 5 s in the background regardless of processing: fast, but a crash after commit and before processing loses records (at-most-once), and a crash after processing before commit duplicates them.
- Manual commit after processing the batch gives **at-least-once**: a crash mid-batch replays the whole batch, so processing must be idempotent.

**Consumer lag** is the difference between the partition's latest offset and the group's committed offset. Rising lag means consumers are falling behind; lag near zero means you are current. It is the metric to alert on, and tools like Burrow and the Kafka UI track it per partition.

**Rebalancing.** When a consumer joins, leaves, crashes or stops calling \`poll()\` for longer than \`max.poll.interval.ms\` (default 5 min), the **group coordinator** (a broker) triggers a rebalance: partitions are reassigned across the surviving members. During a classic "eager" rebalance every consumer stops, gives up all partitions, and receives a new assignment, a stop-the-world pause of seconds. **Cooperative (incremental) rebalancing** (\`CooperativeStickyAssignor\`) moves only the partitions that must move, and **static membership** (\`group.instance.id\`) lets a restarted pod reclaim its old partitions without a rebalance at all. Rebalances are also a duplicate source: uncommitted work on a reassigned partition is redone by the new owner.

**Slow processing traps.** If a handler takes longer than \`max.poll.interval.ms\` for one batch, the consumer is considered dead and kicked, causing a rebalance and reprocessing, which makes it slow again. Fix by lowering \`max.poll.records\`, processing asynchronously with manual pause/resume, or raising the interval.

**Reading from many partitions with fewer consumers** is fine: one consumer can own several partitions. The reverse is not: partitions are the ceiling.`,
      mentalModel:
        'A consumer group is a team of readers sharing one book, each assigned certain chapters (partitions) and keeping a bookmark. When a reader leaves, the chapters are redistributed. Another team can read the same book with entirely different bookmarks.',
      diagram: `Partition P0:  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |  latest = 9
                             ^               ^
                  committed = 3        consumer is here (7)
                  <---- lag = 9 - 3 = 6 ----->

Crash now -> restart at 3 -> records 3..6 processed again (at-least-once)

Rebalance: c2 dies -> coordinator reassigns P1 to c1 or c3
            c1: [P0, P1]  c3: [P2]`,
      keyPoints: [
        'One partition -> one consumer within a group; groups are independent with their own committed offsets.',
        'Commit after processing for at-least-once; auto-commit can both lose and duplicate.',
        'Consumer lag (latest - committed) is the health metric.',
        'Rebalances reassign partitions on membership change; use cooperative assignor and static membership to shrink the pause.',
        'A handler slower than max.poll.interval.ms gets the consumer evicted and reprocessed.',
      ],
      checkpoint: {
        question:
          'A consumer group of 4 reads 8 partitions and has zero lag. You deploy a new version with a rolling restart, one pod at a time. What do you expect to observe in lag and in duplicate processing, and how would you reduce it?',
        answer:
          'Each pod restart triggers a rebalance (two with eager assignment: leave and rejoin), pausing consumption for all members, so lag spikes briefly four times, and any records processed but not yet committed on the moved partitions are reprocessed. Reduce it with CooperativeStickyAssignor so only the affected partitions move, static group membership so a restarted pod reclaims its own partitions without a rebalance, and committing offsets frequently.',
      },
    },
    {
      id: 'replication-and-isr',
      title: 'Replication, ISR and the acks setting',
      body: `A partition is replicated across brokers so that losing a machine loses no data. With \`replication.factor=3\` each partition has one **leader** and two **followers**. All produces and (normally) all consumes go to the leader; followers continuously fetch from the leader to stay caught up.

**In-sync replicas (ISR).** The ISR is the subset of replicas that are fully caught up with the leader (within \`replica.lag.time.max.ms\`, default 30 s). A follower that falls behind, or whose broker dies, is removed from the ISR; when it catches up it is added back. The **high watermark** is the highest offset replicated to every ISR member; consumers can only read up to it, so a record is never visible until it is durable on the whole ISR.

**acks: the producer's durability dial.**
- \`acks=0\`: fire and forget. Fastest; loses records on any hiccup. Metrics and logs only.
- \`acks=1\`: leader has written it. If the leader dies before followers replicate, the record is gone. Fast, acceptable for data you can afford to lose rarely.
- \`acks=all\` (or -1): every replica currently in the ISR has written it. Durable, at the cost of waiting for the slowest in-sync follower.

But \`acks=all\` alone is a trap: if two brokers are down, the ISR shrinks to just the leader and "all" means one copy. That is what **min.insync.replicas** fixes. With \`min.insync.replicas=2\` and \`acks=all\`, the leader rejects writes (\`NotEnoughReplicasException\`) rather than acknowledge a record held by fewer than two replicas. The standard durable configuration is therefore **RF=3, min.insync.replicas=2, acks=all**: survives one broker failure with zero data loss and stays writable; a second simultaneous failure makes the partition read-only rather than lossy. Availability traded for durability, exactly as you would choose for orders or payments.

**Leader election.** When a leader dies, the controller picks a new leader from the ISR, which by definition has every committed record, so no acknowledged data is lost. If the ISR is empty (all in-sync replicas died), \`unclean.leader.election.enable=false\` (the default) keeps the partition offline until one returns; setting it true lets a lagging replica become leader, restoring availability at the price of losing the records it never received. Choose consciously per topic.

**Costs.** Replication triples storage and network. \`acks=all\` adds the replication round trip to produce latency (a few ms in one data centre). Cross-availability-zone replication (rack awareness) adds inter-AZ bandwidth costs but survives a zone outage.

**KRaft.** Since Kafka 3.3, cluster metadata and controller election use the built-in KRaft consensus protocol instead of ZooKeeper, removing a separate system to operate and supporting far more partitions per cluster.`,
      mentalModel:
        'Replication is a notary requiring signatures on copies of a contract. acks=1 is one signature; acks=all with min.insync.replicas=2 is "at least two notaries must sign before you may leave the room". If only one notary is in the building, the office refuses to notarise rather than hand you a weak contract.',
      diagram: `Partition P0, RF=3

  Broker 1 (leader)   | 0 | 1 | 2 | 3 | 4 | 5 |
  Broker 2 (follower) | 0 | 1 | 2 | 3 | 4 | 5 |   in ISR
  Broker 3 (follower) | 0 | 1 | 2 |               lagging -> out of ISR

  high watermark = 5 (replicated to all ISR members {1,2})
  acks=all + min.insync.replicas=2 : write ok (ISR size 2)
  Broker 2 dies -> ISR={1} < 2 -> producer gets NotEnoughReplicas`,
      keyPoints: [
        'Each partition: one leader, N-1 followers; ISR = replicas caught up with the leader.',
        'Consumers read only up to the high watermark (replicated to all ISR).',
        'acks=0 fastest/lossy; acks=1 leader only; acks=all waits for the whole ISR.',
        'RF=3 + min.insync.replicas=2 + acks=all: no loss on one failure; read-only rather than lossy on two.',
        'unclean.leader.election trades durability for availability; default off.',
        'KRaft replaced ZooKeeper for metadata and controller election.',
      ],
    },
    {
      id: 'retention-and-compaction',
      title: 'Retention and log compaction',
      body: `Because Kafka never deletes on read, it must decide independently how long to keep data. There are two policies, and they serve completely different purposes.

**Time and size retention (\`cleanup.policy=delete\`).** Each partition is stored as a sequence of **segment files** (default 1 GB or 7 days each). Kafka deletes whole segments whose newest record is older than \`retention.ms\` (default 7 days) or when the partition exceeds \`retention.bytes\`. Retention is independent of consumption: unread records expire and read records stay. A 7-day window means a consumer can be down for a week and recover, and a new consumer can backfill a week of history. The cost is disk: 100 MB/s of input at 7 days and RF=3 is about 180 TB. **Tiered storage** (Kafka 3.6+, Pulsar, Confluent) moves old segments to S3 so retention can be months at object-storage prices while brokers keep only hot data on local disk.

**Log compaction (\`cleanup.policy=compact\`).** Instead of deleting by age, a background cleaner keeps **at least the latest record for every key** and removes older records with the same key. The result is that the topic converges to a snapshot of current state per key while retaining full ordering for recent records. A record with a **null value** is a **tombstone**: it marks the key as deleted and is itself removed after \`delete.retention.ms\` (default 24 h), giving consumers time to see the deletion.

Compaction turns a topic into a **changelog** or a **materialised key-value store**:

- Kafka's own \`__consumer_offsets\` is a compacted topic keyed by (group, topic, partition).
- Kafka Streams stores each state store's changelog in a compacted topic, so a restarted instance rebuilds its local RocksDB by replaying only the latest value per key.
- **Change data capture** (Debezium reading MySQL binlog or Postgres WAL) publishes row changes keyed by primary key into compacted topics; any service can bootstrap a full copy of the table by reading from the beginning and then stay current by tailing.
- "Current user profile" or "current product price" topics let dozens of services keep a local cache warm without hitting the source database.

**What compaction does not give you.** It is not a database: no secondary indexes, no point reads (you must read the whole partition to find a key), and compaction runs lazily, so the head of the log still contains duplicates for a while. It also requires every record to have a key and does not preserve intermediate history, so if you need the audit trail, use delete retention, or both policies together (\`compact,delete\`) to bound size.

Choosing: **events** ("order placed", clicks, logs) want delete retention; **state** ("current address of user 42") wants compaction.`,
      mentalModel:
        'Time retention is a newspaper archive that shreds anything older than a week. Compaction is an address book: when someone moves, you cross out the old address and keep only the latest, and a crossed-out name (tombstone) is torn out a day later.',
      diagram: `Before compaction (key:value):
  k1:A  k2:X  k1:B  k3:P  k2:Y  k1:C  k3:null(tombstone)

After compaction (latest per key; tombstone kept for delete.retention.ms):
  k2:Y  k1:C  k3:null     -> later k3 removed entirely

Delete retention instead:  segments older than 7 days are dropped whole
  [seg 1: days 8-10] [seg 2: days 5-7] [seg 3: days 1-4 <- active]
        ^ deleted`,
      keyPoints: [
        'Delete policy removes whole segments by age or size, independent of who has read them.',
        'Compaction keeps the latest record per key; null values are tombstones removed after delete.retention.ms.',
        'Compacted topics are changelogs: consumer offsets, Kafka Streams state, CDC tables, current-state caches.',
        'Compaction is not a database: no point lookups, no indexes, lazy cleaning.',
        'Events -> delete retention; state -> compaction; tiered storage makes long retention cheap.',
      ],
      checkpoint: {
        question:
          'You publish every product price change to a Kafka topic keyed by product id. A new pricing-cache service needs the current price of all 5 million products on startup. Which cleanup policy do you want and why does the key matter?',
        answer:
          'Compaction. The new service reads the topic from offset 0 and, because compaction has removed older prices for each product id, it reads roughly one record per product (5 million) instead of every historical change (possibly billions). The key must be the product id so that "latest per key" means "latest price per product"; without keys compaction cannot run at all.',
      },
    },
    {
      id: 'delivery-semantics-in-kafka',
      title: 'Idempotent producers, transactions and exactly-once',
      body: `Kafka's default posture is **at-least-once**: producers retry on transient errors and consumers commit after processing. Two features narrow the duplicate window, and it is important to understand exactly what each covers.

**The producer duplicate problem.** A producer sends a batch, the leader writes it, and the acknowledgement is lost in the network. The producer retries and the leader appends the batch a second time. Before Kafka 0.11 you chose between duplicates and \`retries=0\` (loss).

**Idempotent producer** (\`enable.idempotence=true\`, default since 3.0). Each producer gets a **producer id (PID)** and attaches a per-partition **sequence number** to every batch. The leader remembers the last sequence per PID per partition and discards a batch it has already written. Retries are now safe: **no duplicates and no reordering within a partition from a single producer session**. It also forces \`acks=all\` and \`max.in.flight.requests.per.connection<=5\`. This is free and you should always leave it on. What it does *not* cover: duplicates caused by the application calling \`send()\` twice (for example after the whole process restarts with a new PID), or anything on the consumer side.

**Transactions.** A producer with a \`transactional.id\` can write to several partitions and **commit the consumer offsets in the same transaction** (\`sendOffsetsToTransaction\`). Consumers with \`isolation.level=read_committed\` see either all of a transaction's records or none. This is how Kafka Streams achieves **exactly-once semantics (EOS)** for the pattern *consume from topic A -> transform -> produce to topic B*: the output records and the input offset commit are atomic, so a crash either leaves both undone (replay) or both done (no duplicate output). Cost: a transaction coordinator round trip per commit, higher latency (commit interval, default 100 ms in Streams), and about 3-10% lower throughput.

**The boundary that transactions cannot cross.** If your consumer writes to Postgres, calls Stripe or sends an email, Kafka's transaction knows nothing about it. A crash between the external write and the offset commit replays the record and repeats the side effect. Exactly-once end-to-end therefore still requires an **idempotent consumer**: store the (topic, partition, offset) or a business key with the result in the external system's own transaction, or use an idempotent sink connector (Kafka Connect JDBC sink in upsert mode, Elasticsearch by document id).

**Consumer-side reality check.**
- At-most-once: commit before processing (or auto-commit with slow processing). Rarely what you want.
- At-least-once: process then commit; make processing idempotent. The default for business data.
- Exactly-once inside Kafka: transactions (Streams EOS). Effectively-once outside: idempotent sinks.

Summary rule: turn on the idempotent producer, commit after processing, and design every external side effect to survive replay.`,
      mentalModel:
        'The idempotent producer is a numbered ticket stub: if the clerk sees ticket 17 twice, the second is torn up. A transaction is a sealed envelope containing both the new records and the "I have read up to here" note; the envelope is opened all at once or not at all. Neither helps if the recipient also phones a friend before the envelope is sealed.',
      keyPoints: [
        'Idempotent producer: PID + sequence per partition; the broker drops retried duplicates. Always on.',
        'Transactions: atomic writes to many partitions plus offset commit; read_committed consumers; EOS for Kafka-to-Kafka pipelines.',
        'Transactions cannot cover external side effects; those need idempotent consumers or upsert sinks.',
        'Commit after processing for at-least-once; commit before for at-most-once.',
      ],
      checkpoint: {
        question:
          'A team enables enable.idempotence=true and declares their pipeline "exactly-once". The consumer reads events and inserts rows into Postgres, then commits offsets. Is the claim correct? Where can a duplicate row still appear?',
        answer:
          'No. Idempotence only removes duplicates from producer retries within a partition. If the consumer inserts into Postgres and crashes before committing the offset, it re-reads the same records after restart and inserts them again. Fix by making the insert idempotent (unique constraint on the event id with ON CONFLICT DO NOTHING) or by storing the consumed offset in Postgres in the same transaction as the rows.',
      },
    },
    {
      id: 'when-kafka-beats-a-queue',
      title: 'When Kafka beats a queue, when it does not, and the alternatives',
      body: `Kafka is the default answer in many architectures, which means it is often the wrong one. Decide on the properties.

**Kafka wins when:**
- **Multiple independent consumers** need the same events: billing, analytics, search, fraud, audit. One topic, N groups, no copies.
- **Replay and history** matter: rebuild a projection, backfill a new model, recover from a consumer bug by rewinding a day.
- **Throughput** is high: hundreds of thousands to millions of records per second, sustained, with batching and sequential disk I/O keeping cost low. LinkedIn runs trillions of messages per day.
- **Ordered event logs per entity** are a requirement: event sourcing, CDC pipelines (Debezium), changelog-backed caches.
- **Stream processing**: windowed aggregations, joins and stateful transforms with Kafka Streams or Flink reading partitions in parallel.

**A queue wins when:**
- You need **per-message acknowledgement, retry and dead-lettering** without building it: a failed record in Kafka blocks the partition offset or requires a retry-topic pattern; SQS/RabbitMQ handle it natively.
- You need **delayed delivery, priorities or TTL per message**; Kafka has none of these.
- **Work distribution beyond partition count**: a queue can have 500 competing consumers on a slow job with no partition planning.
- **Scale is small** and you do not want to run a cluster. A three-broker Kafka cluster with monitoring is real operational work; SQS is an API call. Managed Kafka (MSK, Confluent Cloud) narrows but does not close the gap.
- **Latency per message** matters more than throughput: Kafka batching adds milliseconds; RabbitMQ delivers in sub-millisecond.

**Amazon Kinesis Data Streams** is the managed, Kafka-like log on AWS. A stream is split into **shards**, each ingesting 1 MB/s or 1,000 records/s and serving 2 MB/s (5 reads/s shared, or 2 MB/s per consumer with enhanced fan-out). Retention is 24 hours by default, extendable to 365 days. Shards are the scaling and billing unit and you resplit them by hand or with on-demand mode. Simpler than Kafka, tighter limits, no compaction, AWS only.

**Apache Pulsar** separates **serving** (stateless brokers) from **storage** (Apache BookKeeper ledgers). Adding a broker does not move data; adding a bookie adds capacity. It has tiered storage to S3 built in, first-class **multi-tenancy** (tenants and namespaces with quotas), both queue semantics (shared subscriptions with per-message acks) and stream semantics (exclusive/failover subscriptions), and geo-replication. The cost is a more complex deployment (brokers, bookies, ZooKeeper or its replacement) and a smaller ecosystem.

**Redpanda** reimplements the Kafka protocol in C++ with no JVM or ZooKeeper and lower tail latency; **Redis Streams** gives a log with consumer groups inside Redis for small-scale use.

Decision shortcut: **facts that many may read, possibly later -> Kafka. Commands to be done once by someone, with retries -> queue.** Many mature systems use Kafka for the event backbone and a queue for job execution.`,
      mentalModel:
        'Kafka is a public record office: everything filed, anyone can read, forever (or a week). A queue is a dispatcher handing out job tickets. You would not run payroll off a dispatcher, and you would not send a plumber to fix a tap via the record office.',
      diagram: `                  many readers? replay? high throughput? ordered log?
                          yes ---------------> Kafka / Kinesis / Pulsar
                          |
per-message ack/retry/delay/priority? small scale? sub-ms latency?
                          yes ---------------> SQS / RabbitMQ
                          |
both --------------------------------> Kafka backbone + queue for jobs`,
      keyPoints: [
        'Kafka: many independent consumers, replay, millions/s, ordered per-entity logs, stream processing.',
        'Queue: per-message ack/retry/DLQ, delays, priorities, hundreds of workers, small scale, lowest per-message latency.',
        'Kinesis: managed shards (1 MB/s in, 2 MB/s out each), 24 h to 365 d retention, AWS only.',
        'Pulsar: compute/storage separation via BookKeeper, tiered storage, multi-tenancy, queue and stream semantics.',
        'Common pattern: Kafka as event backbone, a queue for retryable job execution.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'In Kafka, ordering of records is guaranteed:',
      options: [
        'Across the whole topic',
        'Within a single partition only',
        'Across all topics written by one producer',
        'Only when acks=all is used',
      ],
      answerIndex: 1,
      explanation:
        'A partition is an ordered log; there is no ordering across partitions. Records with the same key land in the same partition, which is how per-entity ordering is achieved. acks affects durability, not ordering.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'A topic has 8 partitions. A consumer group has 10 consumers. How many consumers are actively receiving records?',
      options: ['10', '8', '2', 'It depends on the replication factor'],
      answerIndex: 1,
      explanation:
        'Each partition is assigned to exactly one consumer in a group, so at most 8 consumers are active and 2 idle. Partition count is the parallelism ceiling; replication factor concerns copies for durability, not consumer assignment.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'With replication.factor=3 and acks=all, two of the three brokers hosting a partition go down. What happens to producer writes if min.insync.replicas is left at its default of 1?',
      options: [
        'Writes fail with NotEnoughReplicas',
        'Writes succeed and are acknowledged with only the leader\'s copy',
        'Writes are buffered until a follower returns',
        'The partition becomes read-only',
      ],
      answerIndex: 1,
      explanation:
        'acks=all means all replicas currently in the ISR, and the ISR has shrunk to the leader alone. With min.insync.replicas=1 that is enough, so writes are acknowledged with a single copy and would be lost if the leader also dies. Setting min.insync.replicas=2 is what makes writes fail (option A) rather than silently weaken.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 2,
      question: 'What does log compaction guarantee for a compacted topic?',
      options: [
        'All records older than retention.ms are deleted',
        'At least the most recent record for every key is retained',
        'Records are deduplicated by value',
        'The topic is sorted by key',
      ],
      answerIndex: 1,
      explanation:
        'Compaction keeps the latest value per key (plus tombstones for a grace period), turning the topic into a current-state snapshot. It is not time-based deletion, not value deduplication, and it does not sort; offset order is preserved.',
    },
    {
      type: 'mcq',
      id: 'q5',
      difficulty: 2,
      question: 'Which problem does the idempotent producer (enable.idempotence=true) solve?',
      options: [
        'A consumer processing the same record twice after a crash before offset commit',
        'Duplicate records caused by the producer retrying a batch whose acknowledgement was lost',
        'Two different producers sending the same business event',
        'Records arriving out of order across partitions',
      ],
      answerIndex: 1,
      explanation:
        'The broker tracks producer id and sequence numbers per partition and discards a retried batch it has already appended. It says nothing about consumer-side duplicates, application-level double sends from different producers, or cross-partition ordering, which does not exist anyway.',
    },
    {
      type: 'multi',
      id: 'q6',
      difficulty: 2,
      question: 'Which of the following would you expect from a stream (Kafka) but NOT from a classic queue (SQS standard, RabbitMQ)? Select all that apply.',
      options: [
        'Multiple independent consumer groups reading the same records without copying them',
        'Per-message acknowledgement with automatic redelivery of just the failed message',
        'Rewinding to reprocess yesterday\'s records',
        'Native delayed delivery of an individual message',
        'Retention of records for days regardless of whether they were consumed',
      ],
      answerIndices: [0, 2, 4],
      explanation:
        'Independent consumer groups, replay by offset, and consumption-independent retention all follow from the log model. Per-message ack with single-message redelivery and per-message delays are queue features that Kafka lacks; in Kafka progress is a single offset per partition.',
    },
    {
      type: 'truefalse',
      id: 'q7',
      difficulty: 2,
      statement: 'Increasing the number of partitions on an existing keyed topic can break per-key ordering for records produced after the change.',
      answer: true,
      explanation:
        'Partition = hash(key) mod N. Changing N sends most keys to different partitions, so new records for a key may be consumed before older records for the same key still in the original partition. This is why partition count should be over-provisioned initially.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: 'Kafka deletes a record from a partition once every consumer group has read it.',
      answer: false,
      explanation:
        'Kafka never deletes on read. Records are removed only by the cleanup policy: whole segments by age or size (delete), or superseded values per key (compact). Consumption is tracked purely by each group\'s offset.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'Consumer lag on partition 3 grows steadily while the other 11 partitions are near zero. Consumers are healthy. What is the most likely cause?',
      options: [
        'The replication factor is too low',
        'A skewed partition key concentrates a large share of traffic on partition 3 (hot partition)',
        'The consumer group has too many members',
        'Log compaction is disabled',
      ],
      answerIndex: 1,
      explanation:
        'Uniform consumers with one lagging partition points to that partition receiving disproportionate volume, typically because one key value (a big tenant, a bot user) dominates. Replication factor and compaction do not affect consumer throughput, and extra group members would idle, not cause skew.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 3,
      question: 'Which pipeline can Kafka transactions make truly exactly-once without any additional idempotency work?',
      options: [
        'Consume from topic A, call a payment API, commit offsets',
        'Consume from topic A, aggregate, produce to topic B, commit offsets (all in Kafka)',
        'Consume from topic A, insert rows into Postgres, commit offsets',
        'Produce to topic A from a web request handler that may retry the HTTP request',
      ],
      answerIndex: 1,
      explanation:
        'Transactions atomically cover produced records plus the offset commit, which is exactly the consume-transform-produce loop (Kafka Streams EOS). External side effects (payment API, Postgres) sit outside the transaction and need idempotent sinks. HTTP-level retries create new send() calls that idempotence does not deduplicate.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design the Kafka topic for order lifecycle events (created, paid, shipped, delivered) for a marketplace doing 5,000 orders/second at peak, with billing, analytics and a search indexer as consumers, and a requirement to lose no acknowledged event. State key, partitions, replication settings, retention and consumer-group layout with a one-line justification each.',
      modelAnswer: `**Key:** order id, so all lifecycle events of one order are in one partition and consumed in order; orders are numerous and evenly distributed so no hot partition.

**Partitions:** each order produces ~4 events, so ~20,000 events/s at peak. A consumer handling ~1,000-2,000 events/s suggests 12-20 partitions; choose **24** to leave room for growth without repartitioning.

**Durability:** \`replication.factor=3\`, \`min.insync.replicas=2\`, producers with \`acks=all\` and \`enable.idempotence=true\`, rack-aware placement across three availability zones. Losing one broker or one AZ loses nothing and stays writable; \`unclean.leader.election.enable=false\`.

**Retention:** \`cleanup.policy=delete\`, \`retention.ms=7 days\` (events are history, not state) so consumers can be down for days and the indexer can rebuild a week; enable tiered storage or a compacted "order-current-state" side topic if a longer rebuild is needed. Size: 20k events/s x ~1 KB x 7 days x RF3 is about 36 TB, fine for a modest cluster with tiered storage.

**Consumers:** three consumer groups (\`billing\`, \`analytics\`, \`search-indexer\`), each with up to 24 members, manual commit after processing, idempotent sinks (billing dedupes by event id in Postgres; indexer upserts by order id). Alert on lag per group. A retry topic and DLQ topic per group for poison records so one bad event does not block a partition.`,
      rubric: [
        'Keys by order id and explains the per-order ordering consequence.',
        'Derives partition count from throughput with headroom and notes repartitioning risk.',
        'Uses RF=3, min.insync.replicas=2, acks=all, idempotent producer for no-loss.',
        'Chooses delete retention with a justified window and gives a rough storage estimate.',
        'Uses independent consumer groups with idempotent sinks and mentions lag monitoring or DLQ handling.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain what the ISR is, how it interacts with acks=all and min.insync.replicas, and what trade-off you are making with the common RF=3 / min.insync=2 configuration.',
      modelAnswer: `The **ISR (in-sync replicas)** is the set of a partition\'s replicas, leader included, that are fully caught up with the leader within \`replica.lag.time.max.ms\`. Followers that fall behind or die are removed; they rejoin when caught up. The high watermark, and thus what consumers can read, is the highest offset present on every ISR member.

\`acks=all\` makes the producer wait until every current ISR member has the record. On its own that is weak, because the ISR can shrink to just the leader. \`min.insync.replicas=2\` sets a floor: if the ISR has fewer than two members the leader rejects the write with NotEnoughReplicas instead of acknowledging a single copy.

With RF=3 / min.insync=2 / acks=all you tolerate one broker failure with zero data loss and continued writes. On a second failure the partition becomes unwritable (but still readable) rather than accepting under-replicated writes. You are trading availability under double failure, plus a few milliseconds of replication latency and 3x storage, for the guarantee that no acknowledged record is ever lost.`,
      rubric: [
        'Defines ISR as replicas caught up with the leader and mentions the high watermark.',
        'Explains that acks=all waits for the current ISR and why that alone is insufficient.',
        'Explains min.insync.replicas as the floor that causes writes to fail.',
        'States the trade-off: durability under one failure vs unavailability under two, plus latency/storage cost.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 2,
      question: 'Give two concrete workloads where you would choose a queue (SQS/RabbitMQ) over Kafka, and one where you would choose Kafka over a queue. Justify each in one or two sentences.',
      modelAnswer: `**Queue 1: video transcoding jobs.** Each job is a command to be done once by any free worker, takes minutes, needs per-job retry with backoff and a DLQ for corrupt files, and benefits from 300 workers regardless of any partition count; SQS with a long visibility timeout fits perfectly and Kafka\'s single offset per partition makes per-job retry awkward.

**Queue 2: scheduled reminder emails.** They need per-message delayed delivery (send in 24 hours) and TTL, which SQS delay queues or RabbitMQ delayed-message plugin provide and Kafka has no concept of.

**Kafka: clickstream and order events feeding analytics, fraud, recommendations and a data lake.** Hundreds of thousands of events per second, four or more independent consumers that must not copy data, per-user ordering, and the need to replay 30 days when a model or schema changes are exactly the properties of a retained partitioned log.`,
      rubric: [
        'Queue examples involve per-message retry/DLQ, delays, or many workers on slow jobs.',
        'Kafka example involves multiple independent consumers, replay, or very high throughput.',
        'Each choice is justified by a property of the technology, not by popularity.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Kafka topic, partition, offset', back: 'Topic: named stream. Partition: ordered, immutable, append-only log within a topic. Offset: a record\'s position in its partition; consumers track it, brokers never delete on read.' },
    { id: 'f2', front: 'Why Kafka is fast', back: 'Append-only sequential disk I/O, OS page cache instead of heap, zero-copy sendfile to sockets, and batching at producer, broker and consumer.' },
    { id: 'f3', front: 'Scope of Kafka ordering guarantee', back: 'Within one partition only. Same key -> same partition (murmur2 hash mod N). No ordering across partitions or topics.' },
    { id: 'f4', front: 'How to choose the partition key', back: 'Key = the entity whose events must be ordered (order id, user id). No key if ordering is irrelevant (best balance). Avoid skewed keys that create hot partitions.' },
    { id: 'f5', front: 'Partition count consequences', back: 'Max consumers per group = partition count. Adding partitions later changes hash mod N and breaks per-key placement. Too many partitions cost memory, file handles, election time.' },
    { id: 'f6', front: 'Consumer group', back: 'Consumers sharing a group.id; each partition assigned to exactly one member. Groups are independent with their own committed offsets in __consumer_offsets.' },
    { id: 'f7', front: 'Consumer lag', back: 'Latest offset minus committed offset per partition. Rising lag = consumers falling behind. The key alerting metric for stream consumers.' },
    { id: 'f8', front: 'Rebalance and how to soften it', back: 'Partition reassignment when membership changes or a consumer misses max.poll.interval.ms. Use CooperativeStickyAssignor (incremental) and static membership (group.instance.id) to avoid stop-the-world pauses.' },
    { id: 'f9', front: 'ISR and high watermark', back: 'ISR: replicas caught up with the leader. High watermark: highest offset on all ISR members; consumers read only up to it.' },
    { id: 'f10', front: 'acks=0 / 1 / all', back: '0: no wait, lossy. 1: leader wrote it, lost if leader dies before replication. all: every ISR member wrote it; combine with min.insync.replicas.' },
    { id: 'f11', front: 'Standard no-loss configuration', back: 'replication.factor=3, min.insync.replicas=2, acks=all, enable.idempotence=true, unclean.leader.election.enable=false. Survives one broker loss; becomes read-only on two.' },
    { id: 'f12', front: 'Delete retention vs log compaction', back: 'Delete: drop whole segments older than retention.ms or beyond retention.bytes. Compact: keep latest record per key; null value = tombstone removed after delete.retention.ms.' },
    { id: 'f13', front: 'Uses of compacted topics', back: '__consumer_offsets, Kafka Streams state changelogs, CDC table snapshots (Debezium), current-state caches that new services bootstrap from offset 0.' },
    { id: 'f14', front: 'Idempotent producer mechanism', back: 'Producer id + per-partition sequence number on each batch; broker discards already-seen sequences. Removes duplicates from producer retries only. Default on since 3.0.' },
    { id: 'f15', front: 'Kafka transactions / EOS', back: 'transactional.id producer writes to many partitions and commits consumer offsets atomically; read_committed consumers. Exactly-once for consume-transform-produce within Kafka; external side effects still need idempotency.' },
    { id: 'f16', front: 'When a queue beats Kafka', back: 'Per-message ack/retry/DLQ, delayed delivery, priorities, hundreds of workers on slow jobs, small scale, sub-ms per-message latency, no cluster to run.' },
    { id: 'f17', front: 'Kinesis shard limits', back: '1 MB/s or 1,000 records/s in; 2 MB/s out per shard (per consumer with enhanced fan-out). Retention 24 h default, up to 365 days. Shard = scaling and billing unit.' },
    { id: 'f18', front: 'Pulsar\'s distinguishing design', back: 'Stateless brokers over Apache BookKeeper storage: scale compute and storage independently. Built-in tiered storage, multi-tenancy, both queue (shared) and stream (exclusive) subscriptions.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Kafka as a log',
      prompt: 'Explain to a developer who knows RabbitMQ what changes when the broker is an append-only log instead of a queue.',
      modelExplanation: `In RabbitMQ the broker hands each message to one consumer and deletes it once acknowledged. The broker is doing bookkeeping about every message. Kafka does almost none of that. It writes each record to the end of a file called a partition, gives it a number (the offset), and leaves it there for as long as the retention says, whether or not anyone read it.

Consumers keep their own bookmark: "I have read up to offset 4,213 in partition 2". Reading does not change the file. That one difference gives you three things RabbitMQ cannot: any number of independent readers on the same data with no copies, the ability to rewind a bookmark and reprocess yesterday, and very high throughput, because appending to and reading ranges of a file is what disks do fastest.

The thing you lose is per-message control. There is no "redeliver just message 4,210"; either your bookmark is past it or it is not. So retrying a single bad record, delaying a message or prioritising one over another is your code's job in Kafka and the broker's job in RabbitMQ.`,
      mustMention: [
        'Partition as an append-only file with offsets',
        'Broker does not delete on read; retention decides',
        'Consumers keep their own offsets, enabling many readers and replay',
        'Sequential I/O gives high throughput',
        'No per-message ack/redelivery; single offset per partition',
      ],
    },
    {
      id: 'fe2',
      concept: 'Partitions, keys and consumer groups',
      prompt: 'Explain how Kafka gives you both ordering and parallelism, and what decides how many consumers you can run.',
      modelExplanation: `A topic is split into partitions, and each partition is strictly ordered. When you send a record with a key, Kafka hashes the key to pick the partition, so every record with the same key, say the same order id, always lands in the same partition and is read in the order it was written. Records with different keys spread across partitions and are processed in parallel. You get ordering where it matters (per order) and parallelism across orders.

A consumer group is a team of consumers sharing the work. Kafka gives each partition to exactly one member of the team, so twelve partitions can feed at most twelve consumers; a thirteenth would sit idle. That is why the partition count is chosen up front with headroom. Adding partitions later is possible but changes the hash, so a key's new records land in a different partition from its old ones and ordering across that moment is lost.

Each group keeps its own committed offsets, so a second team can read the same partitions completely independently.`,
      mustMention: [
        'Key hashed to partition; same key -> same partition -> ordered',
        'Different partitions processed in parallel',
        'One partition to one consumer within a group; partition count caps parallelism',
        'Repartitioning breaks per-key placement',
        'Groups are independent with their own offsets',
      ],
    },
    {
      id: 'fe3',
      concept: 'Durability with acks and ISR',
      prompt: 'Explain how you make sure Kafka never loses an acknowledged record, and what that costs.',
      modelExplanation: `Each partition is copied to several brokers: one leader and some followers. The followers that are fully caught up form the in-sync replica set, the ISR. When a producer sends a record it can choose how long to wait. acks=0 does not wait at all; acks=1 waits until the leader has it; acks=all waits until every replica in the ISR has it.

acks=all sounds safe, but if followers have died the ISR might be just the leader, and "all" becomes one copy. So you add min.insync.replicas=2: if fewer than two replicas are in sync, the leader refuses the write instead of accepting it weakly. With three copies, that means one broker can die and you lose nothing and keep writing; if two die, you stop writing rather than risk data. When a leader dies, a new one is chosen from the ISR, which by definition has every acknowledged record.

The cost is waiting for the replication round trip on every write, three times the storage and network, and being unwritable during a double failure. For orders and payments that is the right trade; for click logs you might pick acks=1.`,
      mustMention: [
        'Leader and followers; ISR as caught-up replicas',
        'acks=0/1/all meaning',
        'min.insync.replicas prevents acks=all degrading to one copy',
        'RF=3 / min.insync=2 tolerates one failure, read-only on two',
        'Costs: latency, storage, availability under double failure',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a grand public records office: a long ledger hall with numbered books, checkout lanes at the entrance, a reading room full of bookmarked readers, a notary office, an archive with a shredder and an address book, and a dispatch window by the exit.',
    stops: [
      { locus: 'The ledger hall', concept: 'Topic as append-only partitioned log', image: 'Three enormous ledgers lie open side by side (partitions). A clerk writes only on the next blank line, numbering each entry (offset). Nothing is ever erased; the pages glow faintly from being kept in RAM by the building itself (page cache).' },
      { locus: 'The checkout lanes at the entrance', concept: 'Partitions and keys', image: 'Visitors are sent to a lane by hashing the name tag on their chest; the whole Order-42 family always ends up in lane 1, in arrival order. One lane is jammed by a single family with forty trolleys: a hot partition. A sign reads: DO NOT ADD LANES AFTER OPENING.' },
      { locus: 'The reading room', concept: 'Consumer groups, offsets, lag', image: 'Teams in matching jackets share the ledgers; each reader owns certain books and holds a bookmark. A wall meter labelled LAG shows how many pages behind each team is. When a reader leaves, a coordinator blows a whistle and everyone swaps books (rebalance).' },
      { locus: 'The notary office', concept: 'Replication, ISR, acks, min.insync.replicas', image: 'Every entry must be copied by notaries. A sign says MIN 2 SIGNATURES. One notary has dozed off and is pushed out of the in-sync circle. When only one notary is awake the office slams shut rather than stamp a weak copy.' },
      { locus: 'The archive with shredder and address book', concept: 'Retention vs compaction', image: 'On the left, a shredder eats whole ledger volumes older than seven days. On the right, an address book where old addresses are crossed out and only the latest remains; a name marked with a black tombstone is torn out a day later.' },
      { locus: 'The numbered-stub counter', concept: 'Idempotent producer and transactions', image: 'A messenger hands in ticket stub 17 twice; the clerk tears up the duplicate. Next to him, a sealed envelope contains both new entries and a note saying "read up to page 40": opened all at once or not at all. A telephone outside the envelope rings unheeded: external side effects are not covered.' },
      { locus: 'The dispatch window by the exit', concept: 'Kafka vs queue, Kinesis and Pulsar', image: 'A dispatcher hands out job tickets one per plumber with a stamp RETRY / DELAY / PRIORITY, things the records office cannot do. Behind, a river labelled KINESIS flows in 1 MB/s channels, and a PULSAR building keeps its librarians upstairs and its shelves in a separate warehouse.' },
    ],
  },
  interviewQuestions: [
    'Explain how Kafka differs from a traditional message queue and what the log abstraction makes possible.',
    'How do you choose a partition key and partition count for a new topic? What goes wrong if you get either wrong?',
    'What is a consumer group and what happens during a rebalance? How do you minimise its impact?',
    'Explain ISR, acks and min.insync.replicas. What configuration guarantees no data loss and what does it cost?',
    'What is log compaction and when would you use a compacted topic?',
    'Does enable.idempotence=true give exactly-once processing? What does it actually cover, and what covers the rest?',
    'When would you choose SQS or RabbitMQ over Kafka? When Kafka over them?',
    'Compare Kafka with Kinesis and Pulsar in terms of scaling model and operational trade-offs.',
  ],
}

export default chapter
