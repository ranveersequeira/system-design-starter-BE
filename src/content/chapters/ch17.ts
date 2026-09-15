import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 17,
  slug: 'circuit-breakers',
  title: 'Circuit Breakers',
  module: 'resilience',
  estimatedMinutes: 35,
  summary:
    'A circuit breaker is a client-side guard that stops a service from repeatedly calling a dependency that is already failing, so that one slow or dead component does not drag the whole system down with it. This chapter explains how cascading failures actually propagate, how the closed/open/half-open state machine works, and how breakers combine with timeouts, retries, bulkheads and fallbacks to build systems that degrade gracefully instead of collapsing.',
  objectives: [
    'Explain, step by step, how a single slow dependency turns into a cascading failure across a call chain.',
    'Describe the three circuit breaker states, the transitions between them, and the thresholds that drive each transition.',
    'Choose sensible timeouts, retry policies (with exponential backoff and jitter) and fallbacks for a given dependency.',
    'Apply bulkheads and breakers together to isolate failures, and decide where in the architecture a breaker belongs.',
    'Compare library-based breakers (Hystrix, resilience4j) with mesh or proxy-based ones (Envoy, Istio) and know their trade-offs.',
  ],
  quickRevision: [
    'Cascading failure: a slow dependency holds caller threads/connections, the caller becomes slow, its callers pile up, and the whole chain fails; slowness is more dangerous than a clean crash.',
    'Circuit breaker states: CLOSED (calls pass, failures counted) -> OPEN (calls fail fast, no network) -> HALF-OPEN (a few trial calls) -> CLOSED on success or back to OPEN on failure.',
    'Trip conditions are usually rate based over a sliding window: e.g. >= 50% failures out of a minimum of 20 calls in the last 10 seconds; slow calls above a latency threshold count as failures too.',
    'OPEN state lasts a configured wait duration (e.g. 30 s); it protects the dependency from a retry storm and gives it time to recover.',
    'Fail fast is the point: an open breaker returns an error or fallback in microseconds instead of holding a thread for a 30 s timeout.',
    'Every remote call needs a timeout; without one a breaker cannot even observe failure, because a hung call never returns.',
    'Retries multiply load: 3 retries on a failing dependency triple its traffic; only retry idempotent operations, with a retry budget, exponential backoff and jitter.',
    'Jitter randomises backoff so thousands of clients do not retry in synchronised waves (the thundering herd).',
    'Bulkhead: give each dependency its own thread pool, connection pool or semaphore so one dependency exhausting resources cannot starve the others.',
    'Fallbacks: cached/stale value, default value, degraded feature, or queue for later; a fallback must be cheaper and more reliable than the primary call.',
    'Breakers live in the caller (client side); one breaker per dependency (or per dependency per host), not one global breaker.',
    'Hystrix (Netflix, now in maintenance) popularised the pattern; resilience4j is the lightweight successor for the JVM; Envoy/Istio implement outlier detection at the proxy layer.',
    'Breaker state must be observable: emit metrics and alerts on state changes, because an open breaker is a partial outage that users may not notice.',
  ],
  sections: [
    {
      id: 'cascading-failures',
      title: 'How one slow service takes down the whole system',
      body: `Distributed systems rarely die because one machine crashes. They die because one component becomes **slow** and everything that depends on it waits.

Consider a call chain: the mobile app hits **API Gateway -> Order Service -> Inventory Service -> Postgres**. Inventory's database gets a lock contention problem and queries that took 5 ms start taking 5 seconds.

1. Inventory Service threads block on the database. Its request handler pool (say 200 threads) fills within seconds.
2. Order Service is calling Inventory synchronously with no timeout. Each order request now holds an Order thread for 5+ seconds. Order's pool of 200 threads fills too, even though Order itself is perfectly healthy.
3. The API Gateway keeps accepting user requests and forwarding them; its connections to Order pile up. Users see spinners, and they hit refresh, which sends *more* requests.
4. Health checks on Order start timing out, the load balancer marks Order instances unhealthy, remaining instances receive all the traffic, and they fall over faster.

Notice three properties of the cascade. First, **healthy services fail** because they run out of threads, sockets or memory waiting on an unhealthy one. Second, **retries amplify it**: every client retry is another request to a dependency that is already drowning. Third, **recovery is prevented**: even when the database lock clears, Inventory is buried under a backlog of queued requests plus retries and cannot climb out.

A hard crash is far kinder than slowness. A crashed process refuses connections instantly and callers can fail fast. A slow process consumes the caller's resources while giving nothing back. The whole discipline of resilience engineering is about converting slow failures into fast, contained failures, and the circuit breaker is the central tool for that.`,
      mentalModel:
        'A cascading failure is a traffic jam on a highway. One stalled car in one lane does not block the road, but if every car behind it waits politely in the same lane instead of switching lanes or turning off, the jam grows backwards for kilometres and blocks exits that had nothing to do with the stalled car.',
      diagram: `Time 0s      Time 5s              Time 15s
[App]        [App]  spinner        [App]  refresh! refresh!
  |            |                     |  xxxxx
[Gateway]    [Gateway] conns 80%   [Gateway] conns 100%  DOWN
  |            |                     |
[Order]      [Order] threads 100%  [Order]  DOWN (was healthy!)
  |            |  (waiting)          |
[Inventory]  [Inventory] 100%      [Inventory] DOWN + retry storm
  |            |                     |
[Postgres]   [Postgres] slow 5s    [Postgres] lock cleared, but
             (lock contention)      buried under backlog`,
      keyPoints: [
        'Slow dependencies are more dangerous than dead ones because they hold caller resources.',
        'Healthy services fail when their thread/connection pools fill up waiting.',
        'Retries and user refreshes amplify load on the component least able to take it.',
        'A backlog of queued requests can prevent recovery even after the root cause is fixed.',
      ],
      checkpoint: {
        question:
          'Inventory Service crashes outright (process dies, port closed) instead of becoming slow. Is the cascade to Order Service worse or better? Why?',
        answer:
          'Better. Connections to a dead port are refused in milliseconds, so Order threads are freed immediately and Order can return an error or fallback. The cascade is caused by waiting, and a hard crash removes the wait. This is why "fail fast" is the goal of a breaker.',
      },
    },
    {
      id: 'state-machine',
      title: 'The circuit breaker state machine',
      body: `A circuit breaker wraps every call to a specific dependency and keeps statistics about the outcomes. It has three states.

**CLOSED** (normal operation). Calls pass through. Each result is recorded in a sliding window: success, failure (exception, 5xx, timeout) or "slow call" (took longer than a configured latency threshold). If the failure rate crosses a threshold, the breaker trips to OPEN.

**OPEN** (tripped). Calls do **not** go to the network. The breaker immediately throws a \`CallNotPermittedException\` (resilience4j naming) or returns the configured fallback. This is the fail-fast behaviour: a call that would have waited 30 seconds for a timeout now fails in a microsecond, freeing the caller's thread. The breaker stays OPEN for a **wait duration**, for example 30 seconds.

**HALF-OPEN** (probing). After the wait duration, the breaker lets a small number of trial calls through (for example 5). If enough of them succeed, the dependency is considered recovered and the breaker goes back to CLOSED with fresh statistics. If they fail, it returns to OPEN for another wait period.

Why the half-open state? Without it you have two bad options: stay open forever (never recover) or flip straight to closed (send the full flood back to a service that may still be fragile, and re-trigger the cascade). Half-open sends a trickle, which is exactly the load a recovering service can handle.

The window is what makes the decision robust. A **count-based** window looks at the last N calls (say 100). A **time-based** window looks at the last T seconds. Both are combined with a **minimum number of calls**: a 100% failure rate is meaningless if it is one failed call out of one, so the breaker will not trip until it has seen, say, 20 samples. Netflix's Hystrix defaulted to a 10 second rolling window, 20 request volume threshold and 50% error percentage, and those remain sensible starting points.`,
      mentalModel:
        'It is exactly the electrical breaker in your house. Normal current flows (closed). A short circuit trips it so the wiring does not melt (open). You flip it back tentatively; if it trips again immediately, the fault is still there (half-open failing back to open).',
      diagram: `                 failure rate >= threshold
                 (over min. N calls)
   +--------+  ------------------------->  +------+
   | CLOSED |                              | OPEN |
   +--------+  <---------+                 +------+
       ^                 |                    |
       |                 | trial calls OK     | wait duration
       |                 |                    | elapsed (e.g. 30s)
       |          +-----------+               |
       +--------- | HALF-OPEN | <-------------+
      (reset      +-----------+
       stats)           |
                        | trial calls FAIL
                        +---------------------> back to OPEN`,
      keyPoints: [
        'CLOSED passes calls and counts outcomes in a sliding window.',
        'OPEN fails fast without touching the network for a fixed wait duration.',
        'HALF-OPEN lets a few probe calls through to test recovery safely.',
        'Trip on a failure rate over a minimum sample size, never on a single failure.',
        'Slow calls above a latency threshold should count as failures.',
      ],
      checkpoint: {
        question:
          'Your breaker is configured with failure-rate threshold 50% and minimum calls 20. In the first 10 seconds after deploy, 3 calls happen and all 3 fail. Does the breaker open?',
        answer:
          'No. Three samples are below the minimum of 20, so the breaker has insufficient evidence and stays CLOSED. This prevents a single flaky request at low traffic from cutting off a healthy dependency.',
      },
    },
    {
      id: 'timeouts-retries',
      title: 'Timeouts, retries, backoff and jitter',
      body: `A breaker cannot detect what it cannot observe. A call with no timeout that hangs forever is never recorded as a failure, so **every remote call must have a timeout**, and the timeout is the first resilience control, not the breaker.

Setting the number is a trade-off. Too long and you re-create the cascade (threads held for the full duration). Too short and you cut off legitimate slow-but-successful work and create failures where none existed. A common rule: set the timeout a little above the dependency's **p99 latency** under healthy conditions, and set the breaker's slow-call threshold near it. Budget timeouts across the chain: if the gateway gives up after 2 s, an inner service timing out at 5 s is pointless because the user is already gone.

**Retries** are a double-edged tool. They convert transient blips (a dropped packet, a single instance restarting) into successes. But against a dependency that is genuinely overloaded, retries are gasoline on the fire: 3 retries triple the offered load precisely when capacity is lowest. Rules:

- Retry only **idempotent** operations (GET, PUT with the same body, POST with an idempotency key). Retrying a non-idempotent payment can charge twice.
- Use a **retry budget**: for example, retries may add at most 10% extra traffic, as Google's SRE book recommends, rather than a fixed count per request.
- Retry across the chain only once. If every layer of a 4-deep chain retries 3 times, one user request can become 81 calls at the bottom.
- Prefer retries **through** the breaker: when the breaker is open, retries are skipped instantly.

**Exponential backoff** spaces retries out: wait 100 ms, then 200, 400, 800, capped at some maximum. This gives the dependency room to breathe. But if 10,000 clients all failed at the same instant, they will all retry at the same instants too, producing synchronised waves. **Jitter** randomises each delay (AWS recommends "full jitter": sleep for a random value between 0 and the exponential cap), spreading the retries into a smooth trickle instead of spikes.`,
      mentalModel:
        'A crowd leaving a stadium after a delay: if everyone waits exactly 5 minutes and then rushes the gate together, you get a crush. If each person waits a random 0 to 5 minutes, the gate sees a steady flow. That randomness is jitter.',
      diagram: `Fixed backoff, no jitter (1000 clients)   Full jitter
load                                       load
 |  ####      ####      ####                |  #  #   #  # #  #  #
 |  ####      ####      ####                |  # ## # ## ## # ## #
 |  ####      ####      ####                |  ####################
 +---------------------------> time         +-----------------------> time
    retry     retry     retry               smooth, no synchronised spikes

sleep = min(cap, base * 2^attempt)          sleep = random(0, min(cap, base * 2^attempt))`,
      keyPoints: [
        'Timeouts come first; a hung call is invisible to every other control.',
        'Set timeouts near the healthy p99 and budget them across the call chain.',
        'Retries multiply load on a struggling dependency; retry only idempotent calls under a budget.',
        'Exponential backoff spaces retries; jitter breaks synchronisation between clients.',
        'Nested retries across layers explode combinatorially; retry at one layer only.',
      ],
      checkpoint: {
        question:
          'A 4-layer call chain where each layer retries 3 times on failure. The bottom database is briefly unavailable. How many database calls can one user request generate?',
        answer:
          'Up to 3 x 3 x 3 x 3 = 81 attempts at the bottom (each layer tries up to 3 times, and each of those triggers 3 attempts below). This is why retries should live at one layer, ideally close to the edge, and be governed by a budget.',
      },
    },
    {
      id: 'fallbacks',
      title: 'Fallbacks and graceful degradation',
      body: `Failing fast is only half the story. When the breaker is open, the caller must decide what to give the user instead. That decision is the **fallback**, and choosing it is a product question as much as an engineering one.

Common fallback strategies, roughly from richest to poorest:

- **Stale data from cache.** The recommendation service is down; serve yesterday's recommendations from Redis. Netflix serves a generic "popular now" row when personalisation fails. Users rarely notice.
- **Default or static value.** The pricing service is down; show the last known price with a "price may have changed" note, or hide the shipping estimate.
- **Degrade the feature.** Search suggestions are unavailable; the search box still works without autocomplete. Reviews are down; the product page renders without the reviews tab.
- **Queue for later.** The notification service is down; persist the "send email" intent to Kafka and process it when the breaker closes. This converts a synchronous dependency into an asynchronous one.
- **Fail with a clear error.** For payments or inventory reservation there is often no honest fallback; return a fast, specific error so the client can tell the user exactly what to retry.

Two rules keep fallbacks safe. First, **the fallback must be more reliable than the primary path**, otherwise you have just added a second thing that can fail. Calling another remote service as a fallback is suspicious; reading a local cache or a constant is good. Second, **fallbacks must be visible in metrics**. A system quietly serving stale recommendations for three days because nobody noticed the breaker was open is a silent outage. Emit a metric on every fallback execution and alert on breaker state transitions.

Also decide which failures should *not* trip the breaker. A 404 or a validation error (4xx) means the dependency is working correctly and rejecting a bad request; counting it as a failure would open the breaker because of one buggy client. Libraries let you configure which exceptions or status codes count as failures; usually only timeouts, connection errors and 5xx should.`,
      mentalModel:
        'When the elevator is out of order, a good building does not lock everyone in the lobby. It puts up a sign and points to the stairs. The stairs are the fallback: slower, less pleasant, but they always work.',
      keyPoints: [
        'Fallback options: stale cache, default value, degraded feature, queue for later, fast explicit error.',
        'A fallback must be cheaper and more reliable than the primary call.',
        'Instrument fallbacks and breaker transitions; an open breaker is a partial outage.',
        'Only server-side failures (timeouts, connection errors, 5xx) should count toward tripping.',
      ],
      checkpoint: {
        question:
          'The breaker around the payment gateway opens during checkout. A teammate proposes the fallback "mark the order as paid and reconcile later". Evaluate.',
        answer:
          'Dangerous. It hands goods to users without confirmed payment and turns a technical failure into financial loss. A safer fallback is: fail fast with a clear "payment temporarily unavailable, your cart is saved" message, or queue the order as "pending payment" with an explicit user-facing state and retry payment asynchronously. Fallbacks must never fabricate a success.',
      },
    },
    {
      id: 'bulkheads',
      title: 'Bulkheads: isolating the blast radius',
      body: `A breaker limits how long you keep calling a broken dependency. A **bulkhead** limits how much of your own capacity any one dependency can consume, even before the breaker has tripped.

The problem it solves: Order Service calls Inventory, Pricing and Recommendations. All three share the same 200-thread request pool and the same outbound HTTP connection pool. If Recommendations (a nice-to-have) becomes slow, its calls can hold all 200 threads, and now Order cannot serve requests that need only Inventory and Pricing (the critical path). A non-critical dependency has taken down the critical one.

The bulkhead pattern partitions resources per dependency:

- **Thread-pool bulkhead** (Hystrix's default): each dependency gets its own small pool, e.g. 10 threads for Recommendations. When it fills, further calls are rejected immediately with a fast failure. The rest of the service is untouched. Cost: thread handoff overhead and many pools to size.
- **Semaphore bulkhead** (resilience4j's default): a counter limits concurrent in-flight calls per dependency; the calling thread is used directly. Cheaper, but cannot forcibly time out a call that ignores interruption.
- **Connection-pool partitioning**: separate HTTP client or database connection pools per downstream, with a hard max per pool.
- **Deployment-level bulkheads**: run separate instance groups for different traffic classes (e.g. mobile vs partner API), or separate Kubernetes pods per tenant, so a noisy neighbour cannot exhaust shared capacity.

Sizing follows Little's Law: concurrency needed = throughput x latency. If Recommendations receives 50 calls/s at a p99 of 100 ms, about 5 concurrent slots suffice in health; a bulkhead of 10 leaves headroom, and when latency jumps to 5 s the bulkhead saturates at 10, rejecting the rest rather than eating 250 threads.

Bulkheads and breakers are complementary: the bulkhead caps damage per second, the breaker stops the bleeding over time. Together they ensure that a failure in an optional dependency costs you that feature, and only that feature.`,
      mentalModel:
        'Ships are built with watertight compartments (bulkheads). A hull breach floods one compartment and the ship stays afloat. Without them, one hole sinks the whole vessel. The Titanic\'s bulkheads famously did not reach high enough, which is the same as sizing a pool too generously.',
      diagram: `Without bulkhead:               With bulkheads:
+-----------------------------+ +-----------------------------+
| Order Service, 200 threads  | | Order Service               |
|                             | |  [Inventory pool: 50]  OK   |
|  Recs slow -> 200 waiting   | |  [Pricing   pool: 50]  OK   |
|  Inventory: no threads left | |  [Recs      pool: 10]  FULL |
|  Pricing:   no threads left | |     -> reject fast, show    |
|  => whole service down      | |        page without recs    |
+-----------------------------+ +-----------------------------+`,
      keyPoints: [
        'Shared pools let a non-critical dependency starve the critical path.',
        'Partition threads, semaphores or connections per dependency with a hard cap.',
        'Size with Little\'s Law: concurrency = throughput x latency, plus headroom.',
        'Bulkheads cap instantaneous damage; breakers stop it persisting.',
      ],
    },
    {
      id: 'placement',
      title: 'Where a breaker lives and how to scope it',
      body: `A breaker protects the **caller**, so it lives on the client side of a call, not inside the service being protected. A service cannot stop its callers from hammering it; the callers must decide to stop. There are three places to put that logic.

**In the application, as a library.** Netflix **Hystrix** (2012) made the pattern mainstream: every dependency call is wrapped in a \`HystrixCommand\` with its own thread pool, timeout, breaker and fallback, plus a real-time dashboard. Hystrix is in maintenance mode since 2018; Netflix moved to adaptive concurrency limits. **resilience4j** is the modern JVM choice: a lightweight, functional library with separate modules for CircuitBreaker, RateLimiter, Retry, Bulkhead and TimeLimiter that compose as decorators. Equivalents exist elsewhere: Polly (.NET), gobreaker and sony/gobreaker (Go), opossum (Node.js), pybreaker (Python). Libraries give the finest control (per method, per argument, rich fallbacks in code) but must be re-implemented in every language and kept consistent across teams.

**In a sidecar or service mesh.** Envoy (used by Istio, Consul Connect, AWS App Mesh) implements **outlier detection**: it ejects an upstream host from the load-balancing pool after N consecutive 5xx or when its error rate deviates from the cluster mean, for an ejection time that grows with repeated ejections. It also enforces per-host connection and pending-request limits (bulkheads) and retry budgets. The huge advantage is that it is language-agnostic and centrally configured. The limitation is that the proxy does not understand your business semantics: it can fail fast, but it cannot serve "yesterday's recommendations" as a fallback; the application still has to handle the error.

**In the gateway or load balancer.** Nginx and HAProxy passive health checks (\`max_fails\`, \`fail_timeout\`) are crude breakers per upstream. Fine for edge protection, too coarse for internal call graphs.

**Scope** matters as much as placement. One breaker per *dependency* is the minimum; per *dependency per instance* (as Envoy does) is better because one bad pod out of ten should be ejected, not the whole service. Sharing a breaker across unrelated operations on the same service is a mistake: a broken "generate report" endpoint should not open the breaker for "get user by id".`,
      mentalModel:
        'The breaker is a bouncer standing at your own front door deciding whether to let your requests out, not a guard at the neighbour\'s door. And you want one bouncer per destination, otherwise a closed bar across town stops you visiting the bakery next door.',
      diagram: `Library (in-process)            Sidecar / mesh (Envoy)
+-----------------------+       +-----------+  +-----------+
| Service A             |       | Service A |->| envoy     |--> B host1
|  resilience4j:        |       |  (any     |  | outlier   |--> B host2 X
|  CB[B] CB[C] CB[D]    |       |   lang)   |  | detection |--> B host3
|  fallback in code     |       +-----------+  | retries   |
+-----------------------+                      | bulkheads |
  fine-grained, per language                   +-----------+
  business-aware fallbacks                      language-agnostic,
                                                 no semantic fallback`,
      keyPoints: [
        'Breakers live on the caller side; the callee cannot protect itself from its callers.',
        'Libraries (Hystrix, resilience4j, Polly, gobreaker) give business-aware fallbacks but need per-language work.',
        'Service meshes (Envoy/Istio) give language-agnostic outlier detection and bulkheads but no semantic fallback.',
        'Scope one breaker per dependency, ideally per dependency per host, never one global breaker.',
      ],
      checkpoint: {
        question:
          'Your platform has services in Java, Go and Python. You want consistent fail-fast behaviour everywhere, and rich fallbacks in two critical Java services. What would you deploy?',
        answer:
          'Both layers. Use Envoy/Istio outlier detection and connection limits as the uniform, language-agnostic baseline for every service. Add resilience4j in the two critical Java services where a business-aware fallback (stale cache, degraded feature) is worth the code. The mesh gives coverage; the library gives control where it pays off.',
      },
    },
    {
      id: 'operating-breakers',
      title: 'Tuning, observability and common mistakes',
      body: `A breaker with the wrong thresholds is either a no-op or a self-inflicted outage. Some hard-won lessons:

**Start from measurements.** Look at the dependency's real p50/p99 latency and baseline error rate. If it normally has 2% errors, a 5% threshold will flap constantly; 50% over 20+ calls is a common default that catches genuine outages without tripping on noise.

**Beware low-traffic dependencies.** A breaker on a call made twice a minute will take ten minutes to gather 20 samples and may never trip during a short outage, while an aggressive minimum-calls setting makes it flap. For such calls a plain timeout plus fallback may be enough.

**Half-open probe volume must be small.** If half-open lets 50% of traffic through, a fragile dependency gets knocked over again. Use a handful of calls (resilience4j default: 10 permitted calls in half-open).

**Do not count client errors.** 4xx responses and business exceptions ("insufficient balance") are the dependency working correctly. Record only timeouts, connection failures and 5xx. Otherwise one buggy caller sending bad requests opens the breaker for everyone.

**Breaker state is per process.** Each instance of your service has its own breaker with its own statistics. That is usually right (each instance sees its own view), but it means a 100-instance fleet does not trip simultaneously and the dependency still receives probes from every instance. Some teams share state via Redis; this adds a dependency to your resilience mechanism, which is rarely worth it.

**Observe everything.** Export per-breaker metrics: state, failure rate, slow-call rate, calls not permitted, fallback executions. Alert on OPEN transitions. Hystrix shipped a live dashboard for this reason; with resilience4j, Micrometer exposes the same to Prometheus and Grafana.

**Test the fallback path.** A fallback that is never executed in staging will surprise you in production. Chaos experiments (Netflix Chaos Monkey, Gremlin, Istio fault injection that returns 503 from 10% of calls) verify that breakers trip and fallbacks render correctly before a real outage does.`,
      mentalModel:
        'A smoke detector with the sensitivity set wrong is either screaming at toast or silent during a fire. You calibrate it against the kitchen you actually have, and you press the test button regularly.',
      keyPoints: [
        'Derive thresholds from real latency and error baselines; 50% over 20+ calls is a sane default.',
        'Low-traffic calls may never accumulate enough samples; use timeout plus fallback instead.',
        'Count only server-side failures; exclude 4xx and business errors.',
        'Breaker state is per instance; sharing it introduces a new dependency.',
        'Expose metrics, alert on OPEN, and exercise fallbacks with fault injection.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'In which circuit breaker state are calls rejected immediately without reaching the network?',
      options: ['CLOSED', 'OPEN', 'HALF-OPEN', 'RESET'],
      answerIndex: 1,
      explanation:
        'OPEN is the tripped state: the breaker fails fast for the wait duration. CLOSED passes calls normally, HALF-OPEN lets a few probe calls through. RESET is not a state.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'What is the purpose of the HALF-OPEN state?',
      options: [
        'To buffer requests until the dependency recovers',
        'To send a small number of trial calls so recovery is tested without flooding a fragile dependency',
        'To retry every failed request one more time',
        'To reduce the failure-rate threshold temporarily',
      ],
      answerIndex: 1,
      explanation:
        'Half-open probes with a trickle of calls. Going straight from OPEN to CLOSED would send full load to a service that may still be weak and re-trigger the cascade. Breakers never buffer requests.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Why is a slow dependency generally more dangerous to a system than one that has crashed completely?',
      options: [
        'Slow responses corrupt data more often',
        'A crashed dependency triggers automatic scaling',
        'Slowness holds caller threads and connections, so healthy callers exhaust their own resources waiting',
        'Load balancers cannot detect crashes',
      ],
      answerIndex: 2,
      explanation:
        'A crash produces instant connection refusals, freeing callers to fail fast. Slowness ties up caller resources for the full timeout, which is how cascades propagate to healthy services.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which of the following should normally count as failures for tripping a circuit breaker? Select all that apply.',
      options: [
        'Connection refused',
        'HTTP 404 Not Found',
        'HTTP 503 Service Unavailable',
        'Request timeout',
        'Validation error (HTTP 400)',
        'Call slower than the configured slow-call threshold',
      ],
      answerIndices: [0, 2, 3, 5],
      explanation:
        'Connection failures, 5xx, timeouts and slow calls indicate the dependency is unhealthy. 404 and 400 mean the dependency processed the request correctly and rejected it; counting them would let one buggy client open the breaker for everyone.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 1,
      statement: 'A circuit breaker should be deployed inside the service being protected so that it can reject excess traffic from its callers.',
      answer: false,
      explanation:
        'The breaker protects the caller and lives on the caller side. The callee cannot make its callers stop; rejecting traffic inside the callee is rate limiting or load shedding, a different (complementary) mechanism.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A breaker is configured with a 50% failure threshold, minimum 20 calls, wait duration 30 s. The dependency has a 3-minute outage. Roughly how does the breaker behave?',
      options: [
        'Opens once and stays open for the full 3 minutes',
        'Opens after enough failures, then cycles OPEN (30 s) -> HALF-OPEN (probes fail) -> OPEN about six times until probes succeed',
        'Never opens because 3 minutes is shorter than the window',
        'Opens immediately on the first failure',
      ],
      answerIndex: 1,
      explanation:
        'After 20+ calls with mostly failures it opens. Every 30 s it goes half-open and sends a few probes; those fail during the outage, so it re-opens. After the dependency recovers, probes succeed and it closes. It never trips on a single failure.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'What problem does jitter solve in a retry policy?',
      options: [
        'It reduces the total number of retries',
        'It prevents many clients from retrying at the same synchronised instants and creating load spikes',
        'It makes retries idempotent',
        'It increases the timeout on each attempt',
      ],
      answerIndex: 1,
      explanation:
        'Exponential backoff alone keeps clients synchronised: they all failed together, so they all retry together. Random jitter spreads the retries into a smooth flow. It does not change retry count, idempotency or timeouts.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 2,
      statement: 'Adding retries to every layer of a deep synchronous call chain is a safe way to improve reliability.',
      answer: false,
      explanation:
        'Retries multiply: with 3 attempts at each of 4 layers, one request can become 81 attempts at the bottom, exactly when the bottom is struggling. Retry at one layer, only for idempotent calls, with a budget and backoff.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question:
        'Order Service calls Inventory (critical) and Recommendations (optional) using one shared thread pool. Recommendations becomes slow and Order stops serving any requests. Which pattern most directly prevents this?',
      options: [
        'A retry with exponential backoff on Recommendations',
        'A bulkhead giving Recommendations its own small, capped pool',
        'A larger shared thread pool',
        'Caching Inventory responses',
      ],
      answerIndex: 1,
      explanation:
        'The failure is resource starvation across dependencies. A bulkhead caps how many threads Recommendations can hold, so Inventory calls keep flowing. A bigger shared pool only delays exhaustion; retries make it worse.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'What is the key limitation of implementing circuit breaking in a service mesh sidecar such as Envoy rather than in an application library like resilience4j?',
      options: [
        'It cannot detect 5xx errors',
        'It only works for Java services',
        'It can fail fast but cannot provide business-aware fallbacks such as serving stale data',
        'It cannot be configured per upstream host',
      ],
      answerIndex: 2,
      explanation:
        'Envoy is language-agnostic and does per-host outlier detection with 5xx and consecutive-failure tracking, but it has no knowledge of your domain, so the application still has to decide what to show when the call fails.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'You are adding resilience around a call to a third-party address-validation API used during checkout. It normally responds in 80 ms (p99 250 ms) with a 1% error rate. Propose a timeout, breaker configuration, retry policy and fallback, and justify each.',
      modelAnswer: `**Timeout:** ~400 ms, a little above the healthy p99, so legitimate slow calls pass but a hung provider cannot hold checkout threads.

**Breaker (resilience4j style):** sliding window of the last 50 calls or 10 s, minimum 20 calls, failure-rate threshold 50%, slow-call threshold 300 ms with slow-rate threshold 50%, wait 30 s in OPEN, 5 permitted calls in HALF-OPEN. Count only timeouts, connection errors and 5xx; a 400 "invalid address" is a correct response.

**Retry:** at most 1 retry, only for timeouts/connection errors (the call is idempotent), with 100-200 ms jittered backoff, and skipped when the breaker is open. A single retry handles blips without doubling load for long.

**Fallback:** accept the address as entered, flag the order for later asynchronous validation, and show "we will confirm your address by email". Checkout continues; a third-party outage costs a nice-to-have, not revenue. Emit a metric on each fallback and alert when the breaker opens.`,
      rubric: [
        'Timeout tied to the observed p99 rather than an arbitrary number.',
        'Breaker uses a rate over a minimum sample size, with a wait duration and a small half-open probe count.',
        'Excludes 4xx from failure counting.',
        'Retry is limited, idempotent-only, and jittered.',
        'Fallback is cheaper and more reliable than the primary call and keeps checkout working; observability is mentioned.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain why a circuit breaker without a timeout on the underlying call is almost useless.',
      modelAnswer: `The breaker decides based on observed outcomes: successes, failures and slow calls. A call with no timeout that hangs on a dead or frozen dependency never returns, so it never produces an outcome. The breaker sees no failures, stays CLOSED, and keeps letting new calls through, each of which also hangs. Meanwhile the caller's threads and connections are consumed one by one, which is precisely the cascade the breaker was meant to prevent. The timeout converts "hung forever" into a recorded failure within a bounded time, giving the breaker the evidence it needs to open and freeing the thread. Timeouts are therefore the foundation; breakers, retries and bulkheads are built on top of them.`,
      rubric: [
        'States that the breaker relies on observed outcomes.',
        'Explains that hung calls never produce an outcome.',
        'Connects the missing timeout to resource exhaustion in the caller.',
        'Concludes that timeouts are the prerequisite control.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 1,
      question: 'List the three circuit breaker states and, for each, what happens to an incoming call.',
      modelAnswer: `**CLOSED:** the call is executed normally and its outcome (success, failure, slow) is recorded in the sliding window.

**OPEN:** the call is rejected immediately without any network activity; an exception is thrown or the fallback is returned. This lasts for the configured wait duration.

**HALF-OPEN:** a limited number of calls are allowed through as probes; the rest are rejected. If the probes succeed the breaker closes, if they fail it re-opens.`,
      rubric: [
        'Names CLOSED, OPEN and HALF-OPEN.',
        'CLOSED passes calls and records outcomes.',
        'OPEN rejects instantly with no network call.',
        'HALF-OPEN permits a limited set of probe calls.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Circuit breaker (one sentence)', back: 'A caller-side guard that tracks failures to a dependency and, once a threshold is crossed, fails fast without calling it, until probe calls show it has recovered.' },
    { id: 'f2', front: 'Cascading failure mechanism', back: 'A slow dependency holds caller threads/connections; the caller\'s pool fills, it becomes slow, its callers fill up, and healthy services fail. Retries and refreshes amplify it.' },
    { id: 'f3', front: 'CLOSED state', back: 'Normal operation: calls pass through, outcomes recorded in a sliding window (count- or time-based). Trips to OPEN when failure rate exceeds threshold over a minimum number of calls.' },
    { id: 'f4', front: 'OPEN state', back: 'Tripped: every call is rejected instantly with an exception or fallback, no network I/O. Lasts for a configured wait duration (e.g. 30 s), then moves to HALF-OPEN.' },
    { id: 'f5', front: 'HALF-OPEN state', back: 'Probing: a small number of trial calls (e.g. 5-10) are allowed. Success -> CLOSED with reset stats. Failure -> back to OPEN for another wait period.' },
    { id: 'f6', front: 'Why require a minimum number of calls before tripping?', back: 'A failure *rate* on 1 or 2 samples is noise. Requiring e.g. 20 calls prevents a single flaky request at low traffic from cutting off a healthy dependency.' },
    { id: 'f7', front: 'Hystrix default thresholds', back: '10-second rolling window, 20 request volume threshold, 50% error percentage, 5-second sleep window before half-open. Still sensible starting values.' },
    { id: 'f8', front: 'Why timeouts come before breakers', back: 'A hung call never returns, so it is never recorded as a failure. Without a timeout the breaker has no evidence and threads are consumed anyway. Set timeout near healthy p99.' },
    { id: 'f9', front: 'Retry rules', back: 'Only idempotent operations; limited attempts under a retry budget (e.g. +10% traffic); exponential backoff with jitter; retry at one layer only; skip when breaker is open.' },
    { id: 'f10', front: 'Full jitter formula (AWS)', back: 'sleep = random(0, min(cap, base * 2^attempt)). Randomising spreads synchronised retries into a smooth flow, avoiding thundering-herd spikes.' },
    { id: 'f11', front: 'Bulkhead pattern', back: 'Partition resources (thread pools, semaphores, connection pools) per dependency with a hard cap so one slow dependency cannot starve the others. Named after ship compartments.' },
    { id: 'f12', front: 'Sizing a bulkhead (Little\'s Law)', back: 'Concurrency = throughput x latency. 50 calls/s at 100 ms p99 needs ~5 slots; cap at ~10 for headroom so a latency spike saturates the bulkhead instead of the whole service.' },
    { id: 'f13', front: 'Good fallback strategies', back: 'Stale cache value, static default, degraded feature (hide the widget), queue for later processing, or a fast explicit error. Must be cheaper and more reliable than the primary call.' },
    { id: 'f14', front: 'Which failures should NOT trip a breaker?', back: '4xx client errors and business exceptions (e.g. insufficient balance). The dependency worked correctly; counting them lets one buggy client open the breaker for everyone.' },
    { id: 'f15', front: 'Library vs mesh breakers', back: 'Library (Hystrix, resilience4j, Polly, gobreaker): business-aware fallbacks, per-language. Mesh (Envoy/Istio outlier detection): language-agnostic, per-host ejection, but no semantic fallback.' },
    { id: 'f16', front: 'Breaker scope', back: 'One breaker per dependency at minimum, ideally per dependency per host (eject one bad pod). Never one global breaker; do not share across unrelated endpoints.' },
    { id: 'f17', front: 'Observability for breakers', back: 'Export state, failure rate, slow-call rate, calls-not-permitted and fallback counts. Alert on OPEN transitions: an open breaker is a silent partial outage.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Circuit breaker states',
      prompt: 'Explain the circuit breaker pattern and its three states to a junior developer who has only written direct HTTP calls between services.',
      modelExplanation: `Imagine your service calls a payment provider on every request. One day the provider hangs. Each of your requests waits 30 seconds for a timeout, your thread pool fills, and now your service is down too, even though nothing is wrong with it.

A circuit breaker sits in front of that call and keeps score. Normally it is **closed**: calls go through and it notes whether each one succeeded or failed. If, say, more than half of the last 20 calls failed, it flips **open**: now it does not even try the call, it instantly returns an error or a fallback like "payment temporarily unavailable". Your threads are free, your service stays healthy, and the provider gets a break from your traffic.

After 30 seconds it goes **half-open** and lets a few test calls through. If they work, it closes again and life is normal. If they fail, it reopens and waits another 30 seconds. That probe step is what lets it recover automatically without slamming a fragile dependency with full traffic.`,
      mustMention: [
        'The problem: waiting on a failing dependency exhausts the caller',
        'CLOSED counts outcomes over a window',
        'OPEN fails fast without a network call',
        'HALF-OPEN sends a few probes to test recovery',
        'Threshold is a rate over a minimum number of calls',
      ],
    },
    {
      id: 'fe2',
      concept: 'Retries with backoff and jitter',
      prompt: 'Explain why naive retries can make an outage worse and how backoff and jitter fix it.',
      modelExplanation: `A retry seems harmless: the call failed, try again. But think about *why* it failed. If the dependency is overloaded, every retry is another request landing on a service that already cannot cope. With 3 retries you have tripled its traffic at the worst possible moment. And if several layers each retry 3 times, one user click becomes dozens of calls at the bottom.

Two fixes. First, **exponential backoff**: wait 100 ms before the first retry, 200 before the next, then 400, and so on, so the dependency gets progressively more room to recover. Second, **jitter**: add randomness to those waits. Without it, all 10,000 clients that failed at the same instant retry at exactly the same instants, producing synchronised spikes. With jitter each waits a random amount, and the retries arrive as a gentle stream.

Also, only retry operations that are safe to repeat, cap the total retry traffic with a budget, and skip retries entirely when the circuit breaker is open.`,
      mustMention: [
        'Retries add load to an already struggling dependency',
        'Nested retries multiply across layers',
        'Exponential backoff spaces attempts out',
        'Jitter breaks synchronisation between clients',
        'Idempotency and retry budgets',
      ],
    },
    {
      id: 'fe3',
      concept: 'Bulkheads',
      prompt: 'Explain the bulkhead pattern and how it differs from a circuit breaker, using a concrete service with several dependencies.',
      modelExplanation: `Suppose your Product Page service calls three things: Inventory (essential), Pricing (essential) and Reviews (nice to have). All three calls run on the same pool of 200 threads.

Now Reviews gets slow. Each Reviews call holds a thread for seconds. Soon all 200 threads are stuck on Reviews, and requests that only need Inventory and Pricing cannot even start. An optional feature has taken down the essential ones.

A **bulkhead** fixes that by giving each dependency its own capped pool: perhaps 10 threads for Reviews. When those 10 are busy, further Reviews calls are rejected instantly, and the page renders without the reviews tab. The other 190 threads keep serving Inventory and Pricing. The name comes from the watertight compartments in a ship: one breach floods one compartment, not the hull.

The difference from a breaker: a bulkhead limits how much damage a dependency can do *right now*, by capping concurrency. A breaker notices a dependency is failing *over time* and stops calling it. You want both.`,
      mustMention: [
        'Shared pools let a non-critical dependency starve critical ones',
        'Per-dependency capped pools or semaphores',
        'Excess calls fail fast and the feature degrades',
        'Bulkhead caps instantaneous concurrency; breaker acts on failure rate over time',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through an old ship\'s engine room during a storm, from the main electrical panel at the entrance, along the corridor of watertight doors, to the bridge at the far end.',
    stops: [
      { locus: 'The flooded stairwell at the entrance', concept: 'Cascading failure', image: 'A single dripping pipe on the top deck has, by sheer patience, flooded every lower deck because each door was politely held open by a sailor waiting for the one above. Slowness, not a crash, sinks the ship.' },
      { locus: 'The main electrical panel', concept: 'Breaker states: closed, open, half-open', image: 'A giant brass breaker switch, hot to the touch. It slams from CLOSED to OPEN with a bang and a shower of sparks; a small timer ticks 30 seconds, then a trembling hand pushes it HALF-way and a single test bulb flickers on.' },
      { locus: 'The tally board beside the panel', concept: 'Thresholds over a sliding window', image: 'A chalkboard with 20 slots. A sailor writes S or F in each; only when the board is full and more than half are red F does the breaker fire. Three lonely Fs on an empty board do nothing.' },
      { locus: 'The egg timer on the pipe valve', concept: 'Timeouts', image: 'Every pipe has a screaming egg timer taped to its valve. If water does not arrive before the ring, the valve slams shut and a red F is chalked on the board. A pipe without a timer would wait forever.' },
      { locus: 'The dice-rolling stokers', concept: 'Retries with backoff and jitter', image: 'Stokers waiting to re-light the boiler roll huge dice to decide how many seconds to wait, doubling the die each time. Because their rolls differ, they approach the boiler in a trickle instead of a crush.' },
      { locus: 'The corridor of watertight doors', concept: 'Bulkheads', image: 'A row of heavy steel doors, each labelled INVENTORY, PRICING, REVIEWS. The REVIEWS compartment is filling with green water, but the door holds and the other compartments stay dry and lit.' },
      { locus: 'The lifeboat locker', concept: 'Fallbacks', image: 'A locker stuffed with yesterday\'s newspaper (stale cache), a plain wooden sign saying PRICE MAY VARY (default value) and a mail sack labelled SEND LATER (queue). A sign reads: never fake a rescue.' },
      { locus: 'The bridge with two telescopes', concept: 'Where to place the breaker: library vs mesh', image: 'The captain holds a fine jeweller\'s loupe (resilience4j, sees details, speaks one language) in one hand and a huge periscope labelled ENVOY (sees every ship, speaks all languages, but cannot read the fine print) in the other.' },
    ],
  },
  interviewQuestions: [
    'Walk me through how a slow downstream service causes a cascading failure, and what the first three controls you would add are.',
    'Explain the circuit breaker state machine. Why is the half-open state necessary?',
    'How would you choose the failure threshold, minimum call count and wait duration for a breaker around a dependency you have never measured?',
    'Retries improve reliability but can also cause outages. When are retries safe, and how do backoff and jitter change the picture?',
    'What is the bulkhead pattern and how does it relate to circuit breakers? Give an example of sizing one.',
    'Compare implementing circuit breaking in resilience4j versus in an Envoy/Istio service mesh. When would you use both?',
    'What fallback would you choose when the recommendation service is down? What about the payment service? Why are they different?',
    'A breaker in production keeps flapping between open and closed every minute. What are likely causes and how would you fix it?',
  ],
}

export default chapter
