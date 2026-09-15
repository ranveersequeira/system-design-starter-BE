import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 22,
  slug: 'bloom-filters',
  title: 'Bloom Filters',
  module: 'building-blocks',
  estimatedMinutes: 30,
  summary:
    'A Bloom filter is a tiny probabilistic set that answers "is X possibly in the set?" using a bit array and a handful of hash functions. It never lies with a false negative, occasionally lies with a false positive, and buys that trade with roughly ten bits per element instead of the tens of bytes a real set needs. Databases, caches and crawlers use it to skip expensive work that would have returned nothing.',
  objectives: [
    'Explain how insert and lookup work on a bit array with k hash functions and why deletion is impossible.',
    'State the no-false-negative guarantee and reason about the tunable false-positive rate.',
    'Size a Bloom filter (m bits, k hashes) for a given number of elements and target error rate.',
    'Describe counting Bloom filters and what they give up to support deletion.',
    'Identify real systems that use Bloom filters (Cassandra, HBase, RocksDB, crawlers, caches) and why the pattern fits them.',
  ],
  quickRevision: [
    'A Bloom filter is a bit array of m bits plus k independent hash functions; insert sets k bits, lookup checks k bits.',
    'If any of the k bits is 0 the element is definitely absent; if all are 1 it is possibly present.',
    'False negatives are impossible; false positives happen when other elements happened to set all k of your bits.',
    'False-positive rate p is approximately (1 - e^(-kn/m))^k for n inserted elements.',
    'Optimal k = (m/n) * ln 2 = about 0.69 * m/n; for 10 bits per element that is 7 hashes and p is about 0.8%.',
    'Rule of thumb: about 9.6 bits per element gives 1% false positives, about 14.4 bits gives 0.1%.',
    'One million keys at 1% error is about 1.2 MB; storing the keys themselves would be 16 MB or more.',
    'You cannot delete from a plain Bloom filter: clearing a bit could erase evidence of another element (a false negative).',
    'Counting Bloom filters replace each bit with a small counter (often 4 bits) so deletion is decrement; cost is 4x memory and counter overflow risk.',
    'You cannot resize a Bloom filter or list its members; if n grows beyond plan you must rebuild from the source data.',
    'Classic uses: skip disk reads for missing keys (Cassandra, HBase, RocksDB SSTables), avoid cache misses, "username taken" pre-check, crawler seen-URL sets.',
    'Use two fast non-cryptographic hashes (murmur3, xxHash) and derive the k hashes as h1 + i*h2 (Kirsch-Mitzenmacher double hashing).',
    'A Bloom filter is only worth it when the expensive operation it guards mostly returns "not found"; hits still pay full price.',
    'Redis offers BF.ADD / BF.EXISTS through the RedisBloom module; Guava and most languages ship an implementation.',
  ],
  sections: [
    {
      id: 'problem',
      title: 'The problem: answering "does this exist?" cheaply',
      body: `Many systems spend most of their effort answering questions whose answer is "no".

- A key-value store looks for a key that was never written.
- A cache is asked for an item it has never held, and then the miss goes to the database anyway.
- A signup form asks "is this username taken?" and almost every guess is free.
- A web crawler asks "have I already seen this URL?" for billions of links, most of which are new.

The honest way to answer is to keep a real set: a hash table, a sorted index, a database column with a unique index. All of them store the *keys themselves*, and keys are big. A 16-byte UUID plus hash-table overhead is easily 40-50 bytes per entry; a billion URLs averaging 80 bytes is 80 GB before any index. That does not fit in the memory of the machine that needs to make the decision quickly, so the check itself becomes a disk read or a network round trip: exactly the cost you were trying to avoid.

The insight behind a **Bloom filter** (Burton Bloom, 1970) is that you do not need the keys to answer "definitely not here". You only need enough evidence to rule an element out. If you are willing to accept an occasional "maybe" that turns out to be wrong, you can compress a set to about **10 bits per element**, roughly 40x smaller than a hash set, and answer in a few nanoseconds from CPU cache.

The contract is asymmetric on purpose:

- **"No" is certain.** If the filter says the element is absent, it is absent.
- **"Maybe" is probabilistic.** If the filter says present, it is present with probability 1 - p, where p is a false-positive rate you choose (1%, 0.1%, ...).

That asymmetry is exactly what "avoid wasted work" needs: a certain "no" lets you skip the disk read, the network call, or the database query with zero risk of skipping something real.`,
      mentalModel:
        'A bouncer with a list of banned names in his head, not on paper. If he does not recognise the name at all, you are definitely not banned. If it rings a bell, he checks the real list at the desk. He never lets a banned person through; he sometimes sends an innocent one to the desk.',
      keyPoints: [
        'Most existence checks return "no"; storing full keys to answer them is expensive.',
        'A Bloom filter compresses a set to about 10 bits per element by giving up exactness.',
        'Guarantee: no false negatives. Tunable: false positives.',
        'It is a filter in front of an expensive lookup, not a replacement for it.',
      ],
      checkpoint: {
        question:
          'A service checks membership in a set of 500 million 36-character UUID strings before hitting the database. Roughly how much memory would a hash set need, versus a Bloom filter with 1% false positives?',
        answer:
          'A hash set stores each 36-byte string plus pointer and bucket overhead, easily 80+ bytes per entry: about 40 GB. A Bloom filter at about 9.6 bits per element needs 500M * 9.6 bits = 4.8 Gbit = about 600 MB. The filter fits in RAM on a modest machine; the hash set does not.',
      },
    },
    {
      id: 'mechanics',
      title: 'How it works: a bit array and k hash functions',
      body: `A Bloom filter is two things: an array of **m bits**, all initially 0, and **k independent hash functions**, each mapping an element to a position in 0..m-1.

**Insert(x):** compute h1(x), h2(x), ..., hk(x) and set those k bits to 1. Nothing else is stored. The element itself is thrown away.

**Lookup(x):** compute the same k positions. If **any** bit is 0, return "definitely not present": had x been inserted, that bit would be 1, and bits are never cleared. If **all** k bits are 1, return "possibly present".

Why "possibly"? Because the bits you are looking at may have been set by *other* elements. Suppose you inserted "alice" (bits 3, 9, 14) and "bob" (bits 5, 9, 21). Now you look up "carol", whose hashes happen to be 3, 5, 21. All three are 1. The filter says "maybe", but carol was never inserted. That is a **false positive**: a coincidence of overlapping bits.

A **false negative** would require a bit that x set to be 0 at lookup time. Since bits only go from 0 to 1, that cannot happen. This is the whole reason the structure is useful: the "no" side is exact.

**Which hash functions?** You do not want cryptographic hashes; SHA-256 costs hundreds of nanoseconds per call and buys nothing here. You want fast, well-distributed, non-cryptographic hashes: **murmur3**, **xxHash**, **FNV**. And you do not need k different algorithms. The **Kirsch-Mitzenmacher** trick computes two hashes h1 and h2 and derives the rest as hi(x) = h1(x) + i * h2(x) mod m. It has essentially the same false-positive behaviour as k truly independent hashes at a fraction of the CPU cost.

**Cost per operation:** k hash computations plus k random bit accesses. With k around 7 and the bit array in memory, that is tens of nanoseconds. A "blocked" or "register-blocked" Bloom filter variant confines all k bits of one element to a single 64-byte cache line, so lookup touches one cache line instead of k; RocksDB uses this layout.`,
      mentalModel:
        'A wall of light switches. To register a guest you flip switches at seven positions chosen by hashing their name. To ask "was this guest here?" you look at their seven switches: any one still down means definitely no; all up means probably, unless other guests happened to flip the same seven.',
      diagram: `m = 16 bits, k = 3 hashes

insert("alice"): h1=3  h2=9  h3=14
insert("bob")  : h1=5  h2=9  h3=21%16=5 -> bits 5, 9

index: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
bits : 0 0 0 1 0 1 0 0 0 1 0  0  0  0  1  0

lookup("dave") : h=3, 7, 9  -> bit 7 is 0  => DEFINITELY NOT
lookup("carol"): h=3, 5, 14 -> all 1       => MAYBE (false positive)`,
      keyPoints: [
        'Insert sets k bits; lookup checks k bits; the element itself is never stored.',
        'Any 0 bit proves absence; all 1s only suggests presence.',
        'False positives come from other elements colliding on all k positions.',
        'Use fast non-cryptographic hashes; derive k positions from two hashes (h1 + i*h2).',
        'Lookup is O(k) and cache-friendly; blocked variants touch one cache line.',
      ],
      checkpoint: {
        question:
          'What happens to the false-positive rate if you keep inserting elements far beyond the n the filter was sized for?',
        answer:
          'More and more bits become 1. Eventually nearly every bit is set and every lookup returns "maybe": the false-positive rate climbs toward 100% and the filter stops filtering anything. You must rebuild a larger filter from the source data; a Bloom filter cannot be resized in place.',
      },
    },
    {
      id: 'sizing',
      title: 'Sizing: choosing m and k for a target error rate',
      body: `The false-positive probability has a clean approximation. After inserting n elements into m bits with k hashes, the probability that a specific bit is still 0 is about e^(-kn/m). A lookup of an absent element is a false positive only if all its k bits are 1:

**p = (1 - e^(-kn/m))^k**

Two knobs matter: the number of **bits per element** (m/n) and **k**.

**Optimal k.** For a fixed m/n, too few hashes means each element leaves little evidence, so collisions are easy; too many hashes fill the array with 1s quickly. The sweet spot is

**k = (m/n) * ln 2 = about 0.693 * (m/n)**

At that k, roughly half the bits are set at capacity, and the error rate is p = 0.6185^(m/n).

**Bits per element for a target p.** Inverting: m/n = -1.44 * log2(p).

| target p | bits per element | optimal k |
|---|---|---|
| 10% | 4.8 | 3 |
| 1% | 9.6 | 7 |
| 0.1% | 14.4 | 10 |
| 0.01% | 19.2 | 13 |

Every 10x improvement in error rate costs about 4.8 more bits per element. That is why "1% at 10 bits" is the default in so many systems; it is the knee of the curve.

**Worked example.** A crawler expects 100 million URLs and tolerates 1% false positives (a false positive means it wrongly skips a new page, so this should be small but need not be zero). m = 100M * 9.6 = 960 Mbit = 120 MB; k = 7. The URLs themselves would average 8 GB.

**Practical wrinkles.**
- You must estimate n up front. Overshoot by 20-30%; undershoot is catastrophic (see the previous checkpoint). Cassandra sizes its SSTable filters from the exact partition count of the file, which is known at flush time.
- **Scalable Bloom filters** handle unknown n by chaining filters: when one fills, start a new larger one with a tighter p; lookups check all of them. Error rates add, so plan the geometric series.
- Round m up to a power of two so the modulo becomes a bit mask.`,
      mentalModel:
        'Sizing a Bloom filter is like buying seats for a party: too few chairs and everyone is squeezed and confused (false positives everywhere); the formula tells you exactly how many chairs per guest give the comfort level you want.',
      diagram: `false-positive rate vs bits per element (k optimal)

p
100% |*
 10% |   *
  1% |        *
0.1% |              *
.01% |                    *
     +----+----+----+----+----+---> bits/element
     0    4.8  9.6  14.4 19.2

each extra 4.8 bits/element buys a 10x lower error rate`,
      keyPoints: [
        'p = (1 - e^(-kn/m))^k; optimal k = 0.693 * m/n.',
        'About 9.6 bits per element for 1%, 14.4 for 0.1%, 19.2 for 0.01%.',
        'Each 10x error reduction costs about 4.8 bits per element.',
        'Estimate n generously; an overfilled filter degrades to useless.',
        'Scalable Bloom filters chain filters when n is unknown.',
      ],
      checkpoint: {
        question:
          'You have a fixed budget of 64 MB for a filter over 50 million keys. What false-positive rate can you expect, and what k should you use?',
        answer:
          '64 MB = 512 Mbit; 512M / 50M = 10.24 bits per element. k = 0.693 * 10.24 = 7. p = 0.6185^10.24 = about 0.7%. So about 1 in 140 lookups of a missing key will be a false positive.',
      },
    },
    {
      id: 'deletion',
      title: 'Why you cannot delete, and counting Bloom filters',
      body: `The bit array works because bits only ever go from 0 to 1. Deletion would need the reverse, and that breaks the one guarantee that makes the filter useful.

Suppose "alice" set bits 3, 9, 14 and "bob" set bits 5, 9, 21. To delete alice you clear 3, 9 and 14. Bit 9 was also bob's. A lookup of bob now finds bit 9 at 0 and returns "definitely not present". That is a **false negative**: the filter has told a database to skip a disk read for a key that exists, or told a crawler that a URL was never seen when it was. A structure that can produce false negatives is not a Bloom filter any more; you can no longer trust "no".

**Counting Bloom filters** (Fan et al., 2000) fix this by replacing each bit with a small counter, typically **4 bits**. Insert increments k counters; delete decrements them; lookup tests whether all k counters are non-zero. Now removing alice takes bit 9 from 2 to 1, and bob's evidence survives.

The costs are real:

- **Memory multiplies by the counter width.** 4-bit counters mean 4x the space, so the 40x advantage over a hash set becomes 10x.
- **Counters can overflow.** With 4 bits the maximum is 15. Analysis shows overflow is rare at optimal loading (probability around 1.4 * 10^-15 per counter), but implementations must saturate at the maximum and then never decrement that counter, which slowly reintroduces false positives.
- **Deletion is only safe for elements you know were inserted.** Decrementing for an element that was never added corrupts other elements' counters and creates false negatives.

**Alternatives when you need deletion.**
- **Cuckoo filters** (Fan, Andersen, Kaminsky, Mitzenmacher, 2014) store short fingerprints in a cuckoo hash table. They support deletion, use *less* space than a Bloom filter below about 3% error, and have better cache locality. RedisBloom offers CF.ADD alongside BF.ADD.
- **Rebuild periodically.** Many systems sidestep deletion by treating filters as immutable snapshots. Cassandra never deletes from an SSTable's filter; when compaction rewrites SSTables it builds fresh filters from the surviving rows. A crawler can rotate a daily filter.

The general lesson: when a data structure gives you a guarantee, ask which invariant provides it. Here the invariant is "bits never clear", and every extension has to protect it.`,
      mentalModel:
        'The light-switch wall again: if two guests share a switch and you flip it down when the first one leaves, the second guest has vanished from the record. A counting filter replaces each switch with a tally counter that you click up on arrival and down on departure.',
      diagram: `plain bloom filter (bits)        counting bloom filter (4-bit)

insert alice -> 3, 9, 14        insert alice -> c[3]=1 c[9]=1 c[14]=1
insert bob   -> 5, 9, 21        insert bob   -> c[5]=1 c[9]=2 c[21]=1
delete alice -> clear 3, 9, 14  delete alice -> c[3]=0 c[9]=1 c[14]=0
lookup bob   -> bit 9 is 0      lookup bob   -> c[5],c[9],c[21] > 0
             => FALSE NEGATIVE               => still present (correct)`,
      keyPoints: [
        'Clearing a shared bit erases evidence of other elements, causing false negatives.',
        'Counting Bloom filters use small counters (often 4 bits) so delete is a decrement.',
        'Price: about 4x memory and rare counter overflow that must saturate, not wrap.',
        'Cuckoo filters support deletion with better space at low error rates.',
        'Many systems avoid deletion entirely by rebuilding immutable filters (Cassandra compaction).',
      ],
    },
    {
      id: 'use-cases',
      title: 'Where Bloom filters live in real systems',
      body: `The pattern is always the same: a cheap filter in front of an expensive operation whose answer is usually "nothing here".

**LSM-tree databases: Cassandra, HBase, RocksDB, LevelDB.** Writes go to a memtable and are flushed to immutable sorted files (SSTables). A read for one key may have to consult many SSTables, and each consult is a disk seek. Every SSTable carries a Bloom filter over its keys, held in memory. A point read checks each filter first and only opens files that say "maybe". With 10 SSTables and a 1% filter, a read for a missing key touches about 0.1 files on average instead of 10. Cassandra exposes this as bloom_filter_fp_chance per table (default 0.01 for SizeTiered compaction, 0.1 for Leveled) and reports "bloom filter false positives" in nodetool tablestats. HBase stores ROW or ROWCOL filters in each HFile.

**Avoiding cache misses.** Akamai found that about 75% of objects requested from its CDN were requested exactly once ("one-hit wonders"). Caching them evicted useful content. A Bloom filter of "URLs seen before" lets the cache store an object only on its second request; the filter costs a few bits per URL, the saving is the whole cache footprint of one-hit wonders.

**Existence pre-checks.** "Is this username taken?" on a signup form: a Bloom filter of all usernames says "definitely free" for most guesses with no database round trip; on "maybe", fall through to the unique index, which gives the exact answer. The same shape works for "has this user already read this article?" (Medium) and "have we already sent this notification?".

**Web crawler seen-URL set.** A crawler discovers billions of links and must not re-fetch. A 10-bit-per-URL filter over 10 billion URLs is about 12 GB, which fits on one machine; the URLs themselves are close to a terabyte. A false positive means occasionally skipping a genuinely new page, an acceptable loss for a crawler that revisits anyway.

**Networking and security.** Chrome's Safe Browsing originally shipped a Bloom filter of malicious URL prefixes so the browser could skip the lookup for almost every safe page. Bitcoin SPV wallets (BIP 37) sent Bloom filters of their addresses so full nodes could return only relevant transactions. Squid proxies exchange "cache digests" (Bloom filters of their contents) so a sibling knows whether asking is worthwhile.

**Joins and analytics.** Query engines like Spark, Impala and Presto build a Bloom filter over the small side of a join and push it to the scan of the large side, dropping rows that cannot match before shuffling them across the network.`,
      mentalModel:
        'Every library branch keeps a one-page "we probably have it" card index. Before driving to a branch you phone and ask; "no" means do not bother, "maybe" means come and check the shelf.',
      diagram: `read(key) in an LSM store with 4 SSTables

        +---------+  bf says NO   -> skip (no disk I/O)
key --> | SST-1 BF|
        +---------+
        | SST-2 BF|  bf says NO   -> skip
        +---------+
        | SST-3 BF|  bf says MAYBE-> read index + block  (hit or FP)
        +---------+
        | SST-4 BF|  bf says NO   -> skip
        +---------+
1% filters: a missing key costs ~0.04 disk reads instead of 4`,
      keyPoints: [
        'LSM stores keep one filter per SSTable to skip files that cannot hold the key.',
        'CDNs filter one-hit wonders out of the cache using a seen-before filter.',
        'Username / already-read / already-sent checks answer "definitely no" without a database trip.',
        'Crawlers hold billions of seen URLs in a few gigabytes.',
        'Query engines push Bloom filters from the small side of a join into the big scan.',
      ],
      checkpoint: {
        question:
          'Cassandra defaults to a 1% false-positive filter for SizeTiered compaction but 10% for Leveled compaction. Why would Leveled tolerate a worse filter?',
        answer:
          'Leveled compaction guarantees that within each level SSTables have non-overlapping key ranges, so a read consults at most one SSTable per level (roughly 5-10 total) and a key present in the table is found quickly. Fewer candidate files means fewer chances for a false positive to cause a wasted read, so a cheaper, looser filter saves memory with little penalty. SizeTiered can have many overlapping SSTables, so tight filters matter more.',
      },
    },
    {
      id: 'when-not',
      title: 'Costs, pitfalls and when not to use one',
      body: `A Bloom filter is a tool for one shape of problem. Recognising when the shape does not fit is as important as knowing the formula.

**It only helps when the answer is usually "no".** A filter in front of a database that returns a row 95% of the time saves nothing: 95% of lookups pass the filter and pay full price anyway, and you have added CPU and memory. Measure your miss rate before adding one.

**False positives are not free.** In a cache-existence check a false positive means an unnecessary database read. In a "username taken" check it means telling a user their name is taken when it is not (so always confirm a "maybe" against the source of truth before showing it). In a security filter it means a benign page triggers a slower check. Decide what a false positive costs in your domain and set p from that, not from habit.

**It cannot enumerate, count, or resize.** You cannot ask a Bloom filter "what is in you?" or "how many items?" (you can estimate n from the fraction of set bits, but that is all). You cannot grow it; you rebuild it from the underlying data. If the source data is not replayable, keep it somewhere durable.

**Persistence and consistency.** A filter in process memory is lost on restart. Options: rebuild from the database at startup (fine for millions of rows, slow for billions), persist the bit array to disk or S3 alongside a version number, or use a shared filter in Redis (RedisBloom) so all instances see the same state. A shared filter that lags behind the source of truth can produce false negatives from the application's point of view: an item inserted into the database but not yet into the filter will be reported absent. Insert into the filter *before* or *atomically with* the write, never after.

**Hash quality matters.** Poorly distributed hashes cluster bits and inflate the real error rate well above the formula. Use murmur3 or xxHash with different seeds, and test measured false-positive rate against expected on a sample.

**Alternatives to consider.**
- A plain **hash set** if the data fits in memory comfortably; exactness beats cleverness.
- A **cuckoo filter** if you need deletion or an error rate below about 3%.
- A **HyperLogLog** if the question is "how many distinct?" rather than "is this one present?".
- A **sorted index or database unique constraint** as the source of truth; a Bloom filter never replaces it, it only stands in front of it.`,
      mentalModel:
        'A metal detector at a venue entrance. It is worth having only because most people carry nothing; if everyone carried keys it would beep constantly and just slow the line down. And it never replaces the actual bag check when it does beep.',
      keyPoints: [
        'Only valuable when the guarded operation mostly returns "not found".',
        'Price each false positive in your domain and derive p from that.',
        'No enumeration, no counting, no in-place growth; keep the source data to rebuild.',
        'Insert into the filter before or with the real write, or you create effective false negatives.',
        'Consider hash set, cuckoo filter, HyperLogLog, or a real index depending on the question.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'A Bloom filter lookup finds that one of the k bits for an element is 0. What can you conclude?',
      options: [
        'The element is probably present',
        'The element is definitely not present',
        'The element was deleted',
        'The hash functions are poorly distributed',
      ],
      answerIndex: 1,
      explanation:
        'Insertion sets all k bits and bits are never cleared, so a 0 bit proves the element was never inserted. "Probably present" is the conclusion only when all k bits are 1. Deletion does not exist in a plain Bloom filter, and hash quality cannot be judged from one lookup.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 1,
      question: 'Which type of error can a standard Bloom filter produce?',
      options: [
        'False negatives only',
        'False positives only',
        'Both false positives and false negatives',
        'Neither; it is exact',
      ],
      answerIndex: 1,
      explanation:
        'Other elements can collectively set all k bits of an absent element, producing a false positive. A false negative would require a set bit to become 0, which never happens. It is not exact; exactness is what it trades for space.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'Roughly how many bits per element does a well-tuned Bloom filter need for a 1% false-positive rate?',
      options: ['1', '4', '10', '64'],
      answerIndex: 2,
      explanation:
        'm/n = -1.44 * log2(0.01) = about 9.6 bits, with k = 7. One or four bits give error rates of tens of percent; 64 bits per element is what you would spend storing an 8-byte hash in an exact set.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 2,
      question: 'Why can you not delete an element from a standard Bloom filter by clearing its k bits?',
      options: [
        'Clearing bits is too slow',
        'The bits may be shared with other elements, so clearing them creates false negatives',
        'The hash functions are one-way and cannot be reversed',
        'The bit array is read-only after the first insert',
      ],
      answerIndex: 1,
      explanation:
        'Elements overlap on bits. Clearing a bit that another element also set makes that element look absent, breaking the no-false-negative guarantee. Speed, hash reversibility and read-only arrays are not the issue; you can compute the positions easily, you just must not clear them.',
    },
    {
      type: 'mcq',
      id: 'q5',
      difficulty: 3,
      question:
        'A Cassandra node has 8 SSTables for a table, each with a 1% Bloom filter. A read arrives for a partition key that exists in exactly one SSTable. About how many SSTables will be opened on disk?',
      options: ['1', 'About 1.07', 'About 4', '8'],
      answerIndex: 1,
      explanation:
        'The one SSTable holding the key always says "maybe" (no false negatives). Each of the other 7 says "maybe" with probability 1%, adding 0.07 expected extra opens. Without filters all 8 would be consulted; that is the saving.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A team adds a Bloom filter in front of a product-lookup database call. Metrics show 97% of lookups find the product. What is the most likely outcome?',
      options: [
        'Latency drops by about 97%',
        'Database load drops to near zero',
        'Little or no benefit; almost every lookup passes the filter and hits the database anyway',
        'False negatives start appearing',
      ],
      answerIndex: 2,
      explanation:
        'A Bloom filter only saves the work of lookups it can reject. If 97% of keys exist, at most 3% of calls can be short-circuited, and the filter adds hashing cost and memory. False negatives never appear in a correct implementation.',
    },
    {
      type: 'multi',
      id: 'q7',
      difficulty: 2,
      question: 'Which of the following are true of a standard Bloom filter? Select all that apply.',
      options: [
        'It can list the elements it contains',
        'Its false-positive rate rises as more elements are inserted',
        'It supports deletion by clearing bits',
        'Lookup cost is O(k), independent of the number of elements',
        'It can be grown in place when it fills up',
        'The element itself is never stored',
      ],
      answerIndices: [1, 3, 5],
      explanation:
        'More elements set more bits, so false positives rise; lookup is always k hash computations; and only bit positions are kept, never the element. It cannot enumerate members, cannot delete safely, and cannot resize in place (you rebuild from source data).',
    },
    {
      type: 'multi',
      id: 'q8',
      difficulty: 2,
      question: 'Which systems or scenarios are classic Bloom filter use cases? Select all that apply.',
      options: [
        'Skipping SSTables that cannot contain a key in Cassandra or RocksDB',
        'Computing the exact count of distinct visitors',
        'A web crawler deciding whether a URL was already seen',
        'A CDN avoiding caching objects requested only once',
        'Sorting a large dataset on disk',
      ],
      answerIndices: [0, 2, 3],
      explanation:
        'SSTable skipping, crawler seen-sets and one-hit-wonder avoidance all guard an expensive operation whose answer is usually "no". Exact distinct counts need a real set (or HyperLogLog for an approximate one), and sorting is unrelated to membership.',
    },
    {
      type: 'truefalse',
      id: 'q9',
      difficulty: 1,
      statement: 'For a fixed bit array size, adding more hash functions always lowers the false-positive rate.',
      answer: false,
      explanation:
        'More hashes set more bits per element and fill the array faster. Beyond the optimum k = 0.693 * m/n, the extra 1s cause more collisions and the error rate rises again.',
    },
    {
      type: 'truefalse',
      id: 'q10',
      difficulty: 2,
      statement:
        'A counting Bloom filter supports deletion but typically uses about four times the memory of a plain Bloom filter with the same m.',
      answer: true,
      explanation:
        'Each bit becomes a small counter, commonly 4 bits, so memory scales by the counter width. Delete decrements the k counters; overflow is rare but must saturate rather than wrap.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'You must keep a seen-URL set for a crawler expecting 2 billion URLs, with a 0.1% false-positive rate, on a single machine. Size the filter and explain the consequence of a false positive here.',
      modelAnswer: `**Sizing:** 0.1% needs about 14.4 bits per element, so m = 2e9 * 14.4 = 28.8 Gbit = 3.6 GB, with k = 10 hash functions (round m up to a power of two, 2^35 bits = 4 GB, for cheap modulo). Storing the URLs themselves (about 80 bytes each) would be 160 GB.

**Consequence of a false positive:** the crawler believes it has already fetched a genuinely new URL and skips it. About 1 in 1,000 new URLs is missed on first discovery. Because crawlers revisit pages and rediscover links, most of those are picked up later, so the loss is acceptable. A false negative (re-crawling a seen page) cannot happen, so bandwidth is never wasted by the filter.

**Operational notes:** over-provision n by 20-30% because an overfilled filter degrades sharply; persist the bit array periodically so a restart does not re-crawl everything; or rotate filters (one per week) if the frontier is unbounded.`,
      rubric: [
        'Uses about 14.4 bits per element for 0.1% and computes a few GB.',
        'States k around 10.',
        'Correctly identifies that a false positive means skipping a new URL, not re-crawling.',
        'Mentions over-provisioning n or persistence / rotation.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question:
        'Explain how an LSM-tree database such as RocksDB or Cassandra uses Bloom filters to speed up point reads, and why writes never need to consult them.',
      modelAnswer: `In an LSM tree, writes go to an in-memory memtable and are periodically flushed into immutable sorted files (SSTables). A key may live in any of many SSTables, so a point read would otherwise have to check each file's index and possibly read a block from disk.

Each SSTable carries a Bloom filter over its keys, built at flush time (when n is known exactly) and kept in memory. A read first asks every candidate SSTable's filter. Files that answer "definitely not" are skipped with zero I/O; only "maybe" files are opened. With 1% filters, a read for a missing key touches about 1% of the files instead of all of them, and a read for a present key opens the right file plus very few false positives.

Writes never consult the filters because writes append to the memtable; nothing needs to know whether the key already exists elsewhere. When compaction merges SSTables, it writes a brand-new filter for the merged file, which is how deletions are handled without ever removing from a filter.`,
      rubric: [
        'One filter per SSTable, kept in memory, built at flush.',
        'Filters skip files that cannot contain the key, saving disk I/O.',
        'Reads for missing keys benefit the most.',
        'Writes append to the memtable; compaction rebuilds filters rather than deleting.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question:
        'A signup service uses an in-memory Bloom filter of usernames to short-circuit "is this taken?" checks. Describe two ways this can go wrong operationally and how to prevent each.',
      modelAnswer: `**1. Filter lags the database.** If a new username is written to Postgres but the filter is only updated afterwards (or on another instance, or after a restart with a stale snapshot), a lookup for that username says "definitely free". The application then tries to insert and hits the unique constraint, or worse, shows "available" and fails at submit. Prevention: add to the filter before or atomically with the insert, use a shared filter (RedisBloom) so all instances see the same bits, and rebuild from the database on startup or keep a versioned snapshot.

**2. Filter overfills.** Sized for 10 million usernames, the product grows to 50 million. The bit array saturates and nearly every check returns "maybe", so every request falls through to the database and the filter is dead weight. Prevention: monitor the fraction of set bits (should stay near 50%), alert well before saturation, and rebuild a larger filter from the users table.

Also: never show "taken" from a "maybe"; always confirm against the unique index because the filter's "maybe" is wrong about 1% of the time.`,
      rubric: [
        'Identifies stale / lagging filter causing wrong "free" answers and gives a fix.',
        'Identifies overfilling / saturation and gives a monitoring or rebuild fix.',
        'Notes that "maybe" must be confirmed against the source of truth.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Bloom filter (one sentence)', back: 'A space-efficient probabilistic set: m bits and k hash functions; says "definitely not present" or "possibly present".' },
    { id: 'f2', front: 'Insert and lookup operations', back: 'Insert: set the k hashed bit positions. Lookup: if any is 0, absent for sure; if all are 1, possibly present.' },
    { id: 'f3', front: 'Which error type is impossible and why', back: 'False negatives. Bits only go 0 -> 1, so every bit an inserted element set stays set.' },
    { id: 'f4', front: 'False-positive probability formula', back: 'p = (1 - e^(-kn/m))^k for n elements, m bits, k hashes.' },
    { id: 'f5', front: 'Optimal number of hash functions', back: 'k = (m/n) * ln 2 = about 0.693 * bits-per-element. At optimum about half the bits are set.' },
    { id: 'f6', front: 'Bits per element for 1% / 0.1% / 0.01%', back: 'About 9.6 (k=7) / 14.4 (k=10) / 19.2 (k=13). Each 10x better error costs about 4.8 bits.' },
    { id: 'f7', front: 'Why deletion breaks a plain Bloom filter', back: 'Clearing a bit shared with another element makes that element look absent: a false negative.' },
    { id: 'f8', front: 'Counting Bloom filter', back: 'Each bit becomes a small counter (often 4 bits). Insert increments, delete decrements. About 4x memory; counters must saturate on overflow.' },
    { id: 'f9', front: 'Kirsch-Mitzenmacher double hashing', back: 'Compute two hashes h1, h2 and derive position i as h1 + i*h2 mod m; nearly identical error rate to k independent hashes at much lower CPU cost.' },
    { id: 'f10', front: 'How Cassandra / RocksDB use Bloom filters', back: 'One filter per SSTable, in memory, built at flush. Reads skip SSTables whose filter says "no", saving disk seeks. Compaction rebuilds filters.' },
    { id: 'f11', front: 'One-hit wonder problem and Bloom filters', back: 'Most CDN objects are requested once. A seen-before filter lets a cache store an object only on its second request, saving cache space.' },
    { id: 'f12', front: 'Crawler seen-URL set sizing (10B URLs, 1%)', back: '10e9 * 9.6 bits = about 12 GB versus about 800 GB for the raw URLs. False positive = skip a new page occasionally.' },
    { id: 'f13', front: 'What happens when a Bloom filter overfills', back: 'Bits saturate toward all 1s; false positives approach 100%; the filter stops filtering. Must rebuild larger from source data.' },
    { id: 'f14', front: 'Three things a Bloom filter cannot do', back: 'Enumerate its members, report an exact count, or grow in place. Keep the source data to rebuild.' },
    { id: 'f15', front: 'Cuckoo filter vs Bloom filter', back: 'Cuckoo stores fingerprints in a cuckoo hash table; supports deletion; uses less space below about 3% error; better cache locality.' },
    { id: 'f16', front: 'When a Bloom filter is NOT worth adding', back: 'When the guarded lookup usually succeeds. Only rejected lookups save work; hits pay full price plus hashing overhead.' },
    { id: 'f17', front: 'Scalable Bloom filter', back: 'A chain of filters; when one fills, start a larger one with tighter p. Lookups check all; error rates add. Handles unknown n.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'How a Bloom filter works and why it has no false negatives',
      prompt: 'Explain to a junior developer how a Bloom filter stores and checks membership, and why it can be wrong in only one direction.',
      modelExplanation: `Imagine a long row of light switches, all off. When you add a name, you run it through, say, seven different scramblers, each of which points at one switch, and you flip those seven switches on. You do not keep the name itself.

To check a name later, you run the same seven scramblers and look at the seven switches. If even one is off, the name was never added, because adding it would have flipped that switch and nobody ever flips switches off. That is a certain "no".

If all seven are on, the name was probably added. But other names might, by coincidence, have flipped exactly those seven switches between them. So "yes" really means "maybe". You control how often that coincidence happens by using more switches per name: about ten switches per name gives roughly a 1% chance of a wrong "maybe".

The whole trick is that "no" is always right, so you can safely skip expensive work whenever the filter says no.`,
      mustMention: [
        'Bit array plus k hash functions; element itself is not stored',
        'Any 0 bit proves absence because bits are never cleared',
        'All 1s means only "maybe" due to collisions from other elements',
        'Error rate is tuned by bits per element (about 10 bits for 1%)',
      ],
    },
    {
      id: 'fe2',
      concept: 'Why deletion is impossible and how counting filters fix it',
      prompt: 'Explain why you cannot remove an item from a Bloom filter, and what a counting Bloom filter changes.',
      modelExplanation: `Every item flips several switches on, and items share switches. Suppose Alice and Bob both flipped switch number nine. If Alice leaves and you turn her switches off, switch nine goes off too. Now when you check for Bob, one of his switches is off, and the filter says "definitely not here" about someone who is still here. That is a false negative, the one mistake a Bloom filter promises never to make. So a plain Bloom filter simply has no delete operation.

A counting Bloom filter swaps each switch for a small tally counter. Adding an item clicks its counters up; removing it clicks them down. Switch nine would read 2 after Alice and Bob arrive and 1 after Alice leaves, so Bob's evidence is preserved. The price is memory: a four-bit counter takes four times the space of a bit, and if a counter ever hits its maximum you must freeze it rather than let it wrap around. Many systems avoid deletion altogether by rebuilding the filter from scratch periodically instead.`,
      mustMention: [
        'Shared bits mean clearing one can erase another element (false negative)',
        'Counting filter uses small counters; delete is decrement',
        'About 4x memory cost and overflow handling',
        'Alternative: rebuild immutable filters (as compaction does)',
      ],
    },
    {
      id: 'fe3',
      concept: 'Bloom filters in LSM-tree databases',
      prompt: 'Explain to a colleague why Cassandra and RocksDB attach a Bloom filter to every SSTable and what it saves.',
      modelExplanation: `Cassandra and RocksDB never overwrite data in place. Writes land in memory and are flushed into immutable sorted files called SSTables. Over time a single key may be in any one of dozens of files, and the only way to know is to look. Each look is a disk seek, and for a key that does not exist at all you would seek into every file and find nothing.

So each SSTable carries a small Bloom filter of its keys, built when the file is written and kept in RAM. Before opening a file, the database asks its filter. "Definitely not here" means skip it with zero disk I/O. "Maybe" means open it and check the index. With a 1% filter and ten files, a read for a missing key opens about a tenth of a file on average instead of ten.

Deletion is never needed because SSTables are immutable: when compaction merges files, it writes a fresh filter for the merged result. That is why the "no delete" limitation costs these databases nothing.`,
      mustMention: [
        'SSTables are immutable; a key can be in many files',
        'One in-memory filter per SSTable, built at flush time',
        'Filter "no" skips the disk seek; "maybe" opens the file',
        'Compaction rebuilds filters, sidestepping deletion',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You are a night guard walking through a vast library vault where a wall of light switches by the door records every book ever shelved. Each stop anchors one idea about Bloom filters.',
    stops: [
      { locus: 'The switch wall at the vault door', concept: 'Bit array plus k hash functions', image: 'A wall of ten thousand brass switches. A librarian feeds a book title into seven clattering cipher wheels; each wheel spits out a number and she flips that switch ON with a loud clack. The book itself is thrown into a chute and gone.' },
      { locus: 'The "NO" trapdoor', concept: 'No false negatives', image: 'You ask about a title; one of its seven switches is still down. A trapdoor opens under you with a brass plaque: DEFINITELY NOT HERE. You fall straight out of the vault without ever touching a shelf.' },
      { locus: 'The mirror maze of maybes', concept: 'False positives from overlapping bits', image: 'All seven switches glow for a book that was never shelved. In a hall of mirrors you see seven other books each lending one lit switch, grinning. The sign reads MAYBE (1 in 100 of these are lies).' },
      { locus: 'The tailor\'s measuring tape', concept: 'Sizing: 9.6 bits per element for 1%', image: 'A tailor measures each book against a tape with exactly 9.6 notches and mutters "seven stitches" (k = 7). For every extra 4.8 notches he grants a tenfold-smaller chance of error.' },
      { locus: 'The switch that snaps in half', concept: 'No deletion', image: 'A clumsy assistant flips a switch OFF to "remove" a book. The switch snaps and a ghostly book that shared it vanishes from the records, wailing "I was still here!". The head librarian screams: never flip a switch off.' },
      { locus: 'The tally-counter wall in the annex', concept: 'Counting Bloom filters', image: 'Next door, every switch is a brass click-counter reading 0-15. Books click up on arrival and down on leaving. The wall is four times bigger and one counter stuck at 15 is padlocked with a sign: SATURATED, NEVER DECREMENT.' },
      { locus: 'The row of sealed filing cabinets', concept: 'SSTable filters in Cassandra / RocksDB', image: 'Ten sealed steel cabinets, each with its own tiny switch panel on the front. You check the panels first; nine say NO and stay locked, one hums MAYBE and its drawer slides open with a hiss of cold air.' },
      { locus: 'The crawler spider on the ceiling', concept: 'Seen-URL sets and one-hit wonders', image: 'A giant mechanical spider weaves a web of billions of URLs across the ceiling; it carries only a matchbox-sized switch panel yet never re-visits a strand. A CDN gargoyle beside it refuses to cache any object until the panel has seen it twice.' },
      { locus: 'The exit turnstile', concept: 'When not to use one', image: 'A turnstile that beeps for 97 out of 100 visitors because nearly everyone is a member. The guard shrugs: "a filter that almost never says NO is just a slower door".' },
    ],
  },
  interviewQuestions: [
    'What is a Bloom filter and what guarantee does it make about false negatives and false positives?',
    'How would you size a Bloom filter for 100 million items with a 1% false-positive rate? Show the numbers.',
    'Why can you not delete from a Bloom filter, and what alternatives exist if you need deletion?',
    'Describe how Cassandra or RocksDB use Bloom filters during a read path.',
    'Give a scenario where adding a Bloom filter would make performance worse rather than better.',
    'How would you keep a Bloom filter consistent across multiple application instances and restarts?',
    'What happens to a Bloom filter if you insert far more items than it was designed for, and how would you detect it?',
    'Compare a Bloom filter with a cuckoo filter and a HyperLogLog: what question does each answer?',
  ],
}

export default chapter
