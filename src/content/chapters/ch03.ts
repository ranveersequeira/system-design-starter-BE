import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 3,
  slug: 'how-do-you-know-you-have-built-a-good-system',
  title: 'How Do You Know You Have Built A Good System',
  module: 'foundations',
  estimatedMinutes: 35,
  summary:
    'A good system is not one that merely works today. It is broken into components that each do one thing, communicates through clear contracts, scales when load grows, stays available and resilient when parts fail, has no single point of failure, can be observed from the outside, and does all this at a cost the business can sustain. This chapter gives you a checklist you can run against any design, including your own.',
  objectives: [
    'List the qualities of a good system and explain why each one matters with a concrete failure it prevents.',
    'Distinguish scalability, availability, resilience and reliability and give a measurable definition of each.',
    'Identify single points of failure in an architecture diagram and propose how to remove them.',
    'Explain what observability requires (logs, metrics, traces, alerts) and why a system you cannot observe is not done.',
    'Evaluate a design against cost and simplicity, not only against technical elegance.',
  ],
  quickRevision: [
    'Good system checklist: componentised, single responsibility, clear communication, scalable, available, resilient, reliable, no SPOF, observable, cost-aware.',
    'A component should have one reason to change; if a box does two jobs, a failure in one takes down the other.',
    'Communication is clear when every interaction has a contract: protocol, schema, timeout, retry policy, failure behaviour.',
    'Scalable = throughput grows roughly linearly when you add resources; stateless services scale horizontally, stateful ones need partitioning.',
    'Available = fraction of time the system answers correctly; 99.9% is 8.7 h/year down, 99.99% is 52 min/year.',
    'Availability of serial dependencies multiplies: two 99.9% services in series give 99.8%.',
    'Resilient = keeps working (perhaps degraded) when components fail: timeouts, retries with backoff, circuit breakers, fallbacks, bulkheads.',
    'Reliable = does the right thing consistently: no lost writes, no double charges, correct results under concurrency.',
    'Single point of failure = any component whose loss stops the system; remove with redundancy plus automatic failover, not redundancy alone.',
    'Observable = you can answer "what is happening and why" from the outside using logs, metrics, traces and alerts on SLOs.',
    'Measure p99 latency and error rate, not averages; averages hide the users who are suffering.',
    'Cost-aware = the design spends money where the requirements are and nowhere else; simplicity is a feature because every component costs operations time.',
    'Good systems fail gracefully: a broken recommendations service should never block checkout.',
  ],
  sections: [
    {
      id: 'components-single-responsibility',
      title: 'Broken into components, each doing one thing',
      body: `The first mark of a good system is that it is decomposed into components with clear, narrow responsibilities. This is the same principle as single responsibility in code, applied one level up, and it matters for three concrete reasons.

**Failure isolation.** If image resizing and payment processing run in the same process, an out-of-memory crash while resizing a 50 MB upload kills a payment in flight. Separate them and a resizing failure is a delayed thumbnail, not a lost order. Components are the blast walls of a system.

**Independent scaling.** The feed service needs 40 servers; the settings service needs 2. If they are one deployable, you scale both to 40 and pay for 38 idle settings servers. Separate components let you buy exactly the capacity each needs.

**Independent change.** Teams can deploy, roll back and rewrite a component without coordinating with everyone else, provided the contract at its boundary holds. This is what lets an organisation of 200 engineers ship daily.

A good test: can you describe what a component does in one sentence without the word "and"? "Authentication issues and validates tokens" passes. "The API server handles auth, orders, email sending and report generation" fails; that is a monolith wearing a component's name.

Decomposition has a cost. Every boundary is a network hop with latency, a contract to maintain, and a distributed failure mode. So the goal is not "as many components as possible"; it is boundaries placed where responsibilities genuinely differ and where failure isolation or independent scaling actually pays. A well-modularised monolith with clean internal boundaries is often a better system than twenty microservices that all share one database.`,
      mentalModel:
        'A ship is built with watertight compartments. One hull breach floods one compartment, not the ship. Components are the compartments; the contracts between them are the sealed doors.',
      diagram: `Bad: one box, many jobs             Good: one job per box
+---------------------------+       +--------+  +--------+  +-------+
| API: auth + orders +      |       |  Auth  |  | Orders |  | Email |
|      email + reports      |       +--------+  +--------+  +-------+
+---------------------------+          scale 2     scale 40   async
 resize OOM -> payment dies         resize OOM -> late thumbnail only`,
      keyPoints: [
        'Components isolate failures, scale independently and change independently.',
        'Test: describe the component in one sentence without "and".',
        'Every boundary costs latency, a contract, and a new failure mode; place boundaries where they pay.',
        'A well-modularised monolith beats badly cut microservices.',
      ],
      checkpoint: {
        question:
          'A single service handles user login, generating monthly invoices, and serving the product catalogue. Which responsibility would you split out first and why?',
        answer:
          'Invoice generation: it is CPU and memory heavy, bursty (month end), and not latency critical. Left in place, a month-end burst can starve login and catalogue requests of CPU or memory. Move it behind a queue to a worker so it can fail or lag without touching the user-facing paths.',
      },
    },
    {
      id: 'clear-communication',
      title: 'Clear communication between components',
      body: `Once a system has components, its behaviour is defined by how they talk. A good system makes every interaction explicit and boring: you can look at any arrow and know exactly what crosses it and what happens when it fails.

**A contract for every arrow.** Protocol (HTTP/JSON, gRPC, a Kafka topic), the schema of the payload (ideally versioned with Protobuf, Avro or an OpenAPI spec), and the semantics: is a call idempotent, what errors can come back, is ordering guaranteed on the topic?

**Sync or async, chosen deliberately.** Synchronous calls (REST, gRPC) give immediate answers and simple reasoning but couple the caller to the callee's latency and availability. Asynchronous messaging (RabbitMQ, SQS, Kafka) decouples health and absorbs bursts but introduces eventual consistency and duplicate delivery that consumers must handle. Good systems use sync where the user is waiting for the answer and async for everything else.

**Timeouts, retries and backoff on every call.** A call without a timeout is a call that can hang forever and pin a thread. A retry without exponential backoff and jitter is a retry storm that finishes off a struggling dependency. Good systems set these per dependency and document them.

**No hidden coupling.** Two services sharing one database table are communicating, but through a channel with no contract; a column rename by one team breaks the other silently. Prefer explicit APIs or events over shared state, or at least own each table by exactly one service.

**Versioning and compatibility.** Producers add fields, never remove or repurpose them; consumers ignore unknown fields. This lets components deploy independently without a coordinated big bang.

When communication is clear, a reader can trace a request through the system and predict its behaviour under failure without reading source code. That predictability is what makes the system operable at 3 a.m.`,
      mentalModel:
        'Air traffic control works because every exchange uses a fixed phraseology, a fixed channel, and a fixed procedure for lost contact. Nobody improvises. Clear component communication is the same discipline.',
      keyPoints: [
        'Every interaction has a contract: protocol, schema, semantics, errors.',
        'Choose sync when the user waits for the answer, async otherwise.',
        'Timeouts, bounded retries with exponential backoff and jitter on every remote call.',
        'Shared database tables between services are hidden, contract-less coupling.',
        'Backward-compatible schema evolution enables independent deploys.',
      ],
    },
    {
      id: 'scalable',
      title: 'Scalable: throughput grows when resources grow',
      body: `A system is scalable when adding resources increases the load it can handle, ideally in proportion. Two servers should serve roughly twice what one does. Where that stops being true, you have found the part of the system that will define its ceiling.

**Vertical scaling** (a bigger machine) is the simplest and often the right first move, but it has a hard ceiling and a steep price curve at the top, and a single big box is still a single point of failure.

**Horizontal scaling** (more machines) has no theoretical ceiling but only works for components that are **stateless** or **partitionable**. A stateless web tier scales by adding servers behind a load balancer because any server can serve any request. A database does not scale that way: its state must either be replicated (which scales reads, not writes) or partitioned (sharded) so each node owns a slice.

What breaks linear scaling:

- **Shared state and coordination.** A global lock, a single counter row, or a leader that every request must touch serialises the whole system. Amdahl's law: the serial fraction caps the speedup no matter how many nodes you add.
- **Hot spots.** Partitioning by user id works until one user has 50 M followers. Uneven load means one node saturates while nine idle.
- **Fan-out.** If one request touches all N shards (a scatter-gather query), adding shards increases per-request work instead of dividing it.
- **Connection and thread limits.** Each new app server opens more DB connections; the database, not the CPU, becomes the ceiling. Pools and proxies fix this.

Good design keeps state out of the request path where possible (sessions in Redis or in signed tokens, not in server memory), chooses partition keys that spread load evenly, and knows in advance where the first non-linear component is. Being able to say "this design scales linearly to about 50k QPS, then the primary database becomes the bottleneck and we shard by user id" is far stronger than claiming "it scales infinitely".`,
      mentalModel:
        'A supermarket scales by opening more checkout lanes only because any cashier can serve any customer (stateless). If every purchase had to be approved by the one manager, the lanes would sit idle waiting on her (shared coordination).',
      diagram: `Stateless tier: linear            Coordinated tier: capped
 req -> [LB] -> [S1][S2][S3]...    req -> [S1][S2][S3] -> [single lock]
 2x servers ~= 2x throughput        2x servers -> same throughput

Partitioned state: linear-ish     Scatter-gather: anti-scaling
 key -> shard(key) -> 1 node       query -> ALL shards -> merge
 hot key -> one node melts          more shards = more work/request`,
      keyPoints: [
        'Scalable means throughput rises roughly linearly with added resources.',
        'Stateless components scale horizontally trivially; stateful ones need replication or partitioning.',
        'Shared coordination, hot spots, fan-out and connection limits break linear scaling.',
        'Know and state where your design stops scaling linearly and what you would do next.',
      ],
      checkpoint: {
        question:
          'A service stores user sessions in each web server\'s memory and uses sticky sessions at the load balancer. Why does this hurt scalability and availability, and how do you fix it?',
        answer:
          'Sticky sessions mean load cannot be rebalanced evenly, so adding servers helps less than linearly, and a server crash logs out every user pinned to it. Fix: make servers stateless by storing sessions in Redis (or in a signed JWT), so any server can serve any request and the balancer can spread load freely.',
      },
    },
    {
      id: 'available-no-spof',
      title: 'Available, with no single point of failure',
      body: `Availability is the fraction of time the system correctly serves requests. It is quoted in nines: 99.9% (three nines) allows about 8.7 hours of downtime a year; 99.99% allows 52 minutes; 99.999% allows 5 minutes. Each extra nine costs roughly an order of magnitude more engineering and infrastructure, so the target must come from the business, not from pride.

Two facts govern availability arithmetic:

1. **Serial dependencies multiply.** If a request must pass through a load balancer, an API server and a database each at 99.9%, the path is 0.999^3, about 99.7%. Every synchronous dependency in the hot path lowers availability; async dependencies mostly do not.
2. **Parallel redundancy improves it.** Two independent 99% servers behind a balancer, where either can serve, fail together only 1% x 1% = 0.01% of the time: 99.99%.

A **single point of failure (SPOF)** is any component whose loss stops the whole system. Common culprits: the one database primary, the one load balancer, the one message broker node, the one Redis instance everyone depends on, a single availability zone, a hard-coded IP, a single DNS provider, and, often forgotten, the one engineer who knows how it works.

Removing SPOFs needs two things, not one:

- **Redundancy**: multiple instances, multiple zones, replicas of every data store.
- **Automatic failover**: something detects the failure and redirects traffic without a human. A replica that requires a 2 a.m. page and a manual promotion is redundancy without availability; you still eat 30 minutes of downtime. Tools: health-checked load balancers, Postgres with Patroni, Redis Sentinel or Cluster, ZooKeeper or etcd based leader election.

Good systems also **degrade instead of dying**. If the recommendation service is down, show best-sellers; if the search cluster is slow, fall back to a simpler database query. Checkout should never fail because a non-essential dependency did. Draw your diagram, cover each box with a finger, and ask "what do users see now?". If the answer is "an error page" for a non-core box, you have work to do.`,
      mentalModel:
        'A hospital has backup generators (redundancy) that start automatically within seconds (failover). A generator that needs someone to find the key and pull the cord in the dark is not a backup, it is a hope.',
      diagram: `Serial path (multiply):
 [LB 99.9%] -> [API 99.9%] -> [DB 99.9%]  =  ~99.7%  (26 h/yr)

Parallel redundancy (either serves):
 [LB] -> [API a 99%]                fails only if both fail
      -> [API b 99%]   = 99.99%

SPOF hunt: cover each box with a finger; what do users see?
 [DB primary] alone -> everything stops -> add replica + auto failover`,
      keyPoints: [
        'Availability is measured in nines; each nine costs roughly 10x more.',
        'Serial synchronous dependencies multiply availability down; parallel redundancy multiplies it up.',
        'A SPOF is any component whose loss stops the system; hunt for them explicitly.',
        'Redundancy without automatic failover is not high availability.',
        'Degrade gracefully: non-core failures must not block core flows.',
      ],
      checkpoint: {
        question:
          'Your architecture has two API servers behind one Nginx box, one Postgres primary with a streaming replica, and one Redis instance used for sessions. List the SPOFs and how to fix each.',
        answer:
          'SPOFs: the single Nginx (add a second with a floating IP or use a managed ALB across zones); the Postgres primary if failover is manual (add Patroni or a managed service with automatic promotion); the single Redis (Redis Sentinel or Cluster, or make sessions stateless with signed tokens so Redis loss degrades rather than kills). The API tier is already redundant.',
      },
    },
    {
      id: 'resilient-reliable',
      title: 'Resilient and reliable: correct under failure and under load',
      body: `Availability says the system answers; **reliability** says it answers correctly; **resilience** says it keeps doing so while things around it break. A system can be up and wrong (double charging customers), or correct and brittle (perfect until one dependency hiccups). Good systems are both resilient and reliable.

**Resilience patterns**, each defending against a specific failure:

- **Timeouts** on every call so a slow dependency cannot pin your threads indefinitely.
- **Retries with exponential backoff and jitter**, bounded, and only for idempotent operations, so a transient blip is survived without creating a retry storm.
- **Circuit breakers** that stop calling a failing dependency for a while and return a fallback, letting it recover instead of burying it.
- **Bulkheads**: separate thread pools or connection pools per dependency so one slow downstream cannot exhaust resources needed for the others.
- **Rate limiting and load shedding**: reject excess work early with a 429 rather than accept it and collapse under it. A system that serves 80% of users fast is better than one serving 100% of users a timeout.
- **Graceful degradation**: fallbacks such as cached or default responses for non-critical features.

**Reliability practices**, each defending against a specific wrong answer:

- **Idempotency keys** so that a retried payment or order creation happens once.
- **Transactions and correct isolation levels** so concurrent writes do not corrupt state (chapter 5).
- **Durable writes** acknowledged only after fsync or replication, so an acknowledged write is never lost.
- **Exactly-once effects** built from at-least-once delivery plus deduplication, since exactly-once delivery is not something a network can promise.
- **Testing the failure paths**: chaos experiments (kill a replica, partition a zone, inject latency) reveal whether resilience patterns actually work or merely exist in the code.

The core question for reliability is "what is the worst wrong thing this system could do to a user?" and for resilience "which single failure would cause that?". Charging twice, losing an order, showing another user's data: each should map to a specific mechanism that prevents it, and you should be able to name that mechanism.`,
      mentalModel:
        'Resilience is a boxer who can take a punch and stay standing; reliability is the boxer who keeps landing the right punches. A fighter with only one of these loses.',
      keyPoints: [
        'Availability: answers. Reliability: answers correctly. Resilience: keeps doing so during failures.',
        'Resilience toolkit: timeouts, bounded retries with backoff and jitter, circuit breakers, bulkheads, load shedding, fallbacks.',
        'Reliability toolkit: idempotency, transactions and isolation, durable acknowledged writes, dedup for exactly-once effects.',
        'Retries without idempotency create duplicates; retries without backoff create storms.',
        'Test failure paths deliberately; untested resilience is decoration.',
      ],
      checkpoint: {
        question:
          'A payment service calls a third-party gateway that sometimes times out. A naive retry produced double charges last month. Which two mechanisms fix this and why are both needed?',
        answer:
          'An idempotency key sent with every attempt so the gateway treats a retry as the same payment (reliability), and bounded retries with exponential backoff behind a circuit breaker so a gateway outage does not turn into a retry storm (resilience). The key alone still lets a storm overwhelm the gateway; backoff alone still risks duplicates if the first call succeeded but the response was lost.',
      },
    },
    {
      id: 'observable',
      title: 'Observable: you can see what it is doing and why',
      body: `A system you cannot observe is not finished. Every serious outage story includes a phase where nobody knew what was happening, and that phase is usually the longest. Observability is the property that lets you answer arbitrary questions about system behaviour from the outside, without deploying new code.

Four pillars, each answering a different question:

- **Metrics** (Prometheus, CloudWatch, Datadog): numeric time series. What is the request rate, error rate and latency (the RED method) for each service? What is the CPU, memory, disk and saturation (the USE method) of each resource? Always record percentiles (p50, p95, p99), not averages: an average of 80 ms can hide 5% of users waiting 4 seconds.
- **Logs** (structured JSON, shipped to Elasticsearch/Loki): what exactly happened in this one request? Logs must be structured and carry the request id so they can be filtered, not grepped through by hand.
- **Traces** (OpenTelemetry, Jaeger, Zipkin): where did the time go across services? A trace shows that the 900 ms checkout spent 850 ms waiting for the inventory service on a single retry.
- **Alerts** on symptoms users feel (error rate above 1%, p99 above SLO, queue lag growing) rather than on causes (CPU at 80%), routed to a human only when action is needed. Alert fatigue is how real incidents get ignored.

Define **SLIs and SLOs**: a service-level indicator is the measurement (fraction of requests under 300 ms), the objective is the target (99.5% over 30 days). SLOs turn "is the system good?" from an opinion into a number, and the error budget they imply tells you when to slow feature work to fix reliability.

Observability also feeds the design process from chapter 2: the iterative "find the bottleneck, fix it" loop only works if you can see the bottleneck. Add a cache because the dashboard shows the DB at 95% CPU on repeated reads, not because caches are fashionable.

Practical minimum for any new service: RED metrics per endpoint, structured logs with a correlation id, distributed tracing enabled, health checks for the load balancer, and one dashboard plus two or three symptom-based alerts. Ship these with the first version, not after the first outage.`,
      mentalModel:
        'Flying a plane at night without instruments is not brave, it is fatal. Metrics are the gauges, logs are the flight recorder, traces are the radar track of one flight, and alerts are the warning lights that only come on when the pilot must act.',
      diagram: `Question                         Pillar     Tool examples
--------                         ------     -------------
How much / how fast / errors?    Metrics    Prometheus, Datadog
What happened in THIS request?   Logs       JSON -> Loki/Elastic
Where did the time go?           Traces     OpenTelemetry, Jaeger
Does a human need to act now?    Alerts     on SLO symptoms only

SLI: % requests < 300 ms   SLO: 99.5% / 30 days   budget: 0.5%`,
      keyPoints: [
        'Metrics, logs, traces and alerts answer different questions; a good system has all four.',
        'Record percentiles (p95, p99), never only averages.',
        'Structured logs with a correlation id; traces across service boundaries.',
        'Alert on user-facing symptoms tied to SLOs, not on raw resource causes.',
        'Observability is what makes the iterative bottleneck-driven design loop possible.',
      ],
      checkpoint: {
        question:
          'Users complain checkout is "sometimes slow". Your dashboard shows average latency at a healthy 120 ms. What is wrong with your observability and what would you look at instead?',
        answer:
          'Averages hide tail latency. Look at p95/p99 per endpoint; a p99 of 3 s with a p50 of 90 ms averages fine but hurts 1% of every page load. Then open traces for slow requests to see which downstream call (payment gateway, inventory, DB) consumes the time, and add an alert on p99 against the SLO.',
      },
    },
    {
      id: 'cost-aware-simple',
      title: 'Cost-aware and as simple as possible',
      body: `Engineering exists inside a business. A design that meets every technical quality but costs three times the revenue it supports is not a good system; it is a beautiful liability. Good designers treat cost as a first-class requirement alongside latency and availability.

**Where money actually goes:**

- **Compute** that sits idle: over-provisioned instances, a 40-server fleet for 2 servers of load "just in case". Autoscaling and right-sizing fix this.
- **Data transfer**: cross-region and cross-zone traffic, and egress to the internet, are often the surprise line item. A CDN in front of media reduces egress bills as much as it reduces latency.
- **Storage tiers**: keeping every byte on SSD-backed block storage when 90% is cold. S3 and its infrequent-access or Glacier tiers can be 10-50x cheaper for cold data.
- **Managed service premiums**: a managed database or Kafka costs more per hour than self-hosting but saves the engineer-months of operating it; the right call depends on team size.
- **Operational cost**: every component needs monitoring, upgrades, on-call knowledge and incident response. This is the cost people forget, and it is why simplicity is a financial property.

**Simplicity as a design goal.** Every box you add has a monthly bill, an on-call burden and a failure mode. The best design satisfies the requirements with the fewest components that still meet the NFRs. This is why the chapter 2 approach starts with one database: it is the cheapest system that works, in dollars and in attention. Reach for Kafka when you need a replayable log at high throughput, not for 50 messages a minute where a Postgres table or SQS does the job.

**Match spend to requirements.** 99.99% for an internal admin tool is money wasted; 99.9% for a payment path may be money lost. Multi-region active-active is right for a global bank and wrong for a regional startup. Ask "what does an hour of downtime cost, and what does avoiding it cost?" and let the smaller number win.

The interview signal here is judgement: a candidate who says "at this scale I would not add a cache; the database handles it and one less component means one less 3 a.m. page" is demonstrating that they have run systems, not just drawn them.`,
      mentalModel:
        'A good backpacker carries everything they need and nothing they do not, because every extra kilogram is paid for on every step of the trail. Every extra component is paid for on every day of operation.',
      keyPoints: [
        'Cost is a requirement: compute, transfer, storage tiers, managed premiums and operational burden.',
        'Simplicity is a financial property; each component adds bill, on-call load and failure modes.',
        'Match the availability target and architecture to what downtime actually costs the business.',
        'Right-size, autoscale, tier storage, and put a CDN in front of media.',
        'Declining to add a component, with a reason, is a strong design decision.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Which statement best defines a scalable system?',
      options: [
        'It never goes down',
        'Adding resources increases the load it can handle roughly proportionally',
        'It uses microservices',
        'It has the fastest possible response time',
      ],
      answerIndex: 1,
      explanation:
        'Scalability is about the relationship between resources and capacity. Uptime is availability, speed is latency, and microservices are one possible means, not the definition.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'A request passes synchronously through three components, each with 99.9% availability. What is the approximate availability of the path?',
      options: ['99.9%', '99.97%', '99.7%', '97%'],
      answerIndex: 2,
      explanation:
        'Serial availabilities multiply: 0.999 x 0.999 x 0.999 is about 0.997, or 99.7%, roughly 26 hours of downtime a year. It does not stay at 99.9%, and it certainly does not improve; only parallel redundancy improves availability.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'What distinguishes reliability from availability?',
      options: [
        'They are synonyms',
        'Reliability is about answering correctly; availability is about answering at all',
        'Reliability applies to hardware, availability to software',
        'Availability is measured in nines; reliability cannot be measured',
      ],
      answerIndex: 1,
      explanation:
        'A system can be up 100% of the time and still double-charge customers (available but unreliable). Reliability is about correctness of behaviour, and it can be measured (e.g. rate of lost or duplicated writes).',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which of the following are resilience mechanisms? Select all that apply.',
      options: [
        'Circuit breaker',
        'Third normal form',
        'Timeouts with bounded retries and jittered backoff',
        'Bulkheads (isolated pools per dependency)',
        'Cursor pagination',
      ],
      answerIndices: [0, 2, 3],
      explanation:
        'Circuit breakers, timeouts/retries with backoff and bulkheads all limit the damage a failing dependency can do. Normal forms are a data-modelling concern and cursor pagination is an API efficiency concern.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement: 'Adding a standby database replica removes the database as a single point of failure.',
      answer: false,
      explanation:
        'Redundancy alone is not enough. Without automatic detection and failover (Patroni, a managed service, Sentinel for Redis), the primary failing still causes downtime until a human promotes the replica. SPOF removal requires redundancy plus automatic failover.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question: 'Your checkout page calls a recommendations service synchronously. Recommendations goes down and checkout starts returning 500 errors. Which quality is most clearly missing?',
      options: [
        'Scalability',
        'Observability',
        'Graceful degradation (resilience)',
        'Normalisation',
      ],
      answerIndex: 2,
      explanation:
        'A non-core dependency took down a core flow. A resilient design wraps the call in a timeout and circuit breaker and falls back to a default (best sellers or nothing). The system may be perfectly observable and scalable and still have this flaw.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'Why should dashboards and alerts use p99 latency rather than average latency?',
      options: [
        'p99 is easier to compute',
        'Averages hide the tail: a small fraction of very slow requests can disappear into a healthy-looking mean',
        'Average latency is not supported by Prometheus',
        'p99 is always lower than the average',
      ],
      answerIndex: 1,
      explanation:
        'An average of 120 ms is consistent with 1% of requests taking 4 seconds. Since every page load makes many requests, that 1% affects most users. Percentiles expose this; p99 is higher than the average, not lower.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: 'Two services that communicate only by reading and writing the same database table are loosely coupled because they never call each other.',
      answer: false,
      explanation:
        'Shared tables are hidden coupling with no contract. A schema change by one team silently breaks the other. Explicit APIs or events, with owned tables, make the coupling visible and versionable.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'An internal admin dashboard used by 20 staff during office hours is designed for 99.99% availability with multi-region active-active deployment. What is the best critique?',
      options: [
        'It should target 99.999% instead',
        'The design overspends: the cost of downtime for this tool does not justify multi-region complexity and operational burden',
        'Multi-region is never appropriate',
        'Admin tools do not need monitoring',
      ],
      answerIndex: 1,
      explanation:
        'Cost-awareness means matching the availability target and architecture to what downtime actually costs. An hour of admin-tool downtime during office hours is an inconvenience; multi-region active-active is a permanent engineering and dollar cost. Monitoring is still required.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'What is the primary reason retries must be limited to idempotent operations?',
      options: [
        'Non-idempotent operations are slower',
        'A retry after a lost response could apply the operation twice (e.g. a duplicate charge)',
        'Idempotent operations do not need timeouts',
        'Load balancers reject non-idempotent retries',
      ],
      answerIndex: 1,
      explanation:
        'If the first attempt succeeded but the response was lost, a retry re-executes it. Idempotency (natural or via an idempotency key) makes the second execution harmless. This is a reliability concern layered on top of the resilience benefit of retrying.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'You are handed the architecture of an order system: one load balancer, three stateless API servers, one Postgres primary with manual failover to a replica, one RabbitMQ node feeding an email worker, and no tracing. Evaluate it against the good-system checklist and list the top three fixes.',
      modelAnswer: `**Assessment.** Componentised and stateless API tier: good, scales horizontally. Communication: email is correctly async. SPOFs: the single load balancer, the Postgres primary (manual failover means minutes of downtime), and the single RabbitMQ node (orders may still succeed if publishing is non-blocking, but emails stop). Observability: no tracing, so a slow order cannot be diagnosed across API -> DB -> queue.

**Top three fixes.**
1. Automatic database failover (Patroni or a managed Postgres with multi-AZ) so primary loss costs seconds, not a page and a manual promotion.
2. Redundant load balancer (managed ALB across zones or two Nginx with a floating IP) and a clustered broker (RabbitMQ quorum queues) or a managed queue such as SQS.
3. Observability baseline: RED metrics per endpoint, structured logs with a correlation id, OpenTelemetry tracing, and alerts on p99 and error rate against an SLO.

Also verify that a broker outage degrades (order succeeds, email retried later) rather than failing the order.`,
      rubric: [
        'Identifies the SPOFs: load balancer, Postgres with manual failover, single broker.',
        'Notes that redundancy needs automatic failover.',
        'Calls out missing observability and names concrete additions.',
        'Considers graceful degradation of the email path.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain why simplicity is a cost property and give an example of declining to add a component.',
      modelAnswer: `Every component carries a monthly infrastructure bill, an operational burden (monitoring, upgrades, on-call knowledge, incident response) and its own failure modes that must be handled by every caller. Those costs are paid every day the system runs, regardless of whether the component delivers value. So a design with fewer components meeting the same requirements is cheaper in dollars and in engineering attention, and usually more reliable.

Example: a service processes 50 events per minute between two internal components. Kafka would work, but it needs a cluster, ZooKeeper or KRaft, monitoring and expertise. A Postgres outbox table polled by the consumer, or a managed SQS queue, meets the requirement with a fraction of the operational cost. Declining Kafka here, with that reasoning, is a good design decision.`,
      rubric: [
        'Links components to ongoing operational and dollar cost.',
        'Mentions failure modes and on-call burden.',
        'Gives a concrete example with a simpler alternative.',
        'Ties the decision to the actual requirement (scale).',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Good-system checklist', back: 'Componentised, single responsibility, clear communication, scalable, available, resilient, reliable, no SPOF, observable, cost-aware.' },
    { id: 'f2', front: 'Single-responsibility test for a component', back: 'Describe it in one sentence without "and". If you cannot, it is doing multiple jobs and failures in one will hit the other.' },
    { id: 'f3', front: 'Three benefits of decomposing into components', back: 'Failure isolation, independent scaling, independent change and deployment.' },
    { id: 'f4', front: 'What a clear interaction contract includes', back: 'Protocol, versioned schema, semantics (idempotent? ordered?), error cases, timeout and retry policy.' },
    { id: 'f5', front: 'Definition of scalability', back: 'Throughput grows roughly in proportion to added resources. Broken by shared coordination, hot spots, scatter-gather fan-out, connection limits.' },
    { id: 'f6', front: 'Downtime per year at 99.9 / 99.99 / 99.999%', back: 'About 8.7 hours / 52 minutes / 5 minutes.' },
    { id: 'f7', front: 'Availability of serial vs parallel components', back: 'Serial: multiply (0.999^3 = 99.7%). Parallel redundant (either serves): 1 - product of failure probabilities (two 99% -> 99.99%).' },
    { id: 'f8', front: 'Single point of failure', back: 'Any component whose loss stops the system. Fix requires redundancy AND automatic failover; a manually promoted replica is not HA.' },
    { id: 'f9', front: 'Resilience vs reliability', back: 'Resilience: keeps working (possibly degraded) when parts fail. Reliability: produces correct results consistently (no lost or duplicated effects).' },
    { id: 'f10', front: 'Resilience toolkit', back: 'Timeouts, bounded retries with exponential backoff and jitter, circuit breakers, bulkheads, rate limiting and load shedding, fallbacks for graceful degradation.' },
    { id: 'f11', front: 'Reliability toolkit', back: 'Idempotency keys, transactions with the right isolation level, durable acknowledged writes, deduplication for exactly-once effects, tested failure paths.' },
    { id: 'f12', front: 'Four pillars of observability', back: 'Metrics (how much/fast), logs (what happened in this request), traces (where time went across services), alerts (does a human need to act).' },
    { id: 'f13', front: 'RED and USE methods', back: 'RED per service: Rate, Errors, Duration. USE per resource: Utilisation, Saturation, Errors.' },
    { id: 'f14', front: 'SLI vs SLO vs error budget', back: 'SLI: the measurement (% requests < 300 ms). SLO: the target (99.5% over 30 days). Error budget: the allowed miss (0.5%) that governs risk-taking.' },
    { id: 'f15', front: 'Why alert on symptoms not causes', back: 'Users feel error rate and latency, not CPU%. Cause-based alerts page for non-problems and create fatigue; symptom alerts tied to SLOs page only when action matters.' },
    { id: 'f16', front: 'Graceful degradation', back: 'Non-core failures must not block core flows: recommendations down -> show best sellers; search slow -> simpler DB query. Checkout never fails for a non-essential dependency.' },
    { id: 'f17', front: 'Why simplicity is a cost property', back: 'Each component adds bill, monitoring, upgrades, on-call knowledge and failure modes, paid every day. Fewest components that meet the NFRs wins.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Availability and single points of failure',
      prompt: 'Explain to a product manager why "we have a backup database" does not mean the system is highly available, and what would.',
      modelExplanation: `Availability is the fraction of time users can actually use the product. Having a backup database helps only if traffic reaches it quickly when the main one dies. If a human must wake up, log in and switch things over, the site is down for that whole time, maybe thirty minutes, which alone spends most of a 99.99% yearly budget of fifty-two minutes.

High availability needs two things together: a spare, and something automatic that notices the failure and moves traffic to the spare within seconds. For databases that is tooling like Patroni or a managed cloud database with multi-zone automatic failover.

Then you repeat the exercise for every other box: is there one load balancer, one queue server, one cache? Cover each with a finger and ask what users see. Anything whose loss shows users an error page is a single point of failure, and the fix is always the same pair: a spare plus automatic switchover.`,
      mustMention: [
        'Availability as fraction of time users can use the system',
        'Redundancy alone is insufficient; automatic failover is required',
        'Finger-over-the-box test for SPOFs',
        'Concrete tooling or managed service example',
      ],
    },
    {
      id: 'fe2',
      concept: 'Resilience patterns',
      prompt: 'Explain timeouts, retries with backoff, and circuit breakers to a junior developer, and how they work together.',
      modelExplanation: `When your service calls another one over the network, three things can go wrong: it can be slow, it can fail briefly, or it can be down for a while. Each pattern handles one of these.

A timeout handles slowness. Without one, a request can wait forever and hold a thread, and enough of those freeze your whole service. With a timeout of, say, 500 ms you give up and do something else.

A retry handles brief failures. But if a thousand callers all retry immediately, they hit the struggling service with a wave that knocks it down for good. So you wait before retrying, doubling the wait each time and adding randomness so callers do not retry in lockstep. You also only retry operations that are safe to repeat.

A circuit breaker handles long outages. After several failures in a row it "opens" and your calls fail instantly with a fallback instead of even trying, giving the other service time to recover. Every so often it lets one call through to check. Together: timeout so you never hang, backoff so you never storm, breaker so you never pile on.`,
      mustMention: [
        'Timeout prevents hung threads',
        'Retries need exponential backoff and jitter to avoid storms',
        'Retries only for idempotent operations',
        'Circuit breaker stops calling a failing dependency and returns a fallback',
      ],
    },
    {
      id: 'fe3',
      concept: 'Observability',
      prompt: 'Explain to a founder why the team wants to spend a sprint on metrics, logging and tracing before adding features.',
      modelExplanation: `Right now, when a customer says the app is slow, we guess. We restart things and hope. Observability is the set of instruments that let us see inside the running system without guessing.

Metrics are gauges: how many requests per second, how many fail, how slow the slowest one percent are. Logs are the flight recorder: for one specific request, exactly what happened, tagged with an id so we can find it in seconds. Traces show one request travelling through all our services so we can see that the two-second checkout spent 1.9 seconds waiting for the payment provider. Alerts wake someone only when customers are actually affected, not when a CPU is a bit busy.

The payoff is direct: outages get shorter because we find the cause in minutes instead of hours, and we stop building the wrong optimisations because the dashboards show exactly where the bottleneck is. It also tells us when to scale, which saves money on servers we are currently guessing about.`,
      mustMention: [
        'Metrics, logs, traces, alerts and what each answers',
        'Percentiles over averages',
        'Alerts on user-facing symptoms',
        'Shorter incidents and data-driven scaling decisions',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You inspect a modern hospital from the entrance to the finance office, checking whether it is a good system. Each department embodies one quality of a good system.',
    stops: [
      { locus: 'The department signboard in the lobby', concept: 'Components with single responsibility', image: 'A huge signboard lists departments, each with exactly one word: CARDIOLOGY, RADIOLOGY, PHARMACY. One old sign reading "CARDIOLOGY AND CATERING" is being sawn in half by two workers while patients cheer.' },
      { locus: 'The pneumatic tube station', concept: 'Clear communication with contracts', image: 'Samples fly through glass tubes between departments. Every capsule has a printed label: FORMAT, VERSION, TIMEOUT 30s, RETRY 3x. A capsule with no label is spat out onto the floor by the machine.' },
      { locus: 'The row of identical triage desks', concept: 'Scalability', image: 'Twenty identical triage desks with interchangeable nurses; when the queue grows, a new desk slides out of the wall and the line halves. In the corner, one lonely desk with the only stamp for approvals has a queue around the block.' },
      { locus: 'The generator room', concept: 'Availability and no SPOF', image: 'Two enormous generators. When the lights flicker, the second roars to life by itself within a second, and a sign flashes AUTO FAILOVER. A dusty third generator labelled "manual start, ask Dave" is covered in cobwebs.' },
      { locus: 'The emergency room', concept: 'Resilience and reliability', image: 'Doctors wear stopwatch armbands (timeouts), a wall chart shows retry intervals doubling (backoff), a big red breaker switch cuts off a malfunctioning machine (circuit breaker), and every wristband has a unique barcode scanned twice so no patient gets the same dose twice (idempotency).' },
      { locus: 'The monitoring station', concept: 'Observability', image: 'A wall of beeping monitors showing heart-rate graphs labelled p99, not "average". Each patient file has a barcode (correlation id), a map traces one patient\'s journey through every department, and an alarm sounds only when a patient is actually in danger.' },
      { locus: 'The finance office', concept: 'Cost-aware and simple', image: 'An accountant weighs every new machine on a scale against a bag of gold. A gleaming MRI for the broom closet is wheeled back out with a tag reading "not justified by requirements". The simplest ward, one bed and one nurse, has a gold star.' },
    ],
  },
  interviewQuestions: [
    'What makes a system "good"? Give a checklist and explain two items in depth.',
    'What is the difference between availability, reliability and resilience? Give an example of a system with one but not the others.',
    'How do you find single points of failure in an architecture, and what does removing one require?',
    'Two services each have 99.9% availability. What is the availability if a request needs both, and how would you improve it?',
    'What would you instrument on a brand-new service before it goes to production, and why?',
    'Describe a time you chose not to add a component. What was the reasoning?',
    'How do retries cause outages, and how do you retry safely?',
    'How would you decide the availability target for a new feature?',
  ],
}

export default chapter
