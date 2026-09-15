import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 19,
  slug: 'leader-election-for-auto-recovery',
  title: 'Leader Election For Auto Recovery',
  module: 'resilience',
  estimatedMinutes: 40,
  summary:
    'Many systems need exactly one node to be in charge at a time: the database primary that accepts writes, the scheduler that assigns jobs, the worker that owns a partition. Leader election is how a group of machines agrees on that one node and, crucially, how they safely pick a new one when it dies, without a human and without ending up with two leaders. This chapter builds the idea from heartbeats and leases through split brain and fencing tokens to majority quorums, Raft, ZooKeeper/etcd/Consul, Redis Sentinel and orchestrator-driven recovery.',
  objectives: [
    'Explain why a single leader simplifies distributed systems and what breaks when there are zero or two leaders.',
    'Describe how heartbeats and leases detect failure, and why failure detection is inherently uncertain.',
    'Explain split brain and how majority quorums and fencing tokens prevent it or make it harmless.',
    'Give the Raft intuition: terms, randomised election timeouts, majority votes and the single-leader-per-term guarantee.',
    'Compare ZooKeeper, etcd, Consul and Redis Sentinel as coordination tools and describe an orchestrator-based auto-recovery loop.',
  ],
  quickRevision: [
    'A leader serialises decisions: one writer, one scheduler, one owner. Zero leaders means no progress; two leaders means conflicting writes (split brain), which is far worse.',
    'Failure detection is guesswork: a missed heartbeat may mean a dead node, a slow node, a GC pause, or a partitioned network. You can never distinguish "dead" from "unreachable".',
    'Heartbeat: periodic "I am alive" message (e.g. every 1 s). Declare a node dead after N missed beats (e.g. 5 s). Shorter = faster failover but more false positives.',
    'Lease: time-bounded ownership. The leader must renew before expiry (e.g. 10 s lease, renew every 3 s); if it cannot, it must stop acting as leader. Requires bounded clock drift.',
    'Split brain: two nodes both believe they are leader, usually due to a network partition. Prevention: only a majority can elect; a leader that loses contact with the majority steps down.',
    'Majority quorum: with N nodes, need floor(N/2)+1 votes. Two disjoint majorities are impossible, so at most one leader per term. 3 nodes tolerate 1 failure, 5 tolerate 2; even counts add cost but no tolerance.',
    'Fencing token: a monotonically increasing number issued with each leadership grant. Storage/downstream rejects any request carrying an older token, making a stale leader harmless even if it keeps acting.',
    'Raft: time is divided into numbered terms; a follower whose election timeout (randomised 150-300 ms) expires becomes a candidate, increments the term and requests votes; a majority makes it leader; it then heartbeats via AppendEntries.',
    'Raft only votes for a candidate whose log is at least as up to date, so a new leader never lacks committed entries.',
    'ZooKeeper (ZAB), etcd (Raft) and Consul (Raft) are strongly consistent coordination stores; leader election is built on ephemeral/TTL keys plus watches, or on a compare-and-swap of a lock key.',
    'ZooKeeper recipe: each candidate creates an ephemeral sequential znode under /election; lowest sequence is leader; others watch their predecessor to avoid a herd of notifications.',
    'Redis Sentinel: sentinels monitor the master; a quorum agrees it is down (SDOWN -> ODOWN), one sentinel is elected to run the failover using a configuration epoch, promotes a replica and reconfigures the rest.',
    'Orchestrator auto recovery (Kubernetes controllers, Patroni, MySQL Orchestrator): a control loop compares desired state (one healthy leader) with observed state and takes actions (promote, fence, reconfigure) to converge; humans set policy, machines execute.',
  ],
  sections: [
    {
      id: 'why-a-leader',
      title: 'Why we want exactly one leader',
      body: `Most distributed systems have some decision that must be made by exactly one node at a time. A database can accept writes on one primary so that ordering and uniqueness constraints are simple. A job scheduler must hand each job to one worker. A Kafka partition has one leader broker that serialises appends. A distributed cron must fire each job once, not once per replica.

Having a leader is a simplification, not a limitation. When one node makes the decisions, there are no conflicts to resolve, no merge rules to define, no "which write wins" ambiguity. Multi-leader systems exist (DynamoDB global tables, CRDT-based stores) but they push complexity onto application developers who must handle concurrent conflicting updates. A single leader turns a hard consensus problem into a much easier one: agree once on *who* the leader is, then let the leader decide everything else quickly and locally.

The trouble starts when the leader dies. Now you have **zero leaders**, and nothing makes progress: writes are rejected, jobs pile up. The system needs to pick a new leader. If a human must do it, your recovery time is measured in tens of minutes at 3 a.m. **Auto recovery** means the remaining nodes elect a new leader themselves, typically within seconds.

But automatic election has a failure mode that is far worse than having no leader: **two leaders**. If the old leader was not dead, only unreachable, and a new one is elected, both accept writes. Two divergent histories, two workers running the same job, two brokers appending different records at the same offset. This is called **split brain**, and every leader election design is ultimately about preventing it or rendering it harmless.

So the requirements for leader election are, in priority order: **safety** (never two leaders acting at once), then **liveness** (eventually pick a leader when the old one is gone), then **speed** (do it in seconds). Safety comes first because a system that is briefly unavailable can be fixed; a system whose data has diverged may never be fully fixed.`,
      mentalModel:
        'An orchestra needs one conductor. With none, the musicians drift out of time. With two conductors waving different tempos, the result is not slower music, it is noise that cannot be untangled afterwards. Better to pause and appoint one than to play under two.',
      diagram: `Zero leaders (stall)        One leader (goal)       Two leaders (split brain)
 [A]  [B]  [C]               [A*] <- writes           [A*] <- writes from west
 no writes accepted            |                       [B*] <- writes from east
 jobs pile up                [B]  [C] replicate        divergent histories,
 recoverable                 progress, consistent      may be unrecoverable

Priority: safety (never 2) > liveness (eventually 1) > speed (in seconds)`,
      keyPoints: [
        'A single leader removes conflict resolution from the rest of the system.',
        'Zero leaders means no progress; two leaders means divergence, which is worse.',
        'Auto recovery means the survivors elect a replacement in seconds without a human.',
        'Design priority: safety, then liveness, then speed.',
      ],
      checkpoint: {
        question:
          'Your distributed cron runs on 3 replicas for high availability. Without leader election, what happens to a job scheduled for 02:00?',
        answer:
          'All three replicas fire it at 02:00, so the job runs three times. This is the "multiple leaders" problem in miniature: without an agreed single owner (via election or a lock), redundancy causes duplicate actions. You need election or a distributed lock so exactly one replica fires the job.',
      },
    },
    {
      id: 'heartbeats-leases',
      title: 'Heartbeats, leases and the impossibility of perfect failure detection',
      body: `Before anyone can elect a new leader, someone must decide that the old one has failed. This is harder than it sounds because a distributed system cannot tell the difference between a node that is **dead** and one that is merely **unreachable or slow**.

**Heartbeats** are the basic tool. The leader (or every node) sends "I am alive" every interval, say 1 second. If a monitor misses several consecutive heartbeats, say 5 seconds' worth, it declares the node dead. The trade-off is unavoidable: a short timeout detects real failures fast but also declares a node dead when it hits a 3-second garbage collection pause or a transient network hiccup, triggering a needless (and dangerous) election. A long timeout avoids false positives but leaves the system leaderless for longer. Real systems tune this per environment: Kafka's ZooKeeper session timeout defaulted to 18 s; Kubernetes marks a node NotReady after 40 s of missed status updates; Raft implementations use hundreds of milliseconds within a data centre.

Heartbeats alone have a fatal gap. The monitor concluding "the leader is dead" does not stop the leader from acting. If the leader is alive but partitioned, it happily keeps accepting writes while a replacement is elected. To close the gap the leader itself must know when it is no longer allowed to lead. That is what a **lease** provides.

A lease is time-bounded authority. The leader holds leadership for a fixed duration, say 10 seconds, and must renew it before expiry, say every 3 seconds. Renewal succeeds only if the leader can still reach the coordination service (ZooKeeper, etcd, a database row). If it cannot renew, **it must stop acting as leader when the lease expires**, even if it feels perfectly healthy; and no other node may become leader until the old lease has expired. This symmetry is what prevents overlap: the new leader is elected only after time T, and the old leader stopped by time T.

Leases depend on **clocks**. Both sides measure "10 seconds" with their own clock, and if the old leader's clock runs slow, it may think its lease still has time left when the coordinator has already handed leadership on. Implementations add safety margins (stop acting at 80% of the lease) and rely on bounded clock drift. A long stop-the-world GC pause is a notorious hazard: the leader checks "lease valid", pauses for 15 seconds, resumes, and issues a write with an expired lease. The fix for this is a fencing token, covered next.`,
      mentalModel:
        'A lease is a parking meter. You may park while it has time; you must top it up before it runs out; and if you cannot reach the meter you have to move your car when it expires even though you would prefer to stay. Nobody else can take the space until the meter reads zero.',
      diagram: `Leader lease = 10 s, renew every 3 s

t=0   [L] acquires lease (expires t=10)     coordinator: L until 10
t=3   [L] renews          (expires t=13)                 L until 13
t=6   [L] --X-- network partition, renew fails
t=9   [L] renew fails again
t=13  lease expires: L MUST stop acting as leader
t=13+ followers may elect new leader; no overlap if clocks agree

Danger: L pauses (GC) at t=12 with "lease ok" in hand,
        resumes at t=20 and writes anyway -> needs fencing token`,
      keyPoints: [
        'You cannot distinguish a dead node from a slow or partitioned one; detection is always a guess.',
        'Heartbeat timeout trades detection speed against false positives.',
        'A lease makes the leader itself stop when it cannot renew, closing the gap heartbeats leave open.',
        'No new leader before the old lease expires; leases require bounded clock drift and safety margins.',
        'Process pauses can make a leader act after its lease expired.',
      ],
      checkpoint: {
        question:
          'You shorten the leader heartbeat timeout from 10 s to 500 ms to speed up failover. What new problem do you expect, and why is it dangerous rather than merely annoying?',
        answer:
          'False positives: routine GC pauses, brief network jitter or a busy CPU will exceed 500 ms and the monitor will declare a healthy leader dead. Each false detection triggers an election while the old leader is still running, so unless leases and fencing are airtight you risk two leaders acting simultaneously, plus needless downtime during each spurious failover.',
      },
    },
    {
      id: 'split-brain-quorum',
      title: 'Split brain and the majority quorum',
      body: `A **network partition** splits a cluster into groups that cannot talk to each other but can each still talk to some clients. Consider 4 nodes split into two pairs. Each pair sees the other pair as dead. If each pair elects a leader, you have two leaders, each accepting writes from the clients on its side. When the partition heals, the two histories conflict. This is **split brain**, and it is the specific disaster leader election must rule out.

The classic defence is the **majority quorum**. A node may become leader only if it gets votes from a strict majority of the *entire* cluster: floor(N/2) + 1. With 5 nodes, 3 votes are needed. The key property is that **two disjoint majorities cannot exist**: any two sets of 3 out of 5 must share at least one node, and that node voted for only one candidate in a given round. Therefore at most one leader can be elected per round, regardless of how the network is partitioned.

The same rule tells a leader when to step down: if it can no longer reach a majority, it cannot possibly be re-elected and something on the other side might be, so it must stop accepting writes. The minority side of a partition becomes read-only or unavailable; the majority side carries on. Availability is sacrificed on the small side to protect consistency, which is exactly the CP choice from CAP.

Cluster size follows from this. Fault tolerance is (N-1)/2 failures: 3 nodes tolerate 1, 5 tolerate 2, 7 tolerate 3. Even numbers are a waste: 4 nodes still need 3 votes and still tolerate only 1 failure, at 33% more cost and with the risk of a perfect 2-2 split that elects nobody. That is why ZooKeeper, etcd and Consul clusters are almost always 3 or 5. Going beyond 7 slows every decision because more nodes must acknowledge.

**Two-node clusters cannot do this safely.** A majority of 2 is 2, so a single failure blocks election; and if you relax to 1, a partition produces two leaders. Two-node HA setups therefore need an external tie-breaker (a third "witness" node, a shared disk lock, or a cloud lock service), or **STONITH**: the node that thinks it is leader forcibly powers off the other via a management interface before proceeding, guaranteeing at most one survivor. Fencing of this kind is standard in Pacemaker/Corosync clusters and in Patroni's watchdog integration.`,
      mentalModel:
        'A committee of five that requires three signatures to pass any motion. Two rival factions cannot both pass motions in the same session, because any three people out of five overlap by at least one person who will not sign both. Split the committee 2-3 and only the side of three can act; the two must wait.',
      diagram: `5-node cluster, partition splits 3 | 2

  [A] [B] [C]     ||     [D] [E]
  majority = 3    ||     minority = 2
  can elect       ||     cannot reach 3 votes
  leader A*       ||     old leader D steps down
  accepts writes  ||     read-only / unavailable

Any two majorities of 5 share >= 1 node -> at most one leader per round
Tolerates floor((N-1)/2) failures: N=3 -> 1, N=5 -> 2, N=4 -> still 1`,
      keyPoints: [
        'Split brain: a partition lets each side elect its own leader and diverge.',
        'Majority quorum (floor(N/2)+1) makes two simultaneous leaders impossible.',
        'A leader that cannot reach a majority must step down; the minority side goes read-only.',
        'Use odd cluster sizes (3 or 5); even sizes add cost without tolerance.',
        'Two-node clusters need a witness or STONITH-style fencing.',
      ],
      checkpoint: {
        question:
          'A 6-node etcd cluster is split 3-3 by a partition. What happens to leadership, and how many failures could the cluster tolerate before the partition?',
        answer:
          'Neither side has 4 votes (a majority of 6), so nobody can be elected and the whole cluster stalls for writes until the partition heals. Before the partition, 6 nodes tolerated only 2 failures, the same as 5 nodes. The sixth node bought nothing but a chance of an even split, which is why odd sizes are recommended.',
      },
    },
    {
      id: 'fencing-tokens',
      title: 'Fencing tokens: making a stale leader harmless',
      body: `Quorums prevent two nodes from being *elected* at once. They do not prevent a node from *acting* as leader after it has lost leadership. Recall the GC-pause scenario: the leader confirms its lease, pauses for 15 seconds, and on waking issues writes. Or a leader is partitioned, a new one is elected, and a delayed packet from the old leader arrives at the storage layer a moment later. The quorum did its job, and you still get a stale write.

The fix is to stop relying on the leader's *belief* and instead make the *resource being protected* check. Every time leadership is granted, the coordination service issues a **fencing token**: a monotonically increasing number. In ZooKeeper this is the znode's zxid or version; in etcd it is the lease's revision; in Raft-based systems it is the term number; in Redlock discussions it is simply called the fencing token. The leader must include the token with every request to storage, to downstream services, to the message broker, wherever its authority is exercised.

The storage layer remembers the highest token it has seen and **rejects any request with a lower token**. When leader 33 is replaced by leader 34, the first request from 34 raises the bar to 34. If the old leader wakes from its pause and sends a write tagged 33, storage refuses it. The stale leader may still *think* it is in charge, but it can no longer do damage. Its belief has become irrelevant.

This idea appears everywhere once you know to look. Kafka's controller epoch and partition leader epoch are fencing tokens: a broker receiving a LeaderAndIsr request with an old epoch ignores it. Kubernetes uses resourceVersion for optimistic concurrency on lease objects. HDFS NameNode HA fences the old active NameNode via the JournalNodes' epoch before the standby takes over. Postgres tools like Patroni combine a lease in etcd with a watchdog that hard-resets the machine if the leader loop stops renewing, which is fencing by force.

The requirement fencing imposes on your architecture is that **every protected resource must be able to check tokens**. A plain filesystem or a third-party API that accepts any write cannot be fenced this way; for those you fall back to leases with generous margins, or physical fencing (power off the old node, revoke its network access or storage attachment). Martin Kleppmann's critique of Redis Redlock is essentially this point: a lock without fencing tokens cannot be safe under process pauses and clock skew, no matter how many Redis nodes vote.`,
      mentalModel:
        'A company issues numbered signing authorities. The bank honours only cheques signed with the highest number it has seen. A former director who still has an old stamp can sign all he likes; the bank rejects every cheque, so his mistaken belief that he is still in charge costs nothing.',
      diagram: `Coordinator grants leadership with token:
   leader L1 gets token 33         later, L2 gets token 34

Storage keeps max_token_seen:
   L1 write(token=33)  -> max=33, accepted
   L2 write(token=34)  -> max=34, accepted
   L1 wakes from GC pause, write(token=33) -> 33 < 34 REJECTED
   L2 write(token=34)  -> accepted

Old leader still *believes* it leads; it just cannot *act*.`,
      keyPoints: [
        'Quorums stop double election, not stale action after a pause or delay.',
        'A fencing token is a monotonically increasing number issued with each leadership grant.',
        'Protected resources track the max token seen and reject anything lower.',
        'Kafka epochs, Raft terms, ZooKeeper zxids and etcd revisions all serve as fencing tokens.',
        'Resources that cannot check tokens need physical fencing (STONITH, revoke storage).',
      ],
      checkpoint: {
        question:
          'Your leader acquires an etcd lease and then calls a legacy payment API that has no notion of tokens or versions. A GC pause causes the lease to expire mid-flight. Can fencing tokens protect you? What can?',
        answer:
          'Not directly: the payment API will accept any call, so a token it never checks cannot be enforced. Options: make the call idempotent with a leader-epoch-tagged idempotency key that a proxy of your own checks; put your own token-aware gateway in front of the API; or use physical fencing (a watchdog that kills the process when lease renewal stalls, Patroni style) plus a large safety margin before lease expiry.',
      },
    },
    {
      id: 'raft-intuition',
      title: 'Raft intuition: terms, elections and majority votes',
      body: `**Raft** (Ongaro and Ousterhout, 2014) is the consensus algorithm that powers etcd, Consul, CockroachDB, TiKV and many others. Its leader election is a clean implementation of everything above, and understanding it makes ZooKeeper, Kafka and Sentinel easier to follow.

Every node is in one of three roles: **follower**, **candidate**, or **leader**. Time is divided into **terms**, numbered consecutively. Each term has at most one leader. The term number is the fencing token of the protocol: any message carrying an older term is rejected, and any node that sees a newer term immediately updates and reverts to follower.

In steady state the leader sends **AppendEntries** messages as heartbeats (and to replicate log entries) every 50-150 ms. Each follower runs an **election timeout**, randomised in a range such as 150-300 ms, reset every time a heartbeat arrives.

When a follower's timeout fires without hearing from a leader, it assumes the leader is gone. It increments the term, becomes a **candidate**, votes for itself, and sends **RequestVote** to all peers. Each node votes for **at most one candidate per term**, first come first served. A candidate that collects votes from a **majority** becomes leader and immediately heartbeats to assert authority. If it hears from a leader with a term at least as high as its own, it steps back to follower. If the timeout fires again without a decision (a **split vote**), it starts a new term and tries again.

The **randomised timeout** is the clever bit. If all followers used the same timeout they would all become candidates at the same instant, split the vote, and repeat forever. With randomisation, one node almost always times out first, wins the votes before the others even become candidates, and heartbeats them back into line. Elections typically resolve in one round.

One more rule makes it safe for data: a node **refuses to vote** for a candidate whose log is less up to date than its own (compared by last entry's term, then index). Since any committed entry is on a majority of nodes, and any winner needs a majority of votes, the winner's log must contain every committed entry. A new leader never has to fetch data it lacks, and committed writes are never lost. This is the reason Raft-based systems can fail over with RPO 0.`,
      mentalModel:
        'A classroom where the teacher speaks every few seconds. Each student has a random patience timer. If the teacher falls silent, the student whose timer runs out first stands up, announces "term 8, vote for me", and since everyone else is still waiting, gets the votes. Anyone who later hears "term 8" in the room knows that round is taken.',
      diagram: `Term 7                        Term 8
[L7] heartbeats every 100ms   [B] timeout fires first (random 150-300ms)
 |    |    |                   term=8, candidate, votes for itself
[A]  [B]  [C]  [D]  [E]        RequestVote -> A, C, D, E
                               A, C vote yes (log up to date) -> 3/5
[L7] crashes at t=0            [B*] leader for term 8, heartbeats
                               D's timeout fires late, sees term 8 -> follower

Rules: one vote per node per term; majority wins; higher term always wins;
       never vote for a candidate with a shorter/older log`,
      keyPoints: [
        'Roles: follower, candidate, leader; time split into numbered terms with at most one leader each.',
        'Followers become candidates when the randomised election timeout expires without a heartbeat.',
        'One vote per node per term; a majority of votes makes a leader; a higher term always wins.',
        'Randomised timeouts avoid repeated split votes so elections resolve in one round.',
        'Nodes only vote for candidates with an up-to-date log, so committed data survives failover.',
      ],
      checkpoint: {
        question:
          'In a 5-node Raft cluster, the leader is partitioned away with one follower. The other three elect a new leader in term 9. The old leader (term 8) keeps trying to replicate to its lone follower. When the partition heals, what happens?',
        answer:
          'The old leader receives a message (heartbeat or vote request) carrying term 9, recognises the higher term, and steps down to follower. Any entries it appended during the partition were never committed (no majority acknowledged them) and get overwritten by the term-9 leader\'s log. No committed data is lost and there is one leader again.',
      },
    },
    {
      id: 'coordination-services',
      title: 'ZooKeeper, etcd and Consul: election as a service',
      body: `Most teams should not implement Raft. Instead they lean on a **coordination service** that already provides strongly consistent, highly available primitives, and build election on top.

**ZooKeeper** (Apache, 2008, from Yahoo) uses its own ZAB protocol and exposes a filesystem-like tree of **znodes**. Two features make election trivial. **Ephemeral** znodes vanish automatically when the creating client's session ends (detected via heartbeats, default session timeout of several seconds). **Sequential** znodes get a monotonically increasing suffix. The standard recipe: every candidate creates an ephemeral sequential znode under \`/election/\`; the one with the lowest number is the leader; every other node sets a **watch** on the znode immediately before its own. When the leader dies its znode disappears, exactly one node is notified, and it becomes leader. Watching only your predecessor, rather than the leader, avoids the **herd effect** of hundreds of clients waking up and hammering ZooKeeper at once. The zxid doubles as a fencing token. Kafka (before KRaft), HBase, Hadoop YARN and SolrCloud all used this.

**etcd** (CoreOS, 2013) is a key-value store on Raft, best known as Kubernetes' brain. Election uses **leases**: a client creates a lease with a TTL (say 15 s), attaches a key such as \`/leader\` to it with a transactional compare-and-swap ("create only if the key does not exist"), and keeps the lease alive with KeepAlive calls. If the client dies, the lease expires and the key is deleted; watchers see the deletion and race to create it. etcd's \`concurrency\` package ships an \`Election\` primitive doing exactly this, and Kubernetes' \`Lease\` objects in \`coordination.k8s.io\` are how the scheduler and controller-manager choose an active replica. The key's revision is the fencing token.

**Consul** (HashiCorp) also runs Raft and offers **sessions** with TTL and health-check binding, plus a lock API: \`PUT /kv/leader?acquire=<session>\` succeeds for one holder. Vault, Nomad and many HashiCorp-stack deployments use it.

All three share the same operational profile: small clusters of 3 or 5 nodes, strongly consistent (linearisable writes, reads that can be made linearisable), low write throughput (thousands of ops/s, not millions), and designed to hold small metadata, not application data. They are a **dependency you must run well**: if the coordination cluster loses quorum, every system relying on it for leadership freezes. Kafka removing ZooKeeper in favour of its internal KRaft quorum was largely about eliminating this operational dependency.

**Databases as coordinators.** A relational database can serve as a poor man's coordinator via \`SELECT ... FOR UPDATE\` on a leader row with an expiry column, or Postgres advisory locks. It works for small systems but adds load to the very database you may be trying to fail over, so it is unsuitable for database leadership itself.`,
      mentalModel:
        'A coordination service is a notary with a single ledger. Anyone can walk in and try to write "I am the leader" on the next line, but the notary lets only the first succeed, notes the line number as proof, and crosses the entry out automatically if the holder stops showing up.',
      diagram: `ZooKeeper recipe                      etcd recipe
/election/                            lease = grant(ttl=15s)
  n_0000000041  <- leader (lowest)    txn: if /leader not exists
  n_0000000042  watches 41                 put /leader "B" with lease
  n_0000000043  watches 42            keepalive every 5s
  n_0000000044  watches 43            client dies -> lease expires
leader session ends -> 41 vanishes    -> key deleted -> watchers race
-> only 42 is notified (no herd)      revision = fencing token
zxid = fencing token`,
      keyPoints: [
        'ZooKeeper: ephemeral sequential znodes + watch-your-predecessor; lowest sequence leads.',
        'etcd: lease with TTL + compare-and-swap key + KeepAlive; used by Kubernetes.',
        'Consul: sessions with TTL and health checks + KV lock acquire.',
        'All are small, strongly consistent Raft/ZAB clusters for metadata, not bulk data.',
        'They are a critical dependency: lose quorum and everything relying on them freezes.',
      ],
    },
    {
      id: 'sentinel-and-orchestrators',
      title: 'Redis Sentinel and orchestrator-based auto recovery',
      body: `Two practical patterns show how these ideas are packaged into real auto-recovery systems.

**Redis Sentinel** is Redis' built-in high availability for a master with replicas. You run at least three Sentinel processes (odd, on separate hosts). Each pings the master every second. When a Sentinel gets no valid reply for \`down-after-milliseconds\` (default 30 s, often lowered to 5 s) it marks the master **SDOWN** (subjectively down). It then asks the other Sentinels; if at least \`quorum\` of them agree, the state becomes **ODOWN** (objectively down). This quorum stops one Sentinel with a bad network view from triggering a failover on its own.

Failover itself is run by exactly one Sentinel. The Sentinels elect a leader for this failover using a majority vote tied to a **configuration epoch**, a monotonically increasing number that acts as the fencing token for the new configuration. The elected Sentinel picks the best replica (lowest priority value, then most replicated offset, then lowest run id), sends it \`REPLICAOF NO ONE\`, reconfigures the other replicas to follow it, and broadcasts the new configuration with the new epoch. Any Sentinel or client seeing a higher epoch adopts it; stale configurations are ignored. Clients discover the current master by asking Sentinels, not via a fixed address. Redis Sentinel is asynchronous replication underneath, so a failover can lose the last writes; \`min-replicas-to-write\` limits that window by refusing writes when too few replicas are in sync.

**Orchestrator-based auto recovery** generalises this into a **control loop**. Tools such as **Patroni** (Postgres), **MySQL Orchestrator**, **Vitess** (VTOrc), **MongoDB replica sets** (built-in), and Kubernetes operators for databases all follow the same shape:

1. **Observe**: continuously gather health of every node and the current topology, ideally from several vantage points.
2. **Compare** with the desired state: exactly one healthy, writable leader with N in-sync replicas.
3. **Act** to converge: if the leader is gone, choose the most advanced replica, fence the old leader, promote, reconfigure replicas and update service discovery; if a replica is broken, rebuild it from the leader.

Patroni is a good study case. Each Postgres node runs a Patroni agent that holds a leader key in etcd (or ZooKeeper/Consul/Kubernetes) with a TTL of about 30 s. The agent renews the key only if Postgres is healthy. If the leader node fails or is partitioned, its key expires, the other agents race to acquire it, and the winner (having checked its WAL position is at least as advanced as its peers') promotes Postgres. The old node, if alive, sees it cannot renew and demotes itself or, with the Linux watchdog enabled, is hard-reset if the agent hangs. Kubernetes exemplifies the same loop at the infrastructure level: controllers repeatedly reconcile "desired replicas: 3" with reality.

The design principle: **humans set the policy, machines run the loop**. Encode the constraints (do not fail over if lag exceeds 10 MB, never fail over across regions automatically, require quorum agreement), test them with chaos experiments, and let the orchestrator handle 3 a.m.`,
      mentalModel:
        'A thermostat is an orchestrator. You set the desired temperature (policy). It measures the room (observe), compares, and switches the heater on or off (act), forever. Auto recovery is a thermostat whose desired state is "one healthy leader".',
      diagram: `Redis Sentinel                       Orchestrator control loop (Patroni)
[S1] [S2] [S3]  ping master/1s        +-----------------------------------+
  SDOWN each -> agree quorum=2         |  observe: node health, WAL pos    |
  -> ODOWN                             |  compare: exactly 1 leader?       |
  elect leader Sentinel (epoch=42)     |  act: fence old, promote best     |
  pick best replica -> REPLICAOF NO ONE|       replica, reconfigure, update |
  reconfigure others, broadcast epoch  |       discovery                   |
  clients ask Sentinels for master     +-----------------------------------+
                                       leader key in etcd, TTL 30s, watchdog`,
      keyPoints: [
        'Sentinel: SDOWN -> ODOWN needs quorum agreement; one Sentinel is elected to run the failover.',
        'Configuration epoch is Sentinel\'s fencing token; clients discover the master via Sentinels.',
        'Sentinel replication is async; min-replicas-to-write bounds data loss.',
        'Orchestrators (Patroni, Orchestrator, operators) run observe-compare-act loops toward "one healthy leader".',
        'Patroni holds a TTL leader key in etcd, promotes the most advanced replica, and uses a watchdog for fencing.',
      ],
      checkpoint: {
        question:
          'You run Redis with one master, two replicas, and a single Sentinel process. The Sentinel\'s host loses network connectivity to the master while clients can still reach it. What happens and why is it bad?',
        answer:
          'With one Sentinel, quorum is 1, so its subjective view becomes objective instantly: it promotes a replica while the original master is still serving clients. You now have two masters (split brain) and, because clients that ask this Sentinel get the new master while others keep the old address, writes diverge. Run at least three Sentinels on separate hosts with quorum 2 so a single bad network view cannot trigger failover.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What is "split brain" in the context of leader election?',
      options: [
        'A leader that is overloaded and responds slowly',
        'Two or more nodes simultaneously believing they are the leader and acting on it',
        'A cluster with no leader for an extended period',
        'A leader whose log has diverged from its followers',
      ],
      answerIndex: 1,
      explanation:
        'Split brain is multiple simultaneous leaders, typically caused by a network partition, leading to divergent writes. No leader is a liveness problem, which is less severe than the safety violation of two leaders.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'Why does requiring a majority quorum (floor(N/2)+1 votes) prevent two leaders being elected in the same round?',
      options: [
        'Because a majority always includes the previous leader',
        'Because any two majorities of the same set must overlap in at least one node, which votes only once',
        'Because the network cannot partition a majority',
        'Because nodes in the minority are shut down',
      ],
      answerIndex: 1,
      explanation:
        'Two disjoint subsets each larger than half the cluster cannot exist. The shared node votes for one candidate only, so at most one can reach a majority. The minority side simply cannot gather enough votes; it is not shut down.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'A cluster is expanded from 5 to 6 nodes. How does its fault tolerance for leader election change?',
      options: [
        'It can now tolerate 3 failures instead of 2',
        'It still tolerates only 2 failures, and a 3-3 partition can now elect nobody',
        'It tolerates 4 failures',
        'Fault tolerance is unaffected by node count',
      ],
      answerIndex: 1,
      explanation:
        'Majority of 6 is 4, so at most 2 nodes may fail, same as with 5 nodes. The extra node adds cost and a new failure mode (an even split). Odd sizes are recommended for this reason.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which of the following act as fencing tokens in real systems? Select all that apply.',
      options: [
        'Raft term number',
        'Kafka leader epoch',
        'A node\'s IP address',
        'ZooKeeper zxid or znode version',
        'Redis Sentinel configuration epoch',
        'The leader\'s wall-clock time',
      ],
      answerIndices: [0, 1, 3, 4],
      explanation:
        'Fencing tokens must be monotonically increasing and issued with each grant of authority; terms, epochs, zxids and revisions all qualify. IP addresses are not ordered by authority, and wall-clock time is unreliable across machines and can go backwards.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 1,
      statement: 'A distributed system can always reliably tell the difference between a node that has crashed and one that is merely unreachable due to a network partition.',
      answer: false,
      explanation:
        'From the observer\'s viewpoint both look identical: no response. This uncertainty is fundamental and is why leases, quorums and fencing tokens exist rather than trusting a simple "node is dead" judgement.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A leader holds a 10-second lease and checks it is valid, then hits a 20-second stop-the-world GC pause. On resuming it writes to storage. A new leader was elected during the pause. Which mechanism prevents the stale write from corrupting data?',
      options: [
        'A shorter heartbeat interval',
        'The majority quorum used in the election',
        'A fencing token checked by the storage layer, rejecting the old leader\'s lower token',
        'Randomised election timeouts',
      ],
      answerIndex: 2,
      explanation:
        'The quorum prevented a double election but cannot stop a node acting on stale belief. Only the storage layer checking tokens (or physical fencing) blocks the write. Heartbeats and timeouts concern detection and election, not enforcement.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'In Raft, why are election timeouts randomised (e.g. 150-300 ms) rather than fixed?',
      options: [
        'To reduce network traffic during normal operation',
        'So that one follower usually times out first and wins before others become candidates, avoiding repeated split votes',
        'To ensure the most up-to-date node always wins',
        'To synchronise clocks between nodes',
      ],
      answerIndex: 1,
      explanation:
        'With identical timeouts all followers would become candidates simultaneously and split the vote indefinitely. Randomisation staggers them. Log up-to-dateness is enforced separately by the voting rule, not by the timeout.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 2,
      statement: 'In the ZooKeeper leader election recipe, every candidate should set a watch on the leader\'s znode so all are notified when it dies.',
      answer: false,
      explanation:
        'Watching the leader causes the herd effect: every candidate wakes and hits ZooKeeper at once. The recipe has each node watch only the znode immediately preceding its own, so exactly one node is notified and becomes the next leader.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 2,
      question: 'In Redis Sentinel, what is the difference between SDOWN and ODOWN?',
      options: [
        'SDOWN means the master is slow; ODOWN means it has crashed',
        'SDOWN is one Sentinel\'s own view that the master is down; ODOWN means a quorum of Sentinels agree, which is required to start failover',
        'SDOWN applies to replicas; ODOWN applies to the master',
        'SDOWN is detected by clients; ODOWN by Sentinels',
      ],
      answerIndex: 1,
      explanation:
        'Subjectively down is a single Sentinel\'s judgement after down-after-milliseconds. Objectively down requires quorum agreement, preventing one Sentinel with a bad network view from triggering an unnecessary failover.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 3,
      question:
        'Patroni runs on three Postgres nodes using etcd. The current leader\'s Patroni agent hangs (deadlocked) while Postgres itself keeps serving writes. Which safeguard prevents split brain after another node takes the leader key?',
      options: [
        'Synchronous replication',
        'The Linux watchdog, which hard-resets the node when the agent stops petting it',
        'Increasing the etcd TTL',
        'A larger etcd cluster',
      ],
      answerIndex: 1,
      explanation:
        'The hung agent cannot demote Postgres, so the node would keep accepting writes after losing the lease. The watchdog is physical fencing: no renewal means a reboot before the TTL elapses. Sync replication limits data loss but does not stop two writers; TTL and cluster size change timing, not safety.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design leader election for a distributed cron service with 5 replicas across 3 availability zones. Jobs must never run twice concurrently and should resume within 15 seconds of a leader failure. Specify the mechanism, timings and how you make a stale leader harmless.',
      modelAnswer: `**Mechanism:** use an existing coordination store rather than custom consensus: a 3-node etcd cluster (one per AZ) or the Kubernetes Lease API backed by it. Each replica tries to acquire the key \`/cron/leader\` via compare-and-swap attached to a lease with a **10 s TTL**, renewing every **3 s**. Only the holder schedules jobs; others watch the key.

**Timings:** if the leader dies, its lease expires within 10 s, watchers see the delete and race to acquire; election completes in well under the 15 s target. The leader stops scheduling at 80% of the TTL if a renewal fails, so it stops before anyone else can start.

**Fencing:** the lease revision is the fencing token. Every job execution record written to the jobs database includes the token; the database enforces "run row for job X at time T may only be inserted by the highest token seen" (or a unique constraint on (job_id, scheduled_time) plus token check). A stale leader waking from a GC pause has its inserts rejected, so a job cannot run twice even if two processes briefly think they lead. Job executions are also made idempotent with (job_id, scheduled_time) as the idempotency key.

**Operational rules:** odd-sized etcd cluster across AZs so one AZ loss keeps quorum; alert when leadership changes more than twice in 10 minutes (flapping); chaos test by killing the leader pod and partitioning an AZ.`,
      rubric: [
        'Uses a coordination service (etcd/ZooKeeper/Consul/Kubernetes Lease) with a TTL lease or ephemeral node.',
        'Chooses timings (TTL, renewal) that meet the 15 s recovery target with a safety margin.',
        'Includes a fencing token checked at the resource (jobs DB) so stale leaders cannot cause duplicate runs.',
        'Mentions idempotency or unique constraints as a second line of defence.',
        'Places the coordination cluster across AZs with an odd size.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain the sequence of a Raft leader election from the moment a leader crashes to the moment a new leader is established, in a 5-node cluster.',
      modelAnswer: `1. The leader for term 8 crashes and stops sending AppendEntries heartbeats.
2. Each follower has a randomised election timeout (e.g. 150-300 ms). The first one to expire, say node B, increments its term to 9, becomes a candidate, votes for itself and sends RequestVote(term=9, lastLogIndex, lastLogTerm) to the other four.
3. Each receiver grants its vote if it has not yet voted in term 9 and B\'s log is at least as up to date as its own. B needs 3 votes in total (itself plus two).
4. Once B holds a majority it becomes leader for term 9 and immediately sends heartbeats. Followers whose timeouts were about to expire reset them and stay followers.
5. If another node had also become a candidate and the vote split, no one reaches 3; both time out again with fresh random delays and retry in term 10, which almost always resolves.
6. If the old leader returns, it sees term 9 in the first message it receives and reverts to follower; any uncommitted entries it had are overwritten.`,
      rubric: [
        'Randomised election timeout triggers candidacy and a term increment.',
        'Candidate votes for itself and requests votes; one vote per node per term.',
        'Majority (3 of 5) required; log up-to-dateness check mentioned.',
        'Winner heartbeats to suppress other candidates; split votes retried with new random timeouts.',
        'Old leader steps down on seeing a higher term.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 1,
      question: 'What is a lease in leader election, and what obligation does it place on the leader?',
      modelAnswer: `A lease is time-limited authority to act as leader, granted by a coordination service for a fixed duration (for example 10 seconds). The leader must renew it periodically before it expires. If renewal fails, because the leader is partitioned, overloaded or dead, the lease lapses and other nodes may then be elected.

The obligation is symmetric: the leader **must voluntarily stop acting as leader once its lease has expired**, even if it believes it is healthy, because it can no longer be sure that a replacement has not been elected. Practical implementations stop early (at around 80% of the lease) to allow for clock drift, and pair leases with fencing tokens to cover process pauses that make a leader act after expiry.`,
      rubric: [
        'Defines a lease as time-bounded leadership requiring renewal.',
        'States that other nodes cannot take over until expiry.',
        'States the leader must stop acting when it cannot renew.',
        'Mentions clock drift margins or fencing as complements.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Why have a single leader?', back: 'One node making decisions removes conflict resolution: one writer, one scheduler, one owner. Agree once on who leads, then the leader decides fast and locally.' },
    { id: 'f2', front: 'Split brain', back: 'Two or more nodes simultaneously acting as leader, usually after a network partition. Causes divergent writes that may be unrecoverable. Prevented by majority quorum; made harmless by fencing tokens.' },
    { id: 'f3', front: 'Priority order for leader election', back: 'Safety (never two leaders acting) > liveness (eventually one leader) > speed (seconds). Brief unavailability is recoverable; divergent data may not be.' },
    { id: 'f4', front: 'Heartbeat timeout trade-off', back: 'Short timeout: fast detection, more false positives (GC pauses, jitter) causing spurious elections. Long timeout: fewer false alarms, longer leaderless gap. Cannot distinguish dead from unreachable.' },
    { id: 'f5', front: 'Lease', back: 'Time-bounded authority (e.g. 10 s) the leader must renew (e.g. every 3 s). On failed renewal the leader must stop at expiry; nobody else may lead before expiry. Needs bounded clock drift and safety margin.' },
    { id: 'f6', front: 'Majority quorum formula and tolerance', back: 'Need floor(N/2)+1 votes. Tolerates floor((N-1)/2) failures: 3 -> 1, 5 -> 2, 7 -> 3. Even N adds cost but no tolerance and risks an even split.' },
    { id: 'f7', front: 'Why two disjoint majorities are impossible', back: 'Two subsets each larger than N/2 must overlap in at least one node. That node votes once per round, so only one candidate can reach a majority.' },
    { id: 'f8', front: 'Fencing token', back: 'Monotonically increasing number issued with each leadership grant. Protected resources track the max seen and reject lower tokens, so a stale leader (after GC pause or partition) cannot act.' },
    { id: 'f9', front: 'Real-world fencing tokens', back: 'Raft term, Kafka controller/leader epoch, ZooKeeper zxid or version, etcd lease revision, Redis Sentinel configuration epoch, HDFS JournalNode epoch.' },
    { id: 'f10', front: 'STONITH', back: '"Shoot The Other Node In The Head": physically power off or isolate the old leader (IPMI, revoke storage/network) before promoting a new one. Used when resources cannot check fencing tokens.' },
    { id: 'f11', front: 'Raft roles and terms', back: 'Follower, candidate, leader. Time divided into numbered terms; at most one leader per term. A node seeing a higher term updates and becomes follower. Term is the fencing token.' },
    { id: 'f12', front: 'Raft election sequence', back: 'Randomised election timeout (150-300 ms) fires -> increment term, become candidate, vote for self, RequestVote -> majority wins -> heartbeats via AppendEntries. Split vote -> new random timeout, retry.' },
    { id: 'f13', front: 'Raft log-completeness voting rule', back: 'A node votes only for a candidate whose last log entry is at least as new (by term, then index). Since committed entries are on a majority, the winner has all committed data: RPO 0 failover.' },
    { id: 'f14', front: 'ZooKeeper election recipe', back: 'Each candidate creates an ephemeral sequential znode under /election. Lowest sequence leads. Each node watches only its predecessor (avoids herd effect). Leader session ends -> znode vanishes -> next is notified.' },
    { id: 'f15', front: 'etcd election recipe', back: 'Grant lease with TTL; transactional put of /leader only if absent, attached to lease; KeepAlive renews. Client death -> lease expiry -> key deleted -> watchers race. Revision = fencing token. Basis of Kubernetes Lease objects.' },
    { id: 'f16', front: 'Redis Sentinel failover flow', back: 'Sentinels ping master; SDOWN after down-after-milliseconds; ODOWN when quorum agrees; elect a leader Sentinel (config epoch); pick best replica; REPLICAOF NO ONE; reconfigure others; broadcast epoch. Async, so min-replicas-to-write bounds loss.' },
    { id: 'f17', front: 'Orchestrator control loop', back: 'Observe health/topology -> compare with desired (exactly one healthy leader) -> act (fence, promote most advanced replica, reconfigure, update discovery). Patroni, MySQL Orchestrator, Kubernetes operators.' },
    { id: 'f18', front: 'Patroni fencing', back: 'Leader key in etcd with ~30 s TTL renewed only if Postgres healthy. Lost lease -> self-demote. Linux watchdog hard-resets the node if the agent hangs, so a stuck agent cannot leave two writers.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Split brain and majority quorum',
      prompt: 'Explain to a new team member why a cluster needs a majority vote to pick a leader, and what goes wrong without it, using a 5-node example.',
      modelExplanation: `Picture five servers, and the network cable between two of them and the other three gets cut. Each group can still talk among itself and to some users, but they cannot see each other. To each group, the other looks dead.

If each group is allowed to pick its own leader, both do, and both start accepting writes. Users on the left update an order; users on the right update the same order differently. When the cable is fixed, there are two versions of the truth and no clean way to merge them. That is split brain, and it can be worse than an outage because you may never fully repair the data.

The fix is a simple rule: you may only become leader if more than half of *all* five servers vote for you, so three votes. The group of two can never get three. The group of three can. And two different groups of three out of five must share at least one server, who only votes once, so two leaders in one round are impossible. The small side goes quiet until the network heals; the big side carries on. We trade a bit of availability on the minority side for never corrupting the data.`,
      mustMention: [
        'Partition makes each side think the other is dead',
        'Two leaders means divergent writes that cannot be merged',
        'Majority = floor(N/2)+1',
        'Two majorities must overlap, so only one leader per round',
        'Minority side sacrifices availability',
      ],
    },
    {
      id: 'fe2',
      concept: 'Fencing tokens',
      prompt: 'Explain fencing tokens and why leases alone are not enough, using the garbage-collection pause example.',
      modelExplanation: `A lease says: you are leader until 10:00:10, renew before then or stop. Sounds airtight. But suppose the leader checks the clock at 10:00:05, sees five seconds left, and then the JVM freezes for a 20-second garbage collection. During that freeze the lease expires and another node becomes leader. When the old one wakes at 10:00:25, it is still in the middle of the code path that already decided "I am leader" and it fires off a write. Two leaders have now written.

The problem is that we trusted the leader's own belief. Fencing tokens move the check to the thing being written. Every time someone becomes leader, the coordination service hands them a number one higher than the last: leader 33, then 34. Every write carries that number. The database remembers the highest number it has seen and refuses anything lower. So when leader 33 wakes up and writes, the database, having already seen 34, rejects it. The old leader can believe whatever it likes; it can no longer do harm.`,
      mustMention: [
        'Leases rely on the leader\'s own belief and timing',
        'Process pauses can make a leader act after expiry',
        'Token is monotonically increasing per leadership grant',
        'Resource rejects lower tokens',
        'Stale leader becomes harmless rather than prevented',
      ],
    },
    {
      id: 'fe3',
      concept: 'Raft leader election',
      prompt: 'Explain how Raft picks a new leader after a crash, in plain language, to someone who has never read the paper.',
      modelExplanation: `In Raft, one server is leader and sends a little "still here" message to the others every 100 milliseconds or so. Every other server has an alarm clock, set to a random time between roughly 150 and 300 milliseconds, that gets reset each time a message arrives.

If the leader crashes, the messages stop. The server whose alarm goes off first says: "New round, number 9. I am running. Vote for me." It sends that to everyone. Each server gives out one vote per round, and only to a candidate whose copy of the log is at least as complete as its own, so nobody with missing data can win. If the candidate gets votes from more than half the cluster, it is leader for round 9 and starts sending "still here" messages, which reset everyone else's alarms before they can run too.

The random alarms are why this works: one server almost always wakes first and wins cleanly. If two do wake together and split the vote, they simply pick new random alarms and try again. And any server that later hears "round 9" knows round 8 is over, so the old leader, if it comes back, quietly steps down.`,
      mustMention: [
        'Heartbeats reset randomised election timeouts',
        'Term increments and self-vote on timeout',
        'One vote per node per term; majority wins',
        'Log up-to-dateness condition for voting',
        'Higher term causes old leader to step down',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a medieval castle during a succession crisis: from the empty throne room, up the watchtower, across the great hall where the council votes, down to the treasury, and out to the mechanical clock tower in the courtyard.',
    stops: [
      { locus: 'The throne room with an empty throne', concept: 'Why exactly one leader', image: 'An empty golden throne: petitioners queue with scrolls (writes) nobody can sign. In a mirror you glimpse the alternative, two kings on two thrones sealing contradictory decrees, and the mirror cracks down the middle.' },
      { locus: 'The watchtower drummer', concept: 'Heartbeats and leases', image: 'A drummer beats once per second so the whole castle knows the king lives. Beside him an hourglass (the lease) runs for ten seconds; the king must flip it every three or, by law, must set down his crown when the sand runs out, even mid-sentence.' },
      { locus: 'The moat that splits the castle in two', concept: 'Split brain', image: 'The drawbridge collapses, cutting the castle into two halves that cannot hear each other. On each side a duke shouts "the king is dead, I rule now", and messengers with contradictory decrees pile up at the broken bridge.' },
      { locus: 'The great hall with five council chairs', concept: 'Majority quorum', image: 'Five enormous chairs; a decree needs three seals. The two dukes stranded across the moat wave their seals uselessly, while the three on the near side stamp a crown onto one of them. Any three of five chairs must share a councillor, so two crowns is impossible.' },
      { locus: 'The treasury door with a numbered stamp', concept: 'Fencing tokens', image: 'The treasurer only opens for warrants stamped with the highest number he has ever seen. A dazed old king, who fainted for twenty minutes, arrives with warrant 33; the treasurer points at the ledger showing 34 and slams the door.' },
      { locus: 'The courtyard clock tower with random chimes', concept: 'Raft terms and randomised timeouts', image: 'Every knight carries a pocket watch set to a different random alarm. When the drummer falls silent, the first alarm rings; that knight yells "TERM 9!", collects three salutes, and starts drumming himself before the other alarms even ring.' },
      { locus: 'The notary\'s ledger by the gate', concept: 'ZooKeeper, etcd and Consul', image: 'A notary with a single numbered ledger. Knights sign in order; the lowest number rules. Each watches only the knight who signed just before him, so when a signature fades (session ends), exactly one knight looks up.' },
      { locus: 'The three sentries and the clockwork steward', concept: 'Redis Sentinel and orchestrators', image: 'Three sentries must all agree the king is down before one is chosen to crown a replacement, stamping a new epoch on the proclamation. A brass clockwork steward endlessly compares "one healthy king" with reality and pulls levers to fix any difference.' },
    ],
  },
  interviewQuestions: [
    'Why do distributed systems often elect a single leader, and what is the worst thing that can happen during automatic failover?',
    'Explain the difference between a heartbeat and a lease. Why do you need both?',
    'What is split brain? Show with a 5-node cluster why a majority quorum prevents it.',
    'What is a fencing token, and what problem does it solve that leases and quorums do not?',
    'Give the Raft leader election algorithm at a high level. Why are election timeouts randomised, and how does Raft ensure the new leader has all committed entries?',
    'Compare ZooKeeper and etcd for leader election. Describe one election recipe in detail.',
    'How does Redis Sentinel decide the master is down and choose which replica to promote?',
    'Describe how you would build automatic failover for a Postgres cluster. What would you never automate?',
  ],
}

export default chapter
