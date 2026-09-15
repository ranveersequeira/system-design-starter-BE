import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 5,
  slug: 'database-isolation-levels',
  title: 'Database Isolation Levels',
  module: 'databases',
  estimatedMinutes: 40,
  summary:
    'Isolation is the I in ACID, and it is the one guarantee databases quietly weaken by default for performance. This chapter explains the anomalies concurrent transactions can produce (dirty, non-repeatable and phantom reads, lost updates, write skew), the four SQL isolation levels that trade them against throughput, how MVCC and locks implement those levels, and what Postgres and MySQL actually do out of the box, so you can pick the level, or the explicit lock, that makes your critical paths correct.',
  objectives: [
    'Define dirty reads, non-repeatable reads, phantom reads, lost updates and write skew with a concrete two-transaction example of each.',
    'Explain what each isolation level (read uncommitted, read committed, repeatable read, serializable) permits and prevents, and its performance cost.',
    'Describe how MVCC gives readers a snapshot without blocking writers, and what garbage it leaves behind.',
    'Use explicit locks (SELECT FOR UPDATE, gap locks) and understand deadlocks.',
    'State the real default isolation levels of Postgres and MySQL and how their implementations differ from the SQL standard.',
  ],
  quickRevision: [
    'Isolation levels trade anomalies for throughput: read uncommitted < read committed < repeatable read < serializable.',
    'Dirty read: seeing another transaction\'s uncommitted write. Prevented from read committed upward.',
    'Non-repeatable read: the same row read twice in one transaction returns different values because another transaction committed in between. Prevented from repeatable read upward.',
    'Phantom read: the same range query returns different rows because another transaction inserted or deleted. Prevented by serializable (and by snapshot isolation in Postgres RR; by gap locks in InnoDB RR).',
    'Lost update: two transactions read-modify-write the same row; the second overwrites the first. Fix: atomic UPDATE SET x = x + 1, SELECT FOR UPDATE, or optimistic version checks.',
    'Write skew: two transactions read overlapping data, each writes a different row, and the combination violates an invariant (two doctors both go off-call). Only serializable prevents it.',
    'MVCC: writers create new row versions instead of overwriting; each transaction reads the versions visible in its snapshot. Readers never block writers and writers never block readers.',
    'MVCC garbage: Postgres dead tuples cleaned by VACUUM; InnoDB undo log purged. Long transactions block cleanup.',
    'Postgres default: READ COMMITTED (new snapshot per statement). REPEATABLE READ = snapshot isolation (per-transaction snapshot, no phantoms). SERIALIZABLE = SSI, aborts with 40001, retry required.',
    'MySQL InnoDB default: REPEATABLE READ with consistent snapshot for plain reads plus gap and next-key locks on locking reads to block phantoms.',
    'Postgres treats READ UNCOMMITTED as READ COMMITTED; dirty reads are impossible in Postgres.',
    'SELECT ... FOR UPDATE takes an exclusive row lock so a read-then-write sequence is safe; FOR SHARE blocks writers but allows other readers.',
    'Deadlock: two transactions each wait on the other\'s lock; the engine detects it and aborts one. Fix by locking rows in a consistent order and keeping transactions short.',
    'Rule: use the default for most work, FOR UPDATE or atomic updates for read-modify-write hot spots, and SERIALIZABLE with retries for invariants spanning multiple rows.',
  ],
  sections: [
    {
      id: 'anomalies',
      title: 'What can go wrong when transactions overlap',
      body: `If transactions ran one at a time, isolation would be free and trivial. They do not: a busy Postgres runs hundreds of transactions concurrently, interleaving their statements. Isolation levels are precise definitions of which interleavings are allowed to become visible. To understand them you must first know the anomalies they are defined against.

**Dirty read.** T1 updates a balance from 100 to 50 but has not committed. T2 reads 50. T1 rolls back. T2 acted on a value that never existed.

**Non-repeatable read.** T1 reads a product price: 10. T2 updates it to 12 and commits. T1 reads the same row again: 12. Within one transaction the same row changed under T1's feet. A report that sums a column twice gets two answers.

**Phantom read.** T1 runs \`SELECT COUNT(*) FROM orders WHERE user_id = 7\` and gets 3. T2 inserts a fourth order for user 7 and commits. T1 runs the same query: 4. No existing row changed; a new row appeared in the range. The distinction from non-repeatable read matters because preventing phantoms requires locking a *range* or a predicate, not individual rows.

**Lost update.** T1 and T2 both read a counter at 10, both compute 11, both write 11. One increment is lost. This is the read-modify-write race and it is the most common real-world isolation bug, because it happens at read committed, the default in Postgres.

**Write skew.** A hospital rule: at least one doctor on call. Alice and Bob are both on call. T1 (Alice) checks "count on call >= 2", sees 2, sets Alice off. T2 (Bob) concurrently checks, also sees 2, sets Bob off. Both commit. Nobody is on call. Each transaction read a set and wrote a *different* row, so no row-level conflict occurred, yet the invariant broke. Only true serializability, or an explicit lock on the shared predicate, prevents this. Other write-skew examples: double-booking a meeting room, two users claiming the same username via check-then-insert without a unique constraint, overspending a shared budget.

The SQL standard defines isolation levels by which of the first three anomalies they forbid. Lost updates and write skew fall outside the standard's table but are the ones that cost real money.`,
      mentalModel:
        'Two accountants editing the same paper ledger. Dirty read: copying a number written in pencil before it is confirmed. Non-repeatable read: a line changes between your two glances. Phantom: a new line appears. Lost update: both erase and write over the same cell. Write skew: each signs off a different page, and together they break the rule on the cover.',
      diagram: `Lost update (read committed):
 T1: SELECT qty -> 10                 T2: SELECT qty -> 10
 T1: UPDATE qty = 10 - 1 = 9
 T1: COMMIT                           T2: UPDATE qty = 10 - 1 = 9
                                      T2: COMMIT     -> one sale lost

Write skew (snapshot isolation):
 invariant: on_call >= 1;  Alice, Bob both on call
 T1: count on_call -> 2               T2: count on_call -> 2
 T1: Alice off                        T2: Bob off
 T1: COMMIT                           T2: COMMIT     -> on_call = 0`,
      keyPoints: [
        'Dirty, non-repeatable and phantom reads are the three anomalies the SQL standard grades levels by.',
        'Phantoms are about ranges, so preventing them needs range or predicate locking, not row locking.',
        'Lost updates (read-modify-write races) are the most common bug and occur at the common default levels.',
        'Write skew breaks multi-row invariants with no row conflict; only serializable or explicit locking prevents it.',
      ],
      checkpoint: {
        question:
          'Two users simultaneously register the username "neo". The code does SELECT to check it is free, then INSERT. Which anomaly is this, and what is the simplest fix?',
        answer:
          'Write skew (check-then-act on a predicate). Both selects see "free", both insert. Simplest fix: a UNIQUE constraint on username so the database itself rejects the second insert; the application catches the unique violation. Serializable isolation would also catch it but the constraint is cheaper and clearer.',
      },
    },
    {
      id: 'read-uncommitted-committed',
      title: 'Read uncommitted and read committed',
      body: `**Read uncommitted** is the weakest level: a transaction may see rows another transaction has written but not yet committed. It permits dirty reads, non-repeatable reads and phantoms. The supposed benefit is that readers never wait for writers. In MVCC databases that benefit is already delivered at higher levels without dirty reads, so Postgres simply does not implement it: asking for READ UNCOMMITTED gives you READ COMMITTED. MySQL InnoDB does implement it, and SQL Server's \`NOLOCK\` hint is effectively this level; both are occasionally used for rough analytics where seeing an in-flight row is acceptable, and almost never appropriate for application logic.

**Read committed** guarantees you only see committed data. It is the default in Postgres, Oracle and SQL Server, and it is what most application code has been written against, usually without the authors knowing it.

How Postgres implements it: **each statement gets a fresh snapshot** of the database as of the moment the statement started. Within the statement you see a consistent view; between statements of the same transaction you may see new commits. So:

- No dirty reads: uncommitted versions are invisible.
- Non-repeatable reads possible: two SELECTs in one transaction can return different values for the same row.
- Phantoms possible: a repeated range query can return new rows.
- Lost updates possible via read-then-write: SELECT 10, then UPDATE ... SET qty = 9 blindly.

One important nuance for writes: when an UPDATE at read committed finds a row that a concurrent transaction has modified and committed, Postgres re-evaluates the WHERE clause against the *new* version and applies the update to it. So \`UPDATE accounts SET balance = balance - 100 WHERE id = 1\` is safe against lost updates even at read committed, because the arithmetic runs on the latest committed value under a row lock. The danger is only when the application reads a value into a variable and writes it back.

Why it is the default: high concurrency with no read blocking, no serialization failures to retry, and sensible behaviour for the vast majority of single-statement operations. The cost is that any multi-statement logic depending on a stable view of data must protect itself with \`SELECT ... FOR UPDATE\`, atomic single-statement updates, or a higher isolation level.`,
      mentalModel:
        'Read uncommitted is reading someone\'s draft over their shoulder before they hit send. Read committed is reading only sent emails, but each time you check the inbox you may find new ones.',
      diagram: `Read committed in Postgres: a snapshot per STATEMENT
 T1: BEGIN
 T1: SELECT price -> 10        (snapshot A)
                                    T2: UPDATE price = 12; COMMIT
 T1: SELECT price -> 12        (snapshot B)   non-repeatable read
 T1: UPDATE t SET price = price + 1
     -> waits for T2 lock, re-reads latest committed (12), writes 13
        atomic update is safe; SELECT-then-write-back is not`,
      keyPoints: [
        'Read uncommitted permits dirty reads; Postgres does not implement it (treated as read committed).',
        'Read committed: only committed data, snapshot per statement; default in Postgres, Oracle, SQL Server.',
        'Non-repeatable reads, phantoms and read-modify-write lost updates remain possible at read committed.',
        'Single-statement atomic updates (SET x = x - 1) are safe at read committed; read into a variable and write back is not.',
      ],
      checkpoint: {
        question:
          'At read committed, is UPDATE accounts SET balance = balance - 50 WHERE id = 1 AND balance >= 50 safe against overdraft when two such updates race? Explain.',
        answer:
          'Yes. The second UPDATE blocks on the row lock held by the first; when the first commits, the second re-evaluates the WHERE clause on the newly committed version. If the balance is now below 50 the predicate fails and zero rows are updated. The check and the write are one atomic statement, so there is no window between them.',
      },
    },
    {
      id: 'repeatable-read',
      title: 'Repeatable read and snapshot isolation',
      body: `**Repeatable read** promises that if a transaction reads a row, later reads of that row in the same transaction return the same value. The SQL standard still allows phantoms at this level, but the two major open-source engines both do better than the standard requires, in different ways.

**Postgres: repeatable read is snapshot isolation.** The transaction takes **one snapshot at its first statement** and every read in the transaction sees the database as of that instant, no matter what commits in the meantime. This gives you repeatable reads *and* no phantoms: a repeated range query returns the same rows because new rows are simply not in your snapshot. Reports, backups (\`pg_dump\`) and any multi-statement read that needs a consistent view use this level.

Writes at this level get a **first-committer-wins** rule. If your transaction tries to UPDATE a row that another transaction modified and committed after your snapshot was taken, Postgres aborts yours with \`ERROR: could not serialize access due to concurrent update\` (SQLSTATE 40001). This prevents lost updates on rows you write, at the cost of the application having to retry. What it does *not* prevent is **write skew**: two transactions reading overlapping rows and writing disjoint rows both commit happily, because neither touched a row the other wrote. The on-call doctors example passes at Postgres repeatable read.

**MySQL InnoDB: repeatable read is the default**, and it is a hybrid. Plain \`SELECT\`s read from a consistent snapshot established at the first read, like Postgres. But **locking reads** (\`SELECT ... FOR UPDATE\`, \`FOR SHARE\`, and the reads done internally by UPDATE and DELETE) read the *latest committed* data and take **next-key locks**: a lock on the row plus the gap before it in the index. Gap locks block other transactions from inserting into the locked range, which is how InnoDB prevents phantoms for locking reads. The price is more lock contention and more deadlocks than read committed, which is why high-concurrency MySQL shops (and MySQL's own docs for some workloads) often switch to READ COMMITTED, where gap locking is largely disabled.

One subtle InnoDB behaviour to remember: because plain reads use the snapshot but writes see the latest data, a transaction can SELECT a row (old version), then UPDATE it (applied to the new version), then SELECT again and see its own update on top of data it never read. This is not a bug but it surprises people.

When to use repeatable read: multi-statement reads that must be self-consistent (reports, exports, invariant checks you will act on), and situations where you want the database to detect concurrent updates to rows you modify.`,
      mentalModel:
        'Snapshot isolation hands you a photograph of the database taken the moment you start; you work entirely from the photo. Anyone else can keep rearranging the room, and you will not notice until you try to move a chair they already moved, at which point Postgres says "take a new photo and try again".',
      diagram: `Postgres REPEATABLE READ = one snapshot for the whole transaction
 T1: BEGIN; SELECT count(*) WHERE user=7 -> 3     (snapshot taken)
                                  T2: INSERT order for user 7; COMMIT
 T1: SELECT count(*) WHERE user=7 -> 3            no phantom
 T1: UPDATE orders SET ... WHERE id = <row T2 changed>
     -> ERROR 40001 could not serialize (first committer wins)

InnoDB REPEATABLE READ: snapshot for plain SELECT,
                        next-key (row + gap) locks for FOR UPDATE / UPDATE`,
      keyPoints: [
        'Postgres RR = snapshot isolation: one snapshot per transaction, no non-repeatable reads, no phantoms.',
        'Postgres RR aborts a write to a row changed since the snapshot (40001); retry logic is mandatory.',
        'Snapshot isolation still allows write skew.',
        'InnoDB RR: snapshot for plain reads, next-key/gap locks on locking reads to block phantoms; more contention and deadlocks.',
        'Use RR for consistent multi-statement reads and exports.',
      ],
      checkpoint: {
        question:
          'Under Postgres REPEATABLE READ, T1 reads all rows WHERE on_call = true (2 rows) and updates Alice to off. T2 concurrently reads the same 2 rows and updates Bob to off. Both commit. Why did first-committer-wins not stop this?',
        answer:
          'First-committer-wins only fires when two transactions write the same row. T1 wrote Alice\'s row and T2 wrote Bob\'s row: disjoint writes, so no conflict is detected. The invariant depended on rows each transaction only read. That is write skew, and snapshot isolation does not track read dependencies. Fix: SERIALIZABLE, or SELECT ... FOR UPDATE on the on-call rows, or a constraint/trigger.',
      },
    },
    {
      id: 'serializable',
      title: 'Serializable: the only level that is actually correct',
      body: `**Serializable** guarantees that the outcome of any set of concurrent transactions equals *some* serial ordering of them. If your transactions are individually correct, the system is correct, full stop. Every anomaly, including write skew, is impossible. The question is how the engine achieves that and what you pay.

**Two-phase locking (2PL)**, the classical approach used by SQL Server (default SERIALIZABLE mode), older engines, and InnoDB's SERIALIZABLE level: every read takes a shared lock and every write an exclusive lock, held until commit, plus predicate or gap locks to stop phantoms. Readers block writers and writers block readers, so throughput falls sharply under contention and deadlocks become frequent. InnoDB's SERIALIZABLE simply converts every plain SELECT into \`SELECT ... FOR SHARE\`, so reads start blocking writes.

**Serializable Snapshot Isolation (SSI)**, used by Postgres since 9.1 and by CockroachDB: transactions run optimistically on snapshots, exactly like repeatable read, while the engine tracks **read-write dependencies** between concurrent transactions (T1 read something T2 later wrote). When it detects a dangerous pattern of dependencies that could form a cycle, meaning no serial order can explain the result, it aborts one transaction with SQLSTATE 40001 \`could not serialize access due to read/write dependencies\`. No transaction ever blocks another on a read; the cost is CPU and memory for tracking (predicate locks called SIReadLocks) and a **false-positive abort rate** that grows with contention. Under SSI the on-call doctors example aborts one of the two transactions, as it should.

The operational implications:

- **Every transaction must be retryable.** The application wraps the transaction in a loop that catches 40001 and re-runs from the start. Frameworks rarely do this for you.
- **Keep transactions short and touch few rows.** Long transactions accumulate dependencies and are the most likely to be aborted, repeatedly.
- **Throughput cost** is modest for low-contention workloads in Postgres SSI (often 10-30%) but can be severe when many transactions touch the same hot rows; each retry is wasted work.
- **Read-only transactions** can be declared \`READ ONLY DEFERRABLE\` in Postgres to run without abort risk once a safe snapshot is found; great for long reports.

When to use it: whenever an invariant spans multiple rows or a predicate and you cannot express it as a constraint. Booking systems (no overlapping reservations), financial ledgers with balance rules across accounts, scheduling. A common pragmatic pattern is to run the whole system at read committed and switch only the critical transactions to SERIALIZABLE with a retry wrapper, or to use explicit \`FOR UPDATE\` locks to serialise access to the specific rows involved.`,
      mentalModel:
        'Serializable is a referee who guarantees the game\'s final score is one that could have happened if the players had taken turns. 2PL makes them physically take turns; SSI lets them all play at once, watches for an impossible score, and makes one player redo their move.',
      diagram: `2PL (pessimistic):  lock everything read/written until commit
 T1: S-lock rows ... X-lock row ... COMMIT -> release
 T2: waits on T1's locks            (blocking, deadlocks)

SSI (optimistic, Postgres):  snapshots + dependency tracking
 T1 reads set R1, writes W1 --+
 T2 reads set R2, writes W2 --+--> rw-dependency cycle? abort one
                                    ERROR 40001 -> app retries`,
      keyPoints: [
        'Serializable: result equals some serial order; all anomalies including write skew are impossible.',
        '2PL implements it with shared/exclusive locks held to commit; reads block writes, deadlocks rise.',
        'Postgres SSI is optimistic: snapshots plus read-write dependency tracking; conflicts abort with 40001.',
        'Applications must retry serialization failures; keep transactions short to limit aborts.',
        'Apply it selectively to transactions guarding multi-row invariants, or use explicit FOR UPDATE locks instead.',
      ],
    },
    {
      id: 'mvcc',
      title: 'MVCC: how readers and writers stop blocking each other',
      body: `Both Postgres and InnoDB implement isolation with **multi-version concurrency control**. Instead of overwriting a row in place and making everyone wait for the lock, a writer creates a **new version** of the row. Each transaction is handed a **snapshot**, a rule for deciding which version of each row it is allowed to see. Readers never block writers, writers never block readers; only writers block writers on the same row.

**Postgres.** Every row version (tuple) carries two hidden columns: \`xmin\`, the id of the transaction that created it, and \`xmax\`, the id of the transaction that deleted or superseded it (zero while live). A snapshot records which transaction ids were committed when it was taken. A tuple is visible if its \`xmin\` committed before the snapshot and its \`xmax\` is unset or belongs to a transaction not yet committed at snapshot time. An UPDATE is therefore a DELETE plus INSERT: the old tuple gets an \`xmax\`, a new tuple is written with a new \`xmin\`, and indexes may need a new entry (unless a HOT update keeps it on the same page). Read committed takes a snapshot per statement; repeatable read and serializable take one per transaction.

The consequence is **dead tuples**: old versions nobody can see any more. **VACUUM** (usually autovacuum) reclaims them. A transaction that stays open for hours keeps its snapshot alive, so every version newer than that snapshot must be retained, tables and indexes bloat, and queries slow down. This is the concrete mechanism behind the advice "keep transactions short". Postgres also wraps transaction ids at 2^32, so VACUUM must periodically "freeze" old tuples; running out of headroom forces an emergency shutdown, which is a famous operational hazard.

**InnoDB.** The row in the clustered index holds the latest version; older versions are reconstructed from the **undo log**, chained per row via a roll-pointer. A reader with an older snapshot follows the chain back until it finds a version its snapshot may see. Undo records are **purged** once no active transaction can need them; long transactions make the undo log (in the system or undo tablespaces) grow, and history-list length is the metric to watch.

**Why this design won.** OLTP workloads are read-heavy; letting reads proceed without locks against a stable snapshot delivers enormous concurrency and makes consistent backups and long reports cheap. The costs are extra storage for versions, background cleanup work, and the subtle semantics (snapshot isolation permits write skew) discussed above. Understanding MVCC also explains a common surprise: \`SELECT COUNT(*)\` on Postgres must visit tuples to check visibility, so it is not the instant metadata lookup people expect.`,
      mentalModel:
        'MVCC is version control for rows. Every writer commits a new revision; every reader checks out the repository as of a fixed commit and sees a consistent tree. Old revisions pile up until a garbage collector (VACUUM, purge) confirms nobody has them checked out.',
      diagram: `Postgres tuple versions for row id=1 (balance)
 v1: xmin=100 xmax=205  balance=100   <- visible to snapshots before 205
 v2: xmin=205 xmax=0    balance=50    <- visible after T205 commits

 T300 (snapshot: 205 committed)  -> sees v2 (50)
 T190 (snapshot: 205 not yet)    -> sees v1 (100)   no blocking
 v1 becomes dead once no snapshot needs it -> VACUUM reclaims

InnoDB: clustered row = latest; older versions via undo log chain`,
      keyPoints: [
        'Writers create new row versions; each transaction sees the versions visible in its snapshot.',
        'Readers never block writers and vice versa; writer-writer conflicts on the same row still block.',
        'Postgres: xmin/xmax per tuple, dead tuples reclaimed by VACUUM; InnoDB: latest row plus undo log chain, purged later.',
        'Long transactions pin old versions: bloat in Postgres, undo growth in InnoDB.',
        'Snapshot per statement (read committed) vs per transaction (repeatable read, serializable).',
      ],
      checkpoint: {
        question:
          'A batch job opens a transaction, then processes 8 hours of work inside it. During that time an unrelated hot table with 50 updates/s gets 10x slower. Explain the mechanism.',
        answer:
          'The open transaction holds an old snapshot, so VACUUM cannot remove any row version created after it, across all tables. The hot table accumulates 50 x 3600 x 8 = 1.44 M dead tuples that every scan and index lookup must step over, and its indexes bloat. Fix: split the batch into short transactions, and monitor for long-running transactions and old xmin horizons.',
      },
    },
    {
      id: 'locks',
      title: 'Locks: taking control explicitly',
      body: `MVCC handles reads, but writes still need locks, and sometimes you want to lock deliberately to serialise a critical read-modify-write without paying for SERIALIZABLE everywhere.

**Row locks.** Any UPDATE or DELETE takes an exclusive lock on the rows it modifies, held until commit. A second writer on the same row waits (at read committed) or, in Postgres repeatable read, aborts once the first commits.

**\`SELECT ... FOR UPDATE\`.** Reads the latest committed version and takes the same exclusive row lock an UPDATE would, blocking other FOR UPDATE and UPDATE on those rows until you commit. This is the standard tool for read-modify-write: lock the inventory row, check stock, decrement, commit. Combined with short transactions it gives correctness at read committed with minimal contention. Variants: \`FOR SHARE\` (blocks writers, allows other sharers; useful to protect a parent row while inserting children), \`NOWAIT\` (error instead of waiting), \`SKIP LOCKED\` (skip rows others hold, the classic pattern for a job queue in SQL where many workers each grab different rows).

**Gap and next-key locks (InnoDB).** In repeatable read, a locking read on an index range locks the gaps between index entries too, so nobody can insert a row into the range until you commit. This stops phantoms but also blocks inserts that seem unrelated, a frequent source of surprising deadlocks in MySQL. Postgres has no gap locks; it relies on snapshots (RR) and SSI predicate tracking (SERIALIZABLE) instead.

**Table locks.** DDL such as ALTER TABLE takes strong table locks; an \`ALTER\` waiting behind a long transaction can then block every other query on the table in a lock queue. Always run migrations with a short \`lock_timeout\`.

**Advisory locks (Postgres).** Application-defined locks on an arbitrary integer key, e.g. \`pg_advisory_xact_lock(user_id)\`, to serialise logic that does not map to a row.

**Deadlocks.** T1 locks row A then wants B; T2 locks B then wants A. Neither can proceed. Postgres and InnoDB detect this (Postgres after \`deadlock_timeout\`, 1 s by default) and abort one transaction with an error the application must retry. Prevention: acquire locks in a consistent order (sort ids before locking), lock everything you need up front with one \`FOR UPDATE ... ORDER BY id\`, and keep transactions short.

**Optimistic locking** is the lock-free alternative for low-contention or long-lived edits: store a \`version\` column, and write with \`UPDATE ... WHERE id = ? AND version = ?\`; zero rows affected means someone else changed it, so reload and retry. No locks held across user think time.`,
      mentalModel:
        'FOR UPDATE is putting your hand on the item in the shop while you decide; nobody else can take it, but you had better decide quickly. A deadlock is two shoppers each holding one shoe of a pair and refusing to let go.',
      diagram: `Read-modify-write, safe at READ COMMITTED:
 BEGIN
 SELECT stock FROM items WHERE id = 42 FOR UPDATE;  -- X lock
 -- stock = 1 ? then
 UPDATE items SET stock = stock - 1 WHERE id = 42;
 INSERT INTO orders ...;
 COMMIT                                             -- lock released

Deadlock:
 T1: lock A ---- wants B (held by T2)
 T2: lock B ---- wants A (held by T1)    -> engine aborts one
 Prevent: always lock in id order (A before B)`,
      keyPoints: [
        'UPDATE/DELETE take exclusive row locks until commit; SELECT FOR UPDATE takes the same lock ahead of time.',
        'FOR UPDATE at read committed is the pragmatic fix for read-modify-write races; SKIP LOCKED builds job queues.',
        'InnoDB gap/next-key locks prevent phantoms in RR but cause extra blocking and deadlocks; Postgres has none.',
        'Deadlocks are detected and one transaction aborted; prevent by consistent lock ordering and short transactions.',
        'Optimistic version checks avoid holding locks across long edits.',
      ],
      checkpoint: {
        question:
          'A money transfer locks the sender row, then the receiver row. Transfers A->B and B->A run concurrently and occasionally deadlock. What is the fix?',
        answer:
          'Lock both accounts in a consistent global order regardless of direction, e.g. SELECT ... FROM accounts WHERE id IN (A, B) ORDER BY id FOR UPDATE, then apply the debit and credit. Both transactions now try to lock the lower id first, so one simply waits for the other instead of forming a cycle.',
      },
    },
    {
      id: 'real-defaults',
      title: 'What Postgres and MySQL actually do by default',
      body: `Knowing the standard is not enough; the engines diverge from it in ways that decide whether your code is correct. Here is the reality.

**PostgreSQL**
- Default: **READ COMMITTED**, snapshot per statement.
- READ UNCOMMITTED: accepted syntactically, behaves as READ COMMITTED. Dirty reads are impossible.
- REPEATABLE READ: true snapshot isolation. No phantoms (stronger than the standard requires). First-committer-wins on row conflicts, error 40001. Write skew possible.
- SERIALIZABLE: SSI. Fully serializable, optimistic, aborts with 40001 on dangerous dependency patterns. Requires retry loops.
- No gap locks. Row locks via FOR UPDATE / FOR SHARE. Advisory locks available.
- Set per transaction: \`BEGIN ISOLATION LEVEL SERIALIZABLE;\` or per session/database via \`default_transaction_isolation\`.

**MySQL (InnoDB)**
- Default: **REPEATABLE READ**. Plain SELECTs read a consistent snapshot taken at the first read; locking reads and DML read the latest data and take next-key (row + gap) locks, which prevent phantoms for those statements.
- READ COMMITTED: each read gets a fresh snapshot; gap locking is mostly disabled, so far fewer lock waits and deadlocks. Widely recommended for high-concurrency OLTP and required for row-based binlog semantics in some setups. Many large MySQL deployments run here.
- READ UNCOMMITTED: real dirty reads.
- SERIALIZABLE: repeatable read plus every plain SELECT silently becomes \`SELECT ... FOR SHARE\` (2PL style), so reads block writes. Rarely used.
- Set with \`SET TRANSACTION ISOLATION LEVEL ...\` or globally with \`transaction_isolation\`.

**Others, for interviews**: Oracle defaults to READ COMMITTED and offers SERIALIZABLE (actually snapshot isolation, write skew possible) but no REPEATABLE READ. SQL Server defaults to READ COMMITTED using locks (readers can block on writers) unless \`READ_COMMITTED_SNAPSHOT\` is on, and offers SNAPSHOT and true SERIALIZABLE via locking. CockroachDB and Spanner default to SERIALIZABLE.

**Practical guidance**
1. Assume read committed semantics unless you set otherwise, even on MySQL where plain reads are snapshot-based, because your writes see the latest data anyway.
2. Make single-row updates atomic in SQL (\`SET x = x - 1 WHERE ... AND x >= 1\`), never read-then-write from application memory.
3. For multi-row read-modify-write on a few known rows, use \`SELECT ... FOR UPDATE\` in a short transaction.
4. For invariants over predicates (no overlapping bookings, at least one on call), use SERIALIZABLE with a retry wrapper, or a constraint (UNIQUE, exclusion constraints in Postgres) where one can express it.
5. Use REPEATABLE READ for reports, exports and any multi-statement read that must be internally consistent.
6. Monitor long transactions; they undermine every level via bloat and lock queues.`,
      mentalModel:
        'Two rental-car companies both advertise "full insurance", but the fine print differs: one covers phantoms, one covers only some situations, and one silently upgrades you. Reading the fine print (the engine\'s manual) is the difference between covered and stranded.',
      diagram: `Level            Postgres                    MySQL InnoDB
---------------  --------------------------  ---------------------------
READ UNCOMMITTED = READ COMMITTED (no dirty)  dirty reads possible
READ COMMITTED   DEFAULT; snapshot/statement  snapshot/read; little gap lock
REPEATABLE READ  snapshot isolation;          DEFAULT; snapshot for SELECT,
                 no phantoms; 40001 on        next-key locks on FOR UPDATE
                 row conflict; write skew ok  and DML block phantoms
SERIALIZABLE     SSI, optimistic, 40001       2PL-ish: SELECT -> FOR SHARE`,
      keyPoints: [
        'Postgres defaults to READ COMMITTED; MySQL InnoDB defaults to REPEATABLE READ.',
        'Postgres has no dirty reads at any level; its RR is snapshot isolation with no phantoms; its SERIALIZABLE is optimistic SSI.',
        'InnoDB RR mixes snapshots for plain reads with next-key locks for locking reads; READ COMMITTED reduces gap-lock contention.',
        'Oracle SERIALIZABLE is really snapshot isolation; SQL Server read committed uses locks unless RCSI is enabled.',
        'Default plus atomic updates plus FOR UPDATE covers most needs; escalate to SERIALIZABLE only for predicate invariants.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What is the default isolation level in PostgreSQL?',
      options: ['Read uncommitted', 'Read committed', 'Repeatable read', 'Serializable'],
      answerIndex: 1,
      explanation:
        'Postgres defaults to READ COMMITTED with a snapshot per statement. MySQL InnoDB is the engine whose default is REPEATABLE READ; mixing the two up is a common interview slip.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'Transaction T1 reads a row, T2 updates and commits it, and T1 reads the same row again and sees the new value. Which anomaly is this?',
      options: ['Dirty read', 'Non-repeatable read', 'Phantom read', 'Write skew'],
      answerIndex: 1,
      explanation:
        'The same row returned different values within one transaction after another transaction committed: a non-repeatable read. A dirty read would require seeing uncommitted data; a phantom concerns new or removed rows in a range, not a changed existing row.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Under Postgres REPEATABLE READ, which of the following is still possible?',
      options: [
        'Dirty reads',
        'Non-repeatable reads',
        'Phantom reads',
        'Write skew',
      ],
      answerIndex: 3,
      explanation:
        'Postgres RR is snapshot isolation: one snapshot for the whole transaction rules out dirty, non-repeatable and phantom reads. Write skew, where two transactions read overlapping data and write disjoint rows, is not detected because no row is written by both. Only SERIALIZABLE prevents it.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which techniques prevent a lost update on an inventory counter at READ COMMITTED? Select all that apply.',
      options: [
        'UPDATE items SET stock = stock - 1 WHERE id = ? AND stock > 0',
        'SELECT stock ... then UPDATE items SET stock = <value from app> in the same transaction',
        'SELECT ... FOR UPDATE, then UPDATE, in a short transaction',
        'UPDATE ... WHERE id = ? AND version = ? with a version column (optimistic locking)',
        'Running the read and write in autocommit mode',
      ],
      answerIndices: [0, 2, 3],
      explanation:
        'An atomic single-statement update re-evaluates on the latest committed row under lock; FOR UPDATE serialises the read-modify-write; a version check detects concurrent modification. Reading into application memory and writing back, with or without autocommit, leaves a window where another transaction commits in between.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement: 'In PostgreSQL, setting a transaction to READ UNCOMMITTED allows it to see rows written by uncommitted transactions.',
      answer: false,
      explanation:
        'Postgres accepts the syntax but implements READ UNCOMMITTED as READ COMMITTED; its MVCC design never exposes uncommitted versions. MySQL InnoDB does implement real dirty reads at that level.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question: 'A meeting-room booking system must prevent overlapping bookings. It runs at READ COMMITTED and checks for overlaps with a SELECT before INSERT. Under load, double bookings appear. Which fix is most appropriate and why?',
      options: [
        'Switch to REPEATABLE READ; snapshot isolation prevents this',
        'Use SERIALIZABLE with a retry loop, or a Postgres exclusion constraint on (room, time range)',
        'Add an index on room_id',
        'Increase the deadlock_timeout',
      ],
      answerIndex: 1,
      explanation:
        'This is write skew: two transactions each read "no overlap" and insert different rows. Snapshot isolation (RR) does not detect it because the writes are disjoint. SERIALIZABLE (SSI) aborts one of them, and an exclusion constraint makes the database enforce non-overlap directly. Indexes and timeouts do not address correctness.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 2,
      question: 'Why does a transaction left open for many hours degrade performance of unrelated tables in Postgres?',
      options: [
        'It holds table locks on every table',
        'Its old snapshot prevents VACUUM from removing dead row versions created after it, causing bloat everywhere',
        'It consumes all WAL segments',
        'Postgres pauses autovacuum while any transaction is open',
      ],
      answerIndex: 1,
      explanation:
        'MVCC must keep every version that any live snapshot could still see. An old snapshot pins versions across the whole database, so dead tuples pile up in hot tables and their indexes. It does not lock other tables, and autovacuum keeps running but cannot reclaim the pinned versions.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 2,
      statement: 'Under MVCC, a transaction reading a row is blocked while another transaction holds an exclusive lock on that row from an UPDATE.',
      answer: false,
      explanation:
        'Readers see the previous committed version from their snapshot and never wait for writers; that is the point of multi-versioning. Only another writer (UPDATE, DELETE, SELECT FOR UPDATE) on the same row waits.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 3,
      question: 'A MySQL team at REPEATABLE READ sees frequent deadlocks between transactions that insert into different, non-overlapping rows of the same table. What is the most likely cause?',
      options: [
        'MVCC snapshots conflicting',
        'Next-key (gap) locks taken by locking reads or DML on index ranges blocking inserts into the locked gaps',
        'Missing primary key',
        'The binlog being disabled',
      ],
      answerIndex: 1,
      explanation:
        'InnoDB RR locks gaps in the index to prevent phantoms, so a locking read on a range blocks inserts anywhere in that range even for rows that do not yet exist. Switching to READ COMMITTED, which largely disables gap locking, is the standard remedy. Snapshots never block.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'What must application code do when using Postgres SERIALIZABLE?',
      options: [
        'Nothing; the database handles all conflicts transparently',
        'Catch serialization failures (SQLSTATE 40001) and retry the whole transaction',
        'Take explicit table locks before every statement',
        'Disable autovacuum',
      ],
      answerIndex: 1,
      explanation:
        'SSI is optimistic: it lets conflicting transactions run and aborts one when a dangerous dependency pattern appears. The aborted transaction must be re-run from the beginning by the application. No explicit locks are needed, and vacuum is unrelated.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'A wallet service must ensure a user\'s balance never goes negative while handling 500 concurrent debits per second across many users, with occasional hot users. Design the transaction, choose the isolation level, and justify.',
      modelAnswer: `Run at the default READ COMMITTED and make each debit a single atomic statement:

\`UPDATE wallets SET balance = balance - :amt WHERE user_id = :u AND balance >= :amt RETURNING balance;\`

If zero rows are returned, the debit is rejected (insufficient funds). The check and the write are one statement under the row lock, so concurrent debits on the same user serialise on the row and re-evaluate the predicate on the latest committed value; no lost update, no overdraft. Add a \`CHECK (balance >= 0)\` constraint as a safety net. Record the ledger entry in the same transaction so atomicity covers both.

Hot users: contention is per row, so 500/s spread over many users is trivial; a single hot user is bounded by row-lock throughput (thousands per second on a short transaction), which is fine. SERIALIZABLE is unnecessary because the invariant is single-row and expressible in one statement; it would only add abort/retry overhead.`,
      rubric: [
        'Uses an atomic conditional UPDATE rather than read-then-write.',
        'Explains re-evaluation on the latest committed row under lock at read committed.',
        'Adds a CHECK constraint or similar safety net.',
        'Argues why SERIALIZABLE is not needed for a single-row invariant.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain how Postgres MVCC decides which version of a row a transaction sees, and what VACUUM has to do with it.',
      modelAnswer: `Each row version carries xmin (creating transaction id) and xmax (deleting or superseding transaction id). When a transaction, or each statement at read committed, starts, it takes a snapshot listing which transactions were committed at that moment. A version is visible if its xmin was committed before the snapshot and its xmax is either unset or belongs to a transaction not committed at snapshot time. An UPDATE marks the old version with its xmax and inserts a new version with its xmin, so readers on older snapshots keep seeing the old version without blocking.

Versions that no current or future snapshot can see are dead tuples. VACUUM scans for them, reclaims their space for reuse, updates the visibility map, and freezes very old transaction ids to prevent id wraparound. A long-open transaction pins its snapshot, preventing VACUUM from removing newer dead versions, which causes bloat.`,
      rubric: [
        'xmin/xmax and the snapshot visibility rule.',
        'UPDATE creates a new version rather than overwriting.',
        'Dead tuples and VACUUM reclaiming them.',
        'Long transactions pin versions and cause bloat.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question: 'Compare how Postgres and MySQL InnoDB each implement REPEATABLE READ, and name one practical consequence of each approach.',
      modelAnswer: `Postgres RR is pure snapshot isolation: one snapshot at the first statement governs every read for the whole transaction, so repeated queries, including range queries, return identical results (no phantoms). Writes to a row modified by a concurrent committed transaction fail with 40001, so the application must retry. Consequence: consistent reports and exports for free, but write skew is still possible and retry logic is needed.

InnoDB RR uses a snapshot for plain SELECTs but locking reads and DML operate on the latest committed data and take next-key locks covering the row and the preceding index gap, which blocks inserts into that range and thus prevents phantoms for locking reads. Consequence: more lock waits and deadlocks, including between transactions inserting different rows, which is why many deployments switch InnoDB to READ COMMITTED for high-concurrency OLTP.`,
      rubric: [
        'Postgres: single snapshot, no phantoms, 40001 on row conflicts.',
        'Postgres: write skew possible.',
        'InnoDB: snapshot for plain reads, next-key/gap locks for locking reads.',
        'InnoDB consequence: gap-lock contention and deadlocks; READ COMMITTED as remedy.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Four SQL isolation levels (weak to strong)', back: 'Read uncommitted, read committed, repeatable read, serializable. Each forbids more anomalies at higher coordination cost.' },
    { id: 'f2', front: 'Dirty read', back: 'Seeing data written by a transaction that has not committed (and may roll back). Allowed only at read uncommitted; impossible in Postgres at any level.' },
    { id: 'f3', front: 'Non-repeatable read', back: 'Reading the same row twice in a transaction and getting different values because another transaction committed a change in between. Allowed at read committed.' },
    { id: 'f4', front: 'Phantom read', back: 'A repeated range query returns different rows because another transaction inserted or deleted rows matching the predicate. Needs range/predicate protection, not row locks.' },
    { id: 'f5', front: 'Lost update', back: 'Two transactions read-modify-write the same row; the later write overwrites the earlier. Fix: atomic UPDATE SET x = x - 1, SELECT FOR UPDATE, or optimistic version check.' },
    { id: 'f6', front: 'Write skew', back: 'Two transactions read overlapping data, write disjoint rows, and together break an invariant (both doctors go off call). Snapshot isolation allows it; SERIALIZABLE or explicit locks/constraints prevent it.' },
    { id: 'f7', front: 'Read committed in Postgres (mechanics)', back: 'Default. New snapshot per statement. No dirty reads. Non-repeatable reads and phantoms possible. Atomic single-statement updates are safe against lost updates.' },
    { id: 'f8', front: 'Repeatable read in Postgres', back: 'Snapshot isolation: one snapshot per transaction, no phantoms. Write to a row changed since the snapshot fails with 40001 (first committer wins). Write skew still possible.' },
    { id: 'f9', front: 'Serializable in Postgres', back: 'SSI: optimistic snapshots plus read-write dependency tracking; dangerous cycles abort a transaction with 40001. Application must retry. No read blocking.' },
    { id: 'f10', front: 'Two-phase locking (2PL)', back: 'Shared locks on reads, exclusive on writes, all held to commit, plus predicate/gap locks. Guarantees serializability pessimistically; readers block writers; deadlock-prone.' },
    { id: 'f11', front: 'MVCC in one sentence', back: 'Writers create new row versions; each transaction reads the versions visible to its snapshot, so readers and writers never block each other.' },
    { id: 'f12', front: 'Postgres MVCC internals', back: 'Tuples carry xmin (creator) and xmax (deleter). Visibility judged against the snapshot. Dead tuples reclaimed by VACUUM; long transactions cause bloat; xid wraparound needs freezing.' },
    { id: 'f13', front: 'InnoDB MVCC internals', back: 'Clustered row holds the latest version; older versions rebuilt from the undo log chain. Purge removes undo once unneeded; long transactions grow the history list.' },
    { id: 'f14', front: 'MySQL InnoDB default level and behaviour', back: 'REPEATABLE READ: snapshot for plain SELECT; locking reads and DML see latest data and take next-key (row + gap) locks that block phantoms but raise contention.' },
    { id: 'f15', front: 'SELECT ... FOR UPDATE', back: 'Reads the latest committed row and takes an exclusive row lock until commit; serialises read-modify-write. Variants: FOR SHARE, NOWAIT, SKIP LOCKED (job queues).' },
    { id: 'f16', front: 'Deadlock and prevention', back: 'Two transactions each wait on the other\'s lock; engine detects and aborts one. Prevent by locking rows in a consistent order (ORDER BY id FOR UPDATE) and keeping transactions short.' },
    { id: 'f17', front: 'Optimistic locking', back: 'Version column; UPDATE ... WHERE id = ? AND version = ?; zero rows affected means concurrent change, so reload and retry. No locks across user think time.' },
    { id: 'f18', front: 'Defaults: Postgres / MySQL / Oracle / SQL Server', back: 'Postgres: read committed. MySQL InnoDB: repeatable read. Oracle: read committed (its serializable is snapshot isolation). SQL Server: read committed with locking unless RCSI.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Isolation levels and anomalies',
      prompt: 'Explain to a backend developer what isolation levels are and why the default one can still produce wrong results, using an inventory example.',
      modelExplanation: `A database runs many transactions at the same time, interleaving their steps. Isolation levels are the rules for what one transaction may see of the others while they are in flight. Stricter rules mean fewer surprises but more waiting or more retries, so databases default to a middle setting called read committed: you only ever see data that has been committed.

That sounds safe, but consider two customers buying the last item. Each transaction reads stock, sees 1, decides it is fine, and writes stock = 0. Both succeed, and you have sold two of one item. Nobody saw uncommitted data; the problem is that reading a value and writing a new one were two separate steps with a gap between them.

The fixes are to make the check and the write one atomic statement (UPDATE ... SET stock = stock - 1 WHERE stock > 0), to lock the row first with SELECT FOR UPDATE, or to raise the level to serializable and retry when the database complains. Knowing the default is not fully safe is the whole point.`,
      mustMention: [
        'Isolation levels define what concurrent transactions can see of each other',
        'Read committed is the common default',
        'Lost update via read-then-write gap',
        'Fixes: atomic update, FOR UPDATE, or serializable with retries',
      ],
    },
    {
      id: 'fe2',
      concept: 'MVCC',
      prompt: 'Explain multi-version concurrency control to someone who assumes databases lock a row whenever anyone touches it.',
      modelExplanation: `Old databases did lock a row for every read and write, so a long report would block updates and updates would block reads. Modern engines like Postgres and InnoDB avoid this by never overwriting a row in place. When you update a row, the database writes a new version and marks the old one as superseded by your transaction. Both versions exist for a while.

When a transaction starts, it takes a snapshot: essentially a note of which transactions had committed at that instant. Whenever it reads a row, it picks the version that was current according to its snapshot. A report that started ten minutes ago keeps seeing the world as of ten minutes ago, perfectly consistent, while updates carry on beside it. Readers never wait for writers, and writers never wait for readers. Two writers on the same row still take turns.

The price is garbage: old versions pile up and a background process (VACUUM in Postgres, purge in InnoDB) removes them once no snapshot needs them. A transaction left open for hours keeps its snapshot alive and blocks that cleanup, so tables bloat. That is why "keep transactions short" is not just advice about locks.`,
      mustMention: [
        'New versions instead of in-place overwrites',
        'Snapshot decides which version is visible',
        'Readers and writers do not block each other',
        'Old versions must be garbage collected; long transactions block cleanup',
      ],
    },
    {
      id: 'fe3',
      concept: 'Write skew and serializability',
      prompt: 'Explain write skew and why snapshot isolation misses it, using the on-call doctors example, to a colleague who thinks repeatable read is "basically serializable".',
      modelExplanation: `Repeatable read in Postgres gives every transaction a frozen snapshot, and it refuses to let you overwrite a row someone else changed after your snapshot. That catches conflicts where two transactions write the same row. It does not catch conflicts where they write different rows based on what they both read.

Hospital rule: at least one doctor on call. Alice and Bob are both on call. Alice's transaction counts on-call doctors, sees two, and sets her own row to off. At the same time Bob's transaction counts, also sees two, and sets his row to off. Neither wrote a row the other wrote, so the database sees no conflict, and both commit. Now nobody is on call. The rows are individually fine; the rule spanning both rows is broken. That is write skew.

Serializable isolation fixes it because it also tracks what each transaction read. Postgres notices that Alice read something Bob changed and Bob read something Alice changed, a pattern no serial order could produce, and aborts one, which the application retries. Alternatively, lock the rows you are reasoning about with FOR UPDATE so the two transactions take turns.`,
      mustMention: [
        'Snapshot isolation only detects write-write conflicts on the same row',
        'Write skew: disjoint writes based on overlapping reads break an invariant',
        'Concrete example with both transactions committing',
        'Serializable tracks read dependencies and aborts one; or lock explicitly',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a busy bank branch from the public counters at the front to the manager\'s office at the back. Each area shows one idea about how transactions are kept apart from each other.',
    stops: [
      { locus: 'The queue of customers at the counters', concept: 'The anomalies', image: 'Five troublemakers in the queue wear name badges: DIRTY peeks at a teller\'s pencil notes, NON-REPEATABLE sees his balance change between two glances, PHANTOM watches a new person materialise in the line, LOST UPDATE and his twin both scribble over the same deposit slip, and two doctors named SKEW each sign out on different pages while the "on call" board goes blank.' },
      { locus: 'The glass wall with a clerk\'s draft in pencil', concept: 'Read uncommitted vs read committed', image: 'Behind the glass a clerk writes in pencil; a customer pressing his face to the glass reads the pencil marks before they are inked (read uncommitted). Next window, a sign says INK ONLY: you see only inked entries, but each time you look, new ink has appeared (read committed).' },
      { locus: 'The photo booth', concept: 'Repeatable read / snapshot isolation', image: 'A customer takes a Polaroid of the whole ledger the moment she starts and works only from the photo. When she tries to correct a line someone else has already re-inked since her photo, the machine flashes 40001 and spits out a card: TAKE A NEW PHOTO AND RETRY.' },
      { locus: 'The referee\'s podium', concept: 'Serializable', image: 'A referee in black and white watches every customer at once. Whenever the combined result could not have happened if they had taken turns, she blows a whistle, sends one customer back to the start of the queue, and stamps their slip RETRY.' },
      { locus: 'The archive with layered carbon copies', concept: 'MVCC', image: 'Every ledger page is a stack of carbon copies, each stamped with the number of the transaction that wrote it. Readers flip to the copy matching the number on their own ticket and never wait. A janitor with a shredder labelled VACUUM removes copies nobody\'s ticket can reach, and grumbles at one customer who has held the same ticket since morning while the stacks tower to the ceiling.' },
      { locus: 'The safe-deposit room', concept: 'Locks, FOR UPDATE and deadlocks', image: 'A customer puts his hand firmly on box 42 (FOR UPDATE) while deciding; nobody else can touch it until he leaves. In the corner two customers each hold one key of a two-key box and glare at each other forever until a guard picks one and shoves him out (deadlock detection). A sign reads: ALWAYS PICK UP KEYS IN NUMBER ORDER.' },
      { locus: 'The manager\'s office with two rulebooks', concept: 'Real defaults in Postgres and MySQL', image: 'Two rulebooks on the desk. The blue elephant book (Postgres) opens by default to "READ COMMITTED" and has "READ UNCOMMITTED" crossed out with a note "same as committed". The orange dolphin book (MySQL) opens by default to "REPEATABLE READ" and has a chapter on gap locks with a warning about deadlocks in the margin.' },
    ],
  },
  interviewQuestions: [
    'Explain the four isolation levels and the anomalies each one prevents.',
    'What is the difference between a non-repeatable read and a phantom read, and why does the distinction matter for how they are prevented?',
    'What is the default isolation level in PostgreSQL and in MySQL, and how do their REPEATABLE READ implementations differ?',
    'How does MVCC work, and what problem do long-running transactions cause under MVCC?',
    'What is write skew? Give an example and explain why snapshot isolation does not prevent it.',
    'How would you prevent a lost update on an inventory counter without using SERIALIZABLE?',
    'How does Postgres implement SERIALIZABLE, and what does the application have to do differently?',
    'Two transactions deadlock. How does the database handle it, and how would you prevent it?',
  ],
}

export default chapter
