import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 16, slug: 'load-balancers', title: 'Load Balancers', module: 'resilience',
  estimatedMinutes: 30,
  summary: 'Route requests across servers while accounting for health, connection lifetime, and uneven work. Design balancing and rollout policies that improve availability without amplifying overload.',
  objectives: ['Compare layer 4 and layer 7 balancing.', 'Choose routing algorithms from workload characteristics.', 'Separate readiness, liveness, and overload signals.', 'Plan draining, retries, and load-balancer redundancy.'],
  quickRevision: ['Layer 4 routes transport connections; layer 7 can inspect application requests.', 'Round robin balances assignment counts, not necessarily work.', 'Least connections helps when connection counts correlate with load.', 'Weighted routing handles unequal capacity or controlled rollouts.', 'Readiness decides whether a server should receive new work.', 'Liveness asks whether restarting a process may help.', 'Session affinity can simplify state placement but creates skew and failover cost.', 'Long-lived connections do not rebalance just because a new server appears.', 'Drain existing work before terminating a backend.', 'Retry only safe operations within a bounded overall deadline.'],
  sections: [
    { id: 'layers', title: 'What can the balancer see?',
      body: `A load balancer presents an entry point and chooses a backend from a pool. At layer 4, routing operates at the transport level, commonly assigning a TCP connection based on addresses and ports. It can avoid interpreting the application protocol. At layer 7, a proxy understands application requests and can route by fields such as HTTP host, path, or selected headers. This enables separate pools for images, API requests, or particular tenants.

TLS placement changes visibility. A proxy terminating TLS can inspect decrypted HTTP, apply application routing, and establish a separate encrypted connection to the backend. With TLS passthrough, ordinary HTTP contents remain encrypted to the balancer, so its application routing choices are more limited. Termination also moves certificate management and part of the security boundary to the proxy.

Do not equate layer 4 with always faster or layer 7 with always better. Compare the protocols, routing needs, connection reuse, operational complexity, and measured latency. Either layer still needs backend health information, capacity planning, and a strategy for the balancer itself failing.`,
      mentalModel: 'A layer 4 receptionist chooses a room from the envelope address. A layer 7 receptionist opens the permitted letter and routes by its subject.',
      diagram: 'Clients -> public entry -> load balancer -> backend A\n                                      \-> backend B\nL4: connection routing     L7: application request routing',
      keyPoints: ['Routing visibility differs by layer.', 'TLS termination determines where plaintext is available.', 'Choose from requirements and measurements.'],
      checkpoint: { question: 'You need /images and /checkout to use different backend pools. What capability is required?', answer: 'Application-aware HTTP routing, usually a layer 7 proxy that can see the request path. Ordinary encrypted layer 4 passthrough cannot inspect that path.' } },
    { id: 'algorithms', title: 'Equal request counts are not equal work',
      body: `Round robin cycles through eligible backends. It is simple and can work well when servers and request costs are similar. Weighted round robin assigns more traffic to stronger servers or gradually exposes a new deployment. Neither method directly observes how much unfinished work each server has accumulated.

Least-connections routing sends new connections toward a backend with fewer active connections. This can help when connections have similar cost, but a single multiplexed connection may carry many requests while another sits idle. Least-outstanding-request or latency-aware approaches can fit other workloads, provided their measurements are stable enough to avoid routing oscillation.

Consider an API where most requests take ten milliseconds but occasional exports take thirty seconds. Equal assignment counts can still leave one backend overloaded. Separating expensive jobs into another pool or processing them asynchronously may help more than changing the algorithm. Compare per-backend utilization, in-flight work, and tail latency. The balancer cannot make an inherently overloaded service healthy; it can only distribute the capacity that exists and enforce admission policies around it.`,
      mentalModel: 'Two checkout lanes each have five shoppers, but one lane contains five full trolleys and the other five single apples.',
      diagram: 'Round robin:       A, B, C, A, B, C\nWeighted routing:  A, A, B, A, A, B\nLeast outstanding: choose measured least busy eligible target',
      keyPoints: ['Counts are useful only when they correlate with cost.', 'Weights can express capacity or rollout intent.', 'Separate unusually expensive work when appropriate.'],
      checkpoint: { question: 'Why can least connections misjudge an HTTP/2 backend?', answer: 'A connection can carry many concurrent streams. Connection count alone may understate outstanding request work compared with another backend.' } },
    { id: 'health', title: 'Healthy enough to receive traffic',
      body: `A process can be running while unable to serve useful requests. A readiness signal tells the routing layer whether a backend should receive new traffic. During startup it may remain false until essential initialization finishes. During shutdown it becomes false before the process exits. A liveness signal has a different purpose: it helps decide whether a stuck process should be restarted.

Health checks must avoid causing their own outage. An expensive query executed by every balancer every second can overload a dependency. Likewise, if every backend marks itself unhealthy because one shared optional dependency fails, the entire fleet may disappear even though useful degraded responses were possible. Check what the service needs to fulfill its actual contract and handle optional features deliberately.

Use thresholds and recovery delays to avoid rapidly adding and removing a flapping backend. Active probes can be combined with observed request failures, but define how overload differs from permanent failure. Removing one busy node sends its traffic to the others and can create a cascade. The system may instead need bounded queues, rejection, or reduced functionality.`,
      mentalModel: 'A shop with its lights on is alive. A shop with a staffed till and open door is ready. Asking it to serve a full banquet as a health check is counterproductive.',
      diagram: 'Starting -> not ready -> serving -> draining -> stopped\n             probes       traffic    no new work',
      keyPoints: ['Readiness and liveness answer different questions.', 'Keep probes cheap and meaningful.', 'Avoid cascading removal during shared dependency failure.'],
      checkpoint: { question: 'Every backend loses access to an optional recommendation service. Should every readiness check fail?', answer: 'Usually not if core requests can still be served without recommendations. Degrade that feature and keep readiness tied to the essential service contract.' } },
    { id: 'connections-and-state', title: 'Affinity, long connections, and draining',
      body: `Session affinity routes a client back to the same backend, perhaps through a cookie or hashing rule. This can help applications with local session state, but it makes distribution less flexible. A busy client can overload one server, and a failed backend takes its local state away. Externalizing required session data often makes balancing and recovery simpler, although affinity can remain an intentional optimization.

A WebSocket or other long-lived connection stays attached to its current backend. Adding servers helps new connections but does not move existing ones automatically. Plan connection capacity and gradual turnover rather than assuming an autoscaling event instantly equalizes load. Routing at the request layer may provide different balancing behavior from routing whole connections.

During a deployment, stop admitting new work to the retiring backend and let in-flight work finish within a drain deadline. Long-lived clients may need a reconnect instruction and a resume protocol. When the deadline expires, remaining connections may be closed, so clients must tolerate interruption. Avoid draining every backend simultaneously, and retain enough capacity for the traffic shifted onto the surviving pool.`,
      mentalModel: 'Guests already seated stay at their tables when a new dining room opens. Closing a room requires finishing meals or helping guests move.',
      keyPoints: ['Affinity trades flexibility for locality.', 'New servers mostly receive new connections.', 'Drain with deadlines and reconnect support.'],
      checkpoint: { question: 'A new gateway is empty while old gateways hold many WebSockets. Is round robin necessarily broken?', answer: 'No. Existing connections remain on their original gateways. The new node receives newly established connections; redistribution needs controlled turnover or explicit reconnects.' } },
    { id: 'retries-and-redundancy', title: 'Do not turn a failure into a traffic multiplier',
      body: `A balancer may retry a failed request on another backend, but the failure can be ambiguous. The first server might have committed a purchase before the connection broke. Retrying a non-idempotent operation can create a second purchase unless the application uses an idempotency key or an equivalent deduplication mechanism. Decide which failures and methods are eligible for retry rather than enabling it universally.

Retries also consume capacity. If the browser, proxy, and service each retry three times independently, one user action can produce many downstream attempts. Share an overall time budget, limit attempts, and avoid retrying overload aggressively. Timeouts should reflect the request contract and include time already spent waiting upstream.

The load balancer itself needs redundancy. Multiple instances, failure-domain separation, and a functioning traffic entry mechanism prevent one proxy from becoming the only path to all servers. DNS changes are not instantaneous for all clients, and existing connections have their own lifetime. Test backend loss, balancer loss, and a rollout under load. Availability claims need evidence from the complete request path.`,
      mentalModel: 'Sending three messengers through three supervisors who each make three copies creates a crowd, not reliability.',
      keyPoints: ['Retry safety depends on application semantics.', 'Bound attempts and total elapsed time.', 'Test failures of both backends and balancers.'],
      checkpoint: { question: 'A POST times out after the server may have committed it. Can a proxy safely retry blindly?', answer: 'No. Use an idempotency contract or determine the original result. A transport timeout does not prove that no side effect occurred.' } },
  ],
  quiz: [
    { type: 'mcq', id: 'q1', difficulty: 1, question: 'Which routing rule needs HTTP awareness?', options: ['Choose by destination port', 'Assign a TCP flow', 'Send /checkout to a payment pool', 'Hash a transport tuple'], answerIndex: 2, explanation: 'The URL path is an application field. The other examples can operate at the transport level.' },
    { type: 'mcq', id: 'q2', difficulty: 2, question: 'What is readiness used for?', options: ['Deciding whether to send new traffic', 'Proving every dependency is perfect', 'Measuring total disk size', 'Guaranteeing no requests can fail'], answerIndex: 0, explanation: 'Readiness is a routing eligibility signal, not a guarantee of perfection.' },
    { type: 'mcq', id: 'q3', difficulty: 2, question: 'Why may round robin produce uneven CPU?', options: ['It encrypts only odd requests', 'Request costs differ', 'It disables health checks by definition', 'It cannot use multiple servers'], answerIndex: 1, explanation: 'Equal assignment counts can represent very different amounts of work.' },
    { type: 'mcq', id: 'q4', difficulty: 2, question: 'What should begin graceful backend shutdown?', options: ['Erase all session data', 'Retry every request', 'Kill the process immediately', 'Stop new admission and drain in-flight work'], answerIndex: 3, explanation: 'Draining lets existing work finish within a deadline while new work goes elsewhere.' },
    { type: 'multi', id: 'q5', difficulty: 3, question: 'Which reduce retry-related failures?', options: ['An overall deadline', 'Idempotency for retried side effects', 'Bounded retry attempts', 'Retries at every layer with no shared budget'], answerIndices: [0, 1, 2], explanation: 'These constrain ambiguity and amplification. Independent unbounded retries multiply work.' },
    { type: 'truefalse', id: 'q6', difficulty: 1, statement: 'Adding a backend automatically moves existing WebSocket connections to it.', answer: false, explanation: 'Established connections remain attached unless interrupted or explicitly migrated by a supported protocol.' },
    { type: 'truefalse', id: 'q7', difficulty: 2, statement: 'Session affinity can create uneven load.', answer: true, explanation: 'A heavy client or tenant may keep returning to one backend.' },
    { type: 'truefalse', id: 'q8', difficulty: 2, statement: 'A timeout proves a server performed no side effect.', answer: false, explanation: 'The operation may have committed before the response was lost.' },
    { type: 'short', id: 'q9', difficulty: 3, question: 'Plan a rollout for a WebSocket gateway fleet.', modelAnswer: 'Add sufficient replacement capacity, mark old instances unready, and stop new connections. Drain gradually with a deadline, request client reconnects with jitter, and resume durable events using cursors. Monitor connection counts, replay load, and latency.', rubric: ['Replacement capacity', 'Readiness and drain deadline', 'Reconnect and resume', 'Load monitoring'] },
    { type: 'short', id: 'q10', difficulty: 3, question: 'How should you choose a balancing algorithm for mixed short and long requests?', modelAnswer: 'Measure request cost and outstanding work per backend. Round robin is a baseline but can skew cost. Consider request-aware load measures and separate expensive exports into a pool or asynchronous jobs. Validate tail latency and node-loss behavior with representative traffic.', rubric: ['Workload measurement', 'Count-versus-cost distinction', 'Suitable routing or workload separation', 'Representative verification'] },
  ],
  flashcards: [
    { id: 'f1', front: 'Layer 4 balancing', back: 'Routes transport connections without needing to inspect HTTP request contents.' },
    { id: 'f2', front: 'Layer 7 balancing', back: 'Uses application information such as HTTP host and path to route requests.' },
    { id: 'f3', front: 'TLS termination', back: 'The proxy decrypts client traffic and may establish separate backend TLS. It owns certificates and can inspect HTTP.' },
    { id: 'f4', front: 'Round robin limitation', back: 'Balances assignment counts; unequal request costs can still produce uneven resource use.' },
    { id: 'f5', front: 'Least-connections limitation', back: 'Connection counts may not reflect work, especially with idle or multiplexed connections.' },
    { id: 'f6', front: 'Weighted routing', back: 'Assign different traffic shares to express unequal capacity or a gradual rollout.' },
    { id: 'f7', front: 'Readiness', back: 'Whether the backend should receive new work now.' },
    { id: 'f8', front: 'Liveness', back: 'Whether the process is functioning enough that it should remain running rather than be restarted.' },
    { id: 'f9', front: 'Session affinity', back: 'Prefer the same backend for a client. Helps locality but complicates balance and failure recovery.' },
    { id: 'f10', front: 'Connection draining', back: 'Stop new admission, allow existing work to finish, and close remaining work after a defined deadline.' },
    { id: 'f11', front: 'Retry amplification', back: 'Independent retries at multiple layers multiply downstream attempts and can worsen overload.' },
    { id: 'f12', front: 'Ambiguous timeout', back: 'The caller lacks a result even though the server may have committed. Retried side effects need idempotency.' },
  ],
  feynman: [
    { id: 'fe1', concept: 'Balancing work', prompt: 'Explain why sending equal numbers of requests to servers may be unfair.', modelExplanation: 'Imagine assigning five shopping customers to each cashier. One group carries five apples; the other carries five overflowing trolleys. The assignment counts match, but the work does not. Round robin can have this problem with an API that mixes quick lookups and expensive exports. Measuring outstanding work may be more useful than counting connections, especially when one connection carries many requests. Another option is to put the expensive jobs in a separate queue or pool. We still need to measure the result, because a clever routing rule cannot create capacity that does not exist. Good balancing aims to use available servers effectively while keeping request latency and failure behavior within the application target.', mustMention: ['Counts differ from work', 'Mixed request costs', 'Work-aware routing or separate pools', 'Finite total capacity'] },
    { id: 'fe2', concept: 'Graceful draining', prompt: 'Explain how to replace a server without abruptly abandoning its users.', modelExplanation: 'Closing a restaurant should begin by stopping new seating, not switching off the kitchen while people eat. A server rollout works the same way. First provide replacement capacity and mark the retiring server unavailable for new requests. Let current work finish, but give it a deadline so one stuck request cannot block the rollout forever. Long-lived connections may need to reconnect, and the application must help clients resume their state or replay missed events. Move one part of the fleet at a time so remaining servers can handle the shifted work. Finally stop the old process. The load balancer, readiness signal, client retry behavior, and application recovery protocol all participate in making the replacement smooth.', mustMention: ['Stop new work first', 'Allow bounded draining', 'Reconnect and resume', 'Retain capacity during rollout'] },
  ],
  memoryPalace: { setting: 'Walk through a supermarket with several checkout lanes.', stops: [
    { locus: 'Envelope desk', concept: 'Routing layers', image: 'One clerk reads addresses while another opens letters to find the checkout department.' },
    { locus: 'Apple lane', concept: 'Unequal work', image: 'Five apples race past five mountain-sized shopping carts.' },
    { locus: 'Green lane light', concept: 'Readiness', image: 'A cashier turns the light off but keeps scanning the current customer’s basket.' },
    { locus: 'Reserved trolley', concept: 'Affinity', image: 'One giant shopper is tied by a ribbon to a single exhausted cashier.' },
    { locus: 'Closing gate', concept: 'Draining', image: 'A sand timer closes admission while existing shoppers finish paying.' },
    { locus: 'Copy machine', concept: 'Retry amplification', image: 'Every supervisor copies an order three times until paper buries the shop.' },
  ] },
  interviewQuestions: ['When would you choose layer 4 versus layer 7 balancing?', 'How would you route workloads with very different request costs?', 'How should readiness differ from liveness?', 'How do you drain long-lived connections?', 'What makes proxy retries unsafe?'],
}

export default chapter
