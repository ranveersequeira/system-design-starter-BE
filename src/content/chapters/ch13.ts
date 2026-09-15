import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 13,
  slug: 'message-brokers',
  title: 'Message Brokers',
  module: 'messaging',
  estimatedMinutes: 40,
  summary:
    'A message broker sits between producers and consumers so that the two never have to be up, fast, or scaled at the same time. This chapter explains what a broker really buys you, how queues distribute work, why "exactly once" is mostly a property of your consumer rather than the broker, and how acknowledgements, retries, dead-letter queues and ordering fit together. It closes with RabbitMQ versus SQS, the message-versus-stream distinction, and the cases where a broker is the wrong tool.',
  objectives: [
    'Explain the three things a broker provides (decoupling, buffering, asynchrony) and the price paid for each.',
    'Describe how competing consumers, acknowledgements, visibility timeouts and prefetch distribute work safely.',
    'Distinguish at-most-once, at-least-once and exactly-once delivery and state which one real systems actually implement and how.',
    'Design a retry and dead-letter strategy for a poison message and explain why ordering and parallelism conflict.',
    'Compare RabbitMQ and SQS, contrast a message queue with a stream, and recognise when a broker should not be used.',
  ],
  quickRevision: [
    'A broker decouples producers from consumers in time (consumer can be down), space (they need not know each other) and rate (bursts are buffered).',
    'A queue is point-to-point: each message is delivered to one of many competing consumers, then deleted after ack.',
    'Consumers pull (SQS) or the broker pushes (RabbitMQ); both need a per-consumer limit (prefetch / max in-flight) to avoid overloading one worker.',
    'At-most-once: ack before processing; may lose. At-least-once: ack after processing; may duplicate. Exactly-once: at-least-once + idempotent consumer.',
    'Brokers give you at-least-once; exactly-once is achieved by your consumer being idempotent (idempotency key, upsert, dedupe table).',
    'SQS visibility timeout hides a message while a consumer works on it; if no delete arrives in time, the message reappears for another consumer.',
    'A dead-letter queue (DLQ) receives messages that failed N times so one poison message cannot block the queue forever.',
    'Retry with exponential backoff and jitter; a retry storm against a struggling downstream is a self-inflicted outage.',
    'Ordering requires a single consumer per ordered stream; parallelism requires many consumers. You get ordering per key (SQS FIFO message group, one RabbitMQ queue per key), never globally with scale.',
    'RabbitMQ: AMQP, exchanges route by routing key to queues, push-based, flexible routing, you operate it. SQS: managed, pull-based, near-infinite scale, 256 KB messages, 14-day retention.',
    'Queue: message consumed once and deleted. Stream (Kafka): messages retained in a log; many consumer groups read independently and can replay.',
    'Do not use a broker when the caller needs the result now, when a database transaction already gives you what you need, or when the extra hop and eventual consistency outweigh the decoupling.',
  ],
  sections: [
    {
      id: 'what-a-broker-does',
      title: 'What a message broker actually buys you',
      body: `Service A needs Service B to do something: send a receipt email, resize an image, update a search index. The direct approach is an HTTP call. It works until the day B is slow, B is down, or A produces 50,000 requests in a burst that B cannot absorb. Every one of those failures is now A's failure too.

A **message broker** (RabbitMQ, Amazon SQS, ActiveMQ, Google Pub/Sub, Azure Service Bus) is a server that accepts messages from **producers**, stores them, and hands them to **consumers**. Inserting it between A and B buys three separable things:

**Decoupling in time.** B can be deployed, restarted or even down for an hour. Messages wait in the queue; when B returns it drains the backlog. A never noticed.

**Decoupling in space.** A publishes "OrderPlaced" without knowing who listens. Today it is the email service; next quarter the fraud service and the analytics pipeline subscribe too. A's code does not change.

**Rate decoupling (buffering).** A flash sale produces 10,000 orders in a minute; the invoicing service can only process 50 per second. The queue absorbs the spike and invoicing catches up over the next few minutes instead of dropping requests or falling over. This is **load levelling**, and it is often the single biggest reason to introduce a broker.

Together these give you **asynchrony**: A's request returns in 5 ms after enqueueing, rather than 800 ms after the email provider responds.

**What it costs.** You gave up the immediate answer. A no longer knows whether the email was sent, only that the request was accepted. Failures move from "the caller sees a 500" to "a message is stuck in a queue somewhere", which is harder to observe. You added a piece of stateful infrastructure that must be highly available, because if the broker is down, both A and B are effectively down. And you must now think about duplicates, ordering and retries, which is what the rest of this chapter is about.`,
      mentalModel:
        'A broker is a post office between two people. You can drop a letter even if the recipient is asleep, you do not need their address if you post to a mailbox they check, and a thousand letters posted at once are delivered as fast as the postman can walk. The price: you no longer get an answer while you stand at the counter.',
      diagram: `Synchronous:
  [Order Svc] --HTTP 800ms--> [Email Svc]     Order waits; fails if Email fails

With a broker:
  [Order Svc] --5ms--> [ Queue: orders ] --> [Email worker 1]
                        ||||||||||||||    --> [Email worker 2]
                        buffer absorbs    --> [Email worker 3]
                        the burst
  Order returns at once; Email may be down and catch up later`,
      keyPoints: [
        'A broker decouples producer and consumer in time, space and rate.',
        'Load levelling: bursts are buffered and drained at the consumer\'s pace.',
        'Asynchrony: the producer returns after the enqueue, not after the work.',
        'Cost: no immediate result, harder observability, a critical new component, and duplicates/ordering to reason about.',
      ],
      checkpoint: {
        question:
          'An e-commerce checkout calls the inventory service synchronously to reserve stock and the notification service synchronously to send a confirmation email. Which of the two calls is a good candidate for a broker, and why not the other?',
        answer:
          'The confirmation email is a perfect candidate: the user does not need to wait for it, the provider is slow and flaky, and a delay of seconds is harmless. Stock reservation is not: checkout needs the yes/no answer now to tell the user whether the purchase succeeded, so it must stay synchronous (or become a more elaborate saga).',
      },
    },
    {
      id: 'queues-and-competing-consumers',
      title: 'Queues, competing consumers and flow control',
      body: `The basic broker abstraction is a **queue**: an ordered buffer of messages where each message is delivered to **exactly one** consumer and removed once that consumer acknowledges it. Multiple consumers attached to one queue are called **competing consumers**; the broker distributes messages among them, which is how you scale processing horizontally by simply starting more workers.

**Push vs pull.** RabbitMQ *pushes* messages to connected consumers over a long-lived AMQP channel; latency is sub-millisecond. SQS is *pull*: the consumer calls ReceiveMessage, ideally with **long polling** (WaitTimeSeconds up to 20 s) so the call blocks until a message exists instead of hammering the API. Pull is simpler to reason about under back-pressure, because a consumer only asks for what it can handle.

**Flow control matters more than you think.** Without a limit, a push broker will drown a fast consumer with thousands of unacknowledged messages while others idle. RabbitMQ's **prefetch count** (\`basic.qos\`) caps how many unacked messages a consumer may hold; a prefetch of 1 gives perfect fairness at the cost of a round trip per message, while 10-100 is typical for short tasks. In SQS the equivalent is how many messages you receive per call (max 10) and how many you have in flight.

**Visibility timeout (SQS) and unacked state (RabbitMQ).** When a consumer receives a message, it is not deleted; it becomes invisible to other consumers for the **visibility timeout** (default 30 s). If the consumer deletes it in time, it is gone. If the consumer crashes or is too slow, the timeout expires and the message reappears for someone else. This single mechanism is what makes crash recovery automatic, and it is also the source of most duplicate deliveries: a slow consumer that finishes at 31 s has already lost the message to a second worker. Size the timeout to your p99 processing time, and extend it (ChangeMessageVisibility) for long jobs.

**Message size and payload design.** Brokers are for small messages: SQS caps at 256 KB, RabbitMQ works best under a few hundred KB. Put large payloads in S3 or a database and send a **claim check**, a reference the consumer uses to fetch the data. Sending the whole 20 MB document through the queue slows everyone.

**Durability.** A message the broker holds only in memory dies with the broker. RabbitMQ needs durable queues plus persistent messages (delivery_mode 2), ideally on quorum queues replicated across nodes. SQS stores redundantly across availability zones by default. Persistence costs throughput: a disk fsync per message versus a memory write.`,
      mentalModel:
        'A queue is a ticket dispenser at a deli counter. Each ticket goes to exactly one clerk. Prefetch is how many tickets a clerk may hold at once. Visibility timeout is the rule that if a clerk walks away with a ticket and does not come back in 30 seconds, the ticket goes back in the dispenser.',
      diagram: `Producer --> [ m7 m6 m5 m4 m3 ] queue
                          |
            +-------------+-------------+
            v             v             v
       [Consumer A]  [Consumer B]  [Consumer C]
        holds m1      holds m2       idle
        (invisible    (invisible
         30s)          30s)
A acks m1  -> deleted.   B crashes -> m2 reappears after 30s -> C gets it`,
      keyPoints: [
        'A queue delivers each message to one of many competing consumers; scale by adding workers.',
        'RabbitMQ pushes; SQS is pulled with long polling.',
        'Prefetch / in-flight limits stop one consumer hoarding messages.',
        'Visibility timeout gives automatic crash recovery and is the main source of duplicates.',
        'Keep messages small (claim-check pattern) and make them durable if losing them matters.',
      ],
      checkpoint: {
        question:
          'Your SQS consumers take 45 seconds at p99 to process a video-thumbnail job. The visibility timeout is the default 30 seconds. What symptom will you see?',
        answer:
          'Roughly every slow job is processed twice: at 30 s the message becomes visible again and a second worker picks it up while the first is still working. You will see duplicate thumbnails, doubled load, and possibly the same message bouncing until it hits the DLQ. Fix: set the visibility timeout above the p99 (say 120 s) or call ChangeMessageVisibility as a heartbeat during processing.',
      },
    },
    {
      id: 'delivery-guarantees',
      title: 'At-most-once, at-least-once and the myth of exactly-once',
      body: `Every message system must answer: if something crashes mid-way, is a message lost, duplicated, or neither? The answer is decided by **when the consumer acknowledges**.

**At-most-once.** The consumer acks (or the broker auto-acks) as soon as the message is delivered, then processes it. If the consumer crashes after the ack but before finishing, the message is gone. No duplicates, possible loss. Acceptable for metrics samples, presence pings, or anything where the next message supersedes this one. RabbitMQ \`autoAck=true\` gives you this.

**At-least-once.** The consumer processes first and acks last. If it crashes after processing but before the ack, the broker redelivers and the work happens twice. No loss, possible duplicates. This is the default posture of every serious queue, and it is the right one: losing an order is unrecoverable, while a duplicate can be detected.

**Exactly-once.** The message is processed once and only once. No broker can promise this end-to-end on its own, because the broker cannot see inside your consumer. Between "process" and "ack" there is always a window in which the machine can die. What you can do is make the duplicate **harmless**, so the observable outcome is as if it were processed once. This is called **effectively-once** or **idempotent consumption**:

- Include a unique **idempotency key** (order id, message id) in each message.
- Before processing, check a dedupe store (a unique index in the database, a Redis SET with TTL). If seen, ack and skip.
- Better, make the side effect itself idempotent: \`INSERT ... ON CONFLICT DO NOTHING\`, "set status = shipped" instead of "increment shipped count", or write the dedupe record and the business change in one database transaction.

Brokers help at the edges. SQS FIFO queues deduplicate messages with the same MessageDeduplicationId within a 5-minute window, and Kafka's idempotent producer removes duplicates caused by producer retries. Neither removes the duplicate caused by *your consumer* crashing after a side effect, so consumer idempotency is never optional.

**The producer side has the same problem.** Publish, then network timeout: did the broker get it? The safe move is to retry, which means the broker may now hold two copies. Producer retries are another reason consumers must tolerate duplicates.

Rule of thumb: design for at-least-once delivery and idempotent processing. Reach for at-most-once only when a lost message costs nothing.`,
      mentalModel:
        'At-most-once is signing for a parcel before opening it: if it is empty, too bad. At-least-once is opening it before signing: if you drop dead mid-unwrapping, the courier brings another tomorrow. Exactly-once is at-least-once plus a fridge that ignores a second identical delivery.',
      diagram: `At-most-once:   receive -> ACK -> process
                              ^ crash here = message lost

At-least-once:  receive -> process -> ACK
                                   ^ crash here = redelivered = duplicate

Effectively-once:
   receive -> seen(msg.id)? yes -> ACK, skip
                            no  -> process + record msg.id (same txn) -> ACK`,
      keyPoints: [
        'Ack timing decides the guarantee: ack-then-process = at-most-once; process-then-ack = at-least-once.',
        'Brokers deliver at-least-once; exactly-once end to end is achieved by idempotent consumers.',
        'Idempotency: unique key per message, dedupe store or natural idempotent write, ideally in one transaction with the side effect.',
        'Producer retries after timeouts also create duplicates.',
        'Default to at-least-once plus idempotency; use at-most-once only when loss is free.',
      ],
      checkpoint: {
        question:
          'A payment consumer reads "charge customer 42 for order 987", calls Stripe, then acks. It crashes right after Stripe returns success. What happens, and what change prevents the customer being charged twice?',
        answer:
          'The message is redelivered and a second worker charges Stripe again: a double charge. Prevent it by passing an idempotency key (order 987) to Stripe, which returns the original charge for a repeated key, and by recording "order 987 charged" in your database before acking so the second delivery is detected and skipped.',
      },
    },
    {
      id: 'retries-and-dead-letter-queues',
      title: 'Retries, backoff and dead-letter queues',
      body: `Consumers fail for two very different reasons, and a good retry policy treats them differently.

**Transient failures**: the database had a blip, the downstream API returned 503, a lock timed out. Retrying in a moment will succeed. **Permanent failures**: the message is malformed, refers to a deleted entity, or triggers a bug. Retrying will fail forever. A message of the second kind is a **poison message**, and without protection it is redelivered indefinitely, consuming a worker slot each time and, in a strictly ordered queue, blocking every message behind it.

**Retry policy.** Do not retry immediately in a tight loop; that turns a struggling downstream into a dead one, because every worker hammers it in lockstep. Use **exponential backoff with jitter**: wait 1 s, 2 s, 4 s, 8 s, each randomised by +/- 50%, and cap the total attempts, typically 3 to 5 for online work. Jitter is not optional: without it, a thousand messages that failed together will retry together forever.

How you implement delayed retry depends on the broker. SQS has no per-message delay on redelivery, but you can call ChangeMessageVisibility to push the message out by the backoff interval, or republish to a delay queue. RabbitMQ has no native delay either; the standard trick is a "retry" queue with a per-message TTL whose dead-letter target is the original queue, or the delayed-message plugin.

**Dead-letter queue (DLQ).** After N failed attempts, the broker (SQS via a redrive policy with maxReceiveCount; RabbitMQ via x-dead-letter-exchange on reject/expiry) moves the message to a separate queue that no worker consumes automatically. This does three things: it unblocks the main queue, it preserves the message for investigation instead of dropping it, and it gives you a metric. **DLQ depth greater than zero should page someone**; it means real work is not being done.

**Operating the DLQ.** Every DLQ needs an owner and a runbook. Typical actions: inspect the payload, fix the bug or the data, then **redrive** (SQS has a one-click "start DLQ redrive" back to the source queue). Keep the retention long (SQS allows 14 days) so a bug discovered on Monday does not mean Friday's messages are gone.

**Retries and idempotency are inseparable.** Every retry is a potential duplicate execution of the parts of the handler that succeeded before the failure. A handler that sends an email, then fails updating the database, will send a second email on retry unless the email step is idempotent or ordered last. Structure handlers so that the non-idempotent side effect happens once, as late as possible, guarded by a dedupe check.`,
      mentalModel:
        'A DLQ is the "damaged mail" shelf at the post office. A letter that keeps getting bounced is taken off the route so the postman can deliver everyone else\'s mail, and a supervisor looks at it later.',
      keyPoints: [
        'Distinguish transient failures (retry) from poison messages (do not retry forever).',
        'Exponential backoff with jitter caps attempts and avoids synchronised retry storms.',
        'After N attempts the broker moves the message to a DLQ; DLQ depth > 0 is an alert.',
        'DLQs need an owner, long retention and a redrive path.',
        'Each retry is a potential duplicate; order and guard non-idempotent side effects.',
      ],
    },
    {
      id: 'ordering',
      title: 'Ordering: why it fights parallelism',
      body: `Suppose a user updates their address twice in one second. If the two "AddressChanged" messages are processed out of order, the database ends up with the old address. Ordering matters whenever messages are **state transitions on the same entity** rather than independent tasks.

Here is the uncomfortable truth: **a single queue with N competing consumers cannot preserve order.** The broker hands message 1 to consumer A and message 2 to consumer B; B is a little faster and commits first. Adding retries makes it worse: message 1 fails and is redelivered after message 2 has already been processed. Ordering and parallelism are fundamentally in tension, because ordering means "wait for the previous one" and parallelism means "do not wait".

The practical resolution is **ordering per key**, not global ordering:

- **SQS FIFO queues** take a **MessageGroupId**. Messages within one group are delivered strictly in order and only one batch of a group is in flight at a time; different groups are processed in parallel. Use the entity id (user id, order id) as the group id. FIFO queues also deduplicate within 5 minutes. Their limit is 300 messages per second per queue without batching (3,000 with), versus effectively unlimited for standard queues, which is the price of ordering.
- **RabbitMQ** preserves order within a single queue for a single consumer. To get per-key ordering with parallelism you route by key to one of several queues (a consistent-hash exchange plugin does this) and attach exactly one consumer to each queue.
- **Kafka** does the same with partitions and keys, which is the subject of the next chapter.

Even with per-key ordering, **your consumer must still handle disorder**, because redelivery and retries can reorder within a key in edge cases. Robust consumers make handlers order-tolerant: carry a version number or timestamp in the message and ignore updates older than what is already stored (last-writer-wins by version), or design messages as idempotent absolute states ("address is now X") instead of relative deltas ("increment by 5").

When you truly need total global order across all entities, you have a single-consumer system and it will not scale; question the requirement.`,
      mentalModel:
        'Ordering is a single-file queue at passport control: everyone waits behind the slowest person. Parallelism is opening ten booths, which destroys the single file. Per-key ordering is putting families in the same booth so a child is never processed before their parent, while unrelated families use other booths.',
      diagram: `Standard queue, 2 consumers:
  m1(addr=A) -> Consumer X (slow)   ---- commits 2nd  DB = A  (wrong)
  m2(addr=B) -> Consumer Y (fast)   -- commits 1st

FIFO / per-key:
  group user42:  m1 -> m2      one at a time, in order  -> DB = B
  group user77:  n1 -> n2      processed in parallel with user42`,
      keyPoints: [
        'Competing consumers on one queue cannot preserve order; retries make it worse.',
        'Order per key (entity id), never globally: SQS FIFO message groups, one RabbitMQ queue per key hash, Kafka partitions.',
        'Ordering costs throughput: SQS FIFO is 300 msg/s per queue unbatched.',
        'Consumers should still tolerate disorder: version checks, absolute-state messages, last-writer-wins.',
      ],
      checkpoint: {
        question:
          'A wallet service processes "credit 100" and "debit 100" messages for the same user with 20 competing consumers on a standard SQS queue. What can go wrong and how would you redesign it?',
        answer:
          'The debit can be processed before the credit, briefly showing a negative balance or being rejected for insufficient funds. Move to an SQS FIFO queue with MessageGroupId = user id, so one user\'s operations are serialised while other users proceed in parallel, and carry a sequence number so a consumer can detect and defer an out-of-order message.',
      },
    },
    {
      id: 'rabbitmq-vs-sqs',
      title: 'RabbitMQ and SQS: two ways to build a broker',
      body: `**RabbitMQ** is the archetypal self-hosted broker, speaking **AMQP**. Its distinctive feature is the **exchange**: producers never publish to a queue directly. They publish to an exchange with a **routing key**, and **bindings** decide which queues receive a copy.

- A **direct** exchange routes on exact key match: routing key \`order.created\` goes to the queues bound with that key.
- A **fanout** exchange copies every message to every bound queue: pub/sub in one line of config.
- A **topic** exchange matches patterns: a queue bound to \`order.*\` receives \`order.created\` and \`order.cancelled\`; \`#\` matches everything.
- A **headers** exchange routes on message attributes.

This lets you add a new consumer (say, a fraud service that wants \`order.*\`) by binding a new queue, with no producer change. RabbitMQ pushes to consumers, supports acks, nacks, prefetch, per-message TTL, priority queues, and dead-lettering. For high availability you run a cluster with **quorum queues** (Raft-replicated), and you own the operations: disk, memory alarms, network partitions, upgrades. Throughput is tens of thousands of messages per second per node, latency sub-millisecond.

**Amazon SQS** takes the opposite stance: a fully managed HTTP API with almost no knobs. There are two queue types: **standard** (unlimited throughput, at-least-once, best-effort ordering) and **FIFO** (ordered per message group, exactly-once within a 5-minute dedupe window, 300 or 3,000 msg/s). Consumers pull with long polling. Messages are up to 256 KB and retained up to 14 days. Delivery delay, visibility timeout, DLQ redrive and CloudWatch metrics are built in. There is no routing: to fan out you put **SNS** (a topic) in front and subscribe multiple SQS queues to it. Latency is tens of milliseconds and you pay per request, which at very high volume can exceed the cost of a RabbitMQ cluster.

**How to choose.**
- Rich routing, sub-millisecond latency, on-prem or multi-cloud, protocol features like priorities -> RabbitMQ (or its managed offerings).
- Zero operations, elastic scale, AWS-native, simple work queues -> SQS, with SNS for fan-out.
- Long retention and replay by many independent readers -> neither; that is a stream (Kafka, Kinesis).

Google Pub/Sub and Azure Service Bus sit in the SQS/SNS space; ActiveMQ and NATS JetStream in the RabbitMQ space.`,
      mentalModel:
        'RabbitMQ is a mailroom you run yourself with a clever sorting clerk (the exchange) who reads the label and drops copies into the right pigeonholes. SQS is a rented mailbox the postal service maintains: no sorting clerk, no maintenance, and you walk over to check it.',
      diagram: `RabbitMQ:
  producer --"order.created"--> [topic exchange]
                                 |  binding order.*     -> [q: fraud]
                                 |  binding order.created -> [q: email]
                                 |  binding #            -> [q: audit]

SQS + SNS:
  producer --> [SNS topic] --> [SQS q: fraud]  <-- pull (long poll)
                           --> [SQS q: email]  <-- pull
                           --> [SQS q: audit]  <-- pull`,
      keyPoints: [
        'RabbitMQ: AMQP, exchanges + bindings for direct/fanout/topic routing, push delivery, sub-ms latency, self-operated with quorum queues for HA.',
        'SQS: managed, pull with long polling, standard (unlimited, unordered) or FIFO (grouped order, dedupe, 300/3,000 msg/s), 256 KB, 14-day retention.',
        'Fan-out in AWS is SNS -> multiple SQS queues.',
        'Choose RabbitMQ for routing richness and latency; SQS for zero ops and elasticity; a stream for replay.',
      ],
    },
    {
      id: 'message-vs-stream',
      title: 'Message queues versus streams',
      body: `Queues and streams both move events between services asynchronously, and people use the words interchangeably, but they are different data structures with different consequences.

**A queue is a task list.** A message exists until a consumer acknowledges it; then it is deleted. Competing consumers split the work. The queue's job is done when it is empty. Mental model: **a to-do list shared by a team**. If two teams want the same events, you create two queues and copy every message into both (fanout exchange, SNS).

**A stream is a log.** Messages are appended to an ordered, durable log and **retained** for a configured period (hours to forever) regardless of whether anyone read them. Consumers do not delete anything; each **consumer group** keeps its own **offset**, a bookmark of how far it has read. Mental model: **a newspaper archive**. Ten teams can read the same log independently at their own pace; a new team can start from the beginning; a buggy consumer can rewind a day and reprocess.

This changes what each is good for:

| Concern | Queue (RabbitMQ, SQS) | Stream (Kafka, Kinesis, Pulsar) |
|---|---|---|
| After consumption | deleted | retained until retention expires |
| Multiple readers | copy to N queues | N consumer groups on one topic |
| Replay | impossible | rewind offset |
| Per-message ack/retry | native | per-partition offset; retry is your problem |
| Ordering | per group / single consumer | per partition (by key) |
| Throughput | 10k-100k msg/s per node | millions msg/s per cluster |
| Best for | work distribution, commands | event history, fan-out, analytics, CDC |

Choose a **queue** when a message is a **command** ("resize this image") that should be done once by whichever worker is free, when you need per-message acknowledgement, delays, priorities and dead-lettering, and when history has no value. Choose a **stream** when a message is a **fact** ("order 987 was placed") that many independent systems may care about now or later, when replay matters (rebuilding a search index, backfilling a new analytics model), or when throughput is in the hundreds of thousands per second.

Many systems use both: Kafka carries the durable event log, and a service consuming from Kafka pushes per-item jobs onto SQS for retry-friendly processing. Redis Streams and RabbitMQ Streams are attempts to give a queue product stream semantics; the next chapter goes deep on Kafka, the canonical stream.`,
      mentalModel:
        'A queue is a shared to-do list: tick it off and it is gone. A stream is a newspaper archive: every reader keeps their own bookmark, and the papers stay on the shelf whether or not anyone reads them.',
      keyPoints: [
        'Queue: delivered once, deleted on ack, competing consumers split work.',
        'Stream: append-only retained log, consumer groups track offsets, replay possible, many independent readers.',
        'Queues suit commands and per-message ack/retry; streams suit facts, fan-out, history and high throughput.',
        'Both are often combined: a stream for the durable log, a queue for retryable jobs.',
      ],
      checkpoint: {
        question:
          'You need to rebuild a product search index from scratch after a mapping change. Your product-update events flow through SQS today. Why is that a problem, and what would a stream give you?',
        answer:
          'SQS messages were deleted after the indexer acked them, so there is no history to replay; you must write a one-off script that scans the product database. With Kafka and a retention of, say, 30 days (or a compacted topic keeping the latest state per product), you would start a new consumer group at the earliest offset and let the normal indexer code rebuild the index from the log.',
      },
    },
    {
      id: 'when-not-to-use-a-broker',
      title: 'When NOT to use a broker',
      body: `Brokers are so useful that teams reach for them reflexively, and the result is often a slower, harder-to-debug system. Recognise the anti-patterns.

**The caller needs the answer now.** "Is this username available?" "Did the payment succeed?" "What is the price?" Routing a request/response through a queue and waiting for a reply on another queue adds two hops, two serialisations and a correlation-id dance to get what an HTTP call gives you in one round trip. If the user is waiting for the result, keep it synchronous. Brokers are for work whose result the caller does not need immediately.

**The scale does not justify it.** A background job table in Postgres (\`SELECT ... FOR UPDATE SKIP LOCKED\`) handles hundreds of jobs per second with transactional guarantees, no new infrastructure, and trivially observable state. Until you exceed that, a queue is complexity without benefit.

**You need a transaction across the boundary.** "Debit account A and credit account B" cannot be made atomic by putting the credit on a queue; you have converted a transaction into a saga with compensations and a window of inconsistency. Sometimes that is the right call at scale; often the two rows belong in one database transaction.

**The dual-write problem.** Writing to the database and then publishing to the broker is two operations that can fail independently: the row commits and the publish times out, or vice versa. If you do introduce a broker for events, you need the **transactional outbox** pattern (write the event into an outbox table in the same transaction, a relay publishes it) or change data capture, not a naive publish-after-commit.

**Latency budgets.** Every broker hop adds milliseconds (RabbitMQ) to tens of milliseconds (SQS) and, more importantly, adds *variability*: a backlog turns a 50 ms task into a 5-minute wait with no signal to the user. If a step has a tight latency SLO, a queue in the middle removes your control over it.

**Observability and debugging.** A synchronous call fails with a stack trace pointing at the caller. An async flow fails with a message sitting in a DLQ three services away, an hour later. If your team does not yet have tracing (correlation ids propagated in message headers), queue depth alerts and DLQ ownership, the broker will hide failures rather than handle them.

**The distributed monolith.** If every service must consume every other service's events to do anything, and a change to one message schema breaks five consumers, you have coupling with extra latency. Brokers decouple availability, not semantics.

Use a broker when: work is deferrable, bursts need levelling, several independent consumers want the same events, or a slow or unreliable dependency must be isolated from the user path.`,
      mentalModel:
        'Posting a letter is wonderful for a birthday card and absurd for asking someone to pass the salt. If you are standing at the table waiting, talk.',
      keyPoints: [
        'Keep request/response synchronous when the caller needs the result immediately.',
        'At low volume a job table in the existing database beats new infrastructure.',
        'A queue does not make a cross-service transaction atomic; it creates a saga.',
        'DB write + publish is a dual write; use the transactional outbox or CDC.',
        'Async hides failures unless you have tracing, queue-depth alerts and DLQ ownership.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Which of the following is NOT one of the core benefits of putting a message broker between two services?',
      options: [
        'The consumer can be down while the producer keeps working',
        'Traffic bursts are buffered and drained at the consumer\'s pace',
        'The producer receives the result of the consumer\'s work immediately',
        'New consumers can be added without changing the producer',
      ],
      answerIndex: 2,
      explanation:
        'A broker gives decoupling in time, rate and space. It removes the immediate result: the producer only learns the message was accepted. Needing the result right away is exactly the case where a broker is the wrong tool.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'In SQS, what happens when a consumer receives a message but neither deletes it nor extends its visibility before the visibility timeout expires?',
      options: [
        'The message is deleted automatically',
        'The message is moved to the dead-letter queue immediately',
        'The message becomes visible again and another consumer may receive it',
        'SQS returns an error to the original consumer',
      ],
      answerIndex: 2,
      explanation:
        'Visibility timeout hides an in-flight message; on expiry it simply reappears, which is how crashed consumers are recovered and also why duplicates occur. It only goes to the DLQ after the receive count exceeds maxReceiveCount in the redrive policy.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'A consumer acknowledges each message as soon as it is received, then processes it. Which delivery guarantee does this produce?',
      options: ['At-least-once', 'At-most-once', 'Exactly-once', 'Ordered delivery'],
      answerIndex: 1,
      explanation:
        'Acking before processing means a crash after the ack loses the message: at-most-once. Acking after processing gives at-least-once (with possible duplicates). Exactly-once requires at-least-once plus consumer idempotency; ack timing has nothing to do with ordering.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 2,
      question: 'What is the primary purpose of a dead-letter queue?',
      options: [
        'To store messages for long-term analytics',
        'To hold messages that failed processing repeatedly so they stop blocking the main queue and can be inspected',
        'To deliver messages with lower priority',
        'To replicate messages to another region',
      ],
      answerIndex: 1,
      explanation:
        'A DLQ isolates poison messages after N attempts, preserving them for debugging and redrive while unblocking healthy traffic. It is not an analytics store, a priority mechanism or a replication tool.',
    },
    {
      type: 'multi',
      id: 'q5',
      difficulty: 2,
      question: 'Which of these are effective ways to make a consumer safe against duplicate deliveries? Select all that apply.',
      options: [
        'Record the message id in a dedupe table inside the same transaction as the business write',
        'Use INSERT ... ON CONFLICT DO NOTHING keyed on the natural entity id',
        'Increase the visibility timeout to infinity so a message is never redelivered',
        'Send absolute state ("balance is 500") instead of deltas ("add 100") where possible',
        'Pass an idempotency key to downstream APIs such as payment providers',
      ],
      answerIndices: [0, 1, 3, 4],
      explanation:
        'Dedupe tables in the same transaction, idempotent upserts, absolute-state messages and idempotency keys all make repeated processing harmless. An infinite visibility timeout does not prevent duplicates from producer retries and turns every consumer crash into a permanently stuck message.',
    },
    {
      type: 'truefalse',
      id: 'q6',
      difficulty: 2,
      statement: 'A standard queue with ten competing consumers preserves the order in which messages were published, as long as each consumer processes messages one at a time.',
      answer: false,
      explanation:
        'Even with one message per consumer, ten consumers finish at different speeds, so message 2 can commit before message 1, and a retry of message 1 lands even later. Ordering with parallelism is only possible per key (FIFO message groups, partitions), never across a shared standard queue.',
    },
    {
      type: 'truefalse',
      id: 'q7',
      difficulty: 1,
      statement: 'In RabbitMQ, producers publish directly to a named queue.',
      answer: false,
      explanation:
        'Producers publish to an exchange with a routing key; bindings decide which queues receive the message. The default exchange makes it look like direct-to-queue publishing, but the exchange model is what enables fanout and topic routing without producer changes.',
    },
    {
      type: 'mcq',
      id: 'q8',
      difficulty: 3,
      question: 'A downstream API starts returning 503s. 5,000 queued messages fail and your consumers retry each one immediately, then again one second later. What is the most likely outcome and the fix?',
      options: [
        'The API recovers quickly because retries are spread out; no change needed',
        'The synchronized retries keep the API overloaded; use exponential backoff with jitter and cap attempts before dead-lettering',
        'Messages are lost; increase prefetch',
        'The queue deletes the messages; enable durability',
      ],
      answerIndex: 1,
      explanation:
        'Immediate, lock-step retries from thousands of messages are a retry storm that prevents the downstream from recovering. Backoff spreads load over time, jitter de-synchronises the retries, and a max attempt count with a DLQ stops infinite pressure. Prefetch and durability address different problems.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'Which requirement most strongly indicates a stream (Kafka) rather than a queue (SQS/RabbitMQ)?',
      options: [
        'Each job must be done by exactly one free worker with per-message retry and delay',
        'Five independent teams need the same events, and a new team must be able to process the last 30 days of history',
        'Messages are up to 200 KB and volume is 50 per second',
        'The producer needs a response within 10 ms',
      ],
      answerIndex: 1,
      explanation:
        'Multiple independent readers plus replay of history is exactly what a retained log with consumer-group offsets provides and a delete-on-ack queue cannot. Per-message retry and delay favour a queue; low volume needs neither; a 10 ms synchronous response needs no broker at all.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'A service writes an order row to Postgres and then publishes an OrderPlaced message to RabbitMQ. The publish call times out after the commit. What pattern fixes this class of problem?',
      options: [
        'Publish first, then write to the database',
        'Wrap both in a try/catch and log the error',
        'Transactional outbox: write the event to an outbox table in the same DB transaction and let a relay publish it',
        'Use a FIFO queue',
      ],
      answerIndex: 2,
      explanation:
        'This is the dual-write problem; either order can leave the two stores inconsistent. The outbox pattern makes the event part of the same transaction as the business row, and a relay (or CDC) publishes it at-least-once. Logging does not repair state and FIFO is about ordering, not atomicity.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design the consumer for an "order placed -> send confirmation email" flow on SQS so that a crash at any point cannot lose an order or send two emails. Cover ack timing, idempotency, retries, and the DLQ.',
      modelAnswer: `**Ack timing.** Receive with long polling, process, and only then DeleteMessage (at-least-once). Set the visibility timeout above the p99 handler time (e.g. 60 s for an email call) and extend it if a batch runs long.

**Idempotency.** Use the order id as the idempotency key. Before sending, do \`INSERT INTO email_sent(order_id) ... ON CONFLICT DO NOTHING\`; if zero rows were inserted, the email was already sent, so delete the message and return. Send the email with the provider's idempotency key header too, so a crash between provider success and our insert is also covered. Order the steps: reserve the dedupe row, call the provider, delete the message.

**Retries.** On provider 5xx or timeout, do not delete; let visibility expire or set it to a backoff (e.g. 30 s, 2 min, 10 min via ChangeMessageVisibility using the ApproximateReceiveCount). Cap at 5 attempts.

**DLQ.** Redrive policy with maxReceiveCount = 5 to an \`order-email-dlq\` with 14-day retention. Alarm on ApproximateNumberOfMessagesVisible > 0. Runbook: inspect payload, fix, redrive.

**Loss.** The order itself is committed by the order service before publishing (via transactional outbox), so a lost email message can be replayed from the outbox; SQS itself is redundant across AZs.`,
      rubric: [
        'Deletes the message only after processing (at-least-once) and sizes the visibility timeout to p99.',
        'Uses an idempotency key (order id) with a dedupe write and/or provider idempotency key.',
        'Describes backoff between attempts and a capped attempt count.',
        'Configures a DLQ with alerting and a redrive runbook.',
        'Mentions the outbox pattern or equivalent to avoid losing the event at the producer.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain the difference between a message queue and a message stream, and give one workload that fits each.',
      modelAnswer: `A **queue** holds each message until one consumer acknowledges it and then deletes it. Competing consumers split the work; the queue is a shared to-do list. It offers per-message acks, retries, delays, priorities and dead-lettering. Fit: "generate invoice for order 987", done once by any free worker.

A **stream** is an append-only, ordered log where messages are retained for a configured time regardless of reads. Consumers do not delete; each consumer group keeps an offset, so many groups read the same data independently, at their own pace, and can rewind to replay. Ordering is per partition by key and throughput reaches millions of events per second. Fit: "OrderPlaced" facts consumed by billing, analytics, fraud and a search indexer, with the ability to rebuild the index from 30 days of history.`,
      rubric: [
        'Queue: delivered to one consumer, deleted on ack, competing consumers.',
        'Stream: retained log, consumer groups with offsets, replay, many independent readers.',
        'Mentions a capability difference such as per-message retry/DLQ vs replay/throughput.',
        'Gives a sensible example for each.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question: 'A colleague proposes routing the "check username availability" call during signup through RabbitMQ "for scalability". Argue for or against in four sentences.',
      modelAnswer: `Against. The user is waiting for the answer on screen, so the request is inherently request/response; a queue plus a reply queue adds two hops, correlation ids and a variable wait with no way to bound latency when a backlog forms. Availability checks are a cheap indexed read that a synchronous HTTP call to the user service (backed by a Postgres unique index or a Redis set) serves in a few milliseconds and scales by adding read replicas or instances behind a load balancer. A broker would help if the work were deferrable or bursty and the caller did not need the result, which is the opposite of this case. Keep it synchronous, and reserve RabbitMQ for the welcome email and analytics events that signup emits afterwards.`,
      rubric: [
        'Identifies that the caller needs the result immediately.',
        'Notes the added latency, variability and complexity (reply queues, correlation ids).',
        'Proposes the synchronous alternative and how it scales.',
        'Identifies what in the flow would legitimately go through a broker.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Three kinds of decoupling a broker provides', back: 'Time (consumer can be down), space (producer need not know consumers), rate (bursts buffered and drained at consumer pace = load levelling).' },
    { id: 'f2', front: 'Competing consumers', back: 'Several consumers attached to one queue; the broker gives each message to exactly one of them. Horizontal scaling of processing by adding workers.' },
    { id: 'f3', front: 'Prefetch count (RabbitMQ basic.qos)', back: 'Max unacknowledged messages a consumer may hold. Prevents one fast consumer hoarding messages; 1 = perfect fairness, 10-100 typical for short tasks.' },
    { id: 'f4', front: 'SQS visibility timeout', back: 'Period during which a received message is hidden from other consumers. If not deleted in time it reappears: automatic crash recovery, main source of duplicates. Size above p99 processing time.' },
    { id: 'f5', front: 'At-most-once vs at-least-once (ack timing)', back: 'Ack before processing: at-most-once, may lose. Ack after processing: at-least-once, may duplicate.' },
    { id: 'f6', front: 'How exactly-once is really achieved', back: 'At-least-once delivery plus an idempotent consumer: idempotency key per message, dedupe record written in the same transaction as the side effect, or naturally idempotent writes.' },
    { id: 'f7', front: 'Poison message', back: 'A message whose processing fails permanently (bad payload, bug). Without a max-attempt limit and DLQ it is redelivered forever, wasting workers and blocking ordered queues.' },
    { id: 'f8', front: 'Dead-letter queue', back: 'Queue receiving messages that failed maxReceiveCount times. Unblocks the main queue, preserves messages for inspection, provides an alertable metric. Needs an owner and a redrive path.' },
    { id: 'f9', front: 'Why jitter in retry backoff', back: 'Without jitter, messages that failed together retry together in lock-step, keeping the downstream overloaded. Randomising the delay spreads the retries.' },
    { id: 'f10', front: 'Ordering vs parallelism', back: 'Competing consumers on one queue cannot preserve order. Get ordering per key: SQS FIFO MessageGroupId, one RabbitMQ queue per key hash, Kafka partition. Global order = single consumer = no scale.' },
    { id: 'f11', front: 'SQS FIFO queue facts', back: 'Ordered within a MessageGroupId, deduplicates by MessageDeduplicationId for 5 minutes, 300 msg/s per queue (3,000 with batching).' },
    { id: 'f12', front: 'RabbitMQ exchange types', back: 'Direct (exact routing key), fanout (copy to all bound queues), topic (wildcard patterns like order.*), headers (match on attributes).' },
    { id: 'f13', front: 'SQS key limits', back: '256 KB max message, up to 14 days retention, long polling up to 20 s, max 10 messages per receive, standard = unlimited throughput at-least-once, no routing (use SNS for fan-out).' },
    { id: 'f14', front: 'Claim-check pattern', back: 'Store the large payload in S3/DB and send only a reference in the message; the consumer fetches the data. Keeps brokers fast and under size limits.' },
    { id: 'f15', front: 'Queue vs stream in one line each', back: 'Queue: deliver to one consumer, delete on ack, shared to-do list. Stream: retained ordered log, consumer groups keep offsets, replayable newspaper archive.' },
    { id: 'f16', front: 'Transactional outbox', back: 'Write the event into an outbox table in the same DB transaction as the business change; a relay/CDC publishes it to the broker. Solves the dual-write problem.' },
    { id: 'f17', front: 'When NOT to use a broker', back: 'Caller needs the result now; low volume a DB job table handles; you need a real transaction across the boundary; tight latency SLO; no tracing/DLQ ownership yet.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'What a message broker does',
      prompt: 'Explain to a junior developer what a message broker is and why you would put one between two services instead of having one call the other directly.',
      modelExplanation: `When service A calls service B directly, A depends on B being up, fast and able to handle whatever A throws at it. If B goes down, A starts failing too, and a spike in A's traffic becomes a spike in B's traffic instantly.

A message broker is a server in between that holds messages. A drops a message in a queue and moves on in a few milliseconds. B takes messages out whenever it can. If B is down for an hour, the messages wait. If A produces 10,000 messages in a minute, B still processes them at its own speed and catches up. And if tomorrow a third service also wants those messages, it just subscribes; A does not change.

The price is that A no longer gets an answer: it knows the message was accepted, not that the work was done. So brokers are for work the caller does not need to wait for, like sending emails, resizing images or updating analytics, and not for questions like "is this username taken?" where the user is staring at the screen.`,
      mustMention: [
        'Producer is decoupled from consumer availability and speed',
        'Bursts are buffered (load levelling)',
        'New consumers can be added without changing the producer',
        'The producer does not get the result of the work',
        'Suits deferrable work, not request/response',
      ],
    },
    {
      id: 'fe2',
      concept: 'Delivery guarantees and idempotency',
      prompt: 'Explain why "exactly-once delivery" is mostly a property of the consumer, not the broker, and how you achieve it in practice.',
      modelExplanation: `A broker hands you a message and waits for you to say "done". If you say done before you do the work and then crash, the work never happens: that is at-most-once. If you do the work first and crash before saying done, the broker assumes you failed and gives the message to someone else, who does the work again: that is at-least-once, and it is what every sensible system chooses, because losing an order is worse than seeing it twice.

The broker cannot fix that duplicate. It has no idea whether your database write happened before the crash. So "exactly-once" has to come from your side: make doing the work twice look the same as doing it once. Give every message a unique id, and record that id in your database in the same transaction as the real change. When the duplicate arrives, you see the id, skip the work, and acknowledge. Or write the change in an idempotent way, such as "set status to shipped" instead of "add one to shipped count". Pass the same id to external APIs as an idempotency key so they deduplicate too.`,
      mustMention: [
        'Ack timing produces at-most-once or at-least-once',
        'Default to at-least-once because loss is worse than duplication',
        'Broker cannot see whether the consumer\'s side effect happened',
        'Idempotency key recorded with the business write in one transaction',
        'Idempotent operations (absolute state, upserts) and downstream idempotency keys',
      ],
    },
    {
      id: 'fe3',
      concept: 'Ordering and parallelism',
      prompt: 'Explain why a queue with many consumers cannot keep messages in order, and how per-key ordering gets you most of what you need.',
      modelExplanation: `Imagine two updates for the same customer, "address is A" then "address is B", sitting in a queue. With ten workers, the broker gives the first to worker 1 and the second to worker 2. Worker 2 happens to be faster and writes B; then worker 1 writes A. The customer ends up with the old address. If worker 1 had failed and retried, the reordering would be even worse. As long as several workers run in parallel, "wait for the previous one" and "do not wait" cannot both be true.

The trick is to notice that order only matters between messages about the same thing. Nobody cares whether customer 42's update runs before customer 77's. So you give each message a key, the customer id, and make the broker route all messages with the same key to the same lane, processed one at a time in order. SQS FIFO calls the lane a message group; Kafka calls it a partition. Different keys use different lanes in parallel. You get ordering where it matters and parallelism everywhere else, and you still add a version number so a consumer can ignore a stale update if something slips.`,
      mustMention: [
        'Parallel consumers finish at different speeds and retries reorder',
        'Ordering and parallelism are in tension',
        'Order per key (entity id), not globally',
        'SQS FIFO message groups / Kafka partitions as the mechanism',
        'Consumers should still tolerate disorder (versions, absolute state)',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a busy old post office, from the front counter where letters are dropped, through the sorting room, past the delivery bays and the damaged-mail shelf, to the archive at the back.',
    stops: [
      { locus: 'The letter slot at the front', concept: 'Decoupling: drop and go', image: 'You post a letter in 5 milliseconds and walk away whistling. Behind the wall a mountain of letters piles up during a flash sale; the postmen downstairs are asleep and nobody at the slot notices or cares.' },
      { locus: 'The ticket dispenser at the counter', concept: 'Competing consumers, prefetch, visibility timeout', image: 'Each ticket goes to exactly one clerk. A greedy clerk clutching 500 tickets is slapped with a sign PREFETCH=10. A clerk wanders off holding a ticket; a 30-second egg timer rings and the ticket teleports back into the dispenser for someone else.' },
      { locus: 'The signature desk', concept: 'At-most-once vs at-least-once', image: 'Two customers: one signs for a parcel before opening it and finds it empty (lost). The other opens first, faints mid-unwrap, and a second identical parcel arrives tomorrow (duplicate). A fridge behind them labelled IDEMPOTENT swallows the second parcel and shows only one.' },
      { locus: 'The damaged-mail shelf', concept: 'Retries with backoff, DLQ', image: 'A battered letter bounces back 1 s, 2 s, 4 s, 8 s later, each time at a slightly random moment. On the fifth bounce a supervisor puts it on a red shelf marked DEAD LETTERS and a siren goes off: depth > 0.' },
      { locus: 'Passport-control lanes in the hall', concept: 'Ordering per key', image: 'Families are herded into one lane each so no child passes their parent; different families move through different lanes at once. A single lane for everybody would stretch out the door.' },
      { locus: 'The sorting clerk with pigeonholes', concept: 'RabbitMQ exchanges vs SQS mailbox', image: 'A clever clerk reads "order.created" on each envelope and drops copies into pigeonholes labelled with wildcards like order.*. Across the street, a plain rented mailbox with an AWS logo: no clerk, no sorting, you walk over to check it every 20 seconds.' },
      { locus: 'The archive at the back', concept: 'Queue vs stream', image: 'The to-do list on the wall has lines struck through and torn off as they are done. Beside it, an endless shelf of dated newspapers no one removes; ten readers each hold their own bookmark, and one is rewinding to last month.' },
      { locus: 'The exit sign', concept: 'When not to use a broker', image: 'A man at the dinner table posts a letter asking for the salt and waits three days. The sign above the door reads: IF YOU ARE WAITING FOR THE ANSWER, JUST TALK.' },
    ],
  },
  interviewQuestions: [
    'What problems does a message broker solve, and what new problems does it introduce?',
    'Explain at-most-once, at-least-once and exactly-once delivery. Which do real brokers provide and how do you get exactly-once semantics in practice?',
    'How do visibility timeouts in SQS work and how do they cause duplicate processing?',
    'Design a retry and dead-letter strategy for a consumer that calls a flaky third-party API.',
    'Why can a queue with multiple consumers not guarantee ordering? How do SQS FIFO or Kafka address this?',
    'Compare RabbitMQ and SQS. When would you pick each?',
    'What is the difference between a message queue and a stream such as Kafka? Give a workload for each.',
    'What is the dual-write problem when publishing events after a database commit, and how does the transactional outbox pattern solve it?',
  ],
}

export default chapter
