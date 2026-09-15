import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 1,
  slug: 'what-is-system-design',
  title: 'What Is System Design',
  module: 'foundations',
  estimatedMinutes: 25,
  summary:
    'System design is the discipline of turning a set of requirements into an architecture, a set of components and modules, and a clear picture of how they interact. It is what lets a product go from an idea to a system that actually works under real users, real failures, and real growth.',
  objectives: [
    'Define system design in one sentence and explain what it produces.',
    'Distinguish architecture, components, and modules, and give an example of each.',
    'Explain why interactions between components matter more than any single component.',
    'Recognise that system design is a process of trade-offs driven by requirements.',
  ],
  quickRevision: [
    'System design = requirements -> architecture -> components -> modules -> interactions.',
    'Architecture is the big-picture shape; components are the boxes; modules are the insides of a box.',
    'Example: Authentication is a component; token issuing, token refresh and session storage are modules inside it.',
    'How components talk to each other (sync HTTP, async queue, shared DB) defines the system as much as the boxes do.',
    'Every design decision is a trade-off; there is no "best" design, only a design that fits the requirements.',
    'Requirements split into functional (what it does) and non-functional (how well: scale, latency, availability, cost).',
    'Good system design makes the product buildable by a team: clear boundaries, clear contracts.',
    'Start simple, identify bottlenecks, evolve. Do not design for 100x scale on day one.',
    'A system is only as strong as its weakest interaction, so map the data flow end to end.',
    'Ask "what happens when this fails?" for every box and every arrow.',
  ],
  sections: [
    {
      id: 'definition',
      title: 'What system design actually means',
      body: `System design is the process of taking a **set of requirements** and deciding three things:

1. **The architecture** - the overall shape of the solution. Monolith or services? Request-response or event-driven? Where does data live?
2. **The components** - the concrete boxes that make up the system: an API gateway, an authentication service, a database, a cache, a queue.
3. **The modules** - what lives *inside* each component. Inside "Authentication" you might find token generation, token validation, refresh handling, and session storage.

The fourth, and most important, output is **how these pieces interact**. A database and an application server are boring on their own. Whether the server talks to the database synchronously on every request, or writes to a queue that a worker drains later, completely changes the behaviour of the product: its latency, its failure modes, its cost.

Your own note captures it well: *architecture is the big detail, components such as authentication sit inside it, and modules such as token management sit inside the components. How they interact makes the product.*

System design is therefore not "drawing boxes". It is making a series of decisions, each with consequences, until the requirements are satisfied and the team can actually build it.`,
      mentalModel:
        'Think of a city. Architecture is the zoning plan (residential here, industrial there). Components are the buildings. Modules are the rooms inside each building. Roads and pipes between buildings are the interactions, and a city with great buildings but no roads is useless.',
      diagram: `Requirements
     |
     v
+-------------+      +-----------------+      +----------------+
| Architecture| ---> |   Components    | ---> |    Modules     |
| (the shape) |      | (the boxes)     |      | (inside boxes) |
+-------------+      +-----------------+      +----------------+
        \\__________________  Interactions  ___________________/
                       (arrows between boxes)`,
      keyPoints: [
        'Input is requirements; output is architecture, components, modules, and their interactions.',
        'Architecture > components > modules is a zoom-in hierarchy.',
        'Interactions (the arrows) matter as much as the boxes.',
        'Design is a sequence of decisions, not a drawing exercise.',
      ],
      checkpoint: {
        question:
          'In an e-commerce app, is "Payment" an architecture, a component, or a module? What would be a module inside it?',
        answer:
          '"Payment" is a component. Modules inside it could be: payment-gateway integration, retry/idempotency handling, refund processing, and transaction ledger writes.',
      },
    },
    {
      id: 'why-it-matters',
      title: 'Why system design decides product success',
      body: `A product is not a single piece of code. It is many pieces working together, built by many people, over a long time. System design is what makes that possible.

**It creates boundaries.** When "Authentication" is a clearly defined component with a clear contract (input: credentials, output: token), one team can build it while another team builds "Orders" against the contract. Without design, everyone steps on everyone.

**It decides behaviour under stress.** Two systems with identical features can behave completely differently when traffic spikes 10x or a database node dies. One of them stays up. The difference is almost never the code inside a module; it is how the components were connected and what happens when a connection fails.

**It decides cost.** Choosing to cache reads, or to batch writes, or to use object storage instead of a database for large files, can change the monthly bill by an order of magnitude.

**It is how interviews test seniority.** Junior engineers are asked to write a function. Senior engineers are asked to design a system, because designing a system requires understanding how everything fits together and where it will break.`,
      mentalModel:
        'A team of brilliant chefs with no kitchen layout, no order tickets and no agreement on who plates what will still produce chaos. The layout and the ticket flow are the system design.',
      keyPoints: [
        'Clear component boundaries let teams work in parallel.',
        'Behaviour under load and under failure is decided by design, not by module code.',
        'Design choices drive cost.',
        'Design skill is how engineering seniority is evaluated.',
      ],
    },
    {
      id: 'requirements',
      title: 'Requirements: functional and non-functional',
      body: `Everything starts from requirements, and they come in two flavours.

**Functional requirements** describe *what* the system does. "Users can upload a photo." "A user can follow another user." "An order can be refunded within 7 days." These map to features and, eventually, to APIs.

**Non-functional requirements (NFRs)** describe *how well* it must do those things:

- **Scale** - how many users, requests per second, bytes stored?
- **Latency** - how fast must a response be? p50, p99?
- **Availability** - how much downtime is tolerable? 99.9% is ~9 hours a year; 99.99% is ~52 minutes.
- **Consistency** - must every reader see the latest write immediately?
- **Durability** - can we ever lose a written record?
- **Cost** - what is the budget?

NFRs are what actually shape the architecture. "Users can upload a photo" is a small feature; "100 million users upload photos and each must be visible worldwide within 2 seconds" is a completely different system.

A designer's first job is to *extract* NFRs, because stakeholders rarely state them. Ask: how many, how fast, how often, how critical, how much can we spend?`,
      mentalModel:
        'Functional requirements are the destination; non-functional requirements are whether you need a bicycle, a car, or a cargo plane to get there.',
      diagram: `            Requirements
           /            \\
  Functional (WHAT)      Non-functional (HOW WELL)
  - upload photo         - 100M users, 5k QPS
  - follow a user        - p99 < 200 ms
  - refund an order      - 99.99% available
        |                - never lose a write
        v                        |
     APIs / features             v
                          Architecture shape
                   (caches, replicas, queues, regions)`,
      keyPoints: [
        'Functional = what the system does. Non-functional = how well.',
        'NFRs (scale, latency, availability, consistency, durability, cost) drive architecture.',
        'Always extract numbers: users, QPS, data size, latency targets.',
        'The same feature at different scale is a different system.',
      ],
      checkpoint: {
        question:
          'A stakeholder says "the site should be fast and never go down". Rewrite that as two measurable non-functional requirements.',
        answer:
          'Example: "p99 page-load latency under 300 ms for the product page" and "99.95% monthly availability for the checkout flow (about 22 minutes of downtime per month)".',
      },
    },
    {
      id: 'interactions',
      title: 'Interactions: where systems actually live',
      body: `Once components exist, the real design work is deciding how they talk.

**Synchronous (request-response).** Component A calls component B and waits. Simple, easy to reason about, but A is now coupled to B's latency and availability. If B is slow, A is slow. If B is down, A fails.

**Asynchronous (message-based).** A drops a message in a queue and moves on; B processes it later. A is decoupled from B's health. The price: eventual rather than immediate results, and more moving parts.

**Shared state.** A writes to a database and B reads it. Simple, but hides coupling: schema changes or hot rows affect both.

Every arrow in your diagram should have answers to four questions:

1. Is it sync or async?
2. What is the contract (payload, protocol, API)?
3. What happens if the callee is slow or down?
4. How much traffic flows through it?

Designing interactions well is the difference between a system that degrades gracefully and one that collapses in a cascade.`,
      mentalModel:
        'Sync is a phone call: you wait on the line. Async is a text message: you send it and get on with your day. Shared state is a whiteboard in a shared office: anyone can read or scribble, and nobody notices who changed what.',
      diagram: `Sync:    [A] --request--> [B]      A waits; coupled to B
              <--response--

Async:   [A] --msg--> [Queue] --msg--> [B]   A moves on

Shared:  [A] --write--> [ DB ] <--read-- [B]  hidden coupling`,
      keyPoints: [
        'Three interaction styles: synchronous, asynchronous, shared state.',
        'Sync couples availability and latency; async decouples them at the cost of immediacy.',
        'Every arrow needs: protocol, contract, failure behaviour, and traffic estimate.',
        'Cascading failures are almost always an interaction-design problem.',
      ],
    },
    {
      id: 'trade-offs',
      title: 'There is no perfect design, only trade-offs',
      body: `The single most important mindset in system design: **every decision costs something.**

- Adding a cache speeds up reads but introduces staleness and one more thing to operate.
- Replicating a database improves availability but complicates consistency.
- Splitting a monolith into services lets teams move independently but adds network latency and operational complexity.
- Choosing strong consistency simplifies application logic but limits availability during partitions.

A weak designer says "we should use Kafka". A strong designer says "we need to absorb bursty writes and decouple producers from consumers, so a log-based message stream fits; the cost is operational overhead and eventual consistency, which our requirements tolerate."

The pattern for every decision:

1. State the requirement that forces the decision.
2. List 2-3 options.
3. Name the trade-off of each.
4. Pick one *and say why*, referencing the requirement.

This chapter also sets up a habit for the remaining topics: for every building block (databases, caches, brokers, load balancers) ask *what does it give me, what does it cost me, and when would I not use it?*`,
      mentalModel:
        'Every design decision is a purchase. You never ask "is this good?", you ask "is this worth the price for what I need?".',
      keyPoints: [
        'Every design choice has a cost; name it explicitly.',
        'Justify choices by pointing at a requirement.',
        'Pattern: requirement -> options -> trade-offs -> decision with reason.',
        'Ask of every building block: what does it give, what does it cost, when not to use it.',
      ],
      checkpoint: {
        question:
          'Your team wants to add a Redis cache in front of the user-profile database. Name one benefit and two costs.',
        answer:
          'Benefit: far lower read latency and reduced database load. Costs: stale data when profiles change unless you invalidate carefully, and a new component to deploy, monitor, and keep highly available.',
      },
    },
    {
      id: 'how-to-study',
      title: 'How to study for deep understanding',
      body: `This app is built around techniques that produce durable understanding rather than recognition.

**Learn page by page.** Each section ends with a *checkpoint*. Commit to an answer before revealing it. Being wrong and then corrected is what builds memory.

**Quiz right after learning.** Retrieval practice is the strongest known learning technique. Mistakes are recorded so you can revisit them.

**Feynman it.** Explain each core concept in plain words, as if to a junior developer. Then compare against the model explanation and tick off the "must mention" points. Gaps in your explanation are gaps in your understanding.

**Walk the memory palace.** Each chapter has a themed location with vivid images anchoring its concepts in a fixed order. Walk it once with eyes closed after finishing the chapter.

**Review on schedule.** Flashcards use spaced repetition; the *Review* page shows what is due today. Ten minutes daily beats three hours monthly.

**Quick revision before interviews.** The one-liner view compresses each chapter into a minute for rapid, repeated revision.`,
      mentalModel:
        'Reading is like watching someone lift weights. Checkpoints, quizzes and Feynman explanations are you lifting the weights.',
      keyPoints: [
        'Predict before you reveal; retrieve before you re-read.',
        'Explain in your own words to expose gaps.',
        'Spaced review beats massed review.',
        'Use quick revision for high-frequency revision.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Which of the following best describes system design?',
      options: [
        'Writing efficient algorithms for a single service',
        'Turning requirements into an architecture, components, modules, and their interactions',
        'Choosing a programming language and framework',
        'Drawing a diagram of servers and databases',
      ],
      answerIndex: 1,
      explanation:
        'System design starts from requirements and produces the architecture, the components, the modules inside them and, crucially, how they interact. Algorithms, languages and diagrams are tools or by-products, not the definition.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'In the zoom-in hierarchy of system design, what sits inside a component?',
      options: ['Architecture', 'Modules', 'Requirements', 'Users'],
      answerIndex: 1,
      explanation:
        'Architecture contains components; components contain modules. Authentication (component) contains token management (module).',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question:
        '"The search page must return results in under 200 ms at p99 for 5,000 requests per second." This is an example of a:',
      options: [
        'Functional requirement',
        'Non-functional requirement',
        'Module',
        'Component contract',
      ],
      answerIndex: 1,
      explanation:
        'It says how well (latency, throughput) rather than what the system does. Functional would be "users can search products".',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which of these are non-functional requirements? Select all that apply.',
      options: [
        'Users can reset their password',
        '99.99% availability',
        'Data must never be lost once acknowledged',
        'Admins can export reports as CSV',
        'p95 latency below 100 ms',
      ],
      answerIndices: [1, 2, 4],
      explanation:
        'Availability, durability and latency describe quality attributes. Password reset and CSV export are features (functional).',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement:
        'If every individual component of a system is well built, the system as a whole will be reliable.',
      answer: false,
      explanation:
        'Reliability emerges from interactions. A well-built service that synchronously depends on a slow downstream will still fail. Cascading failures are interaction problems.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'Service A synchronously calls Service B on every request. B starts responding slowly. What is the most likely immediate effect on A?',
      options: [
        'Nothing; A is independent of B',
        'A becomes slow and may exhaust its threads or connections waiting on B',
        'A automatically switches to asynchronous mode',
        'B recovers because A reduces traffic',
      ],
      answerIndex: 1,
      explanation:
        'Synchronous calls couple latency and availability. A waits on B, so A slows down, its resources pile up, and it can fail too. This is the classic cascade.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'What is the main advantage of asynchronous, queue-based interaction between components?',
      options: [
        'Results are available immediately',
        'The producer is decoupled from the consumer\'s latency and availability',
        'It removes the need for a database',
        'It guarantees strong consistency',
      ],
      answerIndex: 1,
      explanation:
        'The producer drops a message and moves on; consumer slowness or downtime does not block it. The cost is eventual, not immediate, results.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: '99.9% availability allows roughly 9 hours of downtime per year.',
      answer: true,
      explanation: '0.1% of 8,760 hours is about 8.76 hours. 99.99% allows about 52 minutes.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question:
        'A colleague proposes "let\'s use microservices because Netflix does". What is the strongest system-design response?',
      options: [
        'Agree; industry leaders know best',
        'Refuse; microservices are always over-engineering',
        'Ask which requirement forces the split and what the added network and operational cost buys us',
        'Suggest a monolith because it is easier to code',
      ],
      answerIndex: 2,
      explanation:
        'Decisions must trace back to requirements and be justified against their trade-offs. Neither blind adoption nor blind refusal is design.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'Which four questions should you be able to answer for every arrow in an architecture diagram?',
      options: [
        'Colour, thickness, direction, label',
        'Sync or async, contract, failure behaviour, traffic volume',
        'Team owner, budget, deadline, language',
        'Cloud provider, region, instance type, OS',
      ],
      answerIndex: 1,
      explanation:
        'Interactions are defined by their style (sync/async), their contract, what happens when the other side fails, and how much load flows through.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Using the "requirement -> options -> trade-offs -> decision" pattern, argue for or against adding a cache to a product-catalogue read path that serves 20,000 reads/sec with data that changes a few times per day.',
      modelAnswer: `**Requirement:** 20k reads/sec on data that changes rarely; low read latency is presumably important.

**Options:** (a) read directly from the database with read replicas, (b) add an in-memory cache (e.g. Redis) in front of the database, (c) cache at CDN/edge.

**Trade-offs:** (a) simple but expensive to scale and slower; (b) very fast reads, dramatically lower DB load, but introduces staleness and an extra component; (c) fastest for static content but harder to invalidate per item.

**Decision:** Add a cache (b). The data changes only a few times a day, so staleness is easy to control with short TTLs or explicit invalidation on update. The read volume is high enough that the DB savings justify one more component.`,
      rubric: [
        'States the requirement explicitly (high read volume, rarely changing data).',
        'Lists at least two options.',
        'Names a cost of caching (staleness, extra component).',
        'Ties the final decision back to the requirement.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question:
        'Describe the components and at least two modules for a "Notifications" part of a food-delivery app.',
      modelAnswer: `**Component:** Notification Service.

**Modules inside it:** channel adapters (push, SMS, email), template rendering, user preference and rate limiting, delivery tracking/retries, and a scheduler for delayed notifications.

**Interactions:** the Order service publishes "order status changed" events to a queue; the Notification service consumes them asynchronously so order processing never waits on SMS providers.`,
      rubric: [
        'Identifies Notifications as a component, not the architecture.',
        'Lists at least two plausible modules.',
        'Mentions how it interacts with other components (ideally async).',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'System design (one sentence)', back: 'Turning a set of requirements into an architecture, components, modules and the interactions between them.' },
    { id: 'f2', front: 'Architecture vs component vs module', back: 'Architecture: overall shape. Component: a box (e.g. Authentication). Module: what is inside the box (e.g. token refresh).' },
    { id: 'f3', front: 'Functional requirement', back: 'What the system does: a feature or capability, e.g. "user can upload a photo".' },
    { id: 'f4', front: 'Non-functional requirement', back: 'How well it does it: scale, latency, availability, consistency, durability, cost.' },
    { id: 'f5', front: 'Downtime allowed by 99.9% / 99.99% per year', back: 'About 8.76 hours / about 52 minutes.' },
    { id: 'f6', front: 'Three interaction styles between components', back: 'Synchronous request-response, asynchronous messaging, shared state (e.g. common DB).' },
    { id: 'f7', front: 'Main cost of synchronous calls', back: 'Caller is coupled to callee latency and availability; slowness cascades.' },
    { id: 'f8', front: 'Main benefit and cost of async messaging', back: 'Benefit: decoupling from consumer health. Cost: eventual results and more moving parts.' },
    { id: 'f9', front: 'Four questions for every arrow in a diagram', back: 'Sync or async? Contract? What if the other side fails? How much traffic?' },
    { id: 'f10', front: 'Decision pattern in system design', back: 'Requirement -> options -> trade-offs -> decision with a reason.' },
    { id: 'f11', front: 'Why interactions matter more than boxes', back: 'Failure and latency propagate along interactions; a cascade is an arrow problem, not a box problem.' },
    { id: 'f12', front: 'Three questions to ask of any building block', back: 'What does it give me? What does it cost me? When would I not use it?' },
    { id: 'f13', front: 'p99 latency', back: 'The latency below which 99% of requests complete; captures tail experience, unlike the average.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'What system design is',
      prompt: 'Explain what system design is to a junior developer who has only ever written single functions. Use an example.',
      modelExplanation: `When you write a function, you decide what goes in and what comes out. System design is the same idea, one level up. Instead of a function, you have a whole product, and instead of variables you have big building blocks: an authentication service, a database, a cache, a queue.

You start with requirements: what should the product do, and how fast, how reliable, and for how many people. Then you decide the overall shape (the architecture), which blocks you need (components), what each block does inside (modules), and, most importantly, how blocks talk to each other.

For example, in a food-delivery app, "Orders" and "Notifications" are components. Orders could call Notifications directly and wait, or drop a message on a queue and move on. That single choice decides whether a slow SMS provider can slow down placing an order. Making those choices deliberately is system design.`,
      mustMention: [
        'Starts from requirements',
        'Produces architecture, components and modules',
        'Interactions between components are central',
        'Uses a concrete example',
      ],
    },
    {
      id: 'fe2',
      concept: 'Functional vs non-functional requirements',
      prompt: 'Explain the difference between functional and non-functional requirements and why the second kind shapes the architecture.',
      modelExplanation: `Functional requirements are the features: what the system should do. "Users can search products." Non-functional requirements describe how well it must do them: how many users, how fast, how often it can be down, whether data can ever be lost, and how much it may cost.

The functional list tells you which APIs to build. The non-functional list tells you what the system has to look like. Searching products for 100 users can be a single SQL query. Searching for 100 million users with 200 ms responses worldwide needs indexes, caches, replicas, maybe a dedicated search engine. Same feature, very different system, and the difference is entirely non-functional.`,
      mustMention: [
        'Functional = what, non-functional = how well',
        'Examples of NFRs: scale, latency, availability, durability, cost',
        'Same feature at different scale becomes a different system',
      ],
    },
    {
      id: 'fe3',
      concept: 'Trade-offs',
      prompt: 'Explain why there is no single "best" design, using one concrete decision as an example.',
      modelExplanation: `Every design choice buys something and pays for it with something else. Take adding a cache in front of a database. It buys much faster reads and takes load off the database. It pays with staleness: a user may see old data until the cache is refreshed. It also pays with one more component to run and monitor.

Whether that is a good deal depends entirely on the requirements. For a product catalogue that changes a few times a day, it is a great deal. For a bank balance that must always be exact, it may be a terrible one. So the question is never "is a cache good?" but "is a cache worth its price for this requirement?". That is why designers justify decisions by pointing at requirements.`,
      mustMention: [
        'Every choice has a cost',
        'A concrete example with benefit and cost',
        'The decision depends on requirements',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through the construction site of a new house, from the street to the back garden. Each stop anchors one idea about what system design is.',
    stops: [
      { locus: 'The mailbox at the gate', concept: 'Requirements come first', image: 'The mailbox is overflowing with letters, each stamped REQUIREMENT in red. One shouts "10,000 users!" while another whispers "must never go down". You cannot enter until you read them all.' },
      { locus: 'The architect\'s blueprint table', concept: 'Architecture is the overall shape', image: 'A giant blueprint flaps in the wind, showing only the outline of the house. No furniture, just the shape and where the plumbing runs.' },
      { locus: 'Stacked rooms on the lawn', concept: 'Components are the boxes', image: 'Pre-fabricated rooms sit on the lawn like shipping containers, each labelled: AUTH, ORDERS, PAYMENTS, DATABASE. A crane lifts them into place.' },
      { locus: 'Inside the AUTH container', concept: 'Modules live inside components', image: 'You step inside AUTH and find tiny workers: one stamping tokens, one shredding expired ones, one filing sessions in cabinets.' },
      { locus: 'The plumbing between rooms', concept: 'Interactions define the system', image: 'Pipes connect the containers. Some are rigid copper (synchronous: water waits), others are conveyor belts carrying parcels (asynchronous). A pipe bursts and floods three rooms at once: a cascade.' },
      { locus: 'The price tags on every material', concept: 'Every decision is a trade-off', image: 'Every brick, pipe and cable has a price tag with two sides: "GIVES: speed" and "COSTS: staleness". The foreman refuses to buy anything without reading both sides aloud.' },
      { locus: 'The back garden with a tiny shed', concept: 'Start simple and evolve', image: 'Behind the grand plans sits a tiny finished shed that actually works. A sign reads: "Build this first. Extend when it creaks."' },
    ],
  },
  interviewQuestions: [
    'What is system design and how does it differ from software design or coding?',
    'How do you gather requirements at the start of a design interview?',
    'Give an example of a functional and a non-functional requirement for a ride-sharing app.',
    'Why do interaction patterns between services matter more than the internals of any one service?',
    'Describe a trade-off you made in a real project and how you justified it.',
    'How many minutes of downtime does 99.99% availability permit per month?',
  ],
}

export default chapter
