import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 27,
  slug: 'designing-a-notification-service',
  title: 'Designing A Notification Service',
  module: 'case-studies',
  estimatedMinutes: 40,
  summary:
    'A notification service is the shared plumbing that every product team leans on to reach users over push, SMS, email and in-app channels. It looks trivial (call an API, send a message) but at scale it is a study in queues, priorities, idempotency, retries, third-party failover and respecting user preferences without ever sending the same message twice.',
  objectives: [
    'Design a multi-channel notification pipeline with priority queues, templating and per-user preferences.',
    'Explain why idempotency keys and deduplication are non-negotiable in a retrying, at-least-once system.',
    'Design retries with exponential backoff, dead-letter queues and provider failover across FCM, APNs, Twilio and SES.',
    'Reason about rate limiting, quiet hours and scheduling as protections for the user rather than the system.',
    'Model delivery tracking end to end and estimate throughput, storage and worker counts.',
  ],
  quickRevision: [
    'A notification service decouples producers (order, payment, social services) from channels (push, SMS, email, in-app) through an async queue.',
    'Accept the request, validate, persist, enqueue, return 202 Accepted; never make the caller wait on Twilio or APNs.',
    'Separate queues per priority (critical OTP vs marketing) so a marketing blast cannot starve a login OTP.',
    'Templates are stored centrally and rendered inside the service; producers send template id + variables, not final text.',
    'User preferences (channel opt-outs, quiet hours, language) are checked at send time, not at enqueue time, because they change.',
    'Rate limiting per user per channel protects users from spam and protects your sender reputation with carriers.',
    'Every request carries an idempotency key; a dedup store (Redis SETNX with TTL) drops replays before they reach a provider.',
    'Retries use exponential backoff with jitter; after N attempts the message goes to a dead-letter queue for inspection, not into the void.',
    'Provider failover: FCM for Android, APNs for iOS, Twilio -> alternate SMS gateway, SES -> SendGrid; route by health and cost.',
    'Delivery tracking is a state machine: queued -> sent -> delivered/failed/bounced, fed by provider webhooks.',
    'Scheduled notifications live in a time-indexed store (Redis sorted set or DB indexed by send_at) polled by a scheduler that enqueues when due.',
    'Push tokens go stale; on FCM/APNs "unregistered" errors, delete the token to stop wasting sends.',
    'Budget: 10M notifications/day is only ~115/s average but bursts (a sale, a breaking-news alert) can be 100x that; size for the burst with queues.',
  ],
  sections: [
    {
      id: 'requirements-and-shape',
      title: 'Requirements and the shape of the problem',
      body: `Almost every product needs to tell users something: an OTP for login, an order-shipped update, a "someone liked your post" nudge, a weekly digest. Left to individual teams, each builds its own SMS integration, its own retry logic and its own accidental double-sends. A **notification service** centralises this once.

**Functional requirements** are deceptively simple: accept a request to notify a user, pick the right channel(s), render the content, deliver it, and report what happened. Support push (FCM for Android, APNs for iOS), SMS (Twilio, MSG91), email (SES, SendGrid) and in-app (a bell icon backed by a store). Support immediate and scheduled sends. Respect user preferences.

**Non-functional requirements** are where the design lives:

- **Throughput with bursts.** 10M/day averages ~115/s, but a flash sale or a breaking-news alert can demand 10k/s for a minute. The system must absorb bursts, not reject them.
- **Latency by class.** An OTP must arrive within seconds. A marketing email can take an hour. Treating them equally is a mistake in both directions.
- **At-least-once delivery, with no duplicates visible to users.** Losing an OTP is a failed login; sending it twice confuses users and doubles cost. Both matter.
- **Provider independence.** Twilio has outages; APNs rejects tokens; SES throttles. The service must survive any one provider failing.
- **Auditability.** Support teams ask "did this user get the email?" constantly. Every message needs a traceable lifecycle.

The core architectural decision follows directly from the burst and provider-failure requirements: **the service is asynchronous.** Producers call an API that validates, persists and enqueues, then returns \`202 Accepted\` with a notification id. Workers do the slow, failure-prone provider calls later. The Order service never waits on Twilio.`,
      mentalModel:
        'A notification service is a post office. Senders drop letters at the counter and leave immediately; sorting, choosing the carrier, retrying a failed delivery and tracking the parcel all happen behind the counter.',
      diagram: `Producers                Notification Service               Providers
+--------+   POST /notify   +-----------+   +--------+   +-----------+
| Orders |----------------->|  API      |-->| Queues |-->| Workers   |--> FCM/APNs
| Auth   |   202 Accepted   | validate  |   | by     |   | render,   |--> Twilio
| Social |<-----------------| persist   |   | prio   |   | prefs,    |--> SES
+--------+                  +-----------+   +--------+   | send      |--> In-app
                                                          +-----------+
                                    webhooks (delivered/bounced) <----+`,
      keyPoints: [
        'Centralising notifications avoids every team re-implementing retries, dedup and provider integrations.',
        'Burst absorption and provider failures force an asynchronous design: accept, enqueue, return 202.',
        'Latency requirements differ by class (OTP vs marketing), which will drive priority queues.',
        'At-least-once delivery plus no visible duplicates means idempotency is a core requirement, not a nicety.',
        'Every message needs a traceable lifecycle for support and debugging.',
      ],
      checkpoint: {
        question:
          'The Auth team wants POST /notify to return only after the OTP SMS has actually been sent, "so we know it worked". What do you tell them?',
        answer:
          'Synchronous sending couples login latency and availability to Twilio. Instead return 202 with a notification id immediately, put OTPs on a high-priority queue with a tight SLA (sub-second dequeue), and expose GET /notifications/{id} or a webhook so they can observe delivery status. If they truly need sync semantics for a rare case, offer a separate low-volume sync endpoint with a strict timeout.',
      },
    },
    {
      id: 'priority-queues',
      title: 'Priority queues: the OTP must never wait behind marketing',
      body: `If all notifications share one queue, a marketing campaign that enqueues 5 million emails at 9 a.m. puts every OTP for the next hour behind them. Users cannot log in because someone launched a sale. This is **head-of-line blocking**, and the fix is to physically separate traffic classes.

**Separate queues per priority and per channel.** A common layout is three priorities (critical, high, normal/bulk) crossed with channels: \`push.critical\`, \`sms.critical\`, \`email.bulk\`, and so on. With RabbitMQ these are distinct queues; with Kafka, distinct topics; with SQS, distinct queues (SQS has no native priority). Each queue has its own consumer group, so critical workers are never busy draining bulk.

**Why not one queue with a priority field?** RabbitMQ does support priority queues, but priorities only reorder messages already in the queue and add CPU cost; a huge backlog still costs memory and a consumer crash still delays everything. Physical separation also gives independent scaling: you can run 50 workers on \`sms.critical\` and 5 on \`email.bulk\`, and rate-limit bulk per provider without touching critical.

**Isolation of provider limits.** Twilio caps messages per second per account; SES caps daily volume until warmed up. Bulk workers should be throttled to leave headroom for critical sends. In practice you reserve provider capacity: for instance bulk SMS may use at most 60% of the Twilio rate limit at any time.

**Backpressure.** Queues are buffers, not infinite storage. Monitor queue depth and age of the oldest message. If \`email.bulk\` grows to hours of backlog, that is acceptable; if \`sms.critical\` oldest-message age exceeds 5 seconds, page someone. Kafka retention protects you against worker outages; RabbitMQ needs lazy queues or disk limits for very deep backlogs.`,
      mentalModel:
        'An airport has separate security lanes for crew, first class and economy. If everyone shared one lane, a tour group arriving at once would make the pilot miss the flight.',
      diagram: `                    +------------------+   50 workers
      critical ---> | sms.critical     |------------> Twilio (reserved 40%)
                    +------------------+
                    +------------------+   20 workers
      high     ---> | push.high        |------------> FCM / APNs
                    +------------------+
                    +------------------+   5 workers, throttled
      bulk     ---> | email.bulk       |------------> SES (<= 60% quota)
                    +------------------+
  Alert if age(oldest msg in *.critical) > 5s`,
      keyPoints: [
        'One shared queue lets bulk traffic block OTPs: head-of-line blocking.',
        'Separate queues (or topics) per priority x channel give independent consumers and independent scaling.',
        'Reserve provider capacity for critical traffic; throttle bulk workers below provider limits.',
        'Monitor queue depth and oldest-message age per queue; SLAs differ by class.',
        'In-queue priority fields are a weaker substitute than physical separation.',
      ],
      checkpoint: {
        question:
          'You use SQS, which has no message priority. A product manager asks how you guarantee OTPs are not delayed by a 2M-message campaign. What is your answer?',
        answer:
          'Priority does not need to be a queue feature: create distinct SQS queues (sms-critical, sms-bulk), route by notification class at the API, and run separate, independently scaled worker fleets for each. Throttle bulk workers below the Twilio limit so critical sends always have capacity.',
      },
    },
    {
      id: 'templates-and-preferences',
      title: 'Templating, localisation and user preferences',
      body: `Producers should never send final message text. If the Order service builds the string "Your order #123 has shipped", then changing the wording, translating it into Hindi, or fixing a typo requires redeploying Orders. Instead the producer sends a **template id plus variables**: \`{ template: "order_shipped", vars: { orderId: 123, eta: "Tue" } }\`.

**Template store.** Templates live in a database table (Postgres is fine; templates are small and read-heavy) and are cached in each worker with a short TTL or a version-based invalidation. Each template has one body per channel and per locale: the push version is 80 characters, the email version has HTML and a subject line, the SMS version avoids Unicode to stay within 160 GSM-7 characters (Unicode drops a segment to 70 characters and doubles cost). Rendering uses a safe engine (Mustache/Handlebars style, no arbitrary code) and rejects missing variables at enqueue time so a bad payload fails fast with a 400 instead of failing deep in a worker.

**User preferences** decide whether and how to send. A preferences record per user holds: channel opt-ins per category (transactional cannot be disabled, marketing can), preferred language, timezone, quiet hours (no marketing push between 22:00 and 08:00 local), and a global unsubscribe flag. Regulations make this mandatory: CAN-SPAM and GDPR require honouring unsubscribes; TRAI in India restricts promotional SMS hours.

**Check preferences at send time, not enqueue time.** A digest scheduled at 08:00 may have been enqueued the night before; the user may have unsubscribed in between. Workers fetch preferences (cached in Redis, keyed by user id, invalidated on update) just before calling the provider.

**Device and contact registry.** The service, not the producer, knows the user's current push tokens, phone number and email. A user may have three devices; push fans out to all. Tokens are stored with platform and last-seen time, and FCM/APNs "unregistered" responses delete them.`,
      mentalModel:
        'A template is a form letter with blanks. The sender fills in the blanks; the post office picks the language, the envelope size and whether this customer asked not to receive advertising.',
      keyPoints: [
        'Producers send template id + variables; the service owns wording, channels and locales.',
        'Validate variables against the template at enqueue so bad requests fail fast with a 400.',
        'Preferences: per-category channel opt-in, language, timezone, quiet hours, unsubscribe; transactional cannot be disabled.',
        'Evaluate preferences at send time because they change between enqueue and delivery.',
        'The service owns the device-token and contact registry and prunes stale tokens on provider errors.',
      ],
      checkpoint: {
        question:
          'A marketing push is enqueued at 21:55 for a user whose quiet hours start at 22:00. The queue is backed up and a worker picks it up at 22:10. What should happen?',
        answer:
          'The worker checks preferences at send time, sees the message is marketing and the user is inside quiet hours, and defers it: re-schedule it for 08:00 local (write to the scheduler store) rather than dropping it or sending it. Transactional messages such as OTPs would bypass quiet hours.',
      },
    },
    {
      id: 'idempotency-and-dedup',
      title: 'Idempotency and deduplication: never send it twice',
      body: `Every layer of this system can duplicate work. The producer times out on POST /notify and retries. The queue is at-least-once, so a worker that crashes after calling Twilio but before acking causes a redelivery. A provider returns a 500 but actually sent the SMS. Without defences, users receive duplicate OTPs and you pay twice.

**Idempotency key at the API.** The producer supplies \`Idempotency-Key\` (for example \`order-123-shipped\`). The API does \`SET key notification_id NX EX 86400\` in Redis. If the key already exists, return the existing notification id with 200 instead of enqueuing again. This collapses producer retries into one notification. Stripe popularised exactly this pattern for payments.

**Dedup at the worker.** Before calling a provider, the worker claims the send: \`SET sent:{notification_id}:{channel} 1 NX EX 3600\`. If the claim fails, another worker already sent it, so ack and move on. This handles queue redelivery. The window between "claim" and "provider ack" is still a risk: if the worker dies right there, the message is marked sent but was not. Mitigate by writing the claim with a short TTL and a state \`sending\`, and having a sweeper re-queue messages stuck in \`sending\` beyond the TTL. You are choosing which failure is rarer and cheaper: a rare double send versus a rare missed send, and for OTPs you typically accept a rare double send.

**Provider-side idempotency.** Some providers accept a client reference id (SES \`MessageDeduplicationId\` in SQS-style APIs, Twilio's idempotency headers on newer endpoints). Use them where available; they are the only true protection against the "provider sent but returned 500" case.

**Content-based dedup for producers that lack keys.** Legacy producers may not send keys. Fall back to a hash of (user, template, vars) within a short window (say 60 s). This catches accidental double-clicks but can wrongly merge legitimate repeats, so keep the window small and skip it for OTPs where the vars differ anyway.`,
      mentalModel:
        'A restaurant ticket rail: the waiter clips one ticket per table order. If the same waiter shouts the order twice, the kitchen sees one ticket. If two cooks reach for the same ticket, whoever tears it off cooks it.',
      diagram: `Producer retry           API                   Redis
POST /notify  ------->  SET idem:{key} id NX EX 86400
Idempotency-Key: k      | exists?  -> 200 {existing id}
                        | created? -> persist, enqueue, 202

Queue redelivery         Worker                Redis
msg n (2nd time) ---->  SET sent:{n}:{ch} 1 NX EX 3600
                        | fails -> already sent, ack
                        | ok    -> call provider, mark delivered`,
      keyPoints: [
        'Duplicates arise from producer retries, at-least-once queues and ambiguous provider errors.',
        'API idempotency key stored in Redis with NX and a TTL collapses producer retries.',
        'Workers claim a send with SETNX before calling the provider to survive redelivery.',
        'The claim-then-crash window forces a choice: rare double send vs rare miss; add a sweeper for stuck sends.',
        'Use provider-side idempotency ids where available; they cover the "sent but returned 500" case.',
      ],
    },
    {
      id: 'retries-dlq-failover',
      title: 'Retries, dead-letter queues and provider failover',
      body: `Third-party providers fail constantly in small ways: 429 rate limits, 5xx blips, timeouts, regional outages. The service must distinguish **transient** failures (retry) from **permanent** ones (do not retry) and must never retry forever.

**Classify errors.** Permanent: invalid phone number, unregistered push token, hard email bounce, template rendering error. Mark failed, emit a metric, and for tokens delete the token. Transient: timeouts, 429, 5xx, connection resets. Retry.

**Exponential backoff with jitter.** Retry after 1 s, 2 s, 4 s, 8 s, up to a cap such as 5 minutes, adding random jitter so thousands of retries do not synchronise into a thundering herd against a recovering provider. Implement with delayed redelivery: RabbitMQ dead-letter exchange with per-retry TTL queues, SQS \`ChangeMessageVisibility\`, or a Kafka retry topic per delay tier. Cap attempts by class: OTPs get 3 fast attempts within 30 s (a 10-minute-late OTP is useless), marketing gets 5 attempts over hours.

**Dead-letter queue.** After the final attempt, the message goes to a DLQ with its full history (attempts, error codes, timestamps). The DLQ is not a graveyard; it is an inbox. Alert on its growth, build a small tool to inspect and replay messages after a provider incident, and expire entries after a few days.

**Provider failover.** Each channel has an ordered list of providers with health tracked by a circuit breaker per provider: if Twilio error rate exceeds 20% over 30 s, open the breaker and route new sends to the secondary gateway. Half-open probes restore Twilio when it recovers. Failover is per channel, not global: FCM and APNs are the only way to reach Android and iOS respectively, so push failover means retrying, not switching, whereas SMS and email have genuine alternatives. Routing can also consider cost and geography: a local Indian aggregator may be cheaper and more reliable for Indian numbers than Twilio.

**Rate limiting toward providers.** A token bucket per provider keeps you under contractual limits so you are not the cause of the 429s you are retrying.`,
      mentalModel:
        'A courier who cannot deliver tries again later, then leaves the parcel at the depot with a note explaining every attempt. If one courier company is on strike, the depot hands parcels to another company, but it never stops trying to deliver the pizza until it is cold.',
      diagram: `worker --> provider call
            |-- 2xx ------------------> mark sent
            |-- permanent (400, bad token) -> mark failed, prune token
            |-- transient (429/5xx/timeout)
                  |-- attempts < max? --> retry queue (1s,2s,4s..+jitter)
                  |-- else -------------> DLQ (with history) -> alert

Circuit breaker per provider:
  Twilio err rate > 20% / 30s  ==> OPEN ==> route SMS to MSG91
  half-open probe every 60s    ==> CLOSE when healthy`,
      keyPoints: [
        'Classify errors: permanent failures are recorded, not retried; transient ones are retried.',
        'Exponential backoff with jitter and a per-class attempt cap; late OTPs are worthless so cap them tightly.',
        'A DLQ preserves failed messages with history for alerting, inspection and replay.',
        'Circuit breakers per provider drive failover for SMS and email; push can only retry against FCM/APNs.',
        'Token-bucket toward each provider so you do not cause the rate-limit errors you then retry.',
      ],
      checkpoint: {
        question:
          'APNs starts returning 503 for 30% of requests. Should the circuit breaker fail iOS push over to another provider?',
        answer:
          'There is no alternative provider for iOS push; only Apple can deliver to an iOS device. The breaker should instead slow down (back off, reduce concurrency) and retry, and for critical messages the fallback is a different channel, for example send the OTP over SMS if push has not been confirmed within 10 seconds.',
      },
    },
    {
      id: 'tracking-and-scheduling',
      title: 'Delivery tracking, analytics and scheduling',
      body: `"Did the user get it?" is the most common support question about notifications, and the answer requires tracking every message through a state machine.

**Lifecycle states.** \`created -> queued -> sending -> sent -> delivered | failed | bounced\`, plus \`opened\`/\`clicked\` for email and in-app. "Sent" means the provider accepted it; "delivered" means the provider confirmed the device or carrier received it. The gap between these is real: SMS delivery receipts (DLRs) arrive seconds to minutes later via **provider webhooks**; email bounces may arrive hours later. The webhook endpoint must be idempotent (providers retry) and must verify signatures (Twilio signs with your auth token; SES uses SNS signed messages).

**Storage.** Notification metadata (id, user, template, channel, state, timestamps, provider message id, attempts) is written once and updated a few times, then only read. At 10M/day and ~500 bytes each that is 5 GB/day, 1.8 TB/year. A write-heavy store such as Cassandra or DynamoDB keyed by notification id, with a secondary index by user id and time, fits well; alternatively Postgres partitioned by day with old partitions dropped after 90 days. Provider message id must be indexed, because webhooks identify messages by it, not by your id. Events also stream to Kafka for analytics: delivery rate per provider, per template, per region, which is what tells you a provider is degrading before users complain.

**In-app notifications** are the odd channel: nothing leaves your system. Write to an inbox table keyed by user (Cassandra wide row or Redis list capped at the last 100), and push a "new notification" signal over the user's existing WebSocket connection if online. Unread counts are a Redis counter per user.

**Scheduling.** "Send at 08:00 user-local time" and "send 24 h after cart abandonment" are common. Store scheduled notifications with a \`send_at\` timestamp in a store indexed by time: a Redis sorted set with score = send_at, or a Postgres table indexed on \`(send_at)\`. A scheduler process polls every second for entries with \`send_at <= now\`, moves them to the live queue and marks them dispatched, using a lock or \`SELECT ... FOR UPDATE SKIP LOCKED\` so multiple scheduler instances do not double-dispatch. Cancellation is a delete from the store; because preferences are evaluated at send time, a user who unsubscribes after scheduling is still respected.`,
      mentalModel:
        'A parcel tracking page: each scan (accepted, in transit, out for delivery, delivered) is a webhook from the carrier, and the tracking number they gave you is the key you look everything up by.',
      keyPoints: [
        'Track a state machine per message; sent (provider accepted) is not delivered (device or carrier confirmed).',
        'Provider webhooks drive delivered/bounced states; verify signatures and make the endpoint idempotent.',
        'Store per-message records in a write-optimised store indexed by notification id, user id and provider message id.',
        'Stream events to Kafka for per-provider and per-template delivery-rate dashboards.',
        'Scheduled sends live in a time-indexed store polled by a scheduler with locking to avoid double dispatch.',
      ],
      checkpoint: {
        question:
          'Twilio retries a delivery-receipt webhook three times because your endpoint was slow. What must be true of your webhook handler?',
        answer:
          'It must be idempotent: applying the same "delivered" event three times leaves the state as delivered once, without triggering three analytics events or three state transitions. It should also verify the Twilio signature and return 200 quickly (enqueue the processing) so retries stop.',
      },
    },
    {
      id: 'rate-limiting-users',
      title: 'Rate limiting and batching: protecting users and reputation',
      body: `Rate limiting in a notification service serves two masters: the **user**, who should not receive 40 pushes in a minute, and your **sender reputation**, which carriers and mailbox providers score and which decides whether your OTPs land at all.

**Per-user, per-channel limits.** A sliding-window counter in Redis (\`INCR\` with expiry, or a sorted set of timestamps) enforces rules such as "at most 5 marketing pushes per day" and "at most 1 push per 10 minutes for social notifications". Exceeding the limit does not error; it collapses. Ten "X liked your post" events become one "X and 9 others liked your post", which is what Facebook and Instagram do. Collapsing requires **batching**: hold low-priority events for a short window (say 5 minutes) in a per-user buffer, then render a single aggregated template.

**Category budgets.** Transactional messages (OTP, order status) are exempt from marketing limits but still capped against abuse: an attacker triggering OTPs to a victim's number 1,000 times is an SMS-bombing attack that costs you money and gets your sender id blocked. Cap OTPs per destination number per hour regardless of who requests them.

**Reputation with providers.** Email providers such as Gmail track complaint and bounce rates per sending domain; exceed roughly 0.1% complaints and you go to spam. SES enforces this by suspending accounts. Mitigations: honour unsubscribes instantly, suppress hard bounces permanently (a suppression list checked before every send), warm up new sending domains gradually, and use separate domains or IPs for transactional and marketing so a marketing complaint spike cannot hurt OTP deliverability. For SMS, registered sender ids and DLT templates (mandatory in India) must match content exactly or carriers drop the message silently.

**Global throttles.** Beyond per-user limits, a global token bucket per provider keeps aggregate throughput under contract. When the bucket is empty, bulk workers pause; critical workers draw from a reserved sub-bucket.`,
      mentalModel:
        'A good friend texts you once with a summary, not forty times with each thought. And a friend who shouts at strangers gets everyone in the group chat muted, which is what mailbox providers do to noisy domains.',
      keyPoints: [
        'Per-user per-channel sliding-window limits in Redis; exceeding them collapses and batches rather than errors.',
        'Aggregate low-priority events into one notification ("X and 9 others") via a short buffering window.',
        'Cap OTPs per destination number to stop SMS-bombing abuse.',
        'Protect sender reputation: suppression lists, instant unsubscribes, domain warm-up, separate transactional and marketing domains.',
        'Global token buckets per provider with a reserved share for critical traffic.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What should POST /notify return in a well-designed notification service?',
      options: [
        '200 OK after the SMS provider confirms delivery',
        '202 Accepted with a notification id, after validating and enqueuing',
        '204 No Content immediately without persisting anything',
        '200 OK only after all channels have been attempted',
      ],
      answerIndex: 1,
      explanation:
        'The API validates, persists and enqueues, then returns 202 with an id the caller can use to track status. Waiting for providers couples the caller to third-party latency and outages; returning without persisting risks losing the request.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'Why use physically separate queues per priority rather than one queue with a priority field?',
      options: [
        'Priority fields are not supported by any broker',
        'Separate queues allow independent consumer fleets, independent scaling and isolation from a deep bulk backlog',
        'Separate queues guarantee exactly-once delivery',
        'Priority fields increase message size beyond broker limits',
      ],
      answerIndex: 1,
      explanation:
        'Separate queues mean a 5M-message marketing backlog never sits in front of OTPs, and critical workers can be scaled and throttled independently. RabbitMQ does support priority fields, but they only reorder within a queue and do not isolate resources.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'When should user preferences (quiet hours, opt-outs) be evaluated?',
      options: [
        'Only at enqueue time, to fail fast',
        'Only in the producer, before calling the API',
        'At send time in the worker, because preferences can change between enqueue and delivery',
        'Never; preferences are a client-side concern',
      ],
      answerIndex: 2,
      explanation:
        'A scheduled or backlogged message may be sent hours after enqueue; the user may have unsubscribed or entered quiet hours in between. Evaluating at send time (with a Redis-cached preference lookup) honours the latest choice. Enqueue-time validation is fine for template variables but not for preferences.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which failures should be classified as permanent (do not retry)? Select all that apply.',
      options: [
        'FCM returns "unregistered" for the device token',
        'Twilio returns 429 Too Many Requests',
        'SES reports a hard bounce for the address',
        'The provider connection times out',
        'Template rendering fails due to a missing variable',
      ],
      answerIndices: [0, 2, 4],
      explanation:
        'An unregistered token, a hard bounce and a rendering error will fail identically on every retry; record them, prune the token or suppress the address, and move on. 429 and timeouts are transient and should be retried with backoff.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement:
        'Because message queues like SQS and RabbitMQ provide at-least-once delivery, a notification worker may receive the same message twice and must guard against sending it twice.',
      answer: true,
      explanation:
        'At-least-once means redelivery after a worker crashes before acking. The worker must claim the send (e.g. Redis SETNX on notification id + channel) before calling the provider so the second delivery is recognised and skipped.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A worker claims a send in Redis, calls Twilio, and crashes before recording the result. The Redis claim has a 1-hour TTL. What is the risk and a reasonable mitigation?',
      options: [
        'No risk; Redis will replay the call',
        'The message may be lost if Twilio did not actually send it; a sweeper should re-queue messages stuck in "sending" past a short TTL, accepting a rare double send',
        'The message is guaranteed to be sent twice; reduce the TTL to zero',
        'Twilio will detect the crash and retry automatically',
      ],
      answerIndex: 1,
      explanation:
        'After the claim, redeliveries are skipped, so if Twilio never got the request the message is silently lost until the TTL expires. A sweeper that re-queues stale "sending" records trades a rare duplicate for not losing OTPs. Redis does not replay calls and Twilio has no knowledge of your worker.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question: 'APNs error rates spike to 40%. What is the correct failover behaviour for critical iOS pushes?',
      options: [
        'Route iOS pushes to FCM instead',
        'Route iOS pushes to Twilio SMS immediately for all users',
        'Back off and retry against APNs, and for critical messages fall back to another channel (e.g. SMS) if push is not confirmed within a deadline',
        'Drop iOS pushes until APNs recovers',
      ],
      answerIndex: 2,
      explanation:
        'Only Apple delivers to iOS devices, so there is no alternative push provider. The right move is to slow down and retry, and for time-critical content switch channel after a deadline. FCM cannot deliver to iOS without APNs; blanket SMS for everything is expensive and unnecessary.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: 'In delivery tracking, "sent" and "delivered" mean the same thing.',
      answer: false,
      explanation:
        '"Sent" means the provider accepted the message; "delivered" means the carrier or device confirmed receipt, usually reported later via a webhook (SMS DLR, APNs feedback, email bounce). The gap is where many delivery problems hide.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 2,
      question: 'A user receives 10 "liked your post" events within 5 minutes. What should the notification service do?',
      options: [
        'Send 10 separate pushes to maximise engagement',
        'Drop all but the first and discard the rest',
        'Buffer them briefly and send one aggregated notification such as "A and 9 others liked your post"',
        'Convert them to emails',
      ],
      answerIndex: 2,
      explanation:
        'Per-user rate limits should collapse rather than error or spam. A short buffering window plus an aggregated template preserves the information while protecting the user from noise. Dropping loses information; ten pushes trains users to disable notifications.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'Which store is best suited for "send at 08:00 tomorrow" scheduled notifications?',
      options: [
        'A FIFO queue, since messages are processed in order',
        'A time-indexed store (Redis sorted set scored by send_at or a DB table indexed on send_at) polled by a scheduler',
        'The provider\'s own scheduling API for all channels',
        'An in-memory list inside the API server',
      ],
      answerIndex: 1,
      explanation:
        'Scheduled sends need "give me everything due before now", which is a range query by time, exactly what a sorted set or a time-indexed table provides. A FIFO queue cannot hold messages for arbitrary future times, providers do not uniformly support scheduling, and API-server memory is lost on restart.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Estimate the notification store growth and worker count for a service sending 50M notifications/day with a 10x burst peak, where a provider call takes ~200 ms on average.',
      modelAnswer: `**Throughput:** 50M/day = ~580/s average. 10x burst = ~5,800/s.

**Storage:** ~500 bytes of metadata per notification (ids, state, timestamps, provider message id, attempts) = 25 GB/day, ~9 TB/year before replication. Keep 90 days hot (~2.25 TB) in Cassandra/DynamoDB or day-partitioned Postgres; archive older to S3/Parquet for analytics.

**Workers:** each worker thread handles ~5 sends/s at 200 ms per call. Sustaining 5,800/s at peak needs ~1,200 concurrent sends; with 50 concurrent sends per worker process (async I/O) that is ~25 worker processes, plus headroom (say 40) split across priority queues. Average load only needs ~120 concurrent sends, so autoscale on queue depth and oldest-message age.

**Queue:** bursts of 5,800/s for 5 minutes = 1.7M messages buffered; trivial for Kafka, fine for RabbitMQ with lazy queues.`,
      rubric: [
        'Converts daily volume to per-second average and applies the burst multiplier.',
        'Estimates per-record size and derives daily and yearly storage.',
        'Derives concurrent sends needed from throughput x latency and translates into worker processes.',
        'Mentions autoscaling on queue metrics rather than provisioning for peak permanently.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 3,
      question:
        'Explain how an idempotency key at the API and a send claim in the worker together prevent duplicate OTP SMS, and identify the one case they do not fully cover.',
      modelAnswer: `**API layer:** the producer sends \`Idempotency-Key: login-otp-user42-1712345678\`. The API runs \`SET idem:{key} {id} NX EX 86400\` in Redis. If it already exists, it returns the existing notification id; a producer that timed out and retried therefore creates one notification, not two.

**Worker layer:** before calling Twilio the worker runs \`SET sent:{id}:sms 1 NX EX 3600\`. If the queue redelivers the message (worker crashed before ack), the second worker's claim fails and it acks without sending.

**Uncovered case:** the provider actually sent the SMS but returned a timeout or 500. The worker classifies it as transient and retries, producing a duplicate. Only provider-side idempotency (a client reference id the provider deduplicates on) closes this gap; otherwise you accept a rare duplicate for OTPs because a missing OTP is worse.`,
      rubric: [
        'Describes the API-level key stored with NX and a TTL.',
        'Describes the worker-level claim before the provider call.',
        'Identifies the ambiguous provider response as the uncovered case.',
        'Mentions provider-side idempotency or the explicit trade-off chosen.',
      ],
    },
    {
      type: 'mcq',
      id: 'q13',
      difficulty: 1,
      question: 'Why should a notification service keep separate email sending domains for transactional and marketing mail?',
      options: [
        'Because SES requires it',
        'So a complaint spike from marketing does not damage the reputation, and therefore deliverability, of OTP and receipt emails',
        'To reduce storage costs',
        'To make templates easier to write',
      ],
      answerIndex: 1,
      explanation:
        'Mailbox providers score reputation per sending domain and IP. Isolating marketing protects critical transactional deliverability. SES does not mandate it and it has nothing to do with storage or templating.',
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Core architectural choice of a notification service', back: 'Asynchronous: API validates, persists, enqueues and returns 202 with an id; workers call providers later. Decouples producers from provider latency and outages.' },
    { id: 'f2', front: 'Head-of-line blocking in notifications', back: 'A huge bulk campaign in a shared queue delays OTPs behind it. Fix: separate queues per priority x channel with independent worker fleets.' },
    { id: 'f3', front: 'What producers send instead of message text', back: 'Template id + variables. The service owns wording, per-channel and per-locale bodies, and validates variables at enqueue.' },
    { id: 'f4', front: 'When to evaluate user preferences', back: 'At send time in the worker (cached in Redis), because opt-outs and quiet hours can change between enqueue and delivery.' },
    { id: 'f5', front: 'API idempotency key pattern', back: 'Producer sends Idempotency-Key; API does SET key id NX EX 86400 in Redis; if it exists, return the existing notification instead of enqueuing again.' },
    { id: 'f6', front: 'Worker send claim', back: 'SET sent:{id}:{channel} 1 NX before calling the provider; a redelivered message fails the claim and is acked without sending.' },
    { id: 'f7', front: 'Transient vs permanent provider errors', back: 'Transient (429, 5xx, timeout): retry with backoff. Permanent (bad number, unregistered token, hard bounce, render error): mark failed, prune, do not retry.' },
    { id: 'f8', front: 'Exponential backoff with jitter', back: 'Delays 1s, 2s, 4s, 8s... capped, plus random jitter so retries do not synchronise into a herd against a recovering provider.' },
    { id: 'f9', front: 'Dead-letter queue purpose', back: 'Holds messages that exhausted retries, with attempt history, for alerting, inspection and replay. An inbox, not a graveyard.' },
    { id: 'f10', front: 'Provider failover for push vs SMS', back: 'SMS/email have alternatives (Twilio -> MSG91, SES -> SendGrid) via circuit breakers. Push has none: only FCM/APNs; fall back to a different channel instead.' },
    { id: 'f11', front: 'Sent vs delivered', back: 'Sent: provider accepted. Delivered: carrier/device confirmed, reported later via signed, idempotent webhooks (DLR, bounce).' },
    { id: 'f12', front: 'Scheduling store', back: 'Redis sorted set scored by send_at or DB table indexed on send_at; scheduler polls for due items, locks (SKIP LOCKED) to avoid double dispatch, enqueues.' },
    { id: 'f13', front: 'Notification collapsing', back: 'Buffer low-priority events per user for a few minutes and send one aggregated message ("A and 9 others liked your post") instead of many.' },
    { id: 'f14', front: 'SMS-bombing defence', back: 'Cap OTP sends per destination number per hour regardless of requester; it protects cost and sender-id reputation.' },
    { id: 'f15', front: 'Why prune push tokens', back: 'FCM/APNs return "unregistered" for uninstalled apps; deleting the token stops wasted sends and keeps delivery metrics honest.' },
    { id: 'f16', front: 'Storage estimate for 10M notifications/day', back: '~500 bytes each -> 5 GB/day, ~1.8 TB/year. Use Cassandra/DynamoDB by notification id with indexes on user id and provider message id, or day-partitioned Postgres.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Why the notification service is asynchronous with priority queues',
      prompt: 'Explain to a junior developer why POST /notify does not send the message itself and why there is more than one queue.',
      modelExplanation: `Sending an SMS means calling Twilio, which might take 300 ms or fail entirely. If the login endpoint waited for that, a Twilio outage would stop people logging in. So the API just checks the request, saves it, drops it on a queue and returns "accepted" with an id. Workers pick messages off the queue and do the slow, risky provider calls, retrying if needed.

Why several queues? Imagine marketing enqueues five million promotional emails at 9 a.m. If OTPs sit in the same line, nobody can log in for an hour. So we keep separate queues for critical, high and bulk traffic, per channel, each with its own workers. Critical workers never touch bulk messages, and we deliberately throttle bulk workers so they never use up the provider's rate limit. The queue also soaks up bursts: a flash sale can enqueue 100x normal traffic and the workers simply catch up.`,
      mustMention: [
        'API returns 202 after persisting and enqueuing; workers call providers',
        'Decouples producers from provider latency and outages',
        'Shared queue causes head-of-line blocking of OTPs',
        'Separate queues per priority with independent workers and throttling',
        'Queues absorb bursts',
      ],
    },
    {
      id: 'fe2',
      concept: 'Idempotency and deduplication',
      prompt: 'Explain why users might receive the same notification twice and how the service prevents it, in plain language.',
      modelExplanation: `Duplicates come from retries, and retries are everywhere. The Order service might time out and call us again. The queue might hand the same message to a second worker if the first one crashed before saying "done". Twilio might send the SMS but reply with an error, so we try again.

We defend at two points. At the API, the caller includes an idempotency key like "order-123-shipped". We try to write that key into Redis with "only if not exists". If it already exists, we return the original notification instead of creating another. In the worker, just before calling the provider, we write "sent:notification-id:sms" the same way. If that write fails, another worker already sent it, so we skip. The one case we cannot fully fix is the provider that sent but reported failure; for that we use the provider's own reference ids where they exist, and otherwise accept a rare duplicate because losing an OTP is worse than doubling it.`,
      mustMention: [
        'Sources: producer retries, at-least-once queue redelivery, ambiguous provider errors',
        'Idempotency key at the API with Redis SET NX',
        'Send claim in the worker before the provider call',
        'Ambiguous provider response is the residual gap',
      ],
    },
    {
      id: 'fe3',
      concept: 'Retries, DLQ and failover',
      prompt: 'Explain how the service handles a provider that is failing, from the first error to the message finally being sent or parked.',
      modelExplanation: `When a provider call fails we first ask: will this ever work? A wrong phone number or a deleted push token will fail forever, so we record the failure and stop. A timeout or a 429 might work in a moment, so we retry, but not immediately: we wait 1 second, then 2, then 4, adding a little randomness so thousands of retries do not hammer the provider at the same instant. OTPs get only a few quick tries because a late OTP is useless; marketing can retry for hours.

If all attempts fail, the message goes to a dead-letter queue with its whole history so an engineer can inspect and replay it after the incident. Meanwhile a circuit breaker watches each provider's error rate. If Twilio's errors exceed a threshold, the breaker opens and new SMS goes to a backup gateway until Twilio proves healthy again. Push is special: only Apple and Google can reach phones, so there the fallback is a different channel, not a different provider.`,
      mustMention: [
        'Classify permanent vs transient errors',
        'Exponential backoff with jitter and per-class attempt caps',
        'Dead-letter queue with history for replay',
        'Circuit breaker per provider drives failover',
        'Push has no alternative provider; fall back to another channel',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a bustling central post office, from the public counter at the front to the loading dock at the back. Each station handles one part of getting a message to a person.',
    stops: [
      { locus: 'The front counter', concept: 'Accept, persist, enqueue, return 202', image: 'A clerk stamps your envelope ACCEPTED with a giant rubber stamp, hands you a glowing receipt number, and shoves the envelope down a chute before you can even ask whether it was delivered.' },
      { locus: 'Three colour-coded conveyor belts', concept: 'Priority queues per class and channel', image: 'A red belt marked CRITICAL races along nearly empty carrying tiny OTP envelopes; a grey belt marked BULK groans under a mountain of glossy catalogues. A guard physically blocks catalogues from touching the red belt.' },
      { locus: 'The form-letter printing room', concept: 'Templates, locales and preferences', image: 'Printers spit out letters with blanks being filled by robotic arms. A wall of tiny mailboxes, one per customer, has flags: NO ADS, HINDI, ASLEEP 22:00-08:00. Letters get re-routed based on the flags at the very last moment.' },
      { locus: 'The ticket rail with a single hook', concept: 'Idempotency keys and send claims', image: 'Every envelope must be hung on a hook labelled with its key. If a hook already holds an envelope, the duplicate bursts into confetti. Workers snatch tickets off the rail; whoever tears it off delivers it.' },
      { locus: 'The retry carousel and the red cage', concept: 'Backoff, DLQ, provider failover', image: 'Failed parcels ride a carousel that spins slower each lap (1s, 2s, 4s), sparks flying at random. After five laps a parcel drops into a red cage labelled DEAD LETTERS with a clipboard of its attempts. On the wall, a fuse box: the TWILIO breaker trips and a lever flips all SMS to the MSG91 van.' },
      { locus: 'The tracking board', concept: 'Delivery lifecycle and webhooks', image: 'A giant departures board flips letters: QUEUED, SENT, DELIVERED. Carrier pigeons (webhooks) land with signed notes; a bouncer checks each signature and turns away pigeons carrying a note already posted.' },
      { locus: 'The time-locked vault', concept: 'Scheduling', image: 'Envelopes sit in a vault sorted by the exact minute painted on them. A clock strikes, and a keeper with a stopwatch unlocks only the slots whose time has come, locking each slot as he takes it so his twin cannot take it too.' },
      { locus: 'The loading dock speed governor', concept: 'Rate limits and reputation', image: 'Vans leave through a gate with a token turnstile. A single customer\'s ten identical letters are squashed into one thick envelope reading "and 9 others". A separate pristine van, never touched by catalogues, carries only receipts and OTPs.' },
    ],
  },
  designPractice: {
    problem:
      'Design a notification service for a consumer app with 100M users that sends push, SMS, email and in-app notifications on behalf of dozens of internal teams. It must deliver OTPs within seconds, absorb marketing bursts, never visibly duplicate a message, survive any single provider outage, and let support look up what happened to any message.',
    steps: [
      {
        title: 'Functional requirements',
        prompt: 'List the functional requirements. Distinguish what internal producers need from what end users experience, and call out what is explicitly out of scope.',
        reference: `**Producer-facing**
- Send a notification to a user (or a list of users) on one or more channels: push (FCM/APNs), SMS, email, in-app.
- Specify a template id and variables, a priority class (critical / high / bulk), and optionally a send-at time.
- Supply an idempotency key; repeated calls with the same key create one notification.
- Query notification status by id; receive status callbacks via webhook.
- Manage templates (CRUD, per channel, per locale) with versioning.

**User-facing**
- Receive notifications on registered devices and contact points.
- Manage preferences: per-category channel opt-in, language, quiet hours; global unsubscribe for non-transactional categories.
- See an in-app inbox with unread count and mark-as-read.

**Operational**
- Retry transient failures, park exhausted messages in a DLQ, and replay them.
- Fail over between providers per channel based on health.
- Dashboards: delivery rate by provider, template and region; queue depth and age.

**Out of scope**
- Deciding *what* to notify (that is the producer's business logic).
- Rich campaign segmentation and A/B testing (a marketing platform concern; it can be a producer).
- Two-way messaging (replies to SMS).`,
      },
      {
        title: 'Non-functional requirements & estimation',
        prompt: 'State the NFRs with numbers and do back-of-envelope estimates for throughput, burst, storage and worker capacity.',
        reference: `**NFRs**
- Critical (OTP): p99 end-to-end (API accept to provider accept) under 2 s; at most 3 attempts within 30 s.
- High (order status, social): deliver within 1 minute.
- Bulk (marketing): deliver within the campaign window (hours); may be throttled.
- Availability of the API: 99.99% (52 min/year). Provider outages must not affect API availability.
- At-least-once delivery; duplicates visible to users below 0.01%.
- Retention of message records: 90 days hot, 2 years cold for compliance.

**Estimation**
- 100M users, average 1 notification/user/day = 100M/day = ~1,160/s average. Peak (campaign + evening) 10x = ~12k/s for minutes at a time.
- Channel mix: 60% push, 25% in-app, 10% email, 5% SMS. SMS = 5M/day; at roughly $0.01-0.05 each that is $50k-250k/day, so SMS dedup and abuse caps have direct money value.
- Record size ~500 B -> 50 GB/day, 4.5 TB for 90 days hot. Cassandra/DynamoDB with RF=3 -> ~13.5 TB raw.
- Provider latency ~200 ms. Peak 12k/s x 0.2 s = 2,400 concurrent sends. With async workers at 100 concurrent sends each -> 24 workers at peak, ~3 at average. Autoscale on queue depth.
- Queue buffering: a 10-minute burst at 12k/s = 7.2M messages, ~7 GB at 1 KB each. Kafka handles this trivially; size RabbitMQ with lazy queues.
- Preference cache: 100M users x ~200 B = 20 GB in Redis; feasible on a small cluster, or cache only active users with a 24 h TTL.
- Device tokens: 100M users x 1.5 devices x ~200 B = 30 GB; store in the DB, cache hot ones.`,
      },
      {
        title: 'API design',
        prompt: 'Design the producer API, the status API, the preference API and the provider webhook endpoint. Include idempotency and error semantics.',
        reference: `**Send**
\`\`\`
POST /v1/notifications
Idempotency-Key: order-8812-shipped
{
  "userId": "u_42",
  "template": "order_shipped",
  "vars": { "orderId": 8812, "eta": "Tuesday" },
  "channels": ["push", "email"],       // optional; default from template
  "priority": "high",                  // critical | high | bulk
  "category": "transactional",         // for preference checks
  "sendAt": "2026-09-16T08:00:00Z",    // optional; user-local supported via "08:00@user_tz"
  "callbackUrl": "https://orders/hooks/notif"  // optional
}
-> 202 { "id": "n_9f3", "status": "queued" }
-> 200 { "id": "n_9f3", ... } if Idempotency-Key was seen before
-> 400 on unknown template or missing variables
-> 429 if the producer exceeds its quota
\`\`\`
Batch variant: \`POST /v1/notifications:batch\` with up to 1,000 entries for campaigns, returning per-entry ids.

**Status**
\`\`\`
GET /v1/notifications/{id}
-> { "id": "n_9f3", "status": "delivered",
     "attempts": [ { "channel": "push", "provider": "fcm", "state": "delivered", "at": "..." },
                   { "channel": "email", "provider": "ses", "state": "sent", "at": "..." } ] }
GET /v1/users/{userId}/notifications?limit=50&cursor=...   // in-app inbox
POST /v1/users/{userId}/notifications/{id}:read
\`\`\`

**Preferences**
\`\`\`
GET  /v1/users/{userId}/preferences
PUT  /v1/users/{userId}/preferences
{ "locale": "hi-IN", "timezone": "Asia/Kolkata",
  "quietHours": { "start": "22:00", "end": "08:00" },
  "categories": { "marketing": { "push": false, "email": true }, "social": { "push": true } } }
POST /v1/users/{userId}/devices  { "platform": "ios", "token": "..." }
DELETE /v1/users/{userId}/devices/{token}
\`\`\`

**Provider webhooks** (inbound)
\`\`\`
POST /hooks/twilio   (verify X-Twilio-Signature)
POST /hooks/ses      (SNS-signed; bounce, complaint, delivery)
\`\`\`
Handlers verify signatures, enqueue the event to Kafka and return 200 within 100 ms; a consumer updates state idempotently keyed by provider message id.

**Templates** (admin)
\`\`\`
POST /v1/templates  { "id": "order_shipped", "channels": { "push": {...}, "email": {...}, "sms": {...} }, "locales": [...] }
\`\`\``,
      },
      {
        title: 'Data model & storage',
        prompt: 'Define the main entities, choose storage for each, and justify the choices with access patterns and volume.',
        reference: `**notifications** (write-once, few updates, read by id; 50 GB/day)
- \`id, user_id, template_id, template_version, vars (json), priority, category, status, created_at, send_at, idempotency_key\`
- Store: Cassandra or DynamoDB, partition key \`id\`. Secondary access by \`(user_id, created_at desc)\` via a second table or GSI for the inbox and support lookups. TTL 90 days; stream to S3/Parquet for cold retention.
- Alternative: Postgres partitioned by day; simpler operationally at up to ~10-20M/day, drop partitions to expire.

**notification_attempts** (one row per channel attempt)
- \`notification_id, channel, attempt_no, provider, provider_message_id, state, error_code, at\`
- Indexed by \`provider_message_id\` because webhooks identify messages by it.

**templates** (small, read-heavy)
- \`id, version, channel, locale, subject, body, required_vars\` in Postgres; cached in workers with version-check on a 60 s interval.

**user_preferences** (100M rows, ~200 B)
- \`user_id, locale, timezone, quiet_start, quiet_end, categories (json), unsubscribed_all\` in Postgres or DynamoDB; Redis cache with 24 h TTL invalidated on write.

**devices** (150M rows)
- \`user_id, platform, token, last_seen, created_at\`; unique on \`token\`. Postgres or DynamoDB keyed by \`user_id\`.

**suppression_list**
- \`address_or_number, reason (hard_bounce | complaint | abuse), at\`; checked before every send; Redis set mirrored from the DB.

**Dedup / idempotency (ephemeral)**
- Redis: \`idem:{key} -> id\` (TTL 24 h), \`sent:{id}:{channel}\` (TTL 1 h), rate-limit counters, scheduled sorted set \`sched\` scored by send_at.

**Queues**
- Kafka topics \`notif.{channel}.{priority}\` with partitions keyed by \`user_id\` (keeps a user's messages ordered so "order placed" precedes "order shipped"); retry topics \`notif.retry.{delay}\`; \`notif.dlq\`.
- Alternative: RabbitMQ with per-priority queues and a delayed-message exchange; simpler for smaller scale.

**Analytics**
- All state transitions emitted to Kafka \`notif.events\`, sunk to ClickHouse or BigQuery for delivery-rate dashboards.`,
      },
      {
        title: 'High-level design',
        prompt: 'Draw the end-to-end architecture and walk one critical (OTP) and one bulk (campaign) message through it.',
        reference: `\`\`\`
Producers --> [API gateway: auth, quota] --> [Notification API]
                                                | validate template+vars
                                                | idempotency (Redis NX)
                                                | persist (Cassandra)
                                                | sendAt? -> [Scheduler store]
                                                v
                              Kafka: notif.sms.critical / notif.push.high /
                                     notif.email.bulk / ...
                                                v
   [Channel workers per topic] -- prefs (Redis) -- devices -- templates
        | render, quiet hours, rate limit, suppression check
        | claim send (Redis NX)
        | provider router (circuit breakers, token buckets)
        v
   FCM / APNs / Twilio / MSG91 / SES / SendGrid / In-app store + WebSocket push
        |
   [Webhook receivers] -> Kafka notif.events -> [State updater] -> Cassandra
                                              -> ClickHouse dashboards
   [Retry topics with delay tiers] -> back to channel workers
   [DLQ] -> alerting + replay tool
   [Scheduler] polls due items every 1 s -> publishes to live topics
\`\`\`

**OTP walk-through.** Auth calls POST /notifications with priority critical, channel sms. API checks the idempotency key, validates the \`otp\` template has the \`code\` var, writes the record, publishes to \`notif.sms.critical\` (partition by user id). A critical SMS worker consumes within milliseconds, loads preferences (transactional bypasses quiet hours), checks the per-number OTP cap (5/hour), claims the send in Redis, asks the provider router for SMS to an Indian number: MSG91 breaker closed, token available, send. MSG91 accepts in 150 ms; state = sent. Thirty seconds later the DLR webhook arrives, signature verified, state = delivered. Total to provider accept: ~300 ms.

**Campaign walk-through.** Marketing calls the batch endpoint with 5M user ids, template \`festive_sale\`, priority bulk, sendAt 09:00 user-local. The API expands into per-user records and writes them to the scheduler store bucketed by their local 09:00 in UTC. The scheduler publishes each bucket as it becomes due to \`notif.email.bulk\` and \`notif.push.bulk\`. Bulk workers, throttled to 60% of the SES quota, render per locale, skip users with marketing email off or on the suppression list, and drain over ~2 hours. Critical topics are untouched throughout.`,
      },
      {
        title: 'Deep dive & bottlenecks',
        prompt: 'Pick the three hardest parts (dedup/idempotency, retries and failover, scheduling at scale) and design them in detail, identifying where the system bottlenecks.',
        reference: `**1. Exactly-once-ish delivery**
- Layer 1: API idempotency key in Redis (SET NX EX 86400). Redis is the bottleneck only in theory: 12k/s peak is far below a single Redis node's ~100k ops/s; run a cluster for availability, not throughput. If Redis is unavailable, fail closed for bulk (reject with 503, producers retry) and fail open for critical (accept, risk a rare duplicate; a missing OTP is worse).
- Layer 2: worker claim (SET NX EX 3600) plus attempt row. Sweeper re-queues records in \`sending\` older than 2 minutes.
- Layer 3: provider reference ids where supported.
- Kafka partitioning by user id preserves per-user order and makes the same user's messages land on the same consumer, reducing cross-worker races.

**2. Retries and failover**
- Delay tiers as topics: \`retry.5s\`, \`retry.30s\`, \`retry.5m\`, \`retry.1h\`. A consumer per tier sleeps until the message's due time (messages in a tier topic are roughly in order of due time), then republishes to the live topic. Avoids per-message timers.
- Attempt policy per class: critical 3 attempts / 30 s then channel fallback (push -> SMS); high 5 attempts / 1 h; bulk 5 attempts / 6 h.
- Provider router: per-provider circuit breaker (error rate over a sliding 30 s window, open at 20%, half-open probes every 60 s), per-provider token bucket from contract limits, routing table by country prefix and cost. The router is a library inside workers sharing breaker state via Redis so all workers see the same provider health.
- Bottleneck: provider rate limits, not your infrastructure. SES starts at 14 emails/s until warmed; Twilio long codes are ~1 msg/s per number. Buy short codes/registered sender ids and warm domains; queue depth is the release valve.

**3. Scheduling 5M user-local sends**
- Sorted set per minute bucket in Redis (\`sched:{yyyymmddhhmm}\`) or a Postgres table partitioned by day with an index on send_at. Scheduler instances lease buckets via a Redis lock and publish their contents; each item marked dispatched atomically (Lua script or \`UPDATE ... WHERE state='scheduled' RETURNING\`).
- 5M records due across a 24-hour spread of timezones means bursts of ~200k at the top of each hour; the scheduler only publishes to Kafka (fast), the bulk workers do the slow part under throttle.
- Cancellation: DELETE from the bucket; and preferences re-checked at send time cover late unsubscribes.

**Other bottlenecks**
- Fan-out to multiple devices per user: a user with 5 devices means 5 FCM calls; use FCM multicast (up to 500 tokens per request) to batch.
- Webhook ingestion: DLRs arrive at the same rate as sends (12k/s peak). Receivers must be stateless, verify signature, and publish to Kafka; never update the DB inline.
- Hot templates: a campaign template read 5M times must be cached in-process, not fetched from Postgres per message.`,
      },
      {
        title: 'Failure modes & trade-offs',
        prompt: 'Enumerate failure scenarios (component outages, provider outages, bad deploys, abuse) and state how the design behaves. Then summarise the key trade-offs you made.',
        reference: `**Failure scenarios**
- *Kafka/broker degraded*: API keeps accepting and persisting to Cassandra with status \`accepted\`; a re-publisher drains unpublished records when the broker recovers. Alternatively return 503 for bulk and keep a small in-memory buffer for critical. Trade-off: extra complexity vs API availability.
- *Redis down*: idempotency and claims unavailable. Fail open for critical (accept duplicates), fail closed for bulk. Rate limits default to permissive for transactional, restrictive for marketing.
- *Cassandra write latency spike*: API latency rises; put a strict 200 ms timeout and enqueue anyway with a persisted-later flag, since the message body is in Kafka.
- *Provider outage (Twilio)*: breaker opens within 30 s, SMS routes to MSG91; DLQ receives nothing because retries succeed on the alternate. If all SMS providers fail, critical OTPs fall back to push/email; bulk waits in the queue.
- *APNs outage*: no alternate. Back off, retry, and channel-fallback critical messages after 10 s. Bulk push simply delays.
- *Worker deploy with a rendering bug*: all messages for one template fail with permanent errors and would be marked failed. Guard: a template failure-rate alarm that pauses the topic (consumer pause) when failures exceed 5% in a minute, rather than burning through 5M messages.
- *Poison message*: a payload that crashes workers. Kafka consumers would loop on it; cap attempts and route to the DLQ after 3 crashes using a Redis attempt counter keyed by offset.
- *Producer bug sends 10x traffic*: per-producer quotas at the gateway (429) plus per-user caps protect users; alert the producer team.
- *Abuse: OTP bombing*: per-destination cap (5/hour), per-IP caps at the auth service, and cost alarms.
- *Stale tokens accumulating*: prune on unregistered errors and expire tokens not seen in 90 days; otherwise delivery rate metrics decay and cost rises.
- *Webhook replay or forgery*: signature verification and idempotent state updates keyed by provider message id and event type.

**Key trade-offs**
- *Async with 202 vs sync confirmation*: chose async for availability and burst absorption; producers must poll or accept callbacks.
- *Physical queue separation vs one prioritised queue*: chose separation for isolation and independent scaling; more topics to operate.
- *At-least-once with dedup vs exactly-once*: true exactly-once across third-party providers is impossible; chose layered dedup and accepted rare duplicates for critical messages, rare drops for bulk.
- *Preferences at send time vs enqueue time*: chose send time for correctness; costs a cached lookup per message.
- *Cassandra vs Postgres for records*: Cassandra for write throughput and TTL expiry at 50 GB/day; Postgres is the simpler choice below ~20M/day.
- *Kafka vs RabbitMQ*: Kafka for retention (replay after worker outages), partition-ordering per user and huge backlogs; RabbitMQ is easier for delayed retries and small teams.
- *Cost*: SMS is the dominant cost; the dedup, caps and channel preference logic exist as much to save money as to protect users.`,
      },
    ],
  },
  interviewQuestions: [
    'Design a notification service that supports push, SMS and email for 100M users. How do you ensure an OTP is never delayed by a marketing campaign?',
    'How do you prevent duplicate notifications when producers retry and the queue is at-least-once?',
    'Walk through what happens when Twilio starts returning 5xx for 30% of requests. What about when APNs does?',
    'How would you implement "send this at 8 a.m. in the user\'s local timezone" for 5 million users?',
    'Where do you evaluate user preferences and quiet hours, and why does the timing matter?',
    'How do you track whether a message was actually delivered, and how do you handle provider webhooks safely?',
    'What would you store per notification, in which database, and how much storage is that for 50M notifications a day?',
    'How do you protect users from notification spam and protect your sender reputation with carriers and mailbox providers?',
  ],
}

export default chapter
