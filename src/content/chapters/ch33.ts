import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 33,
  slug: 'designing-fraud-detection',
  title: 'Designing Fraud Detection',
  module: 'case-studies',
  estimatedMinutes: 45,
  summary:
    'A fraud detection system must decide, in under 100 milliseconds and in the middle of a payment, whether a transaction is legitimate, using rules, a machine-learning model, and features computed from the last few seconds of behaviour. This chapter designs the synchronous scoring path, the streaming feature pipeline on Kafka and Flink, the feature store, the asynchronous review loop, and the feedback that turns analyst decisions into training labels.',
  objectives: [
    'Design a synchronous scoring service that combines a rules engine and an ML model within a strict latency budget.',
    'Explain what a feature store is, why it needs online and offline halves, and how velocity features are computed over sliding windows.',
    'Build the streaming pipeline (Kafka + Flink) that keeps velocity and graph features fresh in near real time.',
    'Design the asynchronous review queue and the label feedback loop, and reason about the cost asymmetry between false positives and false negatives.',
    'Identify the failure modes of an inline decision system and design safe degradation.',
  ],
  quickRevision: [
    'Fraud detection is an inline decision: the payment API calls the scorer synchronously and must get allow / block / review back in under ~100 ms, or the checkout stalls.',
    'Two engines run side by side: a rules engine (deterministic, explainable, instantly updatable) and an ML model (catches novel patterns); rules handle hard policy, the model handles probability.',
    'Features come in three flavours: transaction attributes (amount, merchant, device), velocity features (count/sum per window: card in last 10 min, IP in last hour), and graph features (how many cards share this device, degree of the account in the shared-attribute graph).',
    'Velocity features cannot be computed at request time from the database; they are maintained incrementally by a stream processor (Flink/Kafka Streams) and kept in an online store (Redis) for sub-millisecond lookup.',
    'A feature store has an online half (Redis/DynamoDB, low latency, latest value) and an offline half (Parquet/Hive/BigQuery, historical, for training); the same feature definitions feed both to avoid training-serving skew.',
    'Point-in-time correctness: training rows must use feature values as they were at transaction time, never later values, or the model learns from the future (label leakage).',
    'Latency budget example: 5 ms auth/parse, 10 ms feature fetch (parallel Redis MGETs), 5 ms rules, 20 ms model inference, 5 ms decision and log; leave 50 ms headroom for tail latency.',
    'Three outcomes: allow, block, or route to review (async queue for analysts or step-up authentication such as 3DS/OTP); review converts a hard decision into a delayed one.',
    'Labels arrive late: chargebacks take 30-90 days; analyst decisions take hours; confirmed-good labels come from settled, undisputed transactions. Training data lags reality.',
    'False positive cost is a declined legitimate customer (lost sale, churn, support cost); false negative cost is the chargeback amount plus fees. The threshold is a business decision, not an ML one.',
    'Kafka carries the transaction event stream; Flink computes windowed aggregates and writes them to Redis; the same stream lands in the data lake for offline features and training.',
    'When the scorer is slow or down, the payment path must degrade deliberately: fail open (allow, with rules-only fallback) for low amounts, fail closed or step-up for high amounts; never let a fraud check hang checkout.',
    'Shadow-deploy a new model (score but do not act) and compare against the live model before promotion; monitor score distribution drift and feature null rates in production.',
  ],
  sections: [
    {
      id: 'problem-and-requirements',
      title: 'The problem: a decision inside the payment path',
      body: `Every card payment, wallet transfer, account signup or login is a chance for fraud: stolen cards, account takeover, promo abuse, money laundering. A fraud detection system sits **inline** in these flows and decides, per event, whether to allow it, block it, or send it for closer inspection.

Two properties make this hard. First, the decision is **synchronous and latency-bound**. A payment gateway waits for your answer; if it takes 2 seconds, checkout conversion drops and the merchant blames you. A typical budget is 50-150 ms end to end for the fraud check. Second, the signal is **behavioural and temporal**. A single transaction of 4,999 rupees at an electronics store tells you almost nothing. The same transaction as the sixth attempt in 3 minutes from a card that has never shopped in that city, on a device shared with 40 other cards, is almost certainly fraud. The features that matter are counts, sums and relationships over recent time, and they must be fresh to the second.

**Functional requirements**
- Score every transaction in real time and return allow / block / review with a reason code.
- Support rules authored by fraud analysts (no deploy required) and an ML risk score.
- Compute velocity features (per card, per device, per IP, per account, over 1 min, 10 min, 1 h, 24 h, 7 d windows) and graph features (shared devices, shared addresses).
- Route uncertain cases to a manual review queue or a step-up challenge (OTP, 3DS).
- Capture outcomes (analyst decision, chargeback, dispute) as labels for retraining.

**Non-functional requirements**
- p99 latency under 100 ms for the scoring call.
- Availability 99.99%; a fraud outage is a payments outage.
- Throughput: a mid-size payment processor sees 2,000-5,000 transactions/sec at peak; large ones 50,000+.
- Explainability: regulators and customers ask why a payment was declined; every decision needs a reason and an audit trail.
- Adaptability: fraud patterns shift weekly; rules must be deployable in minutes and models retrainable in days.

**Estimation**
- 3,000 TPS peak, ~100M transactions/day.
- Each scoring request reads ~50 features; 3,000 x 50 = 150k feature reads/sec from the online store.
- Each transaction updates ~20 velocity counters across windows: 60k increments/sec.
- Event log: 100M x 1 KB = 100 GB/day retained for training, 36 TB/year in the lake (compressed ~10 TB).`,
      mentalModel:
        'An airport security officer with a five-second glance per passenger. The glance is short, but they are handed a briefing sheet computed in the background: how many times this passport was scanned today, whether this bag tag matches 30 other passengers. The glance is the scorer; the briefing sheet is the feature pipeline.',
      keyPoints: [
        'Inline and synchronous: latency budget ~100 ms, availability tied to payments.',
        'Signal is temporal and relational: velocity and graph features over recent windows.',
        'Three outcomes: allow, block, review/step-up.',
        'Analyst rules and ML model both required; explainability is non-negotiable.',
        'Order of magnitude: thousands of TPS, ~150k feature reads/sec, 100 GB/day of events.',
      ],
      checkpoint: {
        question:
          'Why can the scorer not simply run SELECT count(*) FROM transactions WHERE card_id = ? AND ts > now() - interval \'10 minutes\' for each velocity feature at request time?',
        answer:
          'Fifty such queries per transaction at 3,000 TPS is 150k range scans per second against a hot OLTP table; each scan touches many rows and the p99 blows the budget. Counters must be precomputed incrementally by a stream processor and read as O(1) key lookups from Redis.',
      },
    },
    {
      id: 'rules-and-model',
      title: 'Rules engine plus ML model: why you need both',
      body: `Teams often frame this as rules versus machine learning. Production systems run both, in a fixed order, because they solve different problems.

**Rules engine.** Analysts write conditions: \`amount > 50000 AND card_age_days < 7 -> block\`, \`country_ip != country_billing AND velocity_card_1h > 3 -> review\`, \`merchant in blocklist -> block\`. Rules are deterministic, explainable, auditable, and deployable in minutes without an ML team. They encode hard policy (sanctions lists, regulatory limits) and react to a fraud ring the same afternoon it appears. Their weakness: they are brittle, they multiply into hundreds of overlapping conditions, and fraudsters learn thresholds (if 5 attempts trigger a block, they stop at 4). Implementation: rules as data (JSON or a DSL) in a table, versioned, hot-reloaded into memory; evaluation is a few microseconds per rule. Drools, Easy Rules or a home-grown expression evaluator all work.

**ML model.** A gradient-boosted tree ensemble (XGBoost, LightGBM) or, at larger companies, a neural network over the same features outputs a probability of fraud. It captures interactions among dozens of features that no analyst would write, adapts when retrained, and does not have crisp thresholds to probe. Its weaknesses: it is only as fresh as its last training set, it needs labels (which arrive weeks late), and its explanations (SHAP values) are approximate. Inference for a 500-tree GBM on 50 features is around 1-5 ms on CPU; a small neural network is similar.

**Combination policy.** A typical decision flow:
1. **Hard rules first.** Blocklists, sanctions, impossible values. If a hard rule fires, block immediately and skip the model. Cheap and legally required.
2. **Model score.** Produce p(fraud) in [0,1].
3. **Soft rules and thresholds.** Analysts set thresholds per segment: \`score > 0.9 -> block\`, \`0.6-0.9 -> review or step-up\`, \`< 0.6 -> allow\`, possibly overridden by rules like "trusted customer for 3 years, allow up to 0.95".
4. **Reason codes.** Every decision records which rule fired or the top SHAP features, for the customer support script and the audit log.

**Why the order matters.** Running the model first wastes 5 ms on transactions a blocklist would have rejected. Running rules last lets analysts override a model that has drifted. And keeping thresholds in the rules layer, not baked into the model, means the business can trade precision for recall on a Friday afternoon without a deployment.`,
      mentalModel:
        'A hospital triage desk. A checklist (rules) immediately flags anyone with a gunshot wound or a known allergy; a diagnostic scan (the model) estimates risk for everyone else; the head nurse (thresholds) decides how full the ward can be today.',
      diagram: `transaction
    |
    v
+---------------+  fired  +-------+
| hard rules    |-------->| BLOCK |  (blocklist, sanctions, limits)
| (in-memory)   |         +-------+
+-------+-------+
        | pass
        v
+---------------+   p(fraud)   +------------------+
| ML model      |------------->| soft rules +     |--> ALLOW
| (GBM, ~3 ms)  |              | thresholds       |--> REVIEW / step-up
+---------------+              | per segment      |--> BLOCK
                               +------------------+
                                       |
                              reason codes -> audit log`,
      keyPoints: [
        'Rules: deterministic, explainable, deployable in minutes; brittle and probeable.',
        'Model: catches complex interactions, adapts on retraining; needs late labels and approximate explanations.',
        'Order: hard rules -> model -> soft rules and thresholds -> reason codes.',
        'Keep thresholds in the rules layer so business can tune precision/recall without deploying a model.',
        'GBM inference on ~50 features costs 1-5 ms; rules cost microseconds.',
      ],
      checkpoint: {
        question:
          'A new fraud ring exploits a pattern the model has never seen. Which layer stops the bleeding this afternoon, and which layer stops it permanently?',
        answer:
          'Analysts add a rule (or a blocklist entry) within minutes: the rules engine stops the bleeding. Over the next weeks the confirmed cases become labels, the model is retrained and learns the pattern generally, and the brittle rule can be relaxed or retired.',
      },
    },
    {
      id: 'features-and-velocity',
      title: 'Features: transaction attributes, velocity, and graph',
      body: `The model is only as good as its features, and the features that separate fraud from legitimate behaviour are overwhelmingly about **context over time and across entities**.

**Transaction attributes (stateless).** Amount, currency, merchant category, hour of day, card BIN country versus IP geolocation, device fingerprint, whether the shipping address matches billing, whether the email domain is disposable. These are computed from the request itself in microseconds.

**Velocity features (stateful, windowed).** Counts and sums per entity per time window:
- \`txn_count_card_10m\`, \`txn_sum_card_1h\`, \`distinct_merchants_card_24h\`
- \`txn_count_ip_1h\`, \`distinct_cards_ip_24h\`
- \`txn_count_device_10m\`, \`failed_auth_count_account_1h\`
- \`time_since_last_txn_card\`, \`distance_km_from_last_txn_card / hours\` (impossible-travel)

These are sliding-window aggregates over keys with high cardinality (hundreds of millions of cards). Computing them exactly at request time is infeasible, so they are maintained incrementally.

**Implementation choices for windows**
- **Fixed buckets in Redis.** For \`count_card_1h\`, keep 60 one-minute buckets: \`HINCRBY card:{id}:1m <minute> 1\` with an EXPIRE of 61 minutes, and sum the hash on read (one HGETALL). Approximate to bucket granularity, memory bounded, O(1) update.
- **Sorted sets.** \`ZADD card:{id} <ts> <txn_id>\`, \`ZREMRANGEBYSCORE\` older than the window, \`ZCARD\` for the exact count. Exact, but memory grows with events in the window; fine for 10-minute windows, expensive for 7-day windows on hot keys.
- **Stream processor.** Flink keyed state with sliding windows emits updated aggregates to Redis whenever a transaction arrives or a window slides. Handles many windows and complex aggregates (distinct counts via HyperLogLog) without app-side logic, and produces the identical value for offline training.

**Graph features.** Fraud rings share infrastructure. Build a bipartite graph of entities (cards, devices, emails, phones, IPs, shipping addresses) connected by co-occurrence in transactions. Features: \`cards_per_device_30d\`, \`devices_per_card_30d\`, \`account_degree\`, \`connected_component_size\`, \`fraud_rate_in_2hop_neighbourhood\`. These are heavier: computed in batch (Spark GraphFrames nightly) for stable structure, with light incremental updates (increment \`device -> set of cards\` in Redis) for the last day. Some teams run a graph database (Neo4j, TigerGraph) for analyst investigation, but the online path reads precomputed numbers, never traverses a graph at request time.

**Feature hygiene.** Null handling (a first-time card has no velocity; encode "new" explicitly rather than 0), consistent time zones, and a monitored null rate per feature in production, because a feature silently going null is the most common cause of a model quietly degrading.`,
      mentalModel:
        'Judging a stranger at your door. Their appearance (attributes) says little. Knowing they have knocked on eight doors in this street in ten minutes (velocity) says more. Knowing that their van is registered to three known burglars (graph) settles it.',
      diagram: `Redis bucketed counter for txn_count_card_1h (60 x 1-min buckets)

key: card:4111...:1m           HINCRBY <minute-of-day> 1
+------+------+------+---- ... ----+------+
| 1402 | 1403 | 1404 |             | 1461 |   EXPIRE 3660s
|  2   |  0   |  5   |             |  1   |
+------+------+------+---- ... ----+------+
   \\_____________ HGETALL, sum buckets in window _____________/

graph (batch, nightly Spark + incremental Redis sets):
 device:D7 -> {card A, card B, ... 40 cards}   cards_per_device = 40`,
      keyPoints: [
        'Three feature classes: stateless attributes, windowed velocity counters, graph relationships.',
        'Velocity is precomputed incrementally: Redis bucketed hashes or sorted sets, or Flink windowed state.',
        'Distinct counts over big windows use HyperLogLog to bound memory.',
        'Graph features are computed in batch nightly with light incremental updates; never traverse a graph inline.',
        'Encode "new entity" explicitly and monitor per-feature null rates in production.',
      ],
      checkpoint: {
        question:
          'You need distinct_cards_per_ip_7d for 50 million IPs. Why is a Redis sorted set per IP the wrong choice, and what would you use?',
        answer:
          'A sorted set stores every event in the 7-day window; a busy NAT IP could hold millions of entries, and 50M keys of variable size is unbounded memory. Use a HyperLogLog per IP per day (PFADD, 12 KB fixed) and PFMERGE 7 daily sketches on read, or let Flink maintain the distinct-count state and emit the number.',
      },
    },
    {
      id: 'streaming-pipeline-and-feature-store',
      title: 'The Kafka + Flink pipeline and the feature store',
      body: `Velocity and graph features are produced by a streaming pipeline and consumed by the scorer through a feature store. Getting this plumbing right is most of the engineering.

**Event flow.** The payment service publishes every transaction attempt (and its outcome: authorised, declined, failed) to a Kafka topic \`transactions\`, partitioned by card_id so all events for a card land on one partition in order. Retention 7 days on the hot topic; a connector (Kafka Connect S3 sink, or Flink itself) writes the same events as Parquet to the data lake for permanent history.

**Flink job.** Consumes \`transactions\`, keys by card, device, IP, account (multiple keyBy branches), maintains sliding-window aggregates in RocksDB-backed keyed state, and on every update writes the new feature values to Redis (\`HSET features:card:{id} txn_count_10m 6 txn_sum_1h 23400 ...\`). Checkpointing every 10-30 seconds to S3 gives exactly-once state; on failure the job restores and replays from the checkpointed Kafka offsets. Event-time processing with watermarks handles out-of-order arrival from retried producers.

**Why not compute in the scorer itself?** The scorer would need to read the previous state, update it, and write it back on every request, racing with itself across replicas. A stream processor serialises updates per key and owns the state; the scorer becomes a pure reader.

**Feature store.** Two halves sharing one feature registry:
- **Online store**: Redis (or DynamoDB, Cassandra) holding the latest value of each feature per entity, read by the scorer with a handful of parallel MGET/HGETALL calls in 1-3 ms. Memory: 300M cards x 20 features x ~16 bytes = ~100 GB, sharded across a Redis Cluster.
- **Offline store**: Parquet tables in S3/Hive/BigQuery holding every feature value **with the timestamp it became valid**, used to build training sets.

The registry (Feast, Tecton, or in-house) defines each feature once (name, entity, window, aggregation, source) and generates both the Flink computation and the offline backfill. This is the defence against **training-serving skew**: if the training pipeline computes \`txn_count_10m\` with SQL and the online path computes it with Redis buckets, they will disagree in edge cases and the model will underperform in production for reasons nobody can see.

**Point-in-time joins.** When building a training row for a transaction at 14:03:07, every feature must be the value that was available at 14:03:07, not the end-of-day value that already includes the fraudulent transactions that followed. The offline store keeps feature history so the join is \`feature_ts <= txn_ts\`, latest. Getting this wrong leaks the label into the features and yields a model that scores 0.99 AUC offline and fails online.

**Freshness.** End-to-end from a transaction hitting Kafka to its effect visible in Redis is typically 100-500 ms. This means the second transaction of a burst may not see the first; the scorer can compensate by also incrementing a short-lived "in-flight" counter synchronously for the most critical 1-minute windows.`,
      mentalModel:
        'A stock ticker board. Traders (scorers) glance at the board (online store) and act instantly; they never recompute prices. Behind the wall, a team (Flink) updates the board as trades stream in (Kafka), and a clerk files every price change with its timestamp in a ledger (offline store) so historians can reconstruct what the board showed at any moment.',
      diagram: `Payment svc --> Kafka topic "transactions" (partition by card_id)
                    |                       |
                    v                       v
            +--------------+       Kafka Connect S3 sink
            | Flink job    |               |
            | keyBy card / |               v
            | device / ip  |       Data lake (Parquet, feature history)
            | sliding win  |               |
            | RocksDB state|        offline features -> training sets
            +------+-------+        (point-in-time joins)
                   |
                   v
            Redis Cluster (online features)  <---- scorer MGET (1-3 ms)`,
      keyPoints: [
        'Kafka partitioned by entity key gives per-key ordering; Flink owns windowed state and writes features to Redis.',
        'Checkpoints to S3 plus offset replay give exactly-once feature state after failures.',
        'Feature store = online (Redis, latest value) + offline (Parquet, full history) from one registry.',
        'Point-in-time joins prevent label leakage; training-serving skew comes from computing features two different ways.',
        'Freshness is 100-500 ms; compensate for the most critical windows with a synchronous in-flight counter.',
      ],
    },
    {
      id: 'latency-budget-and-serving',
      title: 'The scoring service and its 100 ms budget',
      body: `The scoring service is a stateless gRPC/HTTP service called by the payment orchestrator. Everything about it is designed around a p99 of 100 ms, and the budget is allocated explicitly.

**Budget allocation (target p99)**
- Network hop in and out: 5 ms
- Auth, parse, compute stateless attributes: 3 ms
- Feature fetch: 10 ms. About 50 features across 4 entities means 4 parallel HGETALL calls to Redis (one per entity hash) plus one to the graph feature hash. Parallel, not sequential; a sequential chain of 5 x 2 ms would be 10 ms at p50 and 40 ms at p99.
- Hard rules: 1 ms (in-memory evaluation of a few hundred compiled rules).
- Model inference: 5-20 ms. GBM in-process via the native library, or a co-located model server (Triton, TorchServe) over localhost. Avoid a network hop to a remote model service if you can; each hop adds tail latency.
- Soft rules, decision, reason codes: 2 ms
- Async write of the decision to Kafka (fire-and-forget): under 1 ms
- **Sum: ~40 ms**, leaving 60 ms headroom for GC pauses, Redis tail latency and retries.

**Tail latency techniques**
- **Hedged requests** to Redis: if a read has not returned in 5 ms, issue it to a replica and take the first response.
- **Timeouts per stage** with fallback: if features are not back in 15 ms, score with attributes-only features and flag the decision as degraded.
- **Warm model in memory**, no lazy loading; load new model versions in a background thread and atomically swap the pointer.
- **Connection pooling** and keep-alive to Redis; avoid TLS handshakes per request.
- **CPU pinning and no GC storms**: for JVM services, use ZGC/Shenandoah or size the heap so young collections stay under 5 ms; Go and Rust services have an easier time here.

**Horizontal scale.** A single instance handles 500-1,000 scores/sec with the model in-process; 3,000 TPS peak with 2x headroom is 8-12 instances behind a load balancer, spread across availability zones.

**Model deployment.** Version every model artefact; deploy as shadow first (score every transaction, log the score, take no action) for a week; compare precision/recall on incoming labels and score distribution against the champion; then canary at 5% of traffic; then promote. Keep the previous version loaded for instant rollback.

**Decision logging.** Every decision (features used, model version, rules fired, score, outcome) goes to a Kafka topic \`decisions\`, sunk to the lake. This is the audit trail and, joined later with labels, the training set.`,
      mentalModel:
        'A Formula 1 pit stop. Every task has an allocated fraction of a second, they run in parallel where possible, and the crew practises the failure case (a stuck wheel nut) so the car still leaves the pit on time.',
      diagram: `t=0ms  request in
 |--3ms--| parse + stateless attrs
         |------10ms------| parallel Redis HGETALL x5 (features)
                           |-1ms-| hard rules
                                 |------15ms------| GBM inference
                                                   |-2ms-| decision
                                                         | async log
t~35ms response out                    p99 budget 100ms, headroom ~60ms`,
      keyPoints: [
        'Allocate the latency budget stage by stage and measure each stage in production.',
        'Fetch features in parallel; co-locate the model with the scorer to avoid extra network hops.',
        'Use per-stage timeouts with degraded fallbacks and hedged reads for tail latency.',
        'Shadow -> canary -> promote for models; keep the previous version hot for rollback.',
        'Log every decision with features and versions to Kafka for audit and training.',
      ],
      checkpoint: {
        question:
          'Your Redis p99 is 4 ms but the feature-fetch stage p99 is 18 ms. What is the most likely cause?',
        answer:
          'The five feature reads are being issued sequentially, so their tails add up (and a slow one blocks the rest). Issue them concurrently (pipeline or parallel futures) so the stage p99 approaches the max of the five, roughly 4-6 ms, not the sum.',
      },
    },
    {
      id: 'review-queue-and-feedback',
      title: 'Review queue, labels, and the feedback loop',
      body: `Not every decision is confidently allow or block. The middle band, perhaps 1-3% of transactions, goes to **review**. This is where the system converts a hard inline decision into a softer, delayed one, and where labels for training are born.

**Step-up challenge (automated review).** Instead of declining, ask for more evidence: OTP to the registered phone, 3-D Secure redirect to the issuer, biometric confirmation in the app. Legitimate customers pass in seconds; fraudsters with a stolen card number usually fail or abandon. Step-up moves the cost from "lost sale" to "slight friction" and produces an immediate weak label (passed / failed).

**Manual review.** Higher-value or ambiguous cases are placed on a review queue (Kafka topic or SQS -> Postgres \`review_cases\` table) with all features, model explanation and the customer's history. Analysts in a case-management UI approve or reject, typically within minutes to hours. For card payments this often means authorising with a hold and capturing later; for account actions it means a temporary freeze. Queue design: priority by amount and score, SLA timers, assignment to prevent two analysts working one case (\`SELECT ... FOR UPDATE SKIP LOCKED\`), and auto-release when the SLA expires (default allow or block per policy).

**Where labels come from, and how late they are**
- **Analyst decisions**: hours; high quality, small volume, biased toward the review band.
- **Step-up outcomes**: seconds; noisy (people fail OTPs innocently).
- **Chargebacks and disputes**: 30-90 days after the transaction; the gold standard for card fraud but very late and incomplete (many victims never dispute small amounts).
- **Confirmed good**: transactions settled and undisputed after the dispute window; the negative class.
- **Customer reports**: "I did not make this purchase" via support.

Because chargebacks lag, the training set for a model trained today covers transactions from 3 months ago; the freshest fraud is only visible through rules and analyst labels. This is why rules exist and why analyst-labelled cases are weighted heavily.

**Label pipeline.** A \`labels\` topic joins each transaction_id with its eventual outcome and source. A nightly Spark job joins \`decisions\` (features as seen at decision time) with \`labels\` to produce point-in-time correct training rows. Retraining weekly or when drift is detected; evaluation on a time-based holdout (train on months 1-3, test on month 4), never a random split, because random splits leak future patterns into training.

**Selection bias.** You only observe chargebacks on transactions you allowed. Blocked transactions have no ground truth. Over time the model is trained only on what the previous model let through. Mitigations: allow a small random exploration sample (0.1-0.5%) of would-be blocks in low-amount segments to obtain unbiased labels, and treat analyst decisions on reviewed blocks as labels.

**False positive versus false negative cost.** A false negative costs roughly the transaction amount plus a chargeback fee (USD 15-25) plus potential scheme penalties if your chargeback ratio exceeds ~1%. A false positive costs the margin on the sale (2-5% of amount) plus, crucially, the lifetime value of a customer who leaves after being declined; studies put the revenue lost to false declines at several times the losses to actual fraud. The decision threshold therefore minimises **expected cost**, not error rate: \`block if p(fraud) x FN_cost > (1 - p(fraud)) x FP_cost\`, which varies per segment (new versus loyal customer, amount band). This is exactly why thresholds live in the rules layer.`,
      mentalModel:
        'A bank teller with a supervisor in the back office. Clear cases are handled at the counter; the unsure ones get "let me check with my manager" (review). Every manager decision is written in a logbook that trains the next generation of tellers, but the logbook only contains cases that reached the counter.',
      diagram: `decision = REVIEW
    |
    +--> step-up (OTP / 3DS) --pass/fail--> label (seconds)
    |
    +--> review queue (Kafka -> Postgres review_cases)
              | analyst UI, SKIP LOCKED assignment, SLA timer
              v
         approve / reject -----------------------> label (hours)

allowed txns --> settlement --> dispute window --> chargeback / good
                                                   label (30-90 days)
                                                        |
        decisions (features@t) JOIN labels  -->  training set (nightly)
                                                        |
                                              retrain -> shadow -> canary`,
      keyPoints: [
        'Review band (1-3%) is resolved by step-up challenges or an analyst queue; both generate labels.',
        'Labels arrive at different lags and qualities: seconds (step-up), hours (analysts), months (chargebacks).',
        'Training joins decision-time features with eventual labels; use time-based holdouts.',
        'Selection bias: you only see outcomes for what you allowed; use small exploration samples.',
        'Set thresholds by expected cost; false declines often cost more than fraud itself.',
      ],
      checkpoint: {
        question:
          'Your model has 99.8% accuracy on the training set. Why is this number almost meaningless for fraud detection?',
        answer:
          'Fraud is perhaps 0.1-0.5% of transactions, so a model that predicts "legitimate" for everything is already 99.5%+ accurate. What matters is precision and recall at the operating threshold (or the precision-recall curve), and ultimately expected cost per segment.',
      },
    },
    {
      id: 'failure-modes-and-degradation',
      title: 'Failure modes: never let fraud checks hang checkout',
      body: `Because the scorer sits inline, its failures are payment failures. The design must specify, in advance and per segment, what happens when each dependency misbehaves.

**Scorer timeout or outage.** The payment orchestrator must have a hard client-side timeout (say 150 ms) and a fallback policy. Common policy: **fail open for low-risk segments** (small amounts, returning customers with history: allow with a "degraded" flag) and **fail to step-up or fail closed for high-risk segments** (large amounts, new accounts). Whichever you choose, the choice is deliberate and monitored: the fraction of degraded decisions is a top-line alert.

**Feature store unavailable.** Score with stateless attributes and rules only. The model expects all features; either train a companion attributes-only model for this case or impute velocity features with a "missing" indicator the model has seen during training (simulate outages in training data by randomly nulling features). Never impute with 0: zero velocity looks like a perfectly safe first transaction.

**Stale features.** If Flink lags (consumer lag on Kafka rising), velocity counters undercount and fraud bursts look calm. Monitor consumer lag and the age of the latest feature write; when lag exceeds a threshold, tighten rule thresholds automatically or route more to step-up.

**Model server failure.** Hot fallback to the previous model version in-process; if no model is loadable, rules-only mode.

**Kafka unavailable.** The scorer must not block on logging decisions; buffer locally and drop with a metric if the buffer fills. Payment publishing to the transactions topic should also be asynchronous with a local retry buffer.

**Bad rule deployment.** An analyst deploys \`amount > 0 -> block\`. Guardrails: dry-run every rule change against the last hour of traffic and show the projected block rate before activation; cap the block rate any single rule can produce; one-click rollback; rules versioned in git with review for high-impact rules.

**Model drift.** Score distribution shifts, feature distributions shift (a new app version changes device fingerprint format), or fraud adapts. Monitor population stability index per feature and per score bucket, null rates, and precision on the trickle of fast labels (step-up, analyst). Retrain on schedule and on drift alarms.

**Adversarial adaptation.** Fraudsters probe: small test transactions to find thresholds, distributing attempts across many cards and IPs to stay under velocity limits. Graph features and cross-entity velocity (per device rather than per card) exist precisely to catch distributed attacks; randomised thresholds and step-up for borderline cases make probing expensive.

**Consistency and replay.** Decisions are logged with the exact feature values and model version, so any decision can be replayed and explained months later to a regulator or a customer. This also lets you backtest a rule or model against real history before deploying.`,
      mentalModel:
        'A smoke detector wired to the building\'s front door lock. If the detector loses power you must decide in advance whether the door stays locked (fail closed) or opens (fail open), because a detector that jams the door shut on a false alarm evacuates nobody and a detector that silently dies protects nobody.',
      keyPoints: [
        'Client-side timeout plus per-segment fallback: fail open for low risk, step-up or fail closed for high risk.',
        'Feature outages: attributes-only model or explicit missing indicators; never impute velocity as zero.',
        'Monitor Kafka consumer lag and feature freshness; tighten thresholds automatically when stale.',
        'Guardrail rule deployments with dry-runs, block-rate caps and instant rollback.',
        'Log features and versions with every decision for replay, explanation and backtesting.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What is a velocity feature in fraud detection?',
      options: [
        'The network speed between the scorer and the payment gateway',
        'A count or sum of events for an entity (card, IP, device) over a recent time window',
        'The model inference time in milliseconds',
        'The rate at which analysts clear the review queue',
      ],
      answerIndex: 1,
      explanation:
        'Velocity features such as txn_count_card_10m or txn_sum_ip_1h capture how fast an entity is acting. They are the strongest single signal for card testing and account takeover. The other options describe system metrics, not model features.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'Why do production fraud systems run a rules engine in addition to an ML model?',
      options: [
        'Rules are more accurate than models',
        'Rules encode hard policy and can be deployed in minutes to stop new attacks, while the model needs labels that arrive weeks later',
        'Models cannot run within 100 ms',
        'Rules are required to compute features',
      ],
      answerIndex: 1,
      explanation:
        'Rules give instant, explainable, auditable control and handle blocklists and regulatory limits. Models generalise better but can only learn from labelled history, which lags by weeks because chargebacks are slow. Neither replaces the other.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Why are velocity counters maintained by a stream processor (Flink) writing to Redis rather than computed by the scorer with database queries?',
      options: [
        'Databases cannot store timestamps',
        'Range-scan queries per feature per request would be ~150k scans/sec and blow the latency budget; incremental state gives O(1) reads',
        'Redis is the only store that supports counters',
        'Flink is required by PCI DSS',
      ],
      answerIndex: 1,
      explanation:
        'At 3,000 TPS with ~50 features, computing windows on demand means hundreds of thousands of range scans per second on a hot table. A stream processor updates the aggregates incrementally so the scorer performs a few O(1) hash reads.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which statements about a feature store are correct? Select all that apply.',
      options: [
        'The online store holds the latest feature value per entity for low-latency reads',
        'The offline store holds feature history with timestamps for building training sets',
        'Online and offline features may be computed with different code as long as the names match',
        'A shared registry defining each feature once prevents training-serving skew',
        'Point-in-time joins ensure training rows use only feature values available at transaction time',
      ],
      answerIndices: [0, 1, 3, 4],
      explanation:
        'The online/offline split, single registry and point-in-time joins are the defining properties. Computing the same feature with different code paths is exactly what causes training-serving skew, so option three is wrong.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement:
        'When the feature store is unavailable, imputing all velocity features as 0 is a safe fallback because it is the value a new card would have.',
      answer: false,
      explanation:
        'Zero velocity is what a calm, legitimate first transaction looks like, so imputing zeros makes every transaction during the outage look safe. Use an explicit "missing" indicator the model has seen in training, or an attributes-only fallback model, and flag decisions as degraded.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A model achieves 0.99 AUC offline but performs poorly in production. Investigation shows training rows used end-of-day feature values. What is this problem called?',
      options: [
        'Training-serving skew caused by different feature code paths',
        'Label leakage from violating point-in-time correctness: features included information from after the transaction',
        'Class imbalance',
        'Model drift',
      ],
      answerIndex: 1,
      explanation:
        'End-of-day velocity counts include the fraudulent burst that followed the transaction, so the model effectively saw the future. Offline metrics look superb and online results collapse. Point-in-time joins (feature_ts <= txn_ts) fix it. Skew is a related but distinct problem about computation differences.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question:
        'Which decision threshold policy is most appropriate for fraud detection?',
      options: [
        'Block when p(fraud) > 0.5, since that is the Bayes-optimal accuracy threshold',
        'Block when expected cost of allowing exceeds expected cost of blocking, with costs varying by segment (amount, customer tenure)',
        'Block the top 1% of scores each day to keep the block rate constant',
        'Never block; always route to review to avoid false positives',
      ],
      answerIndex: 1,
      explanation:
        'A false negative costs the amount plus fees; a false positive costs margin plus customer lifetime value. Minimising expected cost per segment is the business-correct objective. 0.5 optimises accuracy, which is meaningless with 0.3% fraud prevalence. Fixed block rates ignore actual risk, and reviewing everything is not affordable.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 3,
      statement:
        'Because chargebacks are the most reliable fraud label, a model trained only on chargeback labels will reflect current fraud patterns.',
      answer: false,
      explanation:
        'Chargebacks arrive 30-90 days late, so chargeback-only training data is at least a quarter stale, and it only covers transactions that were allowed (selection bias). Analyst labels, step-up outcomes and exploration samples are needed for freshness and coverage.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 2,
      question: 'What is the safest way to introduce a newly trained fraud model into production?',
      options: [
        'Replace the old model at midnight when traffic is low',
        'Run it in shadow mode (score, log, do not act), compare against the champion on incoming labels, then canary a small percentage, then promote with the old model kept hot for rollback',
        'Deploy to 100% and watch the chargeback rate over the next quarter',
        'Ask analysts to manually re-score a sample of transactions',
      ],
      answerIndex: 1,
      explanation:
        'Shadow scoring gives a production comparison at zero customer risk; canary limits blast radius; a hot previous version enables instant rollback. Waiting a quarter for chargebacks is far too slow to catch a bad model.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'How should graph features such as cards_per_device be served in the 100 ms scoring path?',
      options: [
        'Run a breadth-first traversal in a graph database per request',
        'Precompute in nightly batch (Spark) with light incremental updates in Redis, and read the resulting numbers as ordinary features',
        'Ask the analyst review queue to compute them on demand',
        'Skip graph features; they are only for investigation',
      ],
      answerIndex: 1,
      explanation:
        'Graph traversal at request time is far too slow and variable. Batch computation of structural features plus incremental set updates for the last day keeps them fresh enough while the online read is an O(1) lookup. Graph databases are useful for analyst investigation, not the inline path.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Allocate a 100 ms p99 latency budget for a fraud scoring request across its stages and name two techniques that keep tail latency in check.',
      modelAnswer: `**Budget (p99 targets):** network in/out 5 ms; parse and stateless attributes 3 ms; feature fetch 10 ms (4-5 parallel Redis HGETALLs, one per entity); hard rules 1 ms; model inference 5-20 ms (in-process GBM or localhost model server); soft rules and decision 2 ms; async decision log under 1 ms. Total about 35-40 ms, leaving ~60 ms headroom.

**Tail techniques:** parallel rather than sequential feature reads; hedged Redis reads (retry to a replica after 5 ms); per-stage timeouts with degraded fallback (attributes-only scoring if features exceed 15 ms); co-locating the model to avoid a network hop; keeping models warm and swapping versions atomically; GC tuning or a non-GC runtime; connection pooling.`,
      rubric: [
        'Lists stages with plausible millisecond allocations summing well under 100 ms.',
        'Explains that feature reads must be parallel.',
        'Names at least two tail-latency techniques (hedging, timeouts with fallback, co-location, warm models).',
        'Leaves explicit headroom.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Describe the Kafka + Flink pipeline that keeps velocity features fresh, including how it recovers from a Flink job crash.',
      modelAnswer: `The payment service publishes each transaction event to a Kafka topic partitioned by card_id (per-key ordering). A Flink job consumes it, keys the stream by card, device, IP and account, and maintains sliding-window aggregates (counts, sums, HyperLogLog distinct counts) in RocksDB-backed keyed state using event time and watermarks. On each update it writes the new feature values to Redis hashes read by the scorer. A Kafka Connect sink (or Flink) also lands the events as Parquet in S3 for the offline store.

Flink checkpoints state and Kafka offsets to S3 every 10-30 seconds. If the job crashes, it restarts from the last checkpoint and replays events from the checkpointed offsets, producing exactly-once state; Redis writes are idempotent (set to the recomputed value) so replay is safe. Consumer lag is monitored; while the job catches up, features are stale and the scorer should tighten thresholds or route more to step-up.`,
      rubric: [
        'Kafka partitioned by entity key for ordering.',
        'Flink keyed state with sliding windows writing to Redis.',
        'Checkpointing plus offset replay for recovery.',
        'Mentions the offline copy in the lake and/or lag monitoring.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question:
        'Explain selection bias in fraud training data and two ways to mitigate it.',
      modelAnswer: `Ground-truth labels (chargebacks, confirmed-good settlement) only exist for transactions that were **allowed**. Blocked transactions never settle, so you never learn whether the block was right. The next model is trained only on what the previous model let through, so it inherits the previous model\'s blind spots and can never discover that some blocked segment was actually legitimate (or that fraud it blocks has changed shape).

Mitigations: (1) **exploration sampling**: allow a small random fraction (0.1-0.5%) of would-be blocks in low-amount, low-harm segments to collect unbiased outcomes; (2) **use analyst decisions** on reviewed and blocked cases as labels, since analysts can inspect blocked transactions; (3) **step-up challenges** instead of hard blocks in the borderline band, which yield an outcome for cases that would otherwise be unlabelled; (4) reweighting techniques (inverse propensity) when estimating true fraud rates from the biased sample.`,
      rubric: [
        'States that labels exist only for allowed transactions.',
        'Explains the feedback consequence for successive models.',
        'Gives at least two mitigations (exploration sample, analyst labels, step-up, reweighting).',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Three outcomes of a fraud decision', back: 'Allow, block, or review (step-up challenge such as OTP/3DS, or manual analyst queue). Review converts a hard inline decision into a delayed one.' },
    { id: 'f2', front: 'Why rules AND a model', back: 'Rules: deterministic, explainable, deployable in minutes, encode hard policy. Model: learns complex interactions, adapts on retraining, but needs late labels. Order: hard rules -> model -> soft rules/thresholds.' },
    { id: 'f3', front: 'Velocity feature', back: 'Count or sum per entity per sliding window, e.g. txn_count_card_10m, distinct_cards_ip_24h. Maintained incrementally, read O(1) from Redis.' },
    { id: 'f4', front: 'Redis bucketed counter pattern', back: 'Hash per entity with one field per minute (HINCRBY), EXPIRE slightly past the window, sum fields on read. Bounded memory, approximate to bucket size.' },
    { id: 'f5', front: 'Distinct counts over long windows', back: 'Use HyperLogLog (PFADD, ~12 KB fixed per sketch), one per day, PFMERGE on read; or let Flink hold the distinct-count state.' },
    { id: 'f6', front: 'Graph features', back: 'cards_per_device, devices_per_card, connected component size, fraud rate in 2-hop neighbourhood. Batch nightly (Spark) plus incremental Redis sets; never traverse inline.' },
    { id: 'f7', front: 'Feature store: online vs offline', back: 'Online: Redis/DynamoDB, latest value, 1-3 ms reads. Offline: Parquet in S3/BigQuery with full timestamped history for training. One registry defines each feature once.' },
    { id: 'f8', front: 'Training-serving skew', back: 'Online and offline pipelines compute the "same" feature differently, so the model sees different distributions in production than in training. Prevented by a shared feature definition.' },
    { id: 'f9', front: 'Point-in-time correctness', back: 'Training rows must use feature values as of the transaction timestamp (feature_ts <= txn_ts). Using later values leaks the label and inflates offline metrics.' },
    { id: 'f10', front: 'Kafka + Flink role', back: 'Kafka topic partitioned by card_id carries transactions; Flink keyed sliding windows compute aggregates in RocksDB state, write to Redis; checkpoints to S3 + offset replay give exactly-once recovery.' },
    { id: 'f11', front: 'Latency budget sketch for 100 ms p99', back: 'Network 5, parse 3, parallel feature fetch 10, hard rules 1, model 5-20, decision 2, async log <1 = ~40 ms; ~60 ms headroom.' },
    { id: 'f12', front: 'Tail latency techniques', back: 'Parallel feature reads, hedged requests to replicas, per-stage timeouts with degraded fallback, co-located model, warm models with atomic swap, GC tuning.' },
    { id: 'f13', front: 'Label sources and lag', back: 'Step-up outcome: seconds (noisy). Analyst decision: hours (high quality). Chargeback: 30-90 days (gold but late, incomplete). Confirmed good: after dispute window.' },
    { id: 'f14', front: 'Selection bias in fraud labels', back: 'Outcomes exist only for allowed transactions. Mitigate with small exploration samples of would-be blocks, analyst labels on blocks, step-up instead of hard block.' },
    { id: 'f15', front: 'FP vs FN cost', back: 'FN: amount + chargeback fee (USD 15-25) + scheme penalties above ~1% ratio. FP: lost margin + customer lifetime value. Threshold = minimise expected cost per segment.' },
    { id: 'f16', front: 'Model rollout', back: 'Shadow (score, log, no action) -> compare with champion on fresh labels -> canary 5% -> promote; keep previous version loaded for instant rollback.' },
    { id: 'f17', front: 'Degradation policy when scorer is down', back: 'Client timeout ~150 ms; fail open (allow, degraded flag) for low amount/tenured customers; step-up or fail closed for high risk. Never let checkout hang.' },
    { id: 'f18', front: 'Rule deployment guardrails', back: 'Dry-run against last hour of traffic to show projected block rate, cap per-rule block rate, version in git, one-click rollback.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Why velocity features need a streaming pipeline',
      prompt: 'Explain to a backend developer why the fraud scorer reads precomputed counters from Redis instead of querying the transactions table, and how those counters stay up to date.',
      modelExplanation: `Imagine a bouncer who, for every person at the door, had to walk through the whole club counting how many times that face had come in tonight. The line would stretch around the block. Instead, a colleague inside keeps a tally sheet per face and hands the bouncer a number.

The scorer is the bouncer. It has about 100 milliseconds and needs fifty numbers like "transactions on this card in the last 10 minutes". Running fifty range queries on a table receiving thousands of writes a second would take far longer and hammer the database.

So every transaction is published to Kafka, and a Flink job consumes the stream, keeps a running window per card, device and IP in its own state, and writes the current counts to Redis. The scorer just reads a hash per entity in a millisecond or two. Flink checkpoints its state so a crash replays from the last checkpoint and the counts come back exact. The same events land in the data lake so the training pipeline can recompute identical numbers for history.`,
      mustMention: [
        'Latency budget makes on-demand range queries infeasible',
        'Kafka carries events, Flink maintains windowed state, Redis serves reads',
        'Checkpoint and replay for recovery',
        'Same events feed offline training features',
      ],
    },
    {
      id: 'fe2',
      concept: 'Point-in-time correctness and label leakage',
      prompt: 'Explain why a fraud model can look brilliant offline and fail in production if training features are computed carelessly.',
      modelExplanation: `Suppose a stolen card is used ten times in five minutes. When we later build a training row for the first of those ten transactions, we want to know what the system knew at that moment: one transaction so far, calm velocity. If instead we look up the card\'s velocity from the end of the day, we see ten transactions, a screaming red flag.

A model trained on end-of-day values learns "high velocity means fraud" perfectly and scores 0.99 AUC. But in production, at the moment of the first transaction, the velocity really is one, and the model has no idea. It learned from the future, which is called label leakage.

The fix is a point-in-time join: the offline feature store keeps every feature value with the time it became valid, and training rows take the latest value with a timestamp at or before the transaction. The same discipline explains why we evaluate on a time-based holdout rather than a random split: the future must stay in the future.`,
      mustMention: [
        'Features must reflect what was known at transaction time',
        'Using later values leaks the label',
        'Offline store keeps timestamped history; join on feature_ts <= txn_ts',
        'Time-based evaluation split',
      ],
    },
    {
      id: 'fe3',
      concept: 'Choosing the block threshold',
      prompt: 'Explain to a product manager how the fraud team decides where to set the block threshold, and why it is not an accuracy question.',
      modelExplanation: `Only a few transactions in a thousand are fraud, so a system that approves everything is already over 99% "accurate". Accuracy tells us nothing. What matters is what each mistake costs.

If we approve a fraudulent purchase, we lose the amount, pay a chargeback fee of around 15 to 25 dollars, and if our chargeback ratio climbs above about one percent the card networks fine us. If we decline a genuine customer, we lose the margin on that sale and, worse, we may lose the customer forever; several studies find that false declines cost merchants more than fraud does.

So for each transaction the model gives a probability, and we block only when probability times the cost of fraud exceeds the remaining probability times the cost of a false decline. Those costs differ by segment: a first-time buyer on a 40,000 rupee phone is treated differently from a five-year customer buying groceries. That is why the thresholds live in the rules layer where the business can adjust them, and why the middle band goes to a step-up challenge instead of a hard no.`,
      mustMention: [
        'Class imbalance makes accuracy meaningless',
        'False negative cost: amount, fees, penalties',
        'False positive cost: margin and customer lifetime value',
        'Threshold minimises expected cost and varies by segment',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through an airport security hall from the check-in desks to the boarding gate. Each station anchors one part of the fraud detection design.',
    stops: [
      { locus: 'The departures board flickering above check-in', concept: 'Kafka event stream', image: 'Every transaction is a flight announcement scrolling across the board in strict order per airline (partition by card). A printer beside it spits every line onto paper tape that rolls into a vault (the data lake).' },
      { locus: 'The clerks behind the board with tally counters', concept: 'Flink windowed aggregates', image: 'A row of clerks each click a hand counter every time their assigned card or device appears, resetting sliding ten-minute and one-hour dials. Every thirty seconds they photograph their counters (checkpoint) so a fainting clerk can be replaced mid-count.' },
      { locus: 'The wall of lockers with glowing numbers', concept: 'Online feature store in Redis', image: 'Thousands of small lockers, one per card, each with a digital display showing "6 in 10 min, 23,400 in 1 h". Officers glance at five lockers at once (parallel HGETALL) and read them in a blink.' },
      { locus: 'The string web on the corkboard', concept: 'Graph features', image: 'A detective\'s corkboard where a single phone (device) is connected by red string to forty passports (cards). A label reads cards_per_device = 40. The board is rebuilt every night; new strings are pinned during the day.' },
      { locus: 'The laminated checklist at the first gate', concept: 'Hard rules engine', image: 'A guard flips a laminated card: NO-FLY LIST, AMOUNT OVER LIMIT, SANCTIONED COUNTRY. One match and the barrier slams shut before anyone reaches the scanner. New lines are added with a marker in minutes.' },
      { locus: 'The body scanner with a stopwatch', concept: 'ML model within the latency budget', image: 'A scanner hums for exactly five milliseconds and prints a risk number from 0 to 1. Above it a giant stopwatch shows 100 ms; every stage of the queue has a painted time allocation on the floor, and a spare scanner (previous model) stands ready with its plug in.' },
      { locus: 'The secondary screening room', concept: 'Review queue and step-up', image: 'Borderline passengers are asked one question (OTP) at a side desk or seated in a numbered waiting room with an SLA clock. Each seat can be claimed by only one officer at a time (SKIP LOCKED).' },
      { locus: 'The mailroom with a 90-day calendar', concept: 'Late labels and feedback loop', image: 'Letters marked CHARGEBACK arrive three months after flights departed and are filed against old boarding passes. A clerk staples them to the original scanner printout (features at decision time) to train next month\'s scanner.' },
      { locus: 'The emergency panel by the boarding gate', concept: 'Degradation policy', image: 'A red panel with two switches labelled FAIL OPEN (small bags) and FAIL CLOSED (big bags). A sign reads: the gate never jams; if the scanner dies, flip the switch you decided on in advance.' },
    ],
  },
  designPractice: {
    problem:
      'Design a real-time fraud detection system for a payment processor handling 3,000 transactions per second at peak. Each transaction must be scored inline in under 100 ms (p99) as allow, block, or review, using analyst-authored rules and an ML model over transaction, velocity and graph features. Support a manual review queue and a feedback loop that produces labels for retraining.',
    steps: [
      {
        title: 'Functional requirements',
        prompt: 'List what the system must do for the payment service, for fraud analysts, and for the data science team. Decide the decision outcomes and what "review" means.',
        reference: `**For the payment service**
- Synchronous \`score(transaction)\` returning decision (allow / block / review), risk score, reason codes, and decision id.
- Idempotent scoring by transaction id (retries return the same decision).

**For fraud analysts**
- Author, test (dry-run), version, activate and roll back rules without a code deploy.
- Manage blocklists/allowlists (cards, devices, emails, IPs, merchants).
- Work a review queue: see the transaction, features, explanation, customer history; approve or reject; SLA timers.
- Investigate entities and their graph neighbourhood.

**For data science**
- Access to decision logs with features as seen at decision time, joined to labels.
- Deploy models in shadow, canary, and champion modes; roll back.
- Monitor feature drift, null rates, score distributions, precision/recall on fresh labels.

**Decision semantics**
- Allow: proceed with authorisation.
- Block: decline with a customer-safe reason code; log full reason internally.
- Review: either step-up (OTP/3DS) decided automatically, or hold for analyst with authorise-now-capture-later where the payment rails permit.

**Out of scope:** dispute/chargeback processing workflow, AML reporting, merchant onboarding risk.`,
      },
      {
        title: 'Non-functional requirements & estimation',
        prompt: 'State latency, availability, throughput, freshness and explainability targets. Estimate feature reads/sec, counter updates/sec, online store size, and daily event volume.',
        reference: `**Targets**
- Latency: p50 under 30 ms, p99 under 100 ms for \`score\`; client timeout 150 ms.
- Availability: 99.99% (52 min/year). Degraded mode counts as available if a decision is returned.
- Throughput: 3,000 TPS peak, plan capacity for 6,000.
- Feature freshness: velocity features reflect events within 500 ms; graph features within 24 h (structural) and 1 h (incremental).
- Explainability: every decision reproducible with stored features, model version and rules fired; retained 7 years for compliance.
- Rule deployment time: under 5 minutes from authoring to active.
- Model retraining cadence: weekly, or on drift alarm.

**Estimation**
- Transactions: 3,000/s peak, ~100M/day.
- Feature reads: ~50 features grouped in 5 entity hashes -> 15,000 Redis HGETALL/s at peak; each ~1 KB -> 15 MB/s.
- Counter updates: ~20 aggregates per transaction -> 60,000 writes/s from Flink into Redis (batched pipelines).
- Online store size: 300M cards + 200M devices + 100M IPs + 100M accounts, ~20 features x 16 B each -> ~220 GB; Redis Cluster of 8 x 64 GB nodes with replicas (16 nodes).
- Event log: 100M x 1 KB = 100 GB/day raw, ~10-15 GB/day compressed Parquet, ~5 TB/year.
- Decision log: 100M x 2 KB (features + explanation) = 200 GB/day raw, ~25 GB/day compressed.
- Review queue: 2% of transactions -> 2M/day; if 25% needs a human, 500k cases/day, ~350/min; at 2 min per case that is ~50 analysts per shift, which forces aggressive step-up automation.`,
      },
      {
        title: 'API design',
        prompt: 'Design the scoring API (request/response), the rules management API, the review queue API, and the label ingestion API. Consider idempotency and versioning.',
        reference: `\`\`\`
POST /v1/score                          (gRPC equivalent: Score)
  Body: { transaction_id, timestamp, amount, currency, card_token, bin,
          merchant_id, merchant_category, account_id, device_fp, ip,
          billing_country, shipping_address_hash, email_hash, channel }
  200 -> { decision: "allow"|"block"|"review",
           review_action: "step_up_otp"|"step_up_3ds"|"manual"|null,
           score: 0.87, model_version: "gbm-2026-09-08",
           reason_codes: ["VELOCITY_CARD_10M", "NEW_DEVICE"],
           decision_id, degraded: false }
  Idempotent on transaction_id (Redis cache of decision, 24h TTL).

POST /v1/rules                { name, expression, action, segment, enabled:false }
POST /v1/rules/{id}/dry-run   -> { projected_block_rate, sample_hits[] }
POST /v1/rules/{id}/activate  ; POST /v1/rules/{id}/rollback
GET  /v1/rules?version=

POST /v1/lists/{list}/entries { type: "card"|"device"|"ip", value, expires_at, reason }

GET  /v1/review/next          -> claims one case (SKIP LOCKED), returns
                                 txn, features, explanation, history
POST /v1/review/{case_id}/decision { outcome: "approve"|"reject", note }
POST /v1/review/{case_id}/release

POST /v1/labels               { transaction_id, label: "fraud"|"legit",
                                source: "chargeback"|"analyst"|"stepup"|"customer",
                                observed_at }

POST /v1/models               (register artefact) ; PATCH mode: shadow|canary(pct)|champion
\`\`\`

**Notes**
- The score request carries tokens/hashes, never raw PANs (PCI scope).
- \`reason_codes\` are stable identifiers mapped to customer-facing text elsewhere.
- Rules API changes are versioned; activation writes a new rules-set version that scorers hot-load within seconds via a Kafka control topic or config poll.`,
      },
      {
        title: 'Data model & storage',
        prompt: 'Define the storage for online features, offline features, rules, review cases, decision logs and labels. Choose technologies and justify each.',
        reference: `**Online features (Redis Cluster)**
\`\`\`
feat:card:{token}    HASH  txn_count_1m, txn_count_10m, txn_sum_1h, distinct_merchants_24h,
                           last_txn_ts, last_txn_geo ...           TTL 8d
feat:device:{fp}     HASH  cards_30d (HLL-derived count), txn_count_10m ...
feat:ip:{ip}         HASH  ...
feat:account:{id}    HASH  failed_logins_1h, age_days, chargebacks_lifetime ...
graph:device:{fp}    HASH  cards_per_device_30d, component_size, nbr_fraud_rate
\`\`\`
Why Redis: sub-millisecond reads, hashes group an entity\'s features into one round trip, TTL bounds memory. DynamoDB is the alternative when ops burden matters more than latency.

**Offline features and events (S3 Parquet, Hive/Iceberg tables, queried by Spark/Trino)**
- \`transactions_raw\` partitioned by date.
- \`feature_values(entity_type, entity_id, feature_name, value, valid_from_ts)\` for point-in-time joins.
- \`decisions(decision_id, transaction_id, ts, features_json, score, model_version, rules_fired[], decision)\`.
- \`labels(transaction_id, label, source, observed_at)\`.
- \`training_sets/<date>\` materialised weekly.

**Rules (Postgres)**
\`\`\`
rules(id, name, expression, action, segment, priority, version, enabled, created_by, created_at)
rule_sets(version, rule_ids[], activated_at, activated_by)
lists(list_name, entry_type, value_hash, reason, expires_at)   -- also mirrored to Redis SET
\`\`\`
Postgres for audit and transactional versioning; scorers cache the active rule set in memory.

**Review cases (Postgres)**
\`\`\`
review_cases(case_id, transaction_id, decision_id, priority, state, assigned_to,
             claimed_at, sla_deadline, outcome, note, closed_at)
INDEX (state, priority DESC, sla_deadline)
\`\`\`
Claim via \`UPDATE ... WHERE state='open' ... FOR UPDATE SKIP LOCKED\`.

**Streaming (Kafka)**
- \`transactions\` (partition by card token, 7-day retention), \`decisions\`, \`labels\`, \`rules-control\`.

**Model registry:** MLflow or S3 with versioned artefacts and metadata (training window, metrics, feature list).`,
      },
      {
        title: 'High-level design',
        prompt: 'Draw the architecture: payment service, scoring service, rules store, model, feature store (online/offline), Kafka, Flink, batch graph jobs, review queue, label pipeline, training. Trace a transaction through it.',
        reference: `\`\`\`
Payment svc --score()--> [Scoring service x12] --async--> Kafka "decisions"
     |                     |   |   |                            |
     |                     |   |   +--> in-memory rules (from Postgres/rules-control)
     |                     |   +--> GBM model in-process (registry: MLflow/S3)
     |                     +--> Redis Cluster (online features, lists, idempotency)
     |
     +--publish--> Kafka "transactions" --> [Flink velocity job] --> Redis
                        |                            |
                        +--> S3 sink --> Data lake (Parquet)
                                            |
                        nightly Spark: graph features -> Redis graph:* hashes
                        weekly Spark: decisions JOIN labels -> training set
                                            |
                                     train -> registry -> shadow/canary/champion

review decisions --> Postgres review_cases <-- analyst UI
chargebacks / step-up / analyst --> Kafka "labels" --> lake
\`\`\`

**Trace: one transaction**
1. Payment service builds the request (tokens, hashes) and calls \`score\` with a 150 ms timeout.
2. Scorer checks idempotency cache; computes stateless attributes; issues 5 parallel HGETALLs to Redis.
3. Hard rules evaluate against attributes + features; on hit -> block.
4. GBM produces p(fraud); soft rules and segment thresholds map it to allow/block/review; SHAP top-3 becomes reason codes.
5. Decision returned (~35 ms); decision event published to Kafka asynchronously.
6. Payment service publishes the transaction and outcome to \`transactions\`; Flink updates counters in Redis within ~300 ms.
7. If review: step-up initiated by the payment service, or a review case row created; outcome later published to \`labels\`.
8. Weeks later, chargeback lands as a label; weekly training joins decision-time features with labels.`,
      },
      {
        title: 'Deep dive & bottlenecks',
        prompt: 'Go deep on: meeting the 100 ms budget at 3,000 TPS, computing velocity windows correctly at scale, and building point-in-time correct training data. Quantify each.',
        reference: `**1. Latency at 3,000 TPS**
- Per instance: ~500 scores/s with in-process GBM (~5 ms inference on 500 trees, 50 features) using 8 cores; 12 instances give 6,000/s capacity across 3 AZs.
- Redis: 15,000 HGETALL/s spread over 8 shards is ~2,000/s per shard, trivial; p99 read 1-2 ms with hedging to replicas at 5 ms.
- Avoid: a remote model server hop (+3-10 ms p99), sequential feature reads, synchronous Kafka produce, JVM full GCs (use ZGC or Go).
- Idempotency cache: \`decision:{txn_id}\` in Redis, 24 h TTL, 100M keys x ~200 B = 20 GB; acceptable, or shorten to 1 h (retries happen within seconds).

**2. Velocity windows at scale**
- 60,000 counter updates/s. Flink parallelism 32 over a 64-partition topic; RocksDB state for ~700M keys x ~1 KB window state = ~700 GB across the cluster, checkpointed incrementally to S3 every 15 s.
- Sliding windows: for 1m/10m/1h use minute-granularity buckets (60 buckets max per key); for 24h/7d use hourly buckets. Emit only changed features to Redis with pipelined MSET/HSET batches of 100 to keep Redis write load at ~600 pipelines/s.
- Distinct counts (merchants, cards per IP) via HyperLogLog sketches in Flink state; error ~1%, acceptable.
- Out-of-order events: event-time watermarks with 5 s allowed lateness; later events go to a side output and are applied as corrections.
- Hot keys: a merchant-level aggregate (all transactions for one merchant) is skewed; pre-aggregate per partition then combine, or exclude merchant-level features from the keyed hot path and compute them in 1-minute tumbling windows.
- Freshness gap: the second transaction of a 200 ms burst may not see the first. Scorer does a synchronous \`INCR inflight:card:{token}:1m\` with 60 s TTL and adds it as a feature; cheap insurance for card-testing attacks.

**3. Point-in-time training data**
- Decision logs already contain the features **as seen at decision time**, so the simplest correct training set is \`decisions JOIN labels\`: no reconstruction needed. This is the strongest argument for logging full features with each decision (200 GB/day raw is worth it).
- For new features not yet in production, backfill from \`feature_values\` with \`valid_from_ts <= txn_ts\` using Spark window functions; verify against a sample of decision logs to detect skew.
- Labels: fraud from chargebacks (lag 30-90 d), analyst rejects, failed step-ups (down-weighted); legit from settled transactions older than the dispute window. Training window: last 6 months, labelled through 90 days ago; validation: the most recent labelled month.
- Class imbalance (~0.3% fraud): downsample negatives 10:1 and reweight, or use focal loss; evaluate with precision at fixed recall and expected cost, never accuracy.

**Other bottlenecks**
- Analyst capacity: at 500k manual cases/day you cannot hire enough people; drive the manual share below 0.2% by expanding step-up.
- Rules explosion: hundreds of overlapping rules degrade explainability; enforce ownership, hit-rate reviews and automatic retirement of rules with zero hits in 30 days.`,
      },
      {
        title: 'Failure modes & trade-offs',
        prompt: 'For each dependency describe the failure, the blast radius and the degradation policy. Then articulate the major trade-offs (inline vs async, rules vs model, exact vs approximate features, fail open vs fail closed) and what you rejected.',
        reference: `**Failure modes and policy**
- **Scorer unreachable / timeout (150 ms):** payment service applies segment policy: allow with \`degraded=true\` for amounts under a threshold and customers with history; step-up for others; block for known high-risk segments. Alert when degraded fraction exceeds 0.5%.
- **Redis shard down:** features for entities on that shard are missing; scorer uses the attributes-only fallback model (trained with simulated missingness) and rules, marks degraded. Replicas with automatic failover limit this to seconds.
- **Flink lag:** consumer lag alarm at 30 s; when lag exceeds 60 s, scorer automatically lowers block/review thresholds by a configured delta and increases step-up. Features carry a \`computed_at\` timestamp so staleness is observable per request.
- **Kafka unavailable:** scorer buffers decisions in memory (bounded, 60 s) then drops with a counter; scoring continues. Feature updates stop (see Flink lag policy).
- **Model artefact corrupt or slow:** health check fails to load -> keep the previous champion; if none, rules-only mode with tighter thresholds.
- **Bad rule:** dry-run required; per-rule block-rate cap (e.g. 2% of traffic) auto-disables the rule and pages the owner; rollback to previous rule-set version.
- **Postgres (rules/review) down:** scorers keep the last cached rule set; review case creation falls back to the Kafka topic and is drained later.
- **Region failure:** active-active scorers in two regions with Redis replicated (CRDT or cross-region replication accepting seconds of staleness); Kafka MirrorMaker for the transactions topic.

**Trade-offs**
- **Inline synchronous vs asynchronous scoring:** inline prevents fraud before authorisation but couples payments availability to the scorer; async (score after authorise, void if fraud) removes latency pressure but lets fraud through momentarily and does not work for instant-delivery goods. Chosen: inline with a strict timeout and explicit degradation.
- **Rules vs model:** kept both; rules for speed of response and policy, model for generalisation. Cost: two systems to govern.
- **Approximate windows (minute buckets, HLL) vs exact:** approximate bounds memory and CPU at the cost of about 1% error, irrelevant to a probabilistic score.
- **Logging full features per decision (200 GB/day) vs reconstructing later:** storage cost buys exact reproducibility and skew-free training data. Chosen: log everything, compress, tier to cold storage after 90 days.
- **Fail open vs fail closed:** fail open costs fraud during outages; fail closed costs revenue and trust. Chosen: per-segment policy, decided by the business and reviewed quarterly.
- **In-process model vs model server:** in-process minimises latency and hops; a model server eases polyglot models and GPU use. Chosen: in-process GBM; revisit if moving to deep models.

**Rejected alternatives**
- Computing velocity in the OLTP database with indexes: cannot meet latency at 3,000 TPS.
- Graph traversal at request time in Neo4j: unpredictable latency; precompute instead.
- Random train/test splits: leak temporal patterns; time-based splits only.
- Hard-coding thresholds in the model: removes business control; thresholds live in rules.`,
      },
    ],
  },
  interviewQuestions: [
    'Design a real-time fraud detection system for card payments. Where does it sit in the payment flow and what is its latency budget?',
    'Why do you need both a rules engine and an ML model? In what order do they run?',
    'What are velocity features and how do you compute them at thousands of transactions per second?',
    'Explain the online/offline feature store split and how you prevent training-serving skew.',
    'How do you build training data when labels (chargebacks) arrive 60 days after the transaction?',
    'What happens to payments when your fraud scorer is down? Defend your degradation policy.',
    'How would you detect a fraud ring spreading small transactions across many cards and devices?',
    'How do you safely deploy a new fraud model or a new analyst rule?',
  ],
}

export default chapter
