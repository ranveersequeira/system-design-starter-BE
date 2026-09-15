import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 18,
  slug: 'data-redundancy-and-recovery',
  title: 'Data Redundancy And Recovery',
  module: 'resilience',
  estimatedMinutes: 40,
  summary:
    'Disks die, regions go dark, and engineers run DELETE without a WHERE clause. Data redundancy is how a system keeps serving through hardware failure, and recovery is how it gets its data back after logical or catastrophic loss. This chapter covers replication modes, backup strategies including write-ahead logs and point-in-time recovery, the RPO/RTO vocabulary that ties them to business requirements, failover mechanics, multi-AZ and multi-region topologies, and why an untested backup is not a backup.',
  objectives: [
    'Distinguish redundancy (surviving failure without downtime) from recovery (restoring data after loss) and explain why you need both.',
    'Compare synchronous, asynchronous and semi-synchronous replication in terms of latency, durability and data-loss window.',
    'Design a backup strategy combining full, incremental and WAL-based point-in-time recovery to meet a given RPO and RTO.',
    'Explain failover mechanics, the risks of automatic failover, and how multi-AZ and multi-region deployments differ in cost and protection.',
    'Describe RAID levels at the level needed to reason about single-node durability, and argue for regular restore drills.',
  ],
  quickRevision: [
    'Redundancy keeps you running when a component dies (replicas, RAID, multi-AZ); recovery gets data back after it is lost or corrupted (backups, PITR). Replication is NOT a backup: a bad DELETE replicates in milliseconds.',
    'RPO (Recovery Point Objective) = how much data you may lose, measured in time (e.g. 5 minutes). RTO (Recovery Time Objective) = how long you may be down (e.g. 1 hour).',
    'Synchronous replication: primary waits for the replica to ack before committing; RPO 0 but every write pays a network round trip and a replica outage can stall writes.',
    'Asynchronous replication: primary commits locally and ships changes later; fast writes but replica lag means RPO > 0 and a failover can lose the last seconds of commits.',
    'Semi-synchronous (MySQL semisync, Postgres synchronous_commit with quorum): wait for at least one of N replicas; balances durability and latency.',
    'Full backup = complete copy; incremental = changes since last backup; differential = changes since last full. Restore chain length trades storage for restore time.',
    'The write-ahead log (WAL in Postgres, binlog in MySQL, redo log in Oracle) records every change before it is applied; archiving it continuously enables point-in-time recovery to any second.',
    'PITR = restore last base backup + replay archived WAL up to the target timestamp (just before the bad command).',
    'Failover promotes a replica to primary; automatic failover is fast but risks split brain and lost async writes, manual failover is safe but slow. Always fence the old primary.',
    'Multi-AZ survives a data centre failure with ~1-2 ms replication latency; multi-region survives a regional outage but pays 50-100+ ms cross-region latency, so it is usually async.',
    'RAID 0 stripes (no redundancy), RAID 1 mirrors, RAID 5 stripes with one parity (survives 1 disk), RAID 6 two parities (survives 2), RAID 10 mirror+stripe. RAID protects against disk death, not against deletion or fire.',
    'Follow the 3-2-1 rule: 3 copies, on 2 different media/systems, 1 offsite (another region or provider). Make one copy immutable (S3 Object Lock) against ransomware.',
    'An untested backup is a hope, not a backup. Run restore drills on a schedule and measure the actual RTO; GitLab in 2017 discovered five broken backup mechanisms only during an outage.',
  ],
  sections: [
    {
      id: 'redundancy-vs-recovery',
      title: 'Two different problems: staying up and getting data back',
      body: `Engineers often say "we have replicas, so we are safe". Replicas solve one problem and leave another wide open. It helps to separate them clearly.

**Redundancy** is about continuing to operate when a component fails. A disk fails inside a RAID array and nobody notices. A database primary dies and a replica takes over in 30 seconds. An availability zone loses power and traffic shifts to the other two. Redundancy is measured in **availability**: what fraction of the time can the system serve requests?

**Recovery** is about getting correct data back after it has been lost or damaged. Someone runs \`DELETE FROM orders\` without a WHERE clause. A deploy runs a migration that corrupts a column. Ransomware encrypts the volume. A bug silently writes wrong values for a week. Recovery is measured in **durability** (will the data survive?) and in how far back and how quickly you can restore.

Here is the crucial point: **replication makes recovery problems worse, not better.** A synchronous replica receives the bad DELETE within a millisecond and executes it faithfully. Your five replicas across three zones are now five identical copies of the wrong data. Replication protects against hardware failure; it propagates human and software failure.

Only a **backup**, a copy that is frozen at a point in time and isolated from the live system's writes, lets you go back. And only a backup that is stored somewhere the live system cannot touch (another account, another region, an immutable bucket) protects you when the failure is malicious or when the deletion is of the whole database.

So a complete strategy answers two questions separately. *If a machine, disk or data centre dies, how do we keep serving?* (redundancy). *If the data itself is wrong or gone, how do we get the right data back, from how far in the past, and how quickly?* (recovery). The rest of this chapter takes them in turn, then ties them together with RPO and RTO.`,
      mentalModel:
        'Redundancy is having two engines on an aeroplane: one fails, you keep flying. Recovery is the flight recorder and the maintenance log: after something goes wrong, you can reconstruct exactly what the state was. Two engines do nothing for you if the navigation chart itself was wrong.',
      diagram: `Failure type            Replication  Backup  RAID   Multi-region
-----------------------------------------------------------------
Disk dies                 yes          yes     yes     yes
Server dies               yes          yes     no      yes
AZ / data centre down     yes*         yes     no      yes
Whole region down         no*          yes**   no      yes
Bad DELETE / migration    NO           yes     no      NO
Ransomware / account hack NO           yes***  no      NO
 * if replicas in other AZs/regions   ** if stored offsite
 *** only if immutable / separate account`,
      keyPoints: [
        'Redundancy = keep serving through component failure; recovery = restore correct data after loss.',
        'Replication propagates logical errors instantly; it is not a backup.',
        'A backup is a point-in-time copy isolated from live writes.',
        'Offsite and immutable copies are the only defence against account-level or malicious loss.',
      ],
      checkpoint: {
        question:
          'A team has a Postgres primary with two synchronous replicas in different AZs and no backups. Name one failure they survive and one they do not.',
        answer:
          'They survive a primary crash or an AZ outage (a replica is promoted with zero data loss). They do not survive a bad UPDATE or DROP TABLE, a corrupting migration, or an attacker with database credentials: all replicas apply the same change within milliseconds and there is no earlier copy to return to.',
      },
    },
    {
      id: 'replication-modes',
      title: 'Synchronous, asynchronous and semi-synchronous replication',
      body: `Replication copies every committed change from a primary to one or more replicas. The single design choice that matters most is **when the primary acknowledges the write to the client**.

**Synchronous replication.** The primary sends the change to the replica, waits for the replica to write it durably and acknowledge, and only then tells the client "committed". Both copies have the data at commit time, so a primary failure loses nothing: **RPO is zero**. The costs: every write pays at least one network round trip (about 1 ms within a region, 50-100+ ms across continents), throughput is bounded by the slowest replica, and if the replica is down the primary must either block all writes or violate the guarantee. Postgres \`synchronous_commit = on\` with \`synchronous_standby_names\` and Google Spanner are examples.

**Asynchronous replication.** The primary commits locally, acknowledges immediately, and streams changes to replicas in the background. Writes are as fast as a single node and a dead replica never stalls the primary. But the replica **lags**: under normal load by milliseconds, under heavy load or a network hiccup by seconds or minutes. If the primary dies, everything it committed but had not yet shipped is gone. RPO equals the replication lag at the moment of failure. MySQL default replication, Postgres streaming replication by default, and cross-region read replicas in RDS are asynchronous.

**Semi-synchronous replication.** Wait for acknowledgement from at least one (or a quorum) of N replicas, not all. MySQL's \`rpl_semi_sync\` plugin waits for one replica's relay log; Postgres supports \`ANY 1 (r1, r2, r3)\` or \`FIRST 2\`. You get RPO zero as long as the acknowledging replica survives, but a single slow replica no longer holds everyone hostage. This is the most common production compromise: one sync replica in a nearby AZ for durability, additional async replicas far away for disaster recovery and read scaling.

A subtle distinction: "replica acknowledged" can mean *received into memory*, *written to its log on disk*, or *applied and visible to readers*. Postgres distinguishes \`remote_write\`, \`on\` (flushed) and \`remote_apply\`. Durability needs at least a disk flush; read-your-writes on the replica needs apply.`,
      mentalModel:
        'Sync replication is a registered letter: you do not consider it sent until the recipient signs. Async is dropping it in the postbox and walking away: fast, but if the van crashes the letter is gone. Semi-sync is sending to three friends and moving on as soon as any one texts back "got it".',
      diagram: `Synchronous:                    Asynchronous:
Client  Primary   Replica       Client  Primary   Replica
  |--w-->|          |             |--w-->|          |
  |      |--ship--->|             |      |-commit   |
  |      |          |-fsync       |<-ack-|          |
  |      |<--ack----|             |      |--ship--->|  (later)
  |      |-commit   |             |      |          |-apply
  |<-ack-|          |
  latency: +1 RTT, RPO = 0        latency: local, RPO = lag

Semi-sync: wait for ANY 1 of N replicas, then commit`,
      keyPoints: [
        'The key choice is when the client is told "committed" relative to the replica having the data.',
        'Sync: RPO 0, higher write latency, replica outage can stall writes.',
        'Async: fastest writes, RPO equals replication lag, failover may lose recent commits.',
        'Semi-sync (any 1 of N) gives durability without depending on every replica.',
        'Ack levels differ: received, flushed to disk, applied; durability needs at least a flush.',
      ],
      checkpoint: {
        question:
          'A primary in Mumbai has one sync replica in Mumbai and one async replica in Frankfurt (lag ~2 s). The Mumbai region loses power. What is the data loss if you promote Frankfurt?',
        answer:
          'Roughly the last 2 seconds of committed writes, plus anything in flight. The Mumbai sync replica had everything but is also down. This is why multi-region is usually async and why the business must accept a non-zero RPO for regional failure, or pay cross-region sync latency on every write.',
      },
    },
    {
      id: 'backups',
      title: 'Backups: full, incremental, and the write-ahead log',
      body: `A backup is a copy of the data at a point in time that the live system cannot modify. There are three building blocks.

**Full backup.** A complete copy of the dataset. Simple to restore (one file), expensive to take (copies everything, e.g. \`pg_basebackup\`, \`mysqldump\`, an EBS or RDS snapshot). Taking one per day on a 2 TB database means 2 TB of I/O and storage daily.

**Incremental backup.** Only the blocks or rows changed since the *previous* backup (full or incremental). Cheap to take, but restoring requires the last full plus every incremental in order; a 30-day chain means 31 restores and any corrupt link breaks everything after it. **Differential** backups store changes since the last *full*, so restore is full + one differential: more storage, shorter chain. Cloud snapshots (EBS, RDS) are incremental at the block level but presented as independent full snapshots, which is the best of both.

**Continuous log archiving.** Every serious database writes changes to an append-only log *before* applying them to data files: the **write-ahead log (WAL)** in Postgres, the **binary log (binlog)** in MySQL, the **redo log** in Oracle, the **oplog** in MongoDB. The log exists for crash recovery, but if you continuously copy each log segment to durable storage (Postgres \`archive_command\` to S3, or tools like pgBackRest, WAL-G, Barman; Percona XtraBackup plus binlog streaming for MySQL), you have a record of every committed change.

That enables **point-in-time recovery (PITR)**: restore the most recent full backup, then replay archived log up to a chosen timestamp or transaction id. If someone ran the bad DELETE at 14:32:07, you recover to 14:32:06. Your RPO becomes the log-shipping interval, typically seconds to a minute, at a fraction of the cost of frequent full backups. RDS, Cloud SQL and Aurora all expose this as "restore to point in time" over a 1-35 day window.

A complete schedule looks like: weekly full base backup, daily incrementals or snapshots, continuous WAL archiving, retention tuned to compliance (e.g. 35 days online, monthly fulls kept for 7 years in Glacier). Encrypt everything, store it in a different account or region, and make at least one copy immutable (S3 Object Lock in compliance mode) so a compromised production credential cannot delete your backups along with your data.`,
      mentalModel:
        'A full backup is a photograph of your desk. An incremental is a sticky note listing what moved since the last photo. The WAL is a security camera recording every hand that touched the desk; with the last photo and the tape you can rewind to any second.',
      diagram: `Sun      Mon      Tue      Wed      Thu 14:32:07 bad DELETE
FULL --> inc ---> inc ---> inc --->  |
 |                                   |
 +--- WAL segments archived continuously to S3 ---------->
                                     |
PITR: restore Sun FULL + Mon..Wed inc + replay WAL to 14:32:06
      ^                                          ^
      base                                       stop just before
RPO = WAL archive interval (seconds..1 min)`,
      keyPoints: [
        'Full = complete copy; incremental = changes since last backup; differential = changes since last full.',
        'Longer incremental chains save storage but lengthen and weaken restores.',
        'WAL/binlog archiving records every change; PITR = base backup + log replay to a timestamp.',
        'PITR gives an RPO of seconds without frequent full backups.',
        'Store backups encrypted, offsite, and at least one copy immutable.',
      ],
      checkpoint: {
        question:
          'Your only backup is a nightly full dump at 02:00. A migration corrupts data at 17:00. What is your data loss and how would WAL archiving change it?',
        answer:
          'You lose 15 hours of writes (02:00 to 17:00): RPO 24 h in the worst case. With continuous WAL archiving you restore the 02:00 base and replay the log up to 16:59, losing only the writes after the corruption (which you did not want anyway) plus at most the archive interval. RPO drops from hours to seconds.',
      },
    },
    {
      id: 'rpo-rto',
      title: 'RPO and RTO: turning fear into requirements',
      body: `Business stakeholders say "we can never lose data" and "we can never be down". Both are infinitely expensive, so the designer's job is to convert them into two numbers.

**Recovery Point Objective (RPO)** is the maximum acceptable data loss, expressed as time. "RPO 5 minutes" means: after any disaster, the restored system may be missing at most the last 5 minutes of writes. RPO is determined by **how often you capture state**: replication lag for failover scenarios, WAL archive interval or backup frequency for restore scenarios. RPO 0 requires synchronous replication to the failover target; RPO 24 h is what a nightly dump gives you.

**Recovery Time Objective (RTO)** is the maximum acceptable downtime: how long from failure to service restored. RTO is determined by **how automated and rehearsed recovery is**: a hot standby with automatic failover gives an RTO of seconds to a minute; a warm standby that must be scaled up gives minutes to an hour; restoring a 2 TB database from S3 and replaying a day of WAL can take many hours. Note that restore speed is often bounded by network and disk throughput: 2 TB at 200 MB/s is nearly 3 hours before replay even starts.

Both numbers should be **per dataset, not per company**. The orders ledger may need RPO 0 and RTO 5 minutes. The analytics warehouse might tolerate RPO 24 h and RTO 2 days because it can be rebuilt from the source systems. Applying the ledger's requirements to everything multiplies cost for no benefit.

Cost rises steeply as both approach zero. A rough ladder, from cheapest to most expensive:

1. Nightly backups, restore by hand: RPO 24 h, RTO hours to a day.
2. Backups plus WAL archiving: RPO ~1 min, RTO hours.
3. Async replica in another AZ, manual promotion: RPO seconds, RTO 10-30 min.
4. Sync replica, automatic failover (RDS Multi-AZ, Patroni): RPO 0, RTO ~1 min, within a region.
5. Multi-region active-active with conflict handling (DynamoDB global tables, CockroachDB, Spanner): RPO ~0, RTO ~0, at the price of write latency, complexity and roughly double the infrastructure.

The design conversation is therefore: "Which rung can the business afford for this dataset?" RPO and RTO make that conversation concrete.`,
      mentalModel:
        'RPO is how often you save your document: save every 5 minutes and a crash costs you at most 5 minutes of typing. RTO is how long it takes to reopen the file and get back to work after the crash.',
      diagram: `   last good        disaster          service restored
   capture             |                     |
      |                |                     |
------+================+=====================+--------> time
      |<---- RPO ----->|<------- RTO ------->|
      data you lose      time you are down

RPO driven by: replication lag / WAL archive interval / backup freq
RTO driven by: detection + failover automation + restore throughput`,
      keyPoints: [
        'RPO = acceptable data loss in time; set by how often state is captured.',
        'RTO = acceptable downtime; set by detection, automation and restore throughput.',
        'Define RPO/RTO per dataset; the ledger and the analytics warehouse differ.',
        'Cost climbs steeply toward RPO 0 / RTO 0; pick the rung the business will pay for.',
      ],
      checkpoint: {
        question:
          'A payments database has RPO 0 and RTO 2 minutes. A team proposes an async cross-region replica with manual promotion. Does it meet the requirement?',
        answer:
          'No on both counts. Async replication means non-zero data loss on failover (RPO > 0), and manual promotion, including paging a human, rarely completes in 2 minutes (RTO missed). Meeting RPO 0 / RTO 2 min needs synchronous replication to the failover target plus automated, fenced failover, e.g. a sync standby in another AZ with Patroni or RDS Multi-AZ.',
      },
    },
    {
      id: 'failover',
      title: 'Failover: promoting a replica without making things worse',
      body: `Failover is the act of turning a replica into the new primary when the old one fails. It sounds simple; most self-inflicted database disasters happen here.

The sequence: **detect** that the primary is unhealthy (missed heartbeats or health checks for N seconds), **choose** the replica with the most up-to-date log position, **promote** it (Postgres \`pg_ctl promote\`, MySQL \`STOP REPLICA; RESET REPLICA ALL\`), **redirect** clients (update a DNS record, move a virtual IP, or update service discovery like Consul), and **fence** the old primary so it can never accept writes again.

**Why fencing matters.** The old primary may not be dead; it may be partitioned from the monitor while still reachable by some clients. If it keeps accepting writes while the new primary also accepts writes, you have **split brain**: two divergent histories that cannot be merged automatically. Fencing means the old node is forcibly demoted, its power is cut (STONITH: "shoot the other node in the head"), or its storage lease is revoked, before the new primary starts taking writes. Chapter 19 covers the leader-election machinery behind this.

**Automatic vs manual.** Automatic failover (RDS Multi-AZ, Aurora, Patroni for Postgres, MySQL Group Replication and Orchestrator, Redis Sentinel) achieves an RTO of 30-120 seconds. But a false positive, say a 20-second network blip, triggers a needless failover that itself causes downtime, and with async replication it may discard writes that the "failed" primary actually had. Manual failover avoids these but means a human is paged, investigates, and runs a runbook: 15-60 minutes. A common middle ground is automatic failover only when a quorum of observers agrees the primary is down, with a detection window long enough to ride out blips, and *manual* failover for cross-region moves where the blast radius is larger.

**Failback and client behaviour.** After failover the old primary, once repaired, must be rebuilt as a replica of the new one (its diverged writes are discarded or manually reconciled). Applications must handle the switch: connection pools should retry on failure and re-resolve the endpoint, writes in flight during the switch may have been lost, and read replicas must be re-pointed at the new primary. GitHub's 2018 incident, where a 43-second network partition caused an automatic cross-region failover and left the two regions with divergent writes for 24 hours of recovery, is the canonical case study.`,
      mentalModel:
        'Failover is handing the only set of car keys from a driver who fainted to the passenger. You must be sure the driver is really out (detection), pick the passenger who was paying most attention (most up-to-date replica), and take the keys away so the driver does not wake up and grab the wheel too (fencing).',
      diagram: `  1. detect            2. choose most        3. promote + redirect
                          advanced replica
[monitor]--X-->[P]     [R1] lsn=1050 <--    clients --> DNS/VIP --> [R1*]
   quorum says down    [R2] lsn=1042             ^
                                                 |
  4. FENCE old primary: STONITH / demote / revoke storage lease
     otherwise ---> [P] still taking writes = SPLIT BRAIN`,
      keyPoints: [
        'Failover = detect, choose most advanced replica, promote, redirect clients, fence old primary.',
        'Without fencing a partitioned old primary causes split brain.',
        'Automatic failover gives RTO ~1 min but risks false positives and lost async writes.',
        'Require quorum agreement and a tolerant detection window; keep cross-region failover manual.',
        'After failover, rebuild the old primary as a replica; clients must reconnect and re-resolve.',
      ],
    },
    {
      id: 'multi-az-multi-region',
      title: 'Multi-AZ and multi-region: choosing your blast radius',
      body: `Cloud providers organise capacity into **regions** (a geographic area such as ap-south-1 Mumbai) and **availability zones** (physically separate data centres within a region, typically 3 or more, kilometres apart, with independent power and networking, connected by low-latency fibre with round trips of 1-2 ms).

**Multi-AZ** places replicas in different zones within one region. Because latency is so low, **synchronous** replication is affordable: RDS Multi-AZ writes to both zones before acknowledging. A zone-level failure (power, cooling, a fibre cut, a bad deployment of the zone's network control plane) is survived with RPO 0 and automatic failover in about a minute. Cost is roughly 2x the single-instance price. For most businesses this is the default: AZ failures are rare but real, and the price of protection is modest.

**Multi-region** places replicas in different regions, hundreds or thousands of kilometres apart. This protects against a whole-region outage (the us-east-1 incidents of 2017, 2021 and 2023 took down large parts of the internet) and against regulatory or latency needs for serving users near their data. But cross-region round trips are 50-250 ms, so synchronous replication would make every write painfully slow and couple the regions' availability. Nearly all multi-region setups are therefore **asynchronous**, accepting an RPO of seconds and a manual or carefully gated failover. Topologies:

- **Active-passive (pilot light / warm standby).** One region serves; the other holds an async replica and minimal or scaled-down compute. Cheapest; RTO is minutes to an hour depending on how warm the standby is.
- **Active-active.** Both regions serve traffic, usually with users routed to the nearest region. Requires either partitioning writes by region (each user's data has a home region) or a multi-master store that resolves conflicts: DynamoDB global tables (last-writer-wins), Cassandra, CockroachDB or Spanner (consensus-based, paying the latency). Most complex, near-zero RTO.

The honest trade-off: multi-region roughly doubles infrastructure cost, adds significant engineering complexity (data residency, cache invalidation, conflict handling, testing failover), and protects against events that happen perhaps once every few years. Start with multi-AZ, add cross-region *backups* (cheap, protects the data even if not the uptime), and move to multi-region compute only when the availability requirement or regulation demands it.`,
      mentalModel:
        'Multi-AZ is keeping a spare key with a neighbour on the same street: quick to fetch, useless if the whole street floods. Multi-region is a spare key with your cousin in another city: survives the flood, but you will not get it in five minutes.',
      diagram: `Region ap-south-1 (Mumbai)                Region eu-central-1
+------------------------------------+    +------------------+
| AZ-a          AZ-b          AZ-c   |    | AZ-a             |
| [Primary] ==> [Sync R1]     [Async R2]  | [Async R3]       |
|   1-2 ms RTT  RPO 0                |    |   ~120 ms RTT    |
|   auto failover ~60 s              |    |   RPO ~seconds   |
+------------------------------------+    |   manual failover|
   backups ------------------------------> S3 (cross-region  |
                                           copy, immutable)  |
                                           +------------------+`,
      keyPoints: [
        'AZs are separate data centres in one region with 1-2 ms latency; regions are far apart with 50-250 ms.',
        'Multi-AZ affords synchronous replication and automatic failover; it is the sensible default.',
        'Multi-region is almost always async, so it trades RPO 0 for surviving a regional outage.',
        'Active-passive is cheaper and simpler; active-active needs write partitioning or conflict resolution.',
        'Cross-region backups are the cheap first step before multi-region compute.',
      ],
      checkpoint: {
        question:
          'Why do almost no systems run synchronous replication between regions, even when they could afford the extra servers?',
        answer:
          'Latency and coupling. A synchronous write must wait a 100+ ms round trip to the other region, so every transaction becomes at least that slow, and if the inter-region link degrades, writes in both regions stall. Spanner and CockroachDB do pay this cost for consensus, but they are designed around it; a normal Postgres or MySQL primary is not.',
      },
    },
    {
      id: 'raid',
      title: 'RAID: redundancy inside a single machine',
      body: `Before replicas and backups, there is redundancy at the disk level. **RAID** (Redundant Array of Independent Disks) combines several physical disks into one logical volume with some mix of performance and fault tolerance. You rarely configure RAID directly in the cloud (EBS and persistent disks replicate underneath), but the concepts are still asked about and still matter on bare metal and in storage systems.

- **RAID 0 (striping).** Data is split across disks in chunks. Reads and writes are faster (parallel disks) and you get the full capacity, but **any single disk failure loses everything**. Zero redundancy; use only for scratch data.
- **RAID 1 (mirroring).** Every write goes to two disks. Survives one disk failure with no rebuild complexity, reads can be served from either disk, but usable capacity is 50%.
- **RAID 5 (striping with distributed parity).** Data plus one parity block per stripe spread across N disks. Survives **one** disk failure; capacity is (N-1)/N. Writes are slower (read-modify-write of parity). The danger: rebuilding a failed disk on multi-terabyte drives takes hours to days and stresses the remaining disks; a second failure during rebuild loses the array. With modern disk sizes this is a real probability, which is why RAID 5 is increasingly avoided.
- **RAID 6 (double parity).** Like RAID 5 with two parity blocks; survives **two** simultaneous failures at the cost of another disk's capacity and slower writes. The standard for large capacity arrays.
- **RAID 10 (1+0).** Mirror pairs that are then striped. Survives one failure per mirror pair, fast reads and writes, simple rebuilds, but 50% capacity. The usual choice for database servers on bare metal.

RAID can be implemented in a hardware controller (with battery-backed write cache for performance and safety) or in software (Linux \`mdadm\`, ZFS RAID-Z, which also checksums data to catch silent corruption).

The essential limitation: RAID protects against **disk death** and nothing else. It does not protect against the server catching fire, the controller failing, a user deleting files, or corruption written through the array. Erasure coding, which S3 and Ceph use across machines and data centres, is the same parity idea generalised to survive many failures over a network (covered in Chapter 21).`,
      mentalModel:
        'RAID 1 is photocopying every page twice. RAID 5 is keeping one extra "checksum" page per chapter so you can reconstruct any one lost page. RAID 0 is tearing every page in half to read faster, and praying you never lose a half.',
      diagram: `RAID 0   [A1][A2]      stripe, no redundancy, 100% cap
RAID 1   [A ][A ]      mirror, 1 failure, 50% cap
RAID 5   [A1][A2][Ap]  1 parity, 1 failure, (N-1)/N cap
RAID 6   [A1][A2][Ap][Aq] 2 parity, 2 failures, (N-2)/N cap
RAID 10  [A ][A ] [B ][B ] striped mirrors, fast, 50% cap
         \\---/     \\---/
         mirror    mirror`,
      keyPoints: [
        'RAID 0 stripes for speed with no fault tolerance.',
        'RAID 1 mirrors; RAID 10 stripes mirrors and is the database default on bare metal.',
        'RAID 5 survives one disk, RAID 6 two; large-disk rebuild times make RAID 5 risky.',
        'RAID protects against disk failure only, never against deletion, fire or corruption.',
      ],
    },
    {
      id: 'restore-drills',
      title: 'Restore drills: a backup is only real once you have restored it',
      body: `Every organisation has backups. Far fewer have verified that those backups can be restored, and the gap between the two is where careers end.

The famous case is GitLab, January 2017. An engineer, trying to fix replication lag, accidentally ran \`rm -rf\` on the production Postgres data directory. The team then discovered that: the regular \`pg_dump\` backups had been silently failing for months because of a Postgres version mismatch and the failure emails went to spam; Azure disk snapshots were not enabled on the database servers; the LVM snapshots were taken once every 24 hours; and the S3 backup bucket was empty. They recovered from a 6-hour-old LVM snapshot taken by chance for a staging refresh, and lost about six hours of issues, merge requests and comments. Five backup mechanisms, none tested, none working.

What a working practice looks like:

**Automate restore verification.** On a schedule (nightly or weekly), restore the latest backup into a fresh instance, run integrity checks (row counts, checksums, \`pg_amcheck\`, application smoke tests) and alert if anything fails. Netflix and many others treat "backup restored successfully" as the metric, not "backup job completed".

**Measure the real RTO.** Time the drill end to end. If restoring 2 TB from S3 takes 3 hours plus 40 minutes of WAL replay, your RTO is not "1 hour" no matter what the document says. Options to shrink it: keep a warm replica, use snapshot-based restores that lazy-load blocks (EBS, Aurora clones), or shard so each restore is smaller.

**Rehearse the whole scenario, not just the database.** A game day where the primary region is declared dead surfaces the things outside the database: DNS TTLs of 24 hours, secrets that only exist in the dead region, the deploy pipeline that depends on the region's artifact store, the runbook that references a departed engineer's laptop.

**Monitor the backups themselves.** Alert on backup age (no successful backup in 26 hours), size anomalies (a backup suddenly 90% smaller), and WAL archive lag. Route those alerts to the same paging channel as production incidents.

**Protect backups from the people and systems that can destroy production.** Separate AWS account, separate credentials, S3 Object Lock or Backup Vault Lock, MFA delete. The blast radius of a compromised production credential should stop at production.`,
      mentalModel:
        'A fire drill is not reading the evacuation plan. It is walking the route, finding the locked door nobody knew about, and timing how long it really takes to get everyone out.',
      keyPoints: [
        'Untested backups fail silently; GitLab 2017 had five mechanisms and zero working ones.',
        'Automate restore-and-verify on a schedule; alert on failure and on backup age.',
        'Measure real end-to-end RTO including transfer time and log replay.',
        'Game days expose dependencies outside the database (DNS, secrets, pipelines).',
        'Isolate backups in a separate account with immutability so production credentials cannot destroy them.',
      ],
      checkpoint: {
        question:
          'Your monitoring shows the nightly backup job exiting with code 0 every day for a year. Why is this insufficient evidence that you can recover?',
        answer:
          'Exit code 0 shows the job ran, not that it produced a usable artifact: the dump may be empty, truncated, from the wrong version, encrypted with a key that has since rotated, or written to a bucket with a lifecycle rule deleting it after 7 days. Only an actual restore with integrity checks proves recoverability, and only timing that restore tells you the true RTO.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What does RPO (Recovery Point Objective) measure?',
      options: [
        'How long the system may be unavailable after a failure',
        'How much data, expressed as a time window, may be lost after a failure',
        'How many replicas are required',
        'How often full backups must be taken',
      ],
      answerIndex: 1,
      explanation:
        'RPO is the acceptable data loss window (e.g. 5 minutes of writes). Downtime is RTO. Replica count and backup frequency are means of achieving an RPO, not the definition.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'A team has three synchronous replicas across three availability zones. An engineer runs DROP TABLE users in production. What protects them?',
      options: [
        'The synchronous replicas, which still hold the table',
        'The availability zones, because the drop only affects one zone',
        'Only a backup or point-in-time recovery taken before the drop',
        'RAID 10 on the primary',
      ],
      answerIndex: 2,
      explanation:
        'Synchronous replication faithfully applies the DROP on every replica within milliseconds. Zones and RAID protect against hardware failure, not logical errors. Only an isolated, earlier copy (backup + WAL replay to just before the drop) can recover the table.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'What is the main disadvantage of fully synchronous replication?',
      options: [
        'It can lose the last few seconds of writes on failover',
        'Every write waits for the replica, adding latency, and a replica outage can stall all writes',
        'It cannot be used within a single region',
        'It requires more disk space than asynchronous replication',
      ],
      answerIndex: 1,
      explanation:
        'Sync replication gives RPO 0 precisely because the primary waits; the price is added latency per write and coupling of write availability to replica health. Losing recent writes is the asynchronous failure mode.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which components are needed for point-in-time recovery (PITR) in Postgres or MySQL? Select all that apply.',
      options: [
        'A base (full) backup',
        'Continuously archived WAL / binlog segments',
        'A synchronous replica',
        'A target timestamp or transaction id to stop at',
        'RAID 6 on the primary',
      ],
      answerIndices: [0, 1, 3],
      explanation:
        'PITR restores a base backup and replays the archived log up to a chosen point. Replicas and RAID are redundancy mechanisms and play no role in reconstructing an earlier state.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 1,
      statement: 'RAID 5 can survive the simultaneous failure of two disks in the array.',
      answer: false,
      explanation:
        'RAID 5 has one parity block per stripe and survives exactly one disk failure. RAID 6 adds a second parity and survives two. The long rebuild time of large disks makes a second failure during rebuild a real risk for RAID 5.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'An orders database must have RPO 0 and RTO under 2 minutes for a single-AZ failure, and RPO under 1 minute for a full regional failure. Which design meets this at the lowest cost?',
      options: [
        'Nightly full backups copied to another region',
        'A synchronous replica in a second AZ with automatic fenced failover, plus an asynchronous replica or continuous WAL archiving in another region',
        'Synchronous replicas in two regions with automatic failover',
        'Three asynchronous replicas in the same AZ',
      ],
      answerIndex: 1,
      explanation:
        'Sync in-region replica + automated failover gives RPO 0 / RTO ~1 min for AZ loss. Async cross-region replication or WAL shipping gives RPO of seconds for regional loss without paying cross-region sync latency on every write. Option C meets it but at a large latency and cost penalty; A and D fail the requirements.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'Why is fencing the old primary essential during failover?',
      options: [
        'It speeds up the promotion of the replica',
        'It prevents a partitioned but still-alive old primary from accepting writes and causing split brain',
        'It copies the remaining WAL to the new primary',
        'It reduces replication lag',
      ],
      answerIndex: 1,
      explanation:
        'A primary that looks dead to the monitor may still be reachable by some clients. If both nodes accept writes, histories diverge irreconcilably. Fencing (demote, power off, revoke storage) guarantees a single writer before the new primary takes over.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 2,
      statement: 'Most multi-region database deployments use asynchronous replication between regions.',
      answer: true,
      explanation:
        'Cross-region round trips are 50-250 ms, so synchronous replication would slow every write and couple the regions\' availability. Async replication accepts an RPO of seconds in exchange. Consensus databases like Spanner are the notable exception and are designed around that latency.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 2,
      question: 'What is the primary lesson of the GitLab 2017 database incident?',
      options: [
        'Never use Postgres for production workloads',
        'Backups that are never restored cannot be trusted; multiple untested mechanisms all failed at once',
        'Replication lag should always be zero',
        'LVM snapshots are superior to logical dumps',
      ],
      answerIndex: 1,
      explanation:
        'GitLab had pg_dump backups (silently failing), disk snapshots (not enabled), LVM snapshots (24 h old) and an S3 bucket (empty). None had been verified by restore. The lesson is to automate restore verification and monitor backup health, not a specific tool choice.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 3,
      question:
        'A restore drill shows recovering the 4 TB database from S3 takes 5 hours of transfer plus 1 hour of WAL replay, but the documented RTO is 1 hour. Which change most directly closes the gap?',
      options: [
        'Take incremental backups more frequently',
        'Switch from RAID 5 to RAID 10',
        'Maintain a warm replica (or snapshot-based lazy-loading restore) so recovery does not depend on bulk transfer',
        'Reduce the WAL archive interval to 10 seconds',
      ],
      answerIndex: 2,
      explanation:
        'RTO here is dominated by moving 4 TB. A standing replica or block-lazy-loading snapshot (EBS, Aurora clone) removes the transfer. More frequent incrementals and shorter WAL intervals improve RPO, not RTO; RAID level is irrelevant to restore time.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design a backup and recovery plan for a 1 TB Postgres database powering an e-commerce checkout. The business requires RPO 1 minute and RTO 30 minutes for data corruption or accidental deletion, and 7-year retention for audit. State your components and back-of-envelope numbers.',
      modelAnswer: `**Base backups:** weekly full \`pg_basebackup\` (or daily incremental snapshots via pgBackRest/WAL-G) to S3 in a separate AWS account, encrypted. 1 TB at ~200 MB/s is about 90 minutes to take, run off a replica so the primary is unaffected.

**Continuous WAL archiving** to the same bucket with a 30-second archive timeout. This makes the RPO for corruption or deletion at most ~30-60 seconds, meeting RPO 1 minute.

**RTO 30 min:** a cold restore of 1 TB from S3 (~90 min transfer + replay) misses the target. So keep a **delayed replica** (\`recovery_min_apply_delay = '1h'\`) that lags the primary by an hour: for a bad DELETE at 14:32, stop the delayed replica, roll it forward to 14:31 using archived WAL, and promote or extract the affected rows, all in well under 30 minutes. Alternatively use snapshot-based lazy-loading restores.

**Retention:** 35 days of WAL and daily backups online for PITR; monthly fulls transitioned to S3 Glacier Deep Archive for 7 years (1 TB x 84 months is ~84 TB, roughly 84 USD/month at Deep Archive prices). S3 Object Lock in compliance mode on the audit copies.

**Verification:** nightly automated restore of the latest backup into a scratch instance with row-count and checksum comparison, alerting on failure and on backup age > 26 h. Quarterly game day rehearsing the full runbook and recording the measured RTO.`,
      rubric: [
        'Includes base backups plus continuous WAL archiving and links the archive interval to the 1-minute RPO.',
        'Recognises that a cold 1 TB restore misses a 30-minute RTO and proposes a delayed replica or lazy-loading snapshots.',
        'Addresses 7-year retention with a cold tier and immutability.',
        'Stores backups in a separate account/region, encrypted.',
        'Includes automated restore verification and monitoring.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain the difference between redundancy and recovery, and give one failure that each handles but the other does not.',
      modelAnswer: `**Redundancy** keeps the system serving when a component fails, by having spare copies or capacity ready: replicas, RAID, multiple availability zones. It is measured as availability.

**Recovery** restores correct data after it has been lost or corrupted, using copies frozen at an earlier point in time: backups, archived WAL, point-in-time recovery. It is measured by RPO (how much you lose) and RTO (how long it takes).

A failure redundancy handles but recovery does not: a primary server dies at 3 a.m.; a replica is promoted in a minute and users barely notice, while restoring from backup would take an hour and lose data.

A failure recovery handles but redundancy does not: an engineer runs an UPDATE without a WHERE clause; every replica applies it instantly, but a backup plus WAL replay to one second before the command restores the correct values.`,
      rubric: [
        'Defines redundancy as surviving component failure without downtime.',
        'Defines recovery as restoring earlier correct data.',
        'Gives a hardware failure handled by redundancy.',
        'Gives a logical/human error handled only by recovery, noting replication propagates it.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 1,
      question: 'What is the 3-2-1 backup rule, and what modern addition protects against ransomware?',
      modelAnswer: `Keep **3** copies of your data (production plus two backups), on **2** different media or systems (e.g. local snapshot and object storage), with **1** copy offsite (another region or another provider) so a site-level disaster does not destroy all copies.

The modern addition is **immutability and isolation**: at least one copy should be write-once (S3 Object Lock, Backup Vault Lock, or a separate account with distinct credentials and MFA delete). Ransomware and compromised credentials typically delete or encrypt backups first; an immutable copy in a separate account cannot be touched even by a fully compromised production environment.`,
      rubric: [
        'States 3 copies, 2 media/systems, 1 offsite.',
        'Explains why offsite matters.',
        'Mentions immutability (Object Lock) and/or account isolation as ransomware protection.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Redundancy vs recovery', back: 'Redundancy: keep serving through component failure (replicas, RAID, multi-AZ). Recovery: restore correct data after loss or corruption (backups, WAL, PITR). Replication is not a backup.' },
    { id: 'f2', front: 'RPO', back: 'Recovery Point Objective: maximum acceptable data loss expressed as time (e.g. 5 min). Driven by replication lag, WAL archive interval, or backup frequency.' },
    { id: 'f3', front: 'RTO', back: 'Recovery Time Objective: maximum acceptable downtime. Driven by detection speed, failover automation, and restore throughput (transfer + log replay).' },
    { id: 'f4', front: 'Synchronous replication', back: 'Primary waits for replica to durably ack before committing. RPO 0, but +1 network RTT per write and a replica outage can stall writes. Postgres synchronous_commit=on.' },
    { id: 'f5', front: 'Asynchronous replication', back: 'Primary commits locally, ships changes later. Fastest writes, replica never blocks primary, but replica lag = data lost on failover (RPO > 0).' },
    { id: 'f6', front: 'Semi-synchronous replication', back: 'Wait for ack from at least one (or quorum) of N replicas. RPO 0 as long as an acking replica survives; one slow replica does not block. MySQL semisync, Postgres ANY 1 (...).' },
    { id: 'f7', front: 'Full vs incremental vs differential backup', back: 'Full: complete copy. Incremental: changes since last backup (long restore chain). Differential: changes since last full (restore = full + one differential).' },
    { id: 'f8', front: 'Write-ahead log (WAL)', back: 'Append-only record of every change written before data files are modified. Postgres WAL, MySQL binlog, Oracle redo log, Mongo oplog. Archiving it continuously enables PITR.' },
    { id: 'f9', front: 'Point-in-time recovery (PITR)', back: 'Restore latest base backup, then replay archived WAL/binlog up to a target timestamp or transaction just before the bad event. RPO = archive interval (seconds).' },
    { id: 'f10', front: 'Failover steps', back: 'Detect (quorum of health checks) -> choose most advanced replica -> promote -> redirect clients (DNS/VIP/discovery) -> fence old primary -> rebuild old primary as replica.' },
    { id: 'f11', front: 'Why fence the old primary?', back: 'It may be partitioned, not dead, and still accepting writes. Two writers = split brain with irreconcilable histories. Fence via demote, STONITH power-off, or storage lease revocation.' },
    { id: 'f12', front: 'Automatic vs manual failover trade-off', back: 'Automatic: RTO ~1 min, but false positives cause needless failovers and async writes can be lost. Manual: safe, but 15-60 min RTO. Common: auto in-region with quorum, manual cross-region.' },
    { id: 'f13', front: 'Multi-AZ vs multi-region', back: 'AZ: separate DCs in one region, 1-2 ms RTT, sync replication feasible, ~2x cost. Region: 50-250 ms RTT, almost always async, survives regional outage, roughly doubles cost and complexity.' },
    { id: 'f14', front: 'Active-passive vs active-active multi-region', back: 'Active-passive: one region serves, other holds async replica; cheaper, RTO minutes+. Active-active: both serve; needs write partitioning by home region or conflict resolution (DynamoDB global tables, Spanner).' },
    { id: 'f15', front: 'RAID levels summary', back: 'RAID 0 stripe (no redundancy). RAID 1 mirror (1 failure, 50% cap). RAID 5 one parity (1 failure). RAID 6 two parity (2 failures). RAID 10 striped mirrors (DB default on bare metal).' },
    { id: 'f16', front: 'What RAID does not protect against', back: 'Deletion, corruption written through the array, controller failure, fire, theft. It only protects against disk death. Large-disk rebuild times make RAID 5 risky.' },
    { id: 'f17', front: '3-2-1 rule plus immutability', back: '3 copies, 2 different media/systems, 1 offsite. Add: one copy immutable (S3 Object Lock) in a separate account so compromised production credentials cannot destroy backups.' },
    { id: 'f18', front: 'GitLab 2017 lesson', back: 'rm -rf on prod Postgres; pg_dump failing silently for months, snapshots disabled, S3 bucket empty. Recovered from a 6 h old LVM snapshot. Lesson: automate restore verification, monitor backup age.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Why replication is not a backup',
      prompt: 'A colleague says "we have three replicas in three zones, we do not need backups". Explain to them why that is wrong and what a backup adds.',
      modelExplanation: `Replicas are copies that follow the primary as closely as possible. That is exactly their job, and exactly the problem. Whatever happens on the primary happens on the replicas a few milliseconds later, including the things you did not mean to do.

If a server dies, replicas save you: another copy takes over. But if someone runs a DELETE without a WHERE clause, or a migration rewrites a column wrongly, or an attacker with our credentials drops the database, all three replicas execute the same command faithfully. Three perfect copies of the wrong data.

A backup is different because it is frozen in time and kept away from the live system. It is a photograph of the database from last night, plus a continuous recording of every change since (the write-ahead log). With those two things you can rebuild the database exactly as it was one second before the bad command. Replicas protect against hardware failure; backups protect against humans, software and attackers. You need both.`,
      mustMention: [
        'Replicas apply every change from the primary, including mistakes',
        'A backup is isolated and frozen at a point in time',
        'WAL archiving allows recovery to a specific second',
        'Different failure classes: hardware vs logical/malicious',
      ],
    },
    {
      id: 'fe2',
      concept: 'RPO and RTO',
      prompt: 'Explain RPO and RTO to a product manager who keeps saying "we can never lose data or go down", and show how the numbers drive cost.',
      modelExplanation: `Two numbers turn "never" into something we can build and price.

**RPO** is how much data you are willing to lose, measured in time. If we copy the data every night, a disaster at 5 p.m. loses the whole day: RPO 24 hours. If we stream every change to another machine as it happens and wait for confirmation before saying "saved", we lose nothing: RPO zero. In between, shipping the change log every 30 seconds gives RPO 30 seconds.

**RTO** is how long we are down before service is restored. If a human has to be paged, find the backup and rebuild the server, that is hours. If a standby machine is already running and takes over automatically, that is about a minute.

Each step toward zero costs more: an extra machine in another data centre, slower writes because we wait for confirmation, engineers rehearsing failovers. So the real question is: for *this* data, orders versus analytics, how many minutes of loss and downtime can the business tolerate? Then we buy exactly that much protection.`,
      mustMention: [
        'RPO is data loss measured in time',
        'RTO is downtime',
        'Examples tying mechanisms (nightly backup, sync replica) to numbers',
        'Cost rises as both approach zero',
        'Set per dataset, not globally',
      ],
    },
    {
      id: 'fe3',
      concept: 'Point-in-time recovery',
      prompt: 'Explain how point-in-time recovery works using the write-ahead log, to a developer who has only ever taken database dumps.',
      modelExplanation: `A dump is a snapshot: the whole database as of 2 a.m. If something goes wrong at 4 p.m., restoring the dump throws away 14 hours of legitimate work along with the mistake.

Databases like Postgres and MySQL keep a special file called the write-ahead log (or binlog). Before any change touches the data files, it is written to this log, in order. The database uses it to recover after a crash. If we also copy every completed log segment to S3 as soon as it fills, say every 30 seconds, we have a complete recording of every change since the last dump.

Point-in-time recovery combines the two: restore the 2 a.m. dump, then replay the log forward, change by change, and tell it to stop at 3:59:59 p.m., one second before the bad command. Everything legitimate is back; the mistake never happens. The data lost is at most the last 30 seconds, and we did not need to take a dump every minute to get there.`,
      mustMention: [
        'A dump alone loses everything since it was taken',
        'WAL records every change in order before it is applied',
        'Continuous archiving of log segments to durable storage',
        'Restore base + replay log to a chosen stopping point',
        'RPO becomes the archive interval',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You tour a bank vault complex: from the twin-engined armoured van outside, through the counting room and the vault door, down to the underground archive, ending at the fire-drill assembly point in the car park.',
    stops: [
      { locus: 'The armoured van with two engines', concept: 'Redundancy vs recovery', image: 'The van roars on two engines; one coughs and dies and the van keeps rolling. But the driver is following a forged map, and both engines carry it confidently to the wrong address. Spare engines do not fix bad data.' },
      { locus: 'The counting room with three clerks', concept: 'Sync, async and semi-sync replication', image: 'Clerk one will not stamp a deposit until a colleague across the room has copied it and shouted DONE (sync). Clerk two stamps instantly and tosses copies into a pneumatic tube that sometimes jams (async). Clerk three waits for any one of three colleagues to shout back (semi-sync).' },
      { locus: 'The photocopier and the security camera', concept: 'Full backups and the WAL', image: 'A photocopier the size of a car spits out a full copy of the ledger every Sunday, groaning. Beside it, a security camera never blinks, recording every pen stroke onto tapes labelled by the second and couriered to a bunker.' },
      { locus: 'The rewind desk', concept: 'Point-in-time recovery', image: 'A clerk loads Sunday\'s photocopy, then plays the camera tape forward at high speed, pen strokes reappearing on the page, and slams the STOP button one second before a hand is seen scribbling DELETE across the ledger.' },
      { locus: 'The two dials on the vault door', concept: 'RPO and RTO', image: 'Two enormous brass dials: the left marked "minutes of money you may lose", the right "minutes the vault may stay shut". Every notch toward zero on either dial makes the door heavier and a cash register chimes.' },
      { locus: 'The manager\'s office with the key handover', concept: 'Failover and fencing', image: 'The manager collapses; a deputy grabs the single master key. A guard immediately handcuffs the unconscious manager\'s hand so that if he wakes confused he cannot also open the vault. Two people with the key would be split brain.' },
      { locus: 'The branch across the street and the branch overseas', concept: 'Multi-AZ vs multi-region', image: 'Across the street a twin branch mirrors every transaction with a shout, instant. Overseas, a branch receives copies by airmail that arrives minutes late; cheaper than a transatlantic telephone line held open for every deposit.' },
      { locus: 'The underground archive with parity ledgers', concept: 'RAID', image: 'Rows of ledgers. In one aisle every ledger is doubled (RAID 1). In another, each shelf of five has a sixth ledger of checksums that can regenerate any one missing volume (RAID 5), and the archivist mutters that regenerating takes all night and pray nothing else falls.' },
      { locus: 'The fire-drill assembly point in the car park', concept: 'Restore drills', image: 'Staff stand shivering in the car park with a stopwatch while an auditor actually rebuilds the ledger from the bunker tapes. A framed GitLab incident report hangs on the fence: five backup plans, zero working.' },
    ],
  },
  interviewQuestions: [
    'Why is database replication not a substitute for backups? Give a failure that replication makes worse.',
    'Compare synchronous, asynchronous and semi-synchronous replication. Which would you choose for a payments ledger and why?',
    'Explain point-in-time recovery. What is the RPO of a system with nightly base backups and WAL archived every 60 seconds?',
    'Define RPO and RTO and describe an architecture for RPO 0 / RTO 1 minute within a region. What changes for cross-region?',
    'Walk through a database failover. What is split brain and how do you prevent it?',
    'When is multi-region worth its cost? What is the cheaper intermediate step?',
    'What do RAID 5, 6 and 10 protect against, and what do they not protect against?',
    'How would you verify that your backups actually work, and how would you measure your real RTO?',
  ],
}

export default chapter
