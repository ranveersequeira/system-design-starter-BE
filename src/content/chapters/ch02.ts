import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 2,
  slug: 'how-to-approach-system-design',
  title: 'How To Approach System Design',
  module: 'foundations',
  estimatedMinutes: 35,
  summary:
    'A repeatable method turns a vague problem statement into a defensible architecture: gather requirements, estimate scale, define APIs, model data, draw the high-level design, then deep dive into bottlenecks. The most reliable way to do this is iteratively: start with the simplest thing that works (usually one database), measure where it breaks, and add caches, replicas and partitions only when a number forces you to.',
  objectives: [
    'Run a structured design process: requirements -> estimation -> API -> data model -> high-level design -> deep dives.',
    'Extract measurable non-functional requirements and convert them into QPS, storage and bandwidth numbers.',
    'Define clean APIs and a data model before drawing any boxes.',
    'Apply the iterative "start with the DB, then cache, then scale" approach and justify each step with a bottleneck.',
    'Manage a 45-minute design interview so that every phase gets time and every decision has a stated reason.',
  ],
  quickRevision: [
    'Order of work: requirements -> estimation -> APIs -> data model -> high-level design -> deep dives -> failure modes.',
    'Spend the first 5-10 minutes on requirements; a design for the wrong problem scores zero.',
    'Functional requirements become APIs; non-functional requirements (scale, latency, availability, consistency) become architecture.',
    'Estimation converts DAU and behaviour into QPS, storage per year and bandwidth; 1 day is about 86,400 s, round to 100k.',
    'Read:write ratio decides where to invest: read-heavy -> caches and replicas, write-heavy -> partitioning and async ingestion.',
    'An API is a contract: name, inputs, outputs, error cases, idempotency. Write 3-6 of them, not thirty.',
    'Data model first: entities, relationships, access patterns. The access patterns decide the database, not fashion.',
    'High-level design is client -> load balancer -> stateless servers -> data stores; add components only for a stated reason.',
    'Iterate: single DB -> add index -> add cache -> add read replicas -> partition. Each step is triggered by a measured bottleneck.',
    'Never introduce a component you cannot justify with a requirement or a number; interviewers probe every box.',
    'Deep dives go where the risk is: the hot path, the biggest table, the component with the most traffic.',
    'For every arrow ask: sync or async, what if it fails, how much traffic. For every box ask: what if it dies.',
    'State trade-offs out loud: "I choose X over Y because requirement Z; the cost is W."',
  ],
  sections: [
    {
      id: 'gathering-requirements',
      title: 'Step 1: Gather and narrow requirements',
      body: `Every design conversation should begin with questions, not answers. The problem statement ("design Instagram") is deliberately vague. Your first job is to shrink it to something you can actually design in the time you have, and to surface the constraints that will shape the architecture.

**Functional requirements** are the features. For a photo-sharing app: upload a photo, follow a user, view a feed. Pick the two or three that matter most and say explicitly what you are *not* doing ("no stories, no DMs, no ads"). Scoping out is a sign of seniority, not laziness.

**Non-functional requirements (NFRs)** are what actually decide the shape of the system:

- **Scale**: daily active users, requests per second, data volume.
- **Latency**: p99 target for the hot path (feed load under 200 ms?).
- **Availability**: 99.9% or 99.99%? Is downtime tolerable during deploys?
- **Consistency**: must a follower see a post instantly, or within a few seconds?
- **Durability**: can we ever lose an uploaded photo? (Almost never acceptable.)
- **Cost and team**: budget, existing infrastructure, how many engineers operate it.

Stakeholders rarely state NFRs, so you must extract them. Ask "how many", "how fast", "how fresh", "how critical". When the interviewer says "assume a lot", propose a number yourself and move on: "I will assume 10 million DAU; tell me if that is off."

Write requirements down where everyone can see them. You will point back to them repeatedly when justifying decisions later, and the list keeps you from drifting into features nobody asked for.`,
      mentalModel:
        'A doctor does not prescribe before asking where it hurts, how long, and how badly. Requirements gathering is the diagnosis; the architecture is the prescription.',
      keyPoints: [
        'Narrow the problem: pick 2-3 core features and name what is out of scope.',
        'Functional requirements become APIs; NFRs become architecture.',
        'Extract numbers for scale, latency, availability, consistency, durability and cost.',
        'If numbers are not given, propose reasonable ones and state them.',
        'Keep the written list visible; every later decision must reference it.',
      ],
      checkpoint: {
        question:
          'You are asked to "design a URL shortener". List two functional requirements you would keep, one you would scope out, and three NFR questions you would ask.',
        answer:
          'Keep: create a short URL from a long one; redirect a short URL to the long one. Scope out: custom analytics dashboards or user accounts. NFR questions: how many URLs created per day and how many redirects per second? What redirect latency is acceptable (p99 under 50 ms)? How long must links live (durability and storage horizon)? Is a few seconds of delay before a new link works acceptable (consistency)?',
      },
    },
    {
      id: 'estimation',
      title: 'Step 2: Back-of-the-envelope estimation',
      body: `Estimation turns vague scale into numbers you can design against. The goal is not precision; it is knowing whether you are dealing with 10 QPS or 100,000 QPS, 1 GB or 1 PB, because those differ by architectures, not by instance sizes.

Start from user behaviour and multiply:

- **QPS**: 10 M DAU, each loading the feed 10 times a day = 100 M requests/day. A day is 86,400 s; round to 100,000 s. That is about 1,000 QPS average. Peak is typically 2-5x average, so plan for 3,000-5,000 QPS.
- **Writes**: 10 M DAU, 1 in 10 posts a photo daily = 1 M uploads/day, about 10 writes/s. Reads outnumber writes 100:1: a **read-heavy** system, which tells you caching and replicas will pay off.
- **Storage**: 1 M photos/day x 2 MB = 2 TB/day, about 730 TB/year. Metadata is tiny by comparison (1 M rows x 500 B = 500 MB/day). Blobs go to object storage (S3); metadata goes to a database.
- **Bandwidth**: 1,000 feed loads/s x 10 photos x 200 KB thumbnails = 2 GB/s outbound. That number alone justifies a CDN.

Keep a small table of reference numbers in your head: a single Postgres node comfortably handles a few thousand simple queries per second; one Redis node handles around 100k ops/s; an SSD reads about 1 GB/s; a cross-region round trip is 100-150 ms; 1 million per day is roughly 12 per second.

Estimation also protects you from over-engineering. If the answer is 50 QPS and 20 GB, the right design is one database with backups, and saying so is a strong signal. Sharding a 20 GB table is a mistake, not ambition.`,
      mentalModel:
        'Estimation is checking the weight of the luggage before choosing between a bicycle, a van and a freight train. You do not need the exact kilograms, only the order of magnitude.',
      diagram: `DAU x actions/user/day  = requests/day
requests/day / 100,000  = average QPS
average QPS x 3 (peak)  = design QPS

writes/day x bytes/row  = storage/day   x 365 = storage/year
reads/s x payload bytes = egress bandwidth

Example: 10M DAU, 10 feed loads -> 100M/day -> 1,000 QPS -> 3,000 peak
         1M uploads x 2MB -> 2TB/day -> ~730TB/year -> S3 + CDN`,
      keyPoints: [
        'Estimate QPS (average and peak), storage growth, and bandwidth; order of magnitude is enough.',
        'Read:write ratio steers investment: read-heavy favours caches and replicas.',
        'Large blobs belong in object storage; only metadata belongs in the database.',
        'Memorise a few capacity anchors (Postgres, Redis, SSD, network RTT).',
        'Small numbers justify a simple design; say so explicitly.',
      ],
      checkpoint: {
        question:
          'A chat app has 50 M DAU and each user sends 40 messages per day at 100 bytes each. Estimate messages per second, peak, and storage per year (metadata excluded).',
        answer:
          '50 M x 40 = 2 B messages/day; / 100,000 s = 20,000 messages/s average, roughly 60,000 at peak. Storage: 2 B x 100 B = 200 GB/day, about 73 TB/year. That write rate rules out a single relational node and points to partitioning by conversation.',
      },
    },
    {
      id: 'api-design',
      title: 'Step 3: Define the APIs',
      body: `APIs are the contract between clients and the system, and between components. Writing them down before drawing boxes forces you to be precise about what the system does, and it exposes hidden requirements ("wait, do we need pagination? idempotency?").

For each core functional requirement, write one endpoint with:

- **Name and verb**: \`POST /v1/urls\`, \`GET /v1/urls/{code}\`.
- **Inputs**: the fields and their constraints (long URL up to 2 KB, optional expiry).
- **Outputs**: what comes back, including status codes (201 created, 301 vs 302 for redirects).
- **Errors**: what happens on invalid input, not found, rate limit exceeded.
- **Idempotency**: can the client safely retry? A \`POST /payments\` must accept an idempotency key or a retry will double-charge.
- **Auth and rate limits**: who may call it and how often.

Choose the style by the consumer. REST over HTTP/JSON is the default for public and browser clients. gRPC (binary Protobuf, HTTP/2, streaming) suits internal service-to-service calls where latency and schema strictness matter. GraphQL fits clients that need flexible aggregation of many entities in one round trip, at the cost of harder caching and rate limiting.

Design for evolution: version the path or headers, never remove fields (deprecate them), and paginate every list with a cursor rather than an offset so that page 1,000 does not become a full table scan.

Three to six endpoints is plenty in an interview. The point is not completeness; it is proving that you think in contracts and that the data model you are about to draw actually serves these calls.`,
      mentalModel:
        'An API is a restaurant menu: it fixes what can be ordered, what you get, and what happens when the kitchen is out of something. The kitchen layout (architecture) is designed to serve the menu, not the other way around.',
      keyPoints: [
        'Write APIs before architecture; they are the functional requirements made precise.',
        'Each endpoint: verb, inputs, outputs, errors, idempotency, auth.',
        'REST for public clients, gRPC for internal low-latency calls, GraphQL for flexible aggregation.',
        'Cursor pagination and versioning make APIs survivable over years.',
        'Idempotency keys make retries safe for any mutating call.',
      ],
    },
    {
      id: 'data-model',
      title: 'Step 4: Model the data around access patterns',
      body: `The data model is the centre of gravity of most systems. Get it right and everything else is plumbing; get it wrong and no amount of caching saves you.

Start by listing **entities** and **relationships**: User, Post, Follow (user -> user), Like (user -> post). Then, before choosing a database, list the **access patterns** your APIs need:

- Get a post by id (point read).
- Get the latest 20 posts by a user (range scan by user, ordered by time).
- Get the feed of users I follow (fan-in across many users, the hard one).
- Count likes on a post (aggregate that changes constantly).

Now pick storage per pattern. Point reads and range scans on a well-indexed table are trivially served by Postgres or MySQL for hundreds of millions of rows. A fan-in feed that must return in 200 ms is usually precomputed (fan-out on write into a per-user feed list in Redis or Cassandra). A hot counter is better kept in Redis with periodic flush than updated with a row lock 10,000 times a second.

Decide **what is the source of truth** and what is a derived view. The posts table is truth; the precomputed feed is a cache that can be rebuilt. Being explicit about this tells you what must be durable and consistent versus what can be eventually consistent.

Sketch the key columns and the indexes that serve each access pattern: \`posts(user_id, created_at DESC)\` serves "latest posts by user". If you cannot name the index that serves a query, you have not finished the data model.

Finally, estimate row sizes and counts so you know when a table outgrows one node (roughly: when the working set no longer fits in RAM or a single node cannot absorb the write rate). That is your trigger for partitioning later, and you should be able to name the partition key now (user_id for posts, conversation_id for messages).`,
      mentalModel:
        'Designing a data model without knowing the queries is like organising a warehouse without knowing what the pickers will ask for. Shelves are arranged for the picking list, not for alphabetical neatness.',
      diagram: `Entities            Access pattern              Storage / index
--------            --------------              ---------------
User                get by id                   users(pk id)
Post                latest N by user            posts(user_id, created_at)
Follow              who does X follow           follows(follower_id)
Feed (derived)      first 20 for viewer         Redis list feed:{user}
LikeCount (derived) hot increments              Redis INCR -> flush to DB

Truth: users, posts, follows      Derived (rebuildable): feed, counts`,
      keyPoints: [
        'List entities, then access patterns, then choose storage; never the reverse.',
        'Every query must have a named index or precomputed structure that serves it.',
        'Separate source of truth from derived, rebuildable views.',
        'Hot counters and fan-in feeds are precomputed or kept in memory, not computed per request.',
        'Name the future partition key now even if you start with one database.',
      ],
      checkpoint: {
        question:
          'For a food-delivery app, name three entities, one access pattern that is a simple indexed lookup, and one that would need a precomputed or specialised structure.',
        answer:
          'Entities: Restaurant, Order, Rider. Simple lookup: "orders by customer sorted by time" served by orders(customer_id, created_at). Specialised: "restaurants within 3 km of the user" needs a geospatial index (PostGIS, Redis GEO, or geohash buckets), not a plain B-tree.',
      },
    },
    {
      id: 'high-level-design',
      title: 'Step 5: Draw the high-level design',
      body: `Now, and only now, draw boxes. The high-level design should show the request path for each core API and every place data is stored. Start with the smallest architecture that satisfies the numbers you estimated.

A typical first draft:

1. **Clients** (web, mobile) call a **load balancer** (Nginx, HAProxy, AWS ALB).
2. The balancer spreads traffic over **stateless application servers**. Stateless means any server can serve any request, so you can add or remove servers freely and a crash loses nothing.
3. Servers read and write a **primary database** (Postgres/MySQL).
4. Large files go to **object storage** (S3) and are served through a **CDN**.
5. Slow or non-critical work (sending emails, resizing images, updating counters) goes to a **queue** (RabbitMQ, SQS, Kafka) and is done by **workers**.

Then walk through each API end to end on the diagram: "POST /photos: server validates, writes the blob to S3, inserts metadata in Postgres, publishes an event; a worker generates thumbnails." If a step has no box, add one. If a box serves no step, delete it.

Resist adding components speculatively. A cache appears when reads exceed what the database can serve or when latency demands it. A message broker appears when a step must be decoupled or absorbed in bursts. A search engine appears when queries need full-text or faceting. Each box should be introduced with the sentence "because of requirement X". Interviewers routinely ask "why is that there?" and "what happens if it dies?"; if you cannot answer both, the box should not be on the board.

Mark, for every arrow, whether it is synchronous or asynchronous and roughly how much traffic flows through it. Those annotations are what you will use in the next step to find the bottleneck.`,
      mentalModel:
        'The high-level design is the subway map: stations (components) and lines (interactions), with no track detail. If a station has no line into it, it is not part of the network.',
      diagram: `[Web/Mobile] --> [LB: Nginx/ALB] --> [App servers, stateless] x N
                                          |        |         |
                                   sync   |        | sync    | async
                                          v        v         v
                                   [Postgres]   [S3 blobs]  [Queue]
                                    primary        |          |
                                                 [CDN]     [Workers]
Every box: why is it here? what if it dies?
Every arrow: sync/async? traffic? failure behaviour?`,
      keyPoints: [
        'Start with LB -> stateless servers -> primary DB -> object storage -> queue for async work.',
        'Trace every API through the diagram; each step needs a box, each box needs a step.',
        'Introduce every component with "because of requirement X".',
        'Stateless servers are what make horizontal scaling trivial.',
        'Annotate arrows with sync/async and traffic to prepare for bottleneck hunting.',
      ],
    },
    {
      id: 'deep-dives',
      title: 'Step 6: Deep dive where the risk is',
      body: `With the skeleton on the board, spend the remaining time where the system is most likely to break. Do not deep dive everywhere; pick the two or three highest-risk areas and go deep. The interviewer will usually steer you, but you should have your own list ready.

**Find the bottleneck by numbers.** Look at the arrows you annotated. 3,000 feed reads per second, each needing posts from 500 followed users, is 1.5 M row reads per second against Postgres: that arrow is red. Ten uploads per second is not. Deep dive the red one.

**Typical deep-dive topics:**

- **Hot path latency**: precompute feeds, add a Redis cache, use a CDN for media.
- **Write amplification**: a celebrity with 50 M followers makes fan-out on write explode; use a hybrid (fan-out on write for normal users, fan-out on read for celebrities).
- **The biggest table**: when posts reach billions of rows, how do you partition, and by what key?
- **Consistency edge cases**: a user deletes a post that is already in 10,000 feeds; how is it removed or filtered?
- **Uniqueness under concurrency**: generating short codes or usernames without collisions across many servers (database unique constraint, or a pre-allocated key range service).
- **Failure modes**: what happens when the cache cluster dies (thundering herd on the DB), when a replica lags, when the queue backs up.

For each deep dive, use the same pattern as always: state the problem with a number, propose two or three options, name the trade-off of each, pick one and say why. "Fan-out on write gives 10 ms feed reads but costs 50 M writes per celebrity post; fan-out on read costs nothing on write but makes reads expensive; hybrid gets us both at the price of two code paths."

End the deep dives by revisiting the NFR list and checking each one off: availability (no single point of failure?), latency (hot path served from memory?), durability (blobs replicated, DB backed up?). Unchecked items are your remaining risks; say them aloud.`,
      mentalModel:
        'A structural engineer does not test every bolt in the bridge; they compute the loads, find the three most stressed joints, and examine those under a microscope.',
      keyPoints: [
        'Use the traffic numbers on your arrows to find the bottleneck; deep dive there.',
        'Common deep dives: hot-path latency, fan-out, biggest table partitioning, uniqueness under concurrency, failure modes.',
        'Always: problem with number -> 2-3 options -> trade-offs -> choice with reason.',
        'Finish by checking each NFR against the design and naming what remains risky.',
      ],
      checkpoint: {
        question:
          'In a URL shortener with 10,000 redirects/s and 10 creates/s, which path deserves the deep dive, and what would your first two improvements be?',
        answer:
          'The redirect path: 10,000 reads/s is 1,000x the writes. First, cache code -> long URL in Redis (or in-process LRU) since the mapping is immutable and hit rates will be high. Second, put a CDN or edge in front for the hottest links, and add read replicas as a fallback for cache misses. The create path can stay a plain insert with a unique constraint.',
      },
    },
    {
      id: 'iterative-approach',
      title: 'The iterative approach: DB first, then cache, then scale',
      body: `The most reliable way to design, in interviews and in production, is to build the simplest system that satisfies the functional requirements and then evolve it one bottleneck at a time. Every step is triggered by a measured or estimated limit, never by fashion. Use this iterative approach throughout your design practice.

**Iteration 0: one database.** A stateless API in front of a single Postgres or MySQL node. This serves thousands of QPS and hundreds of GB comfortably. Add correct indexes. Most products never need to leave this stage, and saying so shows judgement.

**Iteration 1: reads outgrow the DB.** Symptoms: CPU pegged by repeated identical queries, p99 rising. Fix: add a **cache** (Redis, Memcached) for hot reads with a TTL or explicit invalidation. Cost: staleness, cache-miss storms, one more thing to run.

**Iteration 2: still read-bound or need read availability.** Add **read replicas** and route reads to them. Cost: replication lag, so reads that must be fresh (read-your-own-writes) go to the primary.

**Iteration 3: writes or data size outgrow one node.** The working set no longer fits in RAM, or write IOPS saturate. **Vertically scale** first (bigger box is the cheapest option until it is not). Then **partition** (shard) by the key you named in the data model. Cost: no cross-shard transactions or joins, rebalancing pain, routing logic.

**Iteration 4: coupling and bursts.** Introduce a **message queue** to absorb write spikes and decouple slow side effects. Cost: eventual consistency, duplicate delivery to handle.

**Iteration 5: specialised stores.** Full-text search to Elasticsearch, time series to a TSDB, blobs to S3, analytics to a warehouse. Each because a query type the relational store handles badly has appeared.

Narrate this evolution in an interview and you demonstrate exactly what the question is testing: that you know what each component buys, what it costs, and when it becomes necessary. Jumping straight to a 15-box microservices diagram demonstrates the opposite.`,
      mentalModel:
        'Grow a system like a city grows: one road until it jams, then a bypass, then a highway, then a second town. Nobody builds the ring road before the first house.',
      diagram: `Iter 0   [API] -> [Postgres]                   thousands QPS, GBs
   |  reads saturate CPU
Iter 1   [API] -> [Redis] -> [Postgres]         hot reads from RAM
   |  still read-bound / need HA
Iter 2   [API] -> [Redis] -> [Primary] => [Replica x N]
   |  writes or data outgrow one node
Iter 3   bigger box, then [Shard A][Shard B][Shard C] by key
   |  bursts, slow side effects
Iter 4   [API] -> [Queue] -> [Workers]           decouple, absorb
   |  query types DB handles badly
Iter 5   + [Search] [S3+CDN] [Warehouse]`,
      keyPoints: [
        'Start with one well-indexed database and stateless servers; most systems stop there.',
        'Add a cache when reads saturate the DB; add replicas when still read-bound or for availability.',
        'Scale vertically before sharding; shard when write rate or working set exceeds one node.',
        'Add queues for bursts and decoupling; add specialised stores for query types the DB handles badly.',
        'Every step is triggered by a number and paid for with a named cost.',
      ],
      checkpoint: {
        question:
          'A product runs on one Postgres node. Monitoring shows 90% of queries are identical product-page reads, CPU is at 95%, and writes are 20/s. What is the next iteration and why not sharding?',
        answer:
          'Add a Redis cache for product pages (iteration 1); the problem is repeated hot reads, which a cache eliminates almost entirely. Sharding is wrong: writes are trivial and the data likely fits one node; sharding would add routing complexity and lose joins without addressing the actual bottleneck.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What is the correct order of phases in a structured system-design approach?',
      options: [
        'High-level design -> APIs -> requirements -> estimation',
        'Requirements -> estimation -> APIs -> data model -> high-level design -> deep dives',
        'Data model -> requirements -> deep dives -> estimation',
        'Estimation -> deep dives -> requirements -> APIs',
      ],
      answerIndex: 1,
      explanation:
        'You cannot estimate before knowing what the system does, cannot define APIs before knowing the features, and cannot draw boxes sensibly before knowing the data and access patterns. Deep dives come last because they target bottlenecks revealed by the earlier phases.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: '10 million DAU each make 20 requests per day. Roughly what average QPS should you design against, before applying a peak factor?',
      options: ['200 QPS', '2,000 QPS', '20,000 QPS', '200,000 QPS'],
      answerIndex: 1,
      explanation:
        '10 M x 20 = 200 M requests/day. Dividing by about 100,000 seconds per day gives roughly 2,000 QPS. 20,000 would be a factor-of-ten slip (dividing by 10,000), a common mistake when rushing arithmetic.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Which artefact should you produce immediately after the functional requirements are agreed and before drawing the architecture?',
      options: [
        'A list of microservices',
        'A cost estimate for cloud hosting',
        'The API contracts and the data model with access patterns',
        'A deployment pipeline',
      ],
      answerIndex: 2,
      explanation:
        'APIs make the functional requirements precise, and access patterns decide storage choices. Boxes drawn before this are guesses. Microservice lists and pipelines are implementation details that come much later, if at all.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which of the following should be part of every API definition in a design? Select all that apply.',
      options: [
        'Inputs and their constraints',
        'The programming language of the implementation',
        'Error responses',
        'Idempotency behaviour for mutating calls',
        'The number of servers behind it',
      ],
      answerIndices: [0, 2, 3],
      explanation:
        'A contract specifies inputs, outputs, errors and whether retries are safe. Language and server count are implementation details that the contract deliberately hides so they can change without breaking clients.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement: 'In the iterative approach, sharding the database should be one of the first steps because it is the hardest to retrofit later.',
      answer: false,
      explanation:
        'Sharding is a late step, triggered only when write rate or data size exceeds a single node after vertical scaling. Caches and read replicas come first because most systems are read-heavy. Naming the future shard key early is wise, but sharding early adds complexity without addressing the actual bottleneck.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question: 'A single Postgres node is at 95% CPU. Metrics show 85% of queries are identical reads of the same 1,000 rows; writes are 15 per second. What is the best next step?',
      options: [
        'Shard the database by user id',
        'Add a Redis cache for the hot rows',
        'Move to Cassandra for write throughput',
        'Add a message queue in front of the database',
      ],
      answerIndex: 1,
      explanation:
        'The bottleneck is repeated hot reads, which a cache removes almost completely. Sharding addresses write or data-size limits that do not exist here; Cassandra solves write scale, also not the problem; a queue helps bursts of writes, and writes are trivial.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'Why does estimating the read:write ratio matter so much early in a design?',
      options: [
        'It determines the programming language',
        'It decides whether investment goes into caches and replicas (read-heavy) or partitioning and async ingestion (write-heavy)',
        'It sets the API versioning scheme',
        'It is required to calculate availability percentages',
      ],
      answerIndex: 1,
      explanation:
        'Read-heavy systems get the biggest win from caching and read replicas; write-heavy systems need partitioning, batching or queues. Knowing the ratio tells you which iteration of the scaling ladder you will reach first.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: 'Adding a component to a high-level design without being able to state which requirement it serves is a warning sign.',
      answer: true,
      explanation:
        'Every box should be introduced with "because of requirement X" and should have an answer to "what happens if it dies". Speculative components add cost and failure modes without benefit.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'You have 15 minutes left in a 45-minute interview and a working high-level design. What is the best use of the time?',
      options: [
        'Redraw the diagram more neatly',
        'Add every component you know (search, cache, CDN, queue) to show breadth',
        'Identify the highest-traffic or highest-risk path from your estimates and deep dive its bottlenecks and failure modes',
        'Discuss which cloud provider to use',
      ],
      answerIndex: 2,
      explanation:
        'Deep dives targeted by numbers demonstrate judgement; the interviewer wants to see you find the weak joint and reason about options and trade-offs. Adding components indiscriminately or discussing vendors shows the opposite.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 1,
      question: 'Which of the following is a derived (rebuildable) structure rather than a source of truth in a social feed system?',
      options: [
        'The posts table',
        'The follows table',
        'The per-user precomputed feed list in Redis',
        'The users table',
      ],
      answerIndex: 2,
      explanation:
        'The feed can always be rebuilt from posts and follows, so it may be eventually consistent and may live in a cache. Posts, follows and users are truth and must be durable.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'You are asked to design a ticket-booking system for 5 M DAU. Walk through the first three phases (requirements, estimation, APIs) in outline, with numbers.',
      modelAnswer: `**Requirements.** Functional: search events, view seat availability, reserve and pay for seats. Out of scope: refunds, resale, recommendations. NFRs: no double booking (strong consistency on seat reservation), p99 under 500 ms for search, 99.95% availability, payment durability.

**Estimation.** 5 M DAU x 10 searches = 50 M searches/day, about 500 QPS average, 2,500 at peak (concert on-sale spikes can be 50x, so plan a queue or waiting room). Bookings: 1 in 50 users books daily = 100k bookings/day, about 1/s average but bursty. Storage: 100k bookings x 1 KB = 100 MB/day; trivial. Read-heavy overall, but the reservation path is the correctness-critical hot spot.

**APIs.** \`GET /events?query=&date=\` (cursor paginated), \`GET /events/{id}/seats\`, \`POST /reservations\` with an idempotency key, body {eventId, seatIds}, returns 201 with a hold that expires in 10 minutes, or 409 if any seat is taken; \`POST /reservations/{id}/pay\`.`,
      rubric: [
        'Scopes functional requirements and states an out-of-scope list.',
        'Names measurable NFRs including strong consistency for seat reservation.',
        'Estimates QPS with a peak factor and notes the on-sale burst problem.',
        'Defines 3-4 APIs with idempotency on the reservation call.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain the iterative "DB first, then cache, then scale" approach and why it is preferred over designing the final architecture upfront.',
      modelAnswer: `Start with stateless servers and one well-indexed relational database. When reads saturate the database, add a cache for hot data. When it is still read-bound or needs read availability, add read replicas. When writes or data size exceed one node, scale vertically, then partition by a key chosen from the access patterns. Add a queue when bursts or slow side effects need decoupling, and specialised stores (search, blob storage) when query types appear that the database handles badly.

It is preferred because every component is justified by a measured bottleneck, so you never pay for complexity you do not need. It also keeps the system understandable, and it lets you say "this stage is sufficient" when the numbers are small, which is a real design decision, not a shortcut.`,
      rubric: [
        'Lists the iterations in the right order with their triggers.',
        'Mentions that each step is driven by a bottleneck or number.',
        'Names at least one cost per step (staleness, lag, loss of joins).',
        'Explains why upfront complexity is a liability.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 2,
      question: 'What are the two questions you must be able to answer for every box, and the three for every arrow, in a high-level design?',
      modelAnswer: `**Every box:** Why is it here (which requirement or number forces it)? What happens if it dies (is it a single point of failure, and how does the system degrade)?

**Every arrow:** Is it synchronous or asynchronous? How much traffic flows through it (so you can find the bottleneck)? What happens when the callee is slow or unavailable (timeouts, retries, fallbacks, queueing)?`,
      rubric: [
        'Box: justification by requirement.',
        'Box: failure behaviour.',
        'Arrow: sync vs async, traffic volume, failure handling.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Phases of a structured design approach', back: 'Requirements -> estimation -> APIs -> data model -> high-level design -> deep dives -> failure modes and trade-offs.' },
    { id: 'f2', front: 'Seconds in a day (for estimation)', back: '86,400; round to 100,000. So 1 M/day is about 10-12 per second.' },
    { id: 'f3', front: 'Peak factor', back: 'Design for 2-5x average QPS; special events (sales, on-sale moments) can be 10-50x and need queues or throttling.' },
    { id: 'f4', front: 'Why the read:write ratio matters', back: 'Read-heavy -> caches, replicas, CDN. Write-heavy -> partitioning, batching, async ingestion via queues.' },
    { id: 'f5', front: 'What goes into an API definition', back: 'Verb and path, inputs with constraints, outputs and status codes, error cases, idempotency, auth and rate limits.' },
    { id: 'f6', front: 'REST vs gRPC vs GraphQL (when)', back: 'REST: public/browser clients. gRPC: internal low-latency, strict schema, streaming. GraphQL: clients needing flexible aggregation; harder to cache and rate limit.' },
    { id: 'f7', front: 'Data model rule', back: 'List entities, then access patterns, then pick storage and indexes. Every query must have a named index or precomputed structure serving it.' },
    { id: 'f8', front: 'Source of truth vs derived view', back: 'Truth must be durable and consistent (posts, users). Derived views (feeds, counters) are rebuildable and may be eventually consistent, often in Redis.' },
    { id: 'f9', front: 'Default first high-level design', back: 'Clients -> load balancer -> stateless app servers -> primary DB; blobs in S3 behind a CDN; slow side effects via a queue to workers.' },
    { id: 'f10', front: 'Why stateless servers', back: 'Any server can handle any request, so adding, removing or losing a server needs no coordination. Session state lives in a shared store (Redis) or a signed token.' },
    { id: 'f11', front: 'Two questions for every box', back: 'Which requirement or number justifies it? What happens when it dies?' },
    { id: 'f12', front: 'Iterative scaling ladder', back: 'One DB + indexes -> cache -> read replicas -> vertical scale -> shard -> queue for bursts -> specialised stores. Each step triggered by a bottleneck.' },
    { id: 'f13', front: 'Trigger for sharding', back: 'Write IOPS or working set exceed what one (already vertically scaled) node can hold. Not before; sharding loses joins and cross-shard transactions.' },
    { id: 'f14', front: 'How to pick deep-dive topics', back: 'Follow the numbers on the arrows: the highest-traffic or correctness-critical path (feed fan-out, biggest table, uniqueness under concurrency, cache failure).' },
    { id: 'f15', front: 'Capacity anchors', back: 'Postgres node: thousands of simple QPS. Redis node: ~100k ops/s. SSD: ~1 GB/s. Cross-region RTT: 100-150 ms. 2 MB photo x 1 M/day = 2 TB/day.' },
    { id: 'f16', front: 'Cursor vs offset pagination', back: 'Offset makes deep pages scan and skip rows (slow, inconsistent). Cursor (after id/timestamp) is O(page) via an index and stable under inserts.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'The structured design process',
      prompt: 'Explain to a new graduate how you would approach "design a photo-sharing app" in 45 minutes, phase by phase.',
      modelExplanation: `First I ask questions for five minutes: which features matter (upload, follow, feed), and how big (I propose 10 M daily users), how fast the feed must load, and whether a follower can see a post a few seconds late. Then I do quick maths: 10 M users loading the feed ten times a day is about a thousand requests a second, three thousand at peak, and a million uploads a day is two terabytes of photos daily, so photos go to object storage behind a CDN and only metadata goes in the database.

Next I write three or four API calls, then list the entities and the queries each API needs, and name the index for each. Only then do I draw boxes: load balancer, stateless servers, Postgres, S3, a queue for thumbnails. Finally I chase the scariest number, the feed fan-in, and discuss precomputing feeds versus computing on read, with the trade-offs, and check each requirement against the design.`,
      mustMention: [
        'Requirements and scoping before anything else',
        'Estimation producing QPS and storage numbers',
        'APIs and data model before drawing boxes',
        'High-level design with justified components',
        'Deep dive targeted at the bottleneck',
      ],
    },
    {
      id: 'fe2',
      concept: 'Back-of-the-envelope estimation',
      prompt: 'Explain why and how you estimate scale before designing, to someone who thinks it is pointless because the numbers are made up.',
      modelExplanation: `The numbers are approximate, but the decisions they drive are not. Ten requests a second and ten thousand requests a second are not the same system with bigger servers; they are different architectures. Estimation tells you which one you are building.

The method is simple multiplication. Take daily users, multiply by actions per user to get requests per day, divide by roughly a hundred thousand seconds to get requests per second, then multiply by three for peak. For storage, multiply writes per day by bytes per write and then by 365. For bandwidth, multiply reads per second by payload size.

A worked example: a million photos a day at two megabytes is two terabytes a day. That single number tells you photos cannot live in a relational database and that you need object storage and probably a CDN. Being off by a factor of two would not change that conclusion; being off by a factor of a hundred would, which is why you check the order of magnitude and move on.`,
      mustMention: [
        'Order of magnitude decides architecture, not precision',
        'DAU x actions / 100k seconds = QPS, with a peak factor',
        'Storage and bandwidth estimates',
        'A concrete example leading to a design decision',
      ],
    },
    {
      id: 'fe3',
      concept: 'Iterative scaling: DB first, then cache, then scale',
      prompt: 'Explain the iterative approach to a colleague who wants to start a new product with microservices, Kafka and a sharded database.',
      modelExplanation: `Every component we add costs money, operations effort and new ways to fail. So we add one only when a measured problem demands it. On day one we run stateless servers against a single, well-indexed Postgres. That handles thousands of requests per second and hundreds of gigabytes, which is more than most products ever see.

When the database CPU is saturated by repeated reads, we add a Redis cache and accept a little staleness. If reads still dominate or we need read availability, we add replicas and route fresh-sensitive reads to the primary. If writes or data size outgrow one machine, we buy a bigger machine, and only after that do we shard, by a key we chose early from the access patterns. Kafka enters when we have bursty writes or slow side effects to decouple.

Starting with the end state means paying all those costs before we know which problems we will actually have, and losing joins and transactions we still need.`,
      mustMention: [
        'Start with one database and stateless servers',
        'Cache when reads saturate; replicas for reads and availability',
        'Vertical scaling before sharding',
        'Each step triggered by a measured bottleneck and paid for with a named cost',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You are an architect walking through your studio from the front desk to the workshop at the back, following the exact order in which a building, and a system, gets designed.',
    stops: [
      { locus: 'The front desk with a clipboard', concept: 'Gather requirements', image: 'A client shouts "build me something big!" while the receptionist calmly hands them a clipboard with only six blanks: HOW MANY, HOW FAST, HOW OFTEN DOWN, HOW FRESH, NEVER LOSE, BUDGET. Nothing proceeds until every blank is filled in thick red ink.' },
      { locus: 'The napkin-covered coffee table', concept: 'Back-of-envelope estimation', image: 'Hundreds of coffee-stained napkins, each with one giant multiplication: 10M x 10 / 100,000 = 1,000. A napkin folded into a paper plane labelled "x3 PEAK" flies across the room and lands on a sign that says S3 + CDN.' },
      { locus: 'The glass wall covered in contracts', concept: 'Define the APIs', image: 'Legal contracts are taped to the glass, each stamped with a verb: POST, GET. Every contract has a clause in bold: IF RETRIED, NOTHING DOUBLE-CHARGES. A tiny lawyer with a magnifying glass checks the error clauses.' },
      { locus: 'The warehouse shelving model', concept: 'Data model around access patterns', image: 'A miniature warehouse where shelves are arranged not alphabetically but by the picking list pinned to the wall: "latest 20 by user" has its own shelf sorted by time; a glowing red box labelled FEED says REBUILDABLE on its side.' },
      { locus: 'The subway map on the ceiling', concept: 'High-level design', image: 'A subway map painted above you: LOAD BALANCER station feeds a row of identical STATELESS stations, which connect to POSTGRES, S3 and a conveyor-belt line to WORKERS. Any station without a line into it is being painted over by a worker on a ladder.' },
      { locus: 'The microscope bench', concept: 'Deep dive where the risk is', image: 'Only one joint of the model bridge is under the microscope: the arrow glowing red hot with "1.5M row reads/s". Everything else is left cold on the bench, deliberately ignored.' },
      { locus: 'The growing city model in the workshop', concept: 'Iterate: DB, then cache, then scale', image: 'A model city grows as you watch: a single house with a POSTGRES sign; a jam of tiny cars appears and a REDIS bypass is built; then a second road (REPLICAS); then the town splits in two (SHARDS) with a river between them, and a conveyor belt (QUEUE) carries parcels across. A plaque reads: NO RING ROAD BEFORE THE FIRST HOUSE.' },
    ],
  },
  interviewQuestions: [
    'Walk me through how you would structure the first ten minutes of a system-design interview.',
    'Estimate the QPS, storage and bandwidth for a service like Twitter with 300 M DAU; state your assumptions.',
    'Why do you define APIs and a data model before drawing the architecture?',
    'How do you decide which part of a design to deep dive?',
    'Describe how you would evolve a single-database system as traffic grows 100x, and what triggers each step.',
    'When would you refuse to add a cache or a message queue to a design?',
    'How do you choose a shard key early even if you do not shard on day one?',
  ],
}

export default chapter
