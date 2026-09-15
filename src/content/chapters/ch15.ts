import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 15, slug: 'realtime-pubsub', title: 'Realtime PubSub', module: 'messaging',
  estimatedMinutes: 35,
  summary: 'Deliver live events to connected users through gateways and topics. Separate fast delivery from durable history, then design reconnection, ordering, authorization, and slow-consumer behavior.',
  objectives: ['Trace an event from publisher through a broker and gateway to subscribers.', 'Separate connection transport from delivery guarantees.', 'Design reconnection using durable history and cursors.', 'Bound fanout work and slow-client queues.'],
  quickRevision: ['Pub/sub routes publications to interested subscribers.', 'WebSocket is a bidirectional transport, not a durable message store.', 'Server-sent events support server-to-client updates over HTTP.', 'Redis Pub/Sub delivers at most once; disconnected subscribers miss messages.', 'Persist important events before relying on live delivery.', 'A reconnect cursor identifies where durable replay should resume.', 'Ordering is usually scoped to a room, stream, or partition.', 'Deduplicate repeated events by stable identifiers.', 'Bound each connection queue and define slow-consumer behavior.', 'Authorize subscriptions and enforce membership changes after connection.'],
  sections: [
    { id: 'event-path', title: 'From a publication to many screens',
      body: `A chat room, live scoreboard, and collaborative dashboard all need one update to reach many interested clients. Pub/sub separates the publisher from the recipients. A publisher names a topic, and subscribers express interest in that topic. A broker or routing layer connects the two. The publisher does not need to know which gateway currently holds each browser connection.

In a web application, browsers commonly connect to a gateway over WebSocket or server-sent events. Gateways subscribe to the backend topics needed by their connected clients and forward matching events. An instance can subscribe once for a room and fan out locally to many browsers, reducing duplicate broker subscriptions. When its last interested client leaves, it can release that subscription.

Decide topic granularity carefully. One global topic sends irrelevant work to every gateway. A topic per user can create a large subscription set. A room or tenant topic may balance routing cost and filtering, but it must respect access boundaries. Count events delivered, not merely events published: one small publication may trigger thousands of downstream sends.`,
      mentalModel: 'A radio station broadcasts once, neighborhood relay towers receive the program, and each tower serves many nearby listeners.',
      diagram: 'Publisher -> topic broker -> gateway A -> browsers 1, 2\n                         \-> gateway B -> browser 3',
      keyPoints: ['Separate publishers from connection placement.', 'Gateways can share subscriptions locally.', 'Fanout determines downstream work.'],
      checkpoint: { question: 'A room has 5,000 viewers across ten gateways. Must the broker have 5,000 subscriptions?', answer: 'No. Each gateway can subscribe once for the room and fan out to its local viewers. The gateway still performs the individual client sends.' } },
    { id: 'transport', title: 'A live connection is only the transport',
      body: `WebSocket provides a long-lived bidirectional connection: the client and server can each send messages. It suits interactions such as chat or collaborative editing. Server-sent events provide a server-to-client event stream over HTTP, often fitting dashboards and notifications while ordinary HTTP requests carry client actions. Polling can also be a reasonable choice when updates are infrequent or connection infrastructure would be unnecessary complexity.

None of these choices automatically makes an application event durable. A gateway can accept a message and crash before persisting or forwarding it. A network can fail after delivery but before an acknowledgment returns. Define which component owns accepted data and what any acknowledgment means. A transport-level successful write is not proof that a person saw the update.

Long-lived connections consume memory, file descriptors, and network capacity. Configure idle handling and heartbeats so dead peers eventually disappear, while avoiding synchronized heartbeat bursts. Load balancing assigns a connection to a gateway, but reconnection may choose a different gateway. Store durable user and room state outside the lifetime of that one connection so the application can recover.`,
      mentalModel: 'A telephone line lets people talk both ways, but it is not a recording archive and does not prove the other person heard every word.',
      diagram: 'Browser <== WebSocket ==> gateway\nBrowser <--- SSE -------- gateway\nBrowser ---- HTTP action -> API\nTransport success != durable application acknowledgment',
      keyPoints: ['Choose transport from interaction direction and update frequency.', 'Define application acknowledgments separately.', 'Expect reconnection to a different gateway.'],
      checkpoint: { question: 'Does sending a message through WebSocket guarantee it survives a gateway crash?', answer: 'No. Durability requires application storage or a durable log and an acknowledgment tied to that persistence step.' } },
    { id: 'history-and-reconnect', title: 'Combine live delivery with recoverable history',
      body: `Some events are disposable. A cursor position or typing indicator can be replaced by the next update. Other events, such as an accepted chat message, must be recoverable. Treat live delivery as an acceleration path for durable events rather than their only storage location. Assign an event identifier and persist the accepted event before reporting the promised success.

A reconnecting client sends its last applied cursor and requests subsequent events from retained history. Redis Pub/Sub alone does not provide this replay: its at-most-once delivery means a subscriber disconnected during publication misses the event. A durable log, stream, or database can supply the missing history. Keep a retention policy and tell clients when their cursor is too old, in which case they may need a fresh snapshot.

Avoid a gap between replay and live subscription. One design subscribes first, buffers live events, fetches history through a known watermark, then merges and deduplicates the buffer. A cursor-capable durable stream can offer another route. Explicitly test a publication at the exact point where replay finishes and live delivery begins.`,
      mentalModel: 'Live announcements are the loudspeaker; the numbered notice board is the record you consult after returning from lunch.',
      diagram: 'Persist event #42 -> publish -> live subscribers\nReconnect(last=#39) -> history #40..#42 -> merge live buffer\nExpired cursor -> snapshot + new cursor',
      keyPoints: ['Classify disposable versus durable events.', 'Use retained history for reconnect.', 'Close the replay/live handoff gap.'],
      checkpoint: { question: 'Why can fetching missed history and only then subscribing lose an event?', answer: 'An event can be published after the history query ends but before the subscription begins. Coordinate the handoff with a watermark and buffering, or use a durable cursor-based stream.' } },
    { id: 'order-and-backpressure', title: 'Ordering and slow consumers',
      body: `Users usually need a meaningful local order, such as messages within one room, rather than a single order across the entire application. Route a room through a sequencing owner or ordered partition, and carry a sequence or cursor in the event. Client timestamps are not a reliable total ordering mechanism because clocks differ and messages can be delayed. Multiple publishers need a stated sequencing policy.

Retries and replay can introduce duplicates even if a live channel itself does not retry. A stable event identifier lets the receiver avoid applying the same operation twice. An edit event should describe whether it replaces state, increments a value, or requires a specific prior version; these operations have different behavior when repeated or reordered.

Every gateway also needs a slow-consumer policy. A browser on a weak connection must not accumulate an unbounded queue. Coalesce disposable state updates, discard superseded presence events, or disconnect and require replay for durable events. Bound queue bytes as well as message count, because one unusually large event can dominate memory. Monitor queue age to detect users receiving updates too late.`,
      mentalModel: 'Each room has numbered tickets. A slow listener receives the latest weather report, but retrieves missed numbered letters from the archive.',
      keyPoints: ['Define ordering scope.', 'Deduplicate repeated application events.', 'Bound queues and choose semantics-aware overflow behavior.'],
      checkpoint: { question: 'Can a gateway safely replace ten queued typing updates with the latest one?', answer: 'Usually yes, because typing is replaceable state. It should not silently replace ten durable chat messages; those need delivery or a recoverable replay path.' } },
    { id: 'authorization-and-scale', title: 'Protect topics and survive reconnect storms',
      body: `Authenticate the connection and authorize every requested subscription. Knowing a room identifier is not proof of membership. Also validate publish rights: permission to read a room does not necessarily include permission to send messages or administer it. When membership changes, update existing subscriptions rather than waiting indefinitely for users to reconnect.

Capacity planning includes active connections, per-connection memory, publication rate, recipient fanout, and payload size. For example, one hundred events per second sent to two thousand viewers produces two hundred thousand deliveries per second before retries and protocol overhead. Popular rooms can overload one routing partition or gateway set even when total connection count appears modest.

A gateway restart can cause many clients to reconnect simultaneously. Use exponential backoff with jitter, bounded admission, and staged draining during deploys. Clients should resume from a cursor rather than assuming that reconnecting starts a complete session. Observe connection churn, delivery latency, queue growth, replay failures, and authorization failures. A healthy broker alone does not mean users are receiving timely, permitted updates.`,
      mentalModel: 'A concert wristband is checked at every restricted area, and evacuation doors reopen gradually so the returning crowd does not crush the entrance.',
      keyPoints: ['Authorize both subscriptions and publications.', 'Propagate access revocation to existing connections.', 'Plan fanout and reconnect load separately.'],
      checkpoint: { question: 'A user is removed from a private room but keeps their socket open. What must happen?', answer: 'The system must revoke or refresh that subscription and stop forwarding protected events. Authentication at connection time alone is insufficient.' } },
  ],
  quiz: [
    { type: 'mcq', id: 'q1', difficulty: 1, question: 'Which component usually owns browser connections?', options: ['A database index', 'A gateway', 'A hash function', 'A backup archive'], answerIndex: 1, explanation: 'Gateways terminate live connections and route events to interested clients.' },
    { type: 'mcq', id: 'q2', difficulty: 2, question: 'What recovers durable events missed while disconnected?', options: ['A TCP keepalive alone', 'A longer topic name', 'Retained history and a resume cursor', 'Redis Pub/Sub alone'], answerIndex: 2, explanation: 'A cursor identifies the replay position in retained history. Ephemeral delivery and connection probes do not reconstruct missed events.' },
    { type: 'mcq', id: 'q3', difficulty: 2, question: 'Which event is the best candidate for coalescing?', options: ['Latest typing status', 'A payment ledger entry', 'A newly accepted chat message', 'A unique audit event'], answerIndex: 0, explanation: 'Typing status is replaceable state. The other events usually require durable individual history.' },
    { type: 'mcq', id: 'q4', difficulty: 2, question: 'What usually defines useful chat ordering?', options: ['A total order of every application event', 'Client wall clocks alone', 'Alphabetical username', 'A room-scoped sequence'], answerIndex: 3, explanation: 'A room-scoped sequence gives meaningful conversation order without unnecessary global coordination.' },
    { type: 'multi', id: 'q5', difficulty: 2, question: 'Which protect a gateway from slow clients?', options: ['Bounded queue bytes', 'Coalescing replaceable state', 'Disconnect-and-replay for durable events', 'Unlimited buffering'], answerIndices: [0, 1, 2], explanation: 'These keep memory finite while respecting event semantics. Unlimited queues eventually exhaust the gateway.' },
    { type: 'truefalse', id: 'q6', difficulty: 1, statement: 'A WebSocket connection automatically provides durable message replay.', answer: false, explanation: 'WebSocket is transport. Replay requires retained application history and a resume protocol.' },
    { type: 'truefalse', id: 'q7', difficulty: 2, statement: 'Authorization can need updating while a connection remains open.', answer: true, explanation: 'Membership and permissions may change after connection establishment.' },
    { type: 'truefalse', id: 'q8', difficulty: 2, statement: 'Fetching history before subscribing always gives a gap-free handoff.', answer: false, explanation: 'A publication between the history read and subscription can be missed.' },
    { type: 'short', id: 'q9', difficulty: 3, question: 'Design reconnection for a durable room feed.', modelAnswer: 'Persist events with room-scoped cursors. A client resumes after its last applied cursor. Coordinate live subscription and replay using a buffer and watermark, deduplicate by event ID, and offer snapshot recovery when history has expired.', rubric: ['Durable history and cursor', 'Gap-free replay/live handoff', 'Deduplication', 'Expired-cursor recovery'] },
    { type: 'short', id: 'q10', difficulty: 3, question: 'A deployment disconnects 100,000 clients. How do you recover safely?', modelAnswer: 'Drain gateways gradually when possible. Clients reconnect with exponential backoff and jitter. Bound admission and replay work, resume sessions from retained cursors, and monitor connection churn, queue age, and replay latency while restoring capacity.', rubric: ['Staged draining', 'Backoff and jitter', 'Bounded replay and admission', 'Recovery observability'] },
  ],
  flashcards: [
    { id: 'f1', front: 'Pub/sub', back: 'Publishers send to topics; subscribers receive topics they are interested in without publishers tracking every recipient.' },
    { id: 'f2', front: 'Gateway', back: 'Owns client connections and forwards authorized backend events to local subscribers.' },
    { id: 'f3', front: 'WebSocket', back: 'A bidirectional connection transport. Application persistence, acknowledgments, and replay remain separate responsibilities.' },
    { id: 'f4', front: 'Server-sent events', back: 'Server-to-client event streaming over HTTP. Client actions can use separate HTTP requests.' },
    { id: 'f5', front: 'Redis Pub/Sub delivery', back: 'At most once. A disconnected subscriber misses events; use retained history elsewhere when replay is required.' },
    { id: 'f6', front: 'Resume cursor', back: 'Identifies the last applied position so a reconnecting client can request later retained events.' },
    { id: 'f7', front: 'Replay/live gap', back: 'Events can fall between a history query and subscription. Coordinate with buffering and a watermark or a durable cursor stream.' },
    { id: 'f8', front: 'Ordering scope', back: 'The domain within which order is promised, such as one room or partition. Avoid assuming global order.' },
    { id: 'f9', front: 'Event deduplication', back: 'Track stable event IDs or sequence progress so replay and retries do not apply an operation twice.' },
    { id: 'f10', front: 'Backpressure', back: 'Bound pending work and react when consumers cannot keep up: coalesce, slow, reject, or reconnect with replay.' },
    { id: 'f11', front: 'Fanout cost', back: 'Publication rate multiplied by recipients and payload size drives downstream delivery work.' },
    { id: 'f12', front: 'Reconnect storm', back: 'Many clients rejoin simultaneously after failure. Jittered backoff and bounded admission spread the load.' },
  ],
  feynman: [
    { id: 'fe1', concept: 'Live delivery versus history', prompt: 'Explain why a chat app needs more than a live socket.', modelExplanation: 'A live socket is like the loudspeaker in a station. If you are listening, you hear the announcement quickly. If you step outside or the speaker breaks, the sound is gone. Important messages need a notice board too: a durable record with numbered entries. When you return, you tell the desk the last number you read and receive the later entries. The app also needs to coordinate when it switches from reading the board to listening live, or an announcement can fall into the gap. Some messages, like a typing indicator, do not need a permanent record because the next update replaces them. The key distinction is the value of the event, not whether its transport happens to be WebSocket.', mustMention: ['Transport is not storage', 'Durable numbered history', 'Resume after a cursor', 'Disposable events differ'] },
    { id: 'fe2', concept: 'Slow consumers', prompt: 'Explain how one slow browser can hurt a gateway and how to prevent it.', modelExplanation: 'Imagine a courier putting letters into a mailbox faster than the owner empties it. An infinitely expanding mailbox eventually fills the entire building. A gateway behaves the same way if it queues unlimited events for a slow browser. Give each connection a finite budget. For changing state, such as a cursor position, keep the newest value instead of every old movement. For durable messages, disconnect the slow client and let it recover from stored history rather than silently losing accepted messages. Measure bytes and how long the oldest queued event has waited. This keeps one weak connection from consuming the memory needed to serve everyone else, while making the recovery promise explicit.', mustMention: ['Unbounded queue risk', 'Finite byte budget', 'Coalesce replaceable state', 'Replay durable messages'] },
  ],
  memoryPalace: { setting: 'Walk through a station with a broadcast booth and numbered notice board.', stops: [
    { locus: 'Broadcast booth', concept: 'Pub/sub', image: 'One announcer speaks into a glowing topic microphone that lights up matching platforms.' },
    { locus: 'Telephone booth', concept: 'Transport', image: 'A two-way phone talks loudly but has no tape recorder inside.' },
    { locus: 'Notice board', concept: 'Durable replay', image: 'Numbered letters wait for a traveler holding ticket 39 to collect 40 onward.' },
    { locus: 'Moving bridge', concept: 'Replay handoff', image: 'A net catches letters falling between the notice board and the loudspeaker.' },
    { locus: 'Small mailbox', concept: 'Backpressure', image: 'An overflowing mailbox ejects old weather reports while preserving numbered letters in a vault.' },
    { locus: 'Ticket gate', concept: 'Authorization', image: 'A wristband fades mid-journey and the private platform gate immediately closes.' },
  ] },
  interviewQuestions: ['Design a room-based realtime pub/sub system.', 'What does WebSocket provide, and what must the application add?', 'How do you avoid gaps during reconnect replay?', 'How do you handle slow subscribers and hot rooms?', 'How do you revoke access on an existing connection?'],
}

export default chapter
