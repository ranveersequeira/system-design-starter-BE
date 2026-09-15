import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 23,
  slug: 'consistent-hashing',
  title: 'Consistent Hashing',
  module: 'building-blocks',
  estimatedMinutes: 35,
  summary:
    'Consistent hashing is the technique that lets a cluster of caches or database nodes grow and shrink without reshuffling almost all of its data. By placing both nodes and keys on a hash ring and assigning each key to the next node clockwise, adding or removing one node moves only about 1/N of the keys. Virtual nodes smooth the load, and walking further around the ring gives replication for free; Cassandra, DynamoDB, Riak, memcached clients and modern load balancers all build on it.',
  objectives: [
    'Explain why hash(key) mod N causes almost every key to move when N changes, and quantify it.',
    'Describe the hash ring, how keys find their owner, and why adding or removing a node moves only about 1/N of keys.',
    'Justify virtual nodes: even load, spread-out failover, and weighting by machine capacity.',
    'Show how replication is achieved by walking the ring to the next distinct physical nodes.',
    'Work through a numeric example of assignment, node addition and node removal, and name real systems that use the technique.',
  ],
  quickRevision: [
    'Problem: with server = hash(key) mod N, changing N from 4 to 5 remaps about 80% of keys; every cache misses at once and every database row migrates.',
    'Consistent hashing places nodes and keys on the same ring (hash space, e.g. 0..2^32-1); a key belongs to the first node clockwise from its position.',
    'Adding a node steals only the keys between it and its predecessor; on average 1/N of all keys move. Removing a node hands its keys to its clockwise successor only.',
    'With one point per node, load is uneven (some arcs are much longer than others) and a failed node dumps its entire load on one neighbour.',
    'Virtual nodes (vnodes) fix this: each physical node owns many ring positions (100-256), so arcs average out and a failed node\'s keys spread across many survivors.',
    'Vnodes also allow weighting: give a machine with 2x capacity 2x the vnodes.',
    'Replication: store the key on the next R distinct physical nodes clockwise (skipping vnodes of the same machine, and often the same rack).',
    'Lookup is a binary search over the sorted token list: O(log(N * V)) in memory, effectively microseconds.',
    'Cassandra and DynamoDB (and Riak, Voldemort) partition data by token ring; memcached clients (ketama) pick cache servers this way; Envoy and Nginx offer ring-hash load balancing.',
    'Consistent hashing balances key ranges, not traffic: a single celebrity hot key still lands on one node.',
    'Alternatives: rendezvous (HRW) hashing, jump consistent hash (no ring, tiny memory, only supports growing/shrinking at the end), Maglev (O(1) lookup table for load balancers).',
    'All clients must use the same hash function and the same node list, or they will disagree on ownership.',
  ],
  sections: [
    {
      id: 'modulo-problem',
      title: 'The rehashing problem with hash mod N',
      body: `The simplest way to spread keys across N servers is to compute server = hash(key) mod N. It is fast, stateless, and perfectly balanced when hash is good. It has one fatal flaw: **N is in the formula**.

Consider four cache servers and a key whose hash is 17. 17 mod 4 = 1, so it lives on server 1. Now traffic grows and you add a fifth server. 17 mod 5 = 2. The key has moved, and so has almost every other key. How many exactly? A key stays put only when hash mod 4 equals hash mod 5, which happens for about 1 in 5 keys. So going from 4 to 5 servers **moves 80% of all keys**. In general, going from N to N+1 moves N/(N+1) of the keys; for large clusters it is essentially everything.

For a cache this is a **cold-start storm**: 80% of lookups suddenly miss, and the database behind the cache absorbs the entire read load at once. For a database (sharded users table, Cassandra-style partitions) it is worse: 80% of rows must physically migrate between machines before the cluster is consistent again, a multi-hour operation with network saturation and a window of wrong answers.

The same happens on the way down. A server crashes, N becomes N-1, and every client that notices recomputes ownership for everything. Failure of one machine turns into a cluster-wide reshuffle.

Notice the asymmetry with what *should* happen. If you add one server to four, the ideal is that it takes one fifth of the keys, one twentieth from each existing server, and nothing else changes. Modulo hashing gives you no way to express "nearly everything stays where it was". We need a mapping from keys to servers that is **stable under changes to the server set**, so that only the keys that must move do move. That property is what "consistent" means in consistent hashing (Karger et al., 1997, originally for distributed web caching at Akamai).`,
      mentalModel:
        'Seating guests by "ticket number mod number of tables": add one table and everyone in the room stands up and moves. The goal is a seating rule where a new table only pulls a few guests from its neighbours.',
      diagram: `hash(key) mod N, N = 4 -> 5

 key hash   mod 4   mod 5   moved?
 ------------------------------------
    17        1       2      yes
    20        0       0      no
    23        3       3      no
    26        2       1      yes
    31        3       1      yes
    42        2       2      no   <- only ~1 in 5 stay
    58        2       3      yes
    63        3       3      no

  fraction moved ~ N / (N+1) = 80%  (ideal is 1/(N+1) = 20%)`,
      keyPoints: [
        'hash mod N couples every key\'s placement to the cluster size.',
        'Changing N from 4 to 5 remaps about 80% of keys; from N to N+1 remaps N/(N+1).',
        'In caches this causes a miss storm; in databases a massive data migration.',
        'The ideal is that only 1/(N+1) of keys move: exactly the new node\'s fair share.',
      ],
      checkpoint: {
        question:
          'A memcached pool of 10 servers uses hash mod 10. One server dies and the client library drops it from the list. What fraction of cached items become unreachable (misses)?',
        answer:
          'About 90%. Only keys where hash mod 10 equals hash mod 9 stay on the same server, roughly 1 in 10. The other 90% are now looked up on the wrong server, miss, and are refetched from the database, even though 9 of the 10 servers still hold perfectly good data.',
      },
    },
    {
      id: 'hash-ring',
      title: 'The hash ring: nodes and keys in the same space',
      body: `Consistent hashing changes one thing: instead of hashing keys to a server index, hash **both servers and keys into the same fixed space**, and treat that space as a circle.

Pick a hash function with a large output, say 32 bits, so positions run from 0 to 2^32 - 1, and imagine 2^32 - 1 wrapping back to 0. Each server is placed on the ring at hash(server_id), for example hash of its IP and port. Each key is placed at hash(key). **A key belongs to the first server encountered walking clockwise from the key's position.** If you pass the top of the ring you wrap around.

Why does this fix the problem? Server positions no longer depend on how many servers there are. Adding server D at position 60 only changes ownership for keys in the arc between D's predecessor and D: those keys used to walk clockwise past 60 to the next server, now they stop at D. Every other key still walks to the same server it always did. **On average the new server takes 1/N of the keys, and takes them from exactly one neighbour.** Removing a server is the mirror image: its arc is absorbed by the next server clockwise; nothing else moves.

**The data structure.** Keep the server positions (called tokens) in a sorted array or balanced tree. To locate a key: hash it, then binary-search for the first token >= hash (Java's TreeMap.ceilingKey, Python's bisect). If none, wrap to the first token. That is O(log N) per lookup and trivially fits in memory: even 1,000 servers with 256 virtual nodes each is 256,000 tokens, a few megabytes.

**Which hash?** Anything fast and uniform: MD5 (original Dynamo, ketama), Murmur3 (Cassandra's default partitioner, range -2^63 to 2^63 - 1), xxHash, CRC32 in some memcached clients. The hash need not be cryptographic; it must be consistent across every client and server, because the ring lives in each client's memory and they must all agree.

Consistent hashing does not require a central coordinator. Each client only needs the current list of servers (from configuration, DNS, ZooKeeper, or gossip) and the shared hash function, and it computes the same ring as everyone else.`,
      mentalModel:
        'A circular street with houses (servers) at certain addresses. A letter (key) is delivered to the first house you reach walking clockwise from its address. Build a new house and only the letters between it and the previous house change delivery; demolish one and its letters go to the next house down the road.',
      diagram: `ring 0..99 (wraps), nodes A=10  B=40  C=75

              0/100
            .   A(10)
       k4=90 .        .
         .              .  k2=33
        .                .
        .                 B(40)
        .                .
         C(75)          .  k3=50
            .         .
               .   .

 key -> first node clockwise
 k2=33 -> B(40)   k3=50 -> C(75)   k4=90 -> wraps -> A(10)`,
      keyPoints: [
        'Servers and keys are hashed into the same circular space.',
        'A key is owned by the first server clockwise from its position.',
        'Server positions do not depend on N, so adding/removing one only changes one arc.',
        'Lookup is a binary search over sorted tokens; the ring lives in each client\'s memory.',
        'Every participant must use the same hash function and the same membership list.',
      ],
      checkpoint: {
        question:
          'On the ring above (A=10, B=40, C=75), where does a key that hashes to 76 live, and where does a key at exactly 40 live?',
        answer:
          'Hash 76 is just past C(75), so it walks clockwise, wraps around 100 to 0, and lands on A(10). Hash 40 is exactly on B; by the usual convention (first token >= hash) it belongs to B.',
      },
    },
    {
      id: 'add-remove',
      title: 'Worked example: adding and removing nodes moves about 1/N keys',
      body: `Let us make the arithmetic concrete on a small ring of 0..99 with three nodes: **A at 10, B at 40, C at 75**. Ownership by arc:

- A owns (75, 100) and [0, 10]: that is 35 positions.
- B owns (10, 40]: 30 positions.
- C owns (40, 75]: 35 positions.

Suppose eight keys hash to 5, 18, 33, 47, 52, 66, 81, 95. Then A holds {5, 81, 95}, B holds {18, 33}, C holds {47, 52, 66}.

**Add node D at 60.** D's arc is (40, 60]: everything that used to walk from just past B to C now stops at D. Keys 47 and 52 move from C to D. Key 66 stays on C. Nothing on A or B changes. Two of eight keys moved, and all of them came from a single node (C). With N nodes the expected share of the new node is 1/(N+1) of the keys, here one quarter, and indeed 2 of 8 is 25%.

Compare with modulo: going from 3 to 4 servers with hash mod N would move about 3/4 of the keys (6 of 8).

**Remove node B (crash).** B's arc (10, 40] is absorbed by the next node clockwise, which is D at 60 (after the addition above). Keys 18 and 33 move to D. A and C are untouched. Again only B's share moved, and again to exactly one node.

**The catch.** That "exactly one node" is a problem in production. When B dies, D suddenly serves its own load plus all of B's. If the cluster was running at 70% capacity per node, D is now at 140% and falls over, handing an even bigger arc to the next node: a **cascading failure around the ring**. Also, with only a handful of tokens the arcs are unequal by luck of the hash: in our example A owns 35 positions and B owns 30, a 17% difference, and with real 32-bit hashes and 5 nodes it is common for one node to own 2-3x the range of another.

Both problems have the same root cause: one position per physical node gives the layout too little randomness to average out. The fix is to give each node many positions, which is the subject of the next section.

**Operationally**, adding a node in Cassandra ("bootstrap") streams exactly the moved ranges from the old owners to the new node while the old owners keep serving reads; then ownership flips. Removing a node ("decommission") streams its ranges to the new owners. Because the moved fraction is 1/N, a 20-node cluster moves about 5% of its data per membership change instead of 95%.`,
      mentalModel:
        'Adding a new bus stop between two existing stops: only the passengers who live between the old stop and the new one change where they get off. Everyone else\'s commute is untouched.',
      diagram: `ring 0..99, keys at 5 18 33 47 52 66 81 95

 before:      A(10)      B(40)         C(75)
 owners:   A:{5,81,95}  B:{18,33}   C:{47,52,66}

 add D(60):   A(10)      B(40)  D(60)  C(75)
 owners:   A:{5,81,95}  B:{18,33}  D:{47,52}  C:{66}
           -> 2 of 8 keys moved (all from C)      mod N: ~6 of 8

 remove B:    A(10)             D(60)  C(75)
 owners:   A:{5,81,95}  D:{18,33,47,52}  C:{66}
           -> 2 keys moved (all to D)  <- D now overloaded`,
      keyPoints: [
        'Adding a node moves only the keys in its new arc, about 1/(N+1) of the total, from one neighbour.',
        'Removing a node moves only its arc, to its clockwise successor.',
        'Modulo would have moved roughly N/(N+1) of keys for the same change.',
        'With one token per node, arcs are uneven and a failure dumps 100% of a node\'s load on one survivor.',
        'Cassandra bootstrap / decommission stream exactly the moved ranges.',
      ],
      checkpoint: {
        question:
          'Continuing the example (A=10, D=60, C=75 after B is removed), a new node E joins at 25. Which keys move, and from which node?',
        answer:
          'E owns (10, 25]. Key 18 moves from D to E. Key 33 is in (25, 60] and stays on D. Exactly one of the seven remaining keys moves, and it comes from D, the node that was overloaded, which is a nice side effect of placing E inside D\'s arc.',
      },
    },
    {
      id: 'virtual-nodes',
      title: 'Virtual nodes: even load and graceful failover',
      body: `The fix for uneven arcs and single-neighbour failover is to place each physical node on the ring **many times**. Each position is a **virtual node** (vnode, or token). Node A might own tokens at hash("A-0"), hash("A-1"), ..., hash("A-199"). The ring now has N * V tokens; a key still goes to the first token clockwise, and that token maps back to its physical owner.

**Why it evens out load.** The share of the ring owned by a physical node is the sum of V random arc lengths. Sums of many random variables concentrate around their mean: the standard deviation of a node's share falls roughly as 1/sqrt(V). With V = 1 a node might own 2x its fair share; with V = 100-200 the imbalance drops to a few percent. Cassandra historically defaulted to 256 tokens per node; since 3.0 it defaults to 16 tokens plus an allocation algorithm that places new tokens deliberately to even out the largest ranges rather than randomly.

**Why it spreads failover.** When physical node B dies, its 200 vnodes are scattered around the ring, and each one is absorbed by whichever token comes next clockwise, which belongs to a different physical node almost every time. B's load is spread across all survivors, each picking up roughly 1/(N-1) of it, instead of one neighbour picking up 100%. The same applies to bootstrap: a new node with 200 tokens takes small slices from many nodes, and the streaming of data comes from many sources in parallel rather than saturating one machine's network.

**Weighting by capacity.** A machine with twice the RAM and disk can be given twice the vnodes and will own twice the key range. This is how heterogeneous clusters stay balanced, something hash mod N cannot express at all.

**Costs.**
- **Metadata grows.** N * V tokens must be stored, sorted and gossiped. At 1,000 nodes and 256 tokens that is 256,000 entries, fine for memory but slower to converge across a gossip protocol, which is one reason Cassandra lowered the default.
- **More, smaller ranges.** Range scans and repair operations (Cassandra's anti-entropy repair, DynamoDB's Merkle-tree sync) work per range; more ranges mean more bookkeeping.
- **Replica placement gets subtler.** Walking clockwise for replicas must skip tokens that belong to the same physical node (next section).

In cache pools the memcached "ketama" algorithm uses about 100-160 points per server for exactly these reasons, and client libraries such as libmemcached, spymemcached and twemproxy ship it.`,
      mentalModel:
        'Instead of one big shop per owner on the circular street, each owner runs 200 kiosks scattered along it. Every owner ends up with about the same total frontage, and when one owner closes, each kiosk is absorbed by a different neighbour.',
      diagram: `physical nodes A, B, C with 4 vnodes each (ring 0..99)

 tokens:  A1  B1  C1  A2  C2  B2  A3  B3  C3  A4  B4  C4
 pos:      3  11  19  27  38  44  52  60  69  77  85  94

 B fails -> B1's arc -> C1,  B2's arc -> A3,
            B3's arc -> C3,  B4's arc -> C4
 load of B spread over A and C, not dumped on one node

 heavier machine? give it 8 vnodes instead of 4`,
      keyPoints: [
        'Each physical node owns many tokens (100-256 typical), scattered pseudo-randomly.',
        'Load imbalance falls as roughly 1/sqrt(V); with hundreds of vnodes it is a few percent.',
        'A failed node\'s ranges are absorbed by many survivors, avoiding cascade.',
        'Bigger machines get more vnodes; heterogeneous clusters stay balanced.',
        'Costs: more metadata to gossip, more ranges to repair, replica placement must skip same-node tokens.',
      ],
      checkpoint: {
        question:
          'Cassandra reduced its default num_tokens from 256 to 16 in version 4.0. What did the higher number buy, and what did it cost, that motivated the change?',
        answer:
          '256 random tokens gave very even load and very spread-out streaming. It cost large token metadata that slowed gossip convergence and cluster startup, fragmented ranges that made repair and range queries slower, and, with high replication factors, raised the chance that any given set of three nodes failing loses some range entirely. With a deliberate token-allocation algorithm, 16 tokens achieve nearly the same balance with far less overhead.',
      },
    },
    {
      id: 'replication',
      title: 'Replication on the ring',
      body: `Consistent hashing tells you which node *owns* a key. Real systems also store copies elsewhere, so that losing a node loses no data. The ring makes this almost free: **the replicas of a key are the next R - 1 distinct physical nodes clockwise after the owner.**

Amazon's Dynamo paper calls this the **preference list**. For key k with replication factor R = 3, walk clockwise from hash(k): the first token's owner is the coordinator/primary, then continue walking, skipping any token belonging to a physical node already chosen, until you have three distinct machines. Because every client computes the same ring, every client agrees on where the three copies are without asking anyone.

**Why "distinct physical nodes" matters.** With vnodes, the next three tokens clockwise might be A-17, A-93 and B-4. Taking them naively puts two of the three copies on machine A; if A dies you are down to one copy. So the walk must dedupe by physical host. Cassandra's **NetworkTopologyStrategy** goes further: it dedupes by **rack** and places copies in different racks (and, per datacenter, a configurable number of replicas), so that a rack power failure does not take out all replicas of any range. DynamoDB does the equivalent across three availability zones.

**What happens on membership change.** When node D joins, it becomes the new owner of a slice of ranges and also becomes a *replica* for slices it is now within R hops of. Some node that was the R-th replica of those ranges drops off the preference list. Bootstrap therefore streams both primary and replica ranges. The moved fraction remains about R/N of total stored data, still far from "everything".

**Reads and writes with replicas.** With a preference list of R nodes the client (or a coordinator node) can send the write to all R and wait for W acknowledgements, and send reads to R and wait for the first R_read responses. Choosing W + R_read > R gives read-your-writes quorum behaviour; this tunable consistency is exactly Cassandra's ONE / QUORUM / ALL consistency levels sitting on top of ring replication. If a replica is temporarily down, Dynamo-style systems write a **hinted handoff** to the next healthy node on the ring and replay it later, so writes stay available.

**Same idea, other systems.** Riak and Voldemort copy Dynamo directly. Kafka does not use a ring (its partitions are assigned by a controller), which is a useful contrast: consistent hashing is for systems where clients must compute placement locally; a central assigner is fine when there is a single controller to ask.`,
      mentalModel:
        'The key\'s letter is delivered to the first house clockwise, and a photocopy goes to the next two houses owned by different families on different streets. Anyone with the street map knows exactly which three doors to knock on.',
      diagram: `replication factor R = 3, walk clockwise from hash(k)

    hash(k)
      |
      v
  ... A-17  A-93   B-4    C-21   B-77 ...
       ^      x     ^      ^
     primary skip  replica replica
     (A)   (A again) (B)   (C)

 preference list for k = [A, B, C]
 rack-aware: also skip tokens in an already-used rack`,
      keyPoints: [
        'Replicas are the next R-1 distinct physical nodes clockwise (the preference list).',
        'With vnodes you must skip tokens of an already-chosen machine, and often an already-chosen rack.',
        'Every client computes the same preference list; no coordinator is needed to find replicas.',
        'Tunable consistency (W, R quorum) and hinted handoff sit on top of ring replication.',
        'Membership changes move about R/N of stored data, still proportional to the change.',
      ],
    },
    {
      id: 'real-world',
      title: 'Where it is used and its limits',
      body: `**Databases.** Cassandra partitions every table by the Murmur3 token of the partition key across a ring of vnodes; nodetool ring and nodetool status show token ownership. DynamoDB (and the original Dynamo) partition by MD5 of the partition key and replicate across three AZs. Riak and Voldemort use the same design. ScyllaDB keeps Cassandra's ring and additionally shards each node's ranges across CPU cores.

**Cache clusters.** Memcached is a set of independent servers; the *client* decides which server holds a key, and every serious client library (libmemcached, spymemcached, twemproxy, mcrouter) uses ketama-style consistent hashing so that adding a cache node causes a small miss bump rather than a total flush. Redis Cluster is a partial exception: it uses 16,384 fixed hash slots (CRC16 mod 16384) and assigns slots to nodes explicitly. Slots give the same "move only what must move" property, with the migration controlled by an operator rather than by hash positions.

**Load balancers and gateways.** When requests for the same user or session should reach the same backend (for a local cache, a WebSocket session, or a per-tenant rate limiter), the balancer hashes the session key onto a ring of backends. Nginx offers hash $key consistent (ketama); HAProxy has hash-type consistent; Envoy and gRPC provide ring_hash and **Maglev**. Maglev (Google, 2016) precomputes a lookup table of about 65,537 entries so each request is an O(1) table index instead of a binary search, with slightly more disruption than a ring on change but far lower per-request cost.

**Others.** Discord routes guilds to servers with a ring; Akamai's CDN, where the technique was invented, maps URLs to edge caches with it; Chord and other DHTs are consistent hashing plus routing tables; Ceph's CRUSH and Kafka consumer partition assignment are cousins.

**What consistent hashing does not do.**
- **It balances key space, not load.** One celebrity user\'s key still lives on one node. Hot keys need a different tool: split the key (append a suffix and fan out), cache it in front, or use Google\'s **consistent hashing with bounded loads** (2017), which caps each node at (1 + epsilon) times average load and spills overflow to the next node; HAProxy and Vimeo\'s video edge use it.
- **It does not know about data size.** If one partition key holds 10 GB of rows, its whole node is skewed. Choose partition keys with bounded size.
- **Membership must be agreed.** If two clients have different node lists (one has noticed a failure, the other has not) they compute different rings and can write the same key to different places. Systems solve this with gossip plus versioned membership (Cassandra), or a coordination service (ZooKeeper, etcd) as the source of truth for the ring.

**Alternatives worth knowing.** **Rendezvous / HRW hashing** (1996): for each key, compute hash(key, node) for every node and pick the max; no ring, trivially even, O(N) per lookup. **Jump consistent hash** (Google, 2014): a few lines of arithmetic, no memory, perfectly even, but nodes are numbered 0..N-1 and only the last one can be removed, which suits sharded storage more than dynamic clusters.`,
      mentalModel:
        'Consistent hashing is the postal code system of distributed storage: everyone can compute the destination locally, adding a district only re-routes that district\'s mail, but a single address that receives a million letters a day is still a single overwhelmed postbox.',
      keyPoints: [
        'Cassandra, DynamoDB, Riak partition data by token ring; ScyllaDB extends it to CPU cores.',
        'Memcached clients (ketama) and Nginx/HAProxy/Envoy ring-hash pick servers with it; Maglev trades a lookup table for O(1).',
        'Redis Cluster uses 16,384 fixed slots: same minimal-movement goal, explicit assignment.',
        'It balances key ranges, not traffic or data size; hot keys need splitting, caching, or bounded-load variants.',
        'All participants must agree on membership; gossip or a coordination service provides it.',
      ],
      checkpoint: {
        question:
          'A team fronts 8 Redis instances (not Redis Cluster) with client-side hash mod 8. They plan to add 4 more instances during a Black Friday sale. What will happen, and what should they do instead?',
        answer:
          'Going from 8 to 12 with modulo remaps about 2/3 of keys, so roughly 67% of cache lookups miss immediately and the database takes the full read load during peak traffic. They should switch the client to consistent hashing with vnodes (most Redis clients support a ketama-style ring), so adding 4 nodes moves only about 1/3 of keys, each new node warming gradually. Better still, add the nodes before the sale and pre-warm them, or move to Redis Cluster whose slot migration is incremental and operator-controlled.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'With server = hash(key) mod N, what happens to key placement when a fifth server is added to four?',
      options: [
        'Only keys destined for the new server move (about 20%)',
        'About 80% of keys map to a different server',
        'No keys move because the hash is stable',
        'Exactly half of the keys move',
      ],
      answerIndex: 1,
      explanation:
        'A key stays only if hash mod 4 equals hash mod 5, roughly 1 in 5 keys. The other 80% remap. "Only the new server\'s share moves" is the ideal that consistent hashing achieves, not what modulo does.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'In consistent hashing, which node owns a key?',
      options: [
        'The node whose hash is numerically closest to the key\'s hash in either direction',
        'The first node encountered moving clockwise from the key\'s position on the ring',
        'The node at index hash(key) mod N',
        'The node with the fewest keys currently',
      ],
      answerIndex: 1,
      explanation:
        'Ownership is defined by walking clockwise to the first token. "Closest in either direction" is a different scheme that would move keys on both sides of a new node; "fewest keys" would require global state. Modulo is the approach being replaced.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'On a ring with nodes at 10, 40 and 75 (range 0-99), a key hashes to 80. Which node owns it?',
      options: ['The node at 75', 'The node at 40', 'The node at 10', 'No node; the key is unplaceable'],
      answerIndex: 2,
      explanation:
        'Walking clockwise from 80 there is no token before 99, so you wrap to 0 and reach the node at 10. The node at 75 is behind the key, not ahead of it.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 2,
      question: 'Why do production systems place each physical node at many points (virtual nodes) on the ring?',
      options: [
        'To make the hash function cryptographically secure',
        'To reduce the memory used by the ring',
        'To even out load and spread a failed node\'s keys across many survivors',
        'To make lookups O(1) instead of O(log N)',
      ],
      answerIndex: 2,
      explanation:
        'Many tokens per node average out random arc lengths (imbalance falls as about 1/sqrt(V)) and scatter a failed node\'s ranges across many successors. Vnodes increase, not reduce, ring memory, and lookups remain a binary search.',
    },
    {
      type: 'mcq',
      id: 'q5',
      difficulty: 3,
      question:
        'A key\'s three clockwise tokens on a vnode ring belong to nodes A, A, and B. With replication factor 3, where should the replicas go?',
      options: [
        'A, A, B as computed',
        'A and B only; a third copy is unnecessary',
        'A, B, and the next token belonging to a node other than A or B',
        'B, then the two tokens after it',
      ],
      answerIndex: 2,
      explanation:
        'Replica placement must skip tokens of an already-chosen physical node, otherwise two copies share a machine and one failure leaves a single copy. So take A, skip the second A, take B, and continue to the next distinct node (in rack-aware strategies, a distinct rack too).',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A social app uses consistent hashing to shard user data across 50 nodes. One celebrity\'s account receives 30% of all traffic. What does consistent hashing do about this?',
      options: [
        'It automatically splits the hot key across several nodes',
        'Nothing; it balances key ranges, not traffic, so one node still takes 30% of load',
        'It migrates the key to the least loaded node',
        'It replicates the key to all 50 nodes',
      ],
      answerIndex: 1,
      explanation:
        'Consistent hashing assigns each key to one owner; it has no notion of per-key traffic. Hot keys need application-level fixes: cache in front, split the key with suffixes, or use bounded-load consistent hashing. Automatic migration and full replication are not part of the algorithm.',
    },
    {
      type: 'multi',
      id: 'q7',
      difficulty: 2,
      question: 'Which of the following systems use consistent hashing (or a ring of tokens) to decide data or request placement? Select all that apply.',
      options: [
        'Cassandra partitioning by Murmur3 token',
        'Memcached client libraries such as libmemcached (ketama)',
        'Kafka assigning partitions to brokers',
        'Amazon Dynamo / DynamoDB partition placement',
        'Nginx hash $key consistent and Envoy ring_hash load balancing',
      ],
      answerIndices: [0, 1, 3, 4],
      explanation:
        'Cassandra, Dynamo/DynamoDB, ketama-based memcached clients and ring-hash load balancers all compute placement on a hash ring. Kafka assigns partitions to brokers via a central controller and stores the assignment in metadata; clients look it up rather than computing it.',
    },
    {
      type: 'multi',
      id: 'q8',
      difficulty: 3,
      question: 'Which statements about virtual nodes are true? Select all that apply.',
      options: [
        'They let a machine with more capacity own proportionally more of the key space',
        'They eliminate hot keys',
        'They increase the amount of token metadata that must be shared across the cluster',
        'They make a single node failure fall entirely on one neighbour',
        'They reduce load imbalance roughly in proportion to 1/sqrt(number of vnodes)',
      ],
      answerIndices: [0, 2, 4],
      explanation:
        'More vnodes equal more ownership (weighting), more metadata, and better balance by roughly 1/sqrt(V). Vnodes spread, rather than concentrate, failover onto many nodes, and they do nothing about hot keys, which are a traffic problem not a range problem.',
    },
    {
      type: 'truefalse',
      id: 'q9',
      difficulty: 1,
      statement: 'When a node is removed from a consistent hash ring, only the keys that node owned need to move, and they move to its clockwise successor(s).',
      answer: true,
      explanation:
        'The removed node\'s arc is absorbed by the next token clockwise. With vnodes, its many small arcs go to many different successors. Keys owned by other nodes are unaffected.',
    },
    {
      type: 'truefalse',
      id: 'q10',
      difficulty: 2,
      statement: 'Consistent hashing requires a central coordinator to tell clients which node owns each key.',
      answer: false,
      explanation:
        'Every client with the same hash function and the same membership list computes the same ring locally. What is needed is agreement on membership (via gossip, DNS, ZooKeeper or configuration), not a per-key lookup service.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Ring 0-99 with nodes P=20, Q=55, R=90 and keys at 3, 25, 41, 58, 70, 88, 97. List ownership, then add node S at 45 and remove node R. Show which keys move at each step and compare with hash mod N.',
      modelAnswer: `**Initial ownership** (first node clockwise):
- P(20): keys 3, 97 (97 wraps past 99 to P).
- Q(55): keys 25, 41.
- R(90): keys 58, 70, 88.

**Add S at 45.** S owns (20, 45]. Key 25 and key 41 move from Q to S. Nothing else changes. 2 of 7 keys moved (29%), close to the expected 1/4; all from Q. With hash mod N going 3 -> 4, about 3/4 of keys (5 of 7) would remap.

**Remove R at 90.** R's arc (55, 90] is absorbed by the next node clockwise, which wraps to P(20). Keys 58, 70, 88 move to P. Q and S are untouched. With modulo 4 -> 3, again about 3/4 would remap.

**Observation:** P now owns 5 of 7 keys. With single tokens, removals concentrate load on one successor. This is why vnodes are needed: with many tokens per node, R's ranges would be split among P, Q and S.`,
      rubric: [
        'Correct initial assignment including wrap-around for 97.',
        'Adding S moves exactly keys 25 and 41 from Q.',
        'Removing R moves 58, 70, 88 to P via wrap-around.',
        'Compares moved fraction with modulo (about 3/4).',
        'Notes the overload on P and links it to the need for vnodes.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain how replication works on a consistent hash ring and one subtlety that virtual nodes introduce.',
      modelAnswer: `The node that owns a key (first token clockwise) is the primary. Replicas are found by continuing clockwise and taking the next R - 1 nodes; Dynamo calls this list of R nodes the preference list. Because every client computes the same ring from the same membership, all of them agree on where every copy lives without a coordinator.

With virtual nodes, consecutive tokens on the ring can belong to the same physical machine. If you naively took the next R - 1 tokens you might place two copies on one host, so a single failure would leave one copy. The walk must therefore skip tokens whose physical owner is already in the list. Cassandra's NetworkTopologyStrategy also skips tokens in an already-used rack (and balances per datacenter) so that a rack outage cannot destroy all replicas of a range.

On membership change, a new node both takes primary ranges and enters some preference lists as a replica, so roughly R/N of the stored data streams: still proportional to the change, not the whole dataset.`,
      rubric: [
        'Replicas are the next R-1 nodes clockwise (preference list).',
        'All clients compute the same placement locally.',
        'Must skip tokens of the same physical node (and ideally rack).',
        'Mentions Dynamo or Cassandra as an example.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question:
        'Your API gateway must route each user\'s requests to the same backend for an in-process cache. Backends autoscale several times a day. Compare hash mod N, ring hashing and Maglev for this use case.',
      modelAnswer: `**hash mod N:** on every scale event nearly every user is rerouted to a different backend, so every in-process cache goes cold simultaneously. Simple, but exactly the wrong property for autoscaling several times a day.

**Ring hash (ketama-style with vnodes):** adding or removing one of N backends reroutes about 1/N of users; the other caches stay warm. Lookup is a binary search over a few thousand tokens, microseconds per request, negligible against network cost. Supported natively by Nginx (hash consistent), HAProxy (hash-type consistent) and Envoy (ring_hash). Good default.

**Maglev:** builds a lookup table (65,537 entries) so each request is one array index, and distributes load almost perfectly evenly. On a backend change slightly more than 1/N of users move because the table is rebuilt, but still far from modulo. Worth it at very high request rates (Google front-end scale) where per-request CPU matters; for a typical gateway, ring hash is simpler and disruption is minimal.

**Also consider:** bounded-load consistent hashing if some users are far hotter than others, and a connection-draining period so rerouted users\' caches can warm without a latency cliff.`,
      rubric: [
        'Identifies modulo as causing near-total reroute on every scale event.',
        'Explains ring hash moves about 1/N and names a real balancer supporting it.',
        'Explains Maglev\'s O(1) lookup table and its slightly higher disruption.',
        'Makes a recommendation tied to the requirement.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Problem with server = hash(key) mod N', back: 'N is in the formula. Changing N from 4 to 5 remaps about 80% of keys; from N to N+1 remaps N/(N+1). Cache miss storm or massive data migration.' },
    { id: 'f2', front: 'Consistent hashing (one sentence)', back: 'Hash nodes and keys onto the same ring; a key belongs to the first node clockwise; adding/removing a node moves only about 1/N of keys.' },
    { id: 'f3', front: 'Who owns a key on the ring', back: 'The first node token at or after hash(key), wrapping around from the end of the hash space to 0.' },
    { id: 'f4', front: 'Keys moved when adding one node to N', back: 'About 1/(N+1) of keys, all taken from the new node\'s clockwise successor (single-token ring) or from many nodes (vnode ring).' },
    { id: 'f5', front: 'Keys moved when removing a node', back: 'Only that node\'s keys, to its clockwise successor(s). Everything else stays.' },
    { id: 'f6', front: 'Two problems with one token per node', back: 'Uneven arcs (some nodes own 2-3x others) and a failed node dumps 100% of its load on one neighbour, risking cascade.' },
    { id: 'f7', front: 'Virtual nodes (vnodes)', back: 'Each physical node owns many ring positions (100-256). Evens load (imbalance ~ 1/sqrt(V)), spreads failover across many nodes, allows capacity weighting.' },
    { id: 'f8', front: 'Cost of many vnodes', back: 'More token metadata to store and gossip, more ranges to repair, slower cluster convergence. Cassandra moved default from 256 to 16 tokens with smarter allocation.' },
    { id: 'f9', front: 'Replication on the ring (preference list)', back: 'Primary is the owner; replicas are the next R-1 distinct physical nodes clockwise, skipping same-host (and same-rack) tokens.' },
    { id: 'f10', front: 'Ring lookup data structure', back: 'Sorted array or tree of tokens; binary search for first token >= hash(key). O(log(N*V)); a few MB even for large clusters.' },
    { id: 'f11', front: 'Systems using consistent hashing', back: 'Cassandra, Dynamo/DynamoDB, Riak, ScyllaDB; memcached clients (ketama, twemproxy, mcrouter); Nginx/HAProxy/Envoy ring-hash; Akamai; Discord.' },
    { id: 'f12', front: 'How Redis Cluster differs', back: 'Uses 16,384 fixed hash slots (CRC16 mod 16384) assigned to nodes explicitly; slot migration gives minimal movement under operator control.' },
    { id: 'f13', front: 'What consistent hashing does NOT solve', back: 'Hot keys and oversized partitions: it balances key ranges, not traffic or bytes. Fix with caching, key splitting, or bounded-load hashing.' },
    { id: 'f14', front: 'Maglev hashing', back: 'Google load-balancer scheme: precomputed lookup table (~65,537 entries) gives O(1) per request and near-perfect balance, slightly more disruption on change than a ring.' },
    { id: 'f15', front: 'Rendezvous (HRW) hashing', back: 'For each key compute hash(key, node) for all nodes, pick the max. No ring, even balance, minimal movement, O(N) per lookup.' },
    { id: 'f16', front: 'Jump consistent hash', back: 'Google 2014; arithmetic-only, no memory, perfectly even; buckets numbered 0..N-1 and only the last can be removed. Suits static-ish sharding.' },
    { id: 'f17', front: 'Membership agreement requirement', back: 'All clients must share the same hash function and node list, or they compute different rings. Provided by gossip (Cassandra), config, DNS, or ZooKeeper/etcd.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Why modulo hashing fails and how the ring fixes it',
      prompt: 'Explain to a junior developer why hash(key) mod N is a trap for a growing cache cluster and how consistent hashing avoids it.',
      modelExplanation: `Suppose you have four cache servers and decide where a key goes by taking its hash and dividing by four; the remainder picks the server. Add a fifth server and now you divide by five. Almost every remainder changes, so about four out of five keys are suddenly looked up on the wrong server. Your cache goes from warm to nearly empty in an instant and the database behind it gets hammered.

Consistent hashing removes the server count from the formula. Picture a clock face. Each server is placed at some position on the clock by hashing its name. Each key is also placed on the clock by hashing it. The rule is: a key belongs to the first server you meet going clockwise.

Now add a fifth server at, say, three o\'clock. The only keys that change owner are the ones between the previous server and three o\'clock, because they used to walk past three o\'clock to the next server and now they stop. Everything else still walks to the same server as before. On average one fifth of the keys move, which is the smallest possible amount, and the cache stays mostly warm.`,
      mustMention: [
        'Modulo puts N in the formula; changing N remaps most keys (about 80% for 4 -> 5)',
        'Ring: servers and keys hashed into the same circular space',
        'Key goes to the first server clockwise',
        'Adding a node moves only the keys in its arc, about 1/N',
      ],
    },
    {
      id: 'fe2',
      concept: 'Virtual nodes',
      prompt: 'Explain why a hash ring with one point per server behaves badly in practice and how virtual nodes fix it.',
      modelExplanation: `Hashing puts servers at random spots on the ring, and random spots are uneven. With five servers, one might own a third of the circle and another a tenth, purely by luck. Worse, when a server dies, its whole arc is handed to the next server clockwise, so one machine\'s load roughly doubles at the worst possible moment and it may fall over too, passing an even bigger arc to the next one.

Virtual nodes fix both problems with one idea: put each server on the ring not once but a couple of hundred times, at positions like hash("server-A-1"), hash("server-A-2") and so on. Each server now owns a couple of hundred small arcs scattered around the circle. Their total length averages out, so every server owns roughly the same share. And when a server dies, each of its small arcs is absorbed by whichever server happens to be next, which is a different one almost every time, so the load spreads across the whole cluster. You can even give a bigger machine more virtual nodes so it owns more of the ring. The price is more bookkeeping: more positions to store and share.`,
      mustMention: [
        'Random single positions give uneven arcs',
        'Single-neighbour failover can cascade',
        'Many tokens per server average out load and spread failover',
        'Weighting by capacity; cost is metadata',
      ],
    },
    {
      id: 'fe3',
      concept: 'Replication via the ring',
      prompt: 'Explain how Dynamo-style systems find the replicas of a key without asking a coordinator.',
      modelExplanation: `On a consistent hash ring the owner of a key is the first server clockwise from the key. To keep extra copies, keep walking. The next server you meet gets the second copy, the one after that gets the third, until you have as many copies as your replication factor. Dynamo calls this ordered list the preference list.

The beauty is that every client and server already has the ring in memory, because they all use the same hash function and the same list of members. So all of them compute exactly the same preference list for any key, and nobody needs to ask a central service where the copies are. A write can be sent to all three at once and wait for two acknowledgements; a read can ask all three and take the first two answers, which gives a quorum.

One detail: with virtual nodes, the next few positions on the ring might belong to the same machine, so while walking you skip any machine you have already picked. Cassandra also skips machines in a rack you have already used, so a rack failure never takes down every copy.`,
      mustMention: [
        'Owner is first node clockwise; replicas are the next R-1 nodes',
        'Preference list computed identically by every client',
        'Skip same physical node (and rack) when using vnodes',
        'Enables quorum reads/writes without a coordinator',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk clockwise around a circular village green ringed by cottages, each cottage a server. The walk starts at the village notice board and ends back there.',
    stops: [
      { locus: 'The notice board with the old seating chart', concept: 'The modulo problem', image: 'A faded poster reads "Cottage = ticket mod 4". A fifth cottage is being built and every villager is dragging furniture across the green at once, shouting; 80 out of 100 doors have new nameplates.' },
      { locus: 'The clock tower in the middle of the green', concept: 'The hash ring', image: 'A giant clock face lies flat on the grass. Cottages sit on its rim at hashed hours. Letters (keys) fall from the sky and roll clockwise until they hit the first cottage door.' },
      { locus: 'The freshly built cottage at three o\'clock', concept: 'Adding a node moves ~1/N keys', image: 'Only the letters lying between two o\'clock and three o\'clock get up and shuffle into the new door. Every other letter stays asleep on the grass.' },
      { locus: 'The collapsed cottage with one panicking neighbour', concept: 'Removal and single-successor overload', image: 'A cottage crumbles and its entire mountain of letters slides into the very next cottage, whose roof bows and creaks; the neighbour after it eyes the pile nervously.' },
      { locus: 'The 200 tiny garden sheds', concept: 'Virtual nodes', image: 'Each family has swapped its one cottage for 200 tiny colourful sheds sprinkled all around the rim. When one family leaves, each shed is claimed by a different neighbour and nobody\'s roof creaks. The rich family has 400 sheds.' },
      { locus: 'The postman with three envelopes', concept: 'Replication on the ring', image: 'A postman delivers the original letter to the first door, then keeps walking clockwise handing carbon copies to the next two doors owned by different families, hopping over sheds of families he has already visited.' },
      { locus: 'The cottage with a queue around the green', concept: 'Hot keys are not solved', image: 'One cottage has a queue of ten thousand fans for a single celebrity letter. The rest of the green is quiet. A sign reads: the ring shares out addresses, not popularity.' },
      { locus: 'The signposts at the exit', concept: 'Real systems and alternatives', image: 'Signposts point to towns named Cassandra, Dynamo, Ketama, Nginx, Envoy. A shortcut sign labelled Maglev shows a single giant lookup table; another labelled Redis Cluster shows 16,384 numbered pigeonholes.' },
    ],
  },
  interviewQuestions: [
    'What problem does consistent hashing solve that hash(key) mod N does not? Quantify the difference for adding one server to four.',
    'Walk me through how a key finds its owner on a hash ring and what happens when a node joins or leaves.',
    'Why are virtual nodes needed, and what trade-off do they introduce?',
    'How would you implement replication factor 3 on a consistent hash ring? What subtlety do virtual nodes add?',
    'How do Cassandra or DynamoDB use consistent hashing? How does Redis Cluster differ?',
    'A single key becomes extremely hot. Does consistent hashing help? What would you do?',
    'How do all clients agree on the same ring? What happens if they disagree?',
    'Compare ring hashing, rendezvous hashing, jump hashing and Maglev: when would you pick each?',
  ],
}

export default chapter
