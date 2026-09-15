import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 29,
  slug: 'designing-tinder-feed',
  title: 'Designing Tinder Feed',
  module: 'case-studies',
  estimatedMinutes: 40,
  summary:
    'The Tinder feed (the "deck" of profiles a user swipes through) is a geo-local recommendation system with a brutal latency requirement: the next card must already be there. Designing it means choosing how to find nearby candidates (geohash sharding), when to compute the deck (precomputed versus on demand), how to store billions of swipes, how to detect a mutual like instantly, how to rank by desirability, and how to guarantee a user never sees the same profile twice.',
  objectives: [
    'Shard and index user locations with geohashes so "people within 10 km" is a handful of cell lookups.',
    'Compare precomputed decks with on-demand generation and design the hybrid most apps use.',
    'Store swipes at billions per day and detect a match (mutual like) with a single fast lookup.',
    'Explain ELO-style desirability scoring and why a two-sided marketplace needs it.',
    'Prevent repeats with seen-sets and Bloom filters, and reason about their memory and false-positive trade-offs.',
  ],
  quickRevision: [
    'The feed is a deck of candidate profiles filtered by location, age and gender preference, ranked by a score, minus everyone already seen.',
    'Geohash encodes lat/long into a string where shared prefixes mean nearby; a radius query becomes a lookup of the cell plus its 8 neighbours.',
    'Shard the location index by geohash prefix so a city\'s users live on a few shards; hot cities (Mumbai, NYC) may need finer cells or splitting.',
    'Candidate generation (who is eligible) is cheap and broad; ranking (in what order) is expensive and narrow. Generate 1,000, rank, serve 50.',
    'Precompute decks for active users in the background and cache them in Redis; fall back to on-demand generation for new users, movers and cache misses.',
    'Swipes are append-only facts: (swiper, swipee, direction, ts). Billions per day -> Cassandra or DynamoDB partitioned by swiper.',
    'Match detection: on a right swipe by A on B, check whether B already liked A. Keep a Redis set of "likes received" per user for an O(1) check.',
    'A match is symmetric and must be created exactly once even if both swipe right within milliseconds; use an ordered pair key (min(A,B), max(A,B)) with SETNX or a unique constraint.',
    'ELO-style desirability: each swipe is a "game"; being liked by a highly rated user raises your rating more. Show users candidates of similar rating to balance the two-sided market.',
    'Seen-set: store swiped ids per user; check with a Bloom filter (about 10 bits per element for 1% false positives) before serving, then confirm from the exact store if needed.',
    'A Bloom filter false positive hides a profile the user never saw; that is a cheap error. A false negative (impossible for Bloom) would show a repeat; that is the expensive one.',
    'Cache the deck as a Redis list per user; pop cards as the client fetches them and refill asynchronously when the list drops below a threshold.',
    'Location changes invalidate the deck: a user who flies to another city needs a fresh candidate set, so recompute on significant movement (> a few km).',
  ],
  sections: [
    {
      id: 'problem-shape',
      title: 'What the feed is and why it is hard',
      body: `Open Tinder and a card appears: a person nearby, within your age range, matching your gender preference, whom you have not seen before. Swipe, and the next card is already there. Behind that instant is a **geo-local recommendation pipeline** with unusually tight constraints.

**Functional requirements.** Show a user an ordered deck of candidate profiles who: are within their chosen radius (1-160 km), match age and gender filters, are active recently, are not already swiped by this user, and have not blocked or been blocked by them. Record swipes. When two users like each other, create a match and notify both. Let users update location and preferences at any time.

**Non-functional requirements.** The next card must render in well under 100 ms from the client's perspective, so effectively the deck must be pre-fetched: the client holds 10-20 cards and asks for more when it runs low. Swipe writes are enormous: Tinder has reported on the order of 1.6-2 billion swipes per day, roughly 20k/s average and perhaps 100k/s at evening peak. Reads of the deck are fewer (one fetch per 10-20 swipes) but each one is a complex query. Users are heavily clustered: a few hundred metro areas hold most of the population, and evening peak hours are synchronised within a timezone.

**Why it is hard.** Three tensions define the design:

1. **Freshness versus precomputation.** A deck computed an hour ago may include people who moved away, went inactive, or already swiped left on you. A deck computed on demand is fresh but expensive at peak.
2. **Two-sidedness.** Unlike a movie recommender, the candidate is also a user with preferences. Showing the most popular profiles to everyone floods them with likes they will never answer and starves everyone else of matches.
3. **Never repeat.** Users notice repeats immediately and it destroys trust in the product. The seen-set grows without bound (a heavy user swipes tens of thousands of profiles) and must be checked for every card served.

The rest of this chapter takes these apart: finding candidates by location, building the deck, storing swipes and matching, scoring, and de-duplicating.`,
      mentalModel:
        'A speed-dating organiser in a stadium: they have to seat you only with people in your section (geo), whom you have not already met (seen-set), in an order that gives everyone a fair shot (scoring), and the next chair must be ready before you stand up (prefetch).',
      diagram: `user prefs + location
        |
        v
[Candidate generation] -- geo cells + age/gender/activity --> ~1,000 ids
        |
[Exclusion] -- seen-set, blocks -----------------------------> ~800 ids
        |
[Ranking] -- desirability, freshness, distance --------------> top 50
        |
[Deck cache] -- Redis list per user ------------------------> client
        |
   swipes --> swipe store --> match check --> notify both`,
      keyPoints: [
        'Feed = filter by geo, age, gender, activity; exclude seen and blocked; rank; serve a prefetched deck.',
        'Writes (swipes, ~2B/day) dwarf deck reads; both are bursty and geographically clustered.',
        'Tensions: freshness vs precomputation, two-sided fairness, never repeating a profile.',
        'The client prefetches 10-20 cards so per-card latency is effectively zero.',
      ],
      checkpoint: {
        question:
          'Why is "show the most attractive profiles first to everyone" a bad ranking rule for a dating app even though it maximises right swipes?',
        answer:
          'It is a two-sided market. The top profiles receive thousands of likes they cannot possibly answer, so most of those right swipes produce no match, while ordinary profiles get shown rarely and get few likes. Matches, not right swipes, are the product outcome, and matches require both sides to be interested.',
      },
    },
    {
      id: 'geo-sharding',
      title: 'Finding people nearby: geohash and geo-sharding',
      body: `"Everyone within 10 km" over 100 million users is the core query, and a naive \`WHERE distance(lat, lng, me) < 10\` is a full table scan. The trick is to turn a 2D radius query into a small number of 1D key lookups.

**Geohash.** Interleave the bits of latitude and longitude and encode in base-32. The result is a string like \`tdr1w\` where each extra character subdivides the cell 32 ways: 4 characters is roughly 39 km x 20 km, 5 characters about 5 km x 5 km, 6 characters about 1.2 km x 0.6 km. Crucially, points that share a prefix are close together, so a prefix range scan finds a whole cell. (Google S2 cells and Uber H3 hexagons solve the same problem with better geometry; H3's hexagons have uniform neighbour distances and are what Uber uses for driver matching. Geohash is the simplest to explain and is what Redis GEO commands use under the hood.)

**Edge problem.** Two users 200 m apart can sit on opposite sides of a cell boundary and have different geohashes. So a radius query always fetches the target cell **plus its 8 neighbours**, then filters by exact haversine distance. For a 10 km radius use 5-character cells (~5 km); for 160 km use 3-character cells.

**Indexing.** Store \`geohash5 -> set of user ids\` in Redis (or a sorted set scored by last-active time so you can take only recent users). Alternatively use Redis \`GEOADD\` / \`GEOSEARCH\`, which implement exactly this over a sorted set. For a persistent index, Elasticsearch geo_point queries or Postgres with PostGIS and a GiST index work but are heavier per query.

**Sharding by geography.** Partition the location index by geohash prefix (say the first 3 characters) so that all users of a metro area live on one or a few shards, and a candidate query touches one shard rather than fanning out to all. The cost is **hot shards**: Mumbai's 3-character cell holds millions of users while a rural cell holds hundreds. Fixes: split hot cells to a finer prefix (adaptive cell depth), or hash the cell id with consistent hashing onto physical nodes so multiple hot cells do not land on the same node. Do not shard user profiles themselves by location; users move, and moving a profile between shards on every GPS update is churn you do not want. Shard the *index* by geo, the *profiles* by user id.

**Location updates.** The app reports location on open and on significant movement. Updating the index is a remove from the old cell set and add to the new one; do it only when the cell changes, which for most users is rarely.`,
      mentalModel:
        'A geohash is a postal code that gets more precise the more characters you read. To find neighbours you check your postcode and the eight surrounding ones, because your next-door neighbour might technically be in the adjacent postcode.',
      diagram: `Geohash precision:  3 chars ~156x156 km | 5 chars ~5x5 km | 6 ~1.2x0.6 km

Radius query, 10 km, user in cell tdr1w:
   +------+------+------+
   | tdr1t| tdr1v| tdr1y|
   +------+------+------+
   | tdr1s|[tdr1w]| tdr1x|   fetch 9 cells -> exact haversine filter
   +------+------+------+
   | tdr1e| tdr1g| tdr1u|
   +------+------+------+
Shard index by prefix "tdr" -> metro on one shard; split if hot`,
      keyPoints: [
        'Geohash turns lat/long into a prefix-friendly string; shared prefix means nearby; each character subdivides 32x.',
        'Always query the cell plus 8 neighbours and filter by exact distance to fix boundary effects.',
        'Redis sets or GEOSEARCH per cell give millisecond candidate lookups; PostGIS/Elasticsearch are heavier alternatives.',
        'Shard the location index by geohash prefix for locality; handle hot metros by splitting cells or consistent hashing.',
        'Shard profiles by user id, not location, because users move.',
      ],
      checkpoint: {
        question:
          'A user in Manhattan sets a 2 km radius. Which geohash precision would you query and roughly how many cells?',
        answer:
          'Use 6-character cells (~1.2 km x 0.6 km) and fetch the user\'s cell plus its 8 neighbours, 9 cells covering roughly 3.6 km x 1.8 km, then filter to exactly 2 km. In dense Manhattan those 9 cells may still contain tens of thousands of users, so the age/gender/activity filters and a cap matter.',
      },
    },
    {
      id: 'deck-generation',
      title: 'Building the deck: precomputed vs on-demand',
      body: `Given a way to find nearby users, the next question is *when* to assemble a user's deck.

**On-demand.** When the client asks for cards, run the full pipeline: fetch candidates from the 9 geo cells, filter by age, gender preference (both directions: I must match their preference too), recent activity and blocks, remove the seen-set, score, sort, return 20. This is always fresh and needs no background jobs. The cost is latency (several Redis round trips plus scoring, perhaps 50-150 ms) and peak CPU: at 8-10 p.m. every user in a timezone opens the app at once and every request does the heavy lifting.

**Precomputed.** A background job periodically builds each active user's deck (say 200 ranked candidates) and stores it in Redis as a list. Serving is an \`LRANGE\`/\`LPOP\` of a few cards: sub-millisecond. Batch computation smooths the peak and can use a heavier ranking model. The costs: staleness (a candidate may have moved, deactivated or swiped left on you since), wasted work for users who never open the app, and a cold start for new users and users who change location or preferences.

**The hybrid that production systems use.**

- Maintain a precomputed deck for users active in the last N days; refresh it when it is consumed below a threshold (e.g. fewer than 20 cards left), when it is older than a TTL (a few hours), or when the user moves more than a few km or changes preferences.
- On a cache miss (new user, expired deck, moved user), generate on demand but with a smaller candidate pool and a lighter ranker, and kick off a full background rebuild.
- Refill asynchronously: when the client fetches cards and the list drops below the threshold, enqueue a refill job (Kafka or SQS); the next fetch finds fresh cards.
- Apply cheap **serve-time filters** on the precomputed list to cover staleness: drop candidates who deactivated, blocked, or already swiped left on this user since the deck was built. These are Redis checks, not a rebuild.

**Two-way eligibility.** Candidate B must match A's filters, and A must match B's filters. Otherwise A likes B, B never sees A, and A's like is wasted. Enforce the reverse check at generation time; it roughly halves the candidate pool and dramatically improves match rates.

**Sizing.** 10M daily active users, 200 candidates x 8-byte ids = 1.6 KB per deck, 16 GB of Redis. Comfortable. Rebuilding each deck once every few hours is a few thousand builds per second in aggregate, spread evenly by a job queue.`,
      mentalModel:
        'A restaurant preps ingredients before the dinner rush (precompute) and still cooks each plate to order (serve-time filtering). Prepping nothing means chaos at 8 p.m.; prepping everything means throwing away food.',
      diagram: `client GET /deck  -->  Redis list deck:{userId}
                          | >= 20 cards?  LPOP 10, serve-time filter, return
                          | < 20 cards?   serve what exists, enqueue refill
                          | missing?      on-demand light build, enqueue full

refill worker: geo cells -> filters (two-way) -> minus seen -> rank -> RPUSH
triggers: low cards | TTL expired | moved > 3 km | prefs changed`,
      keyPoints: [
        'On-demand is fresh but expensive at synchronised evening peaks; precomputed is fast and smooth but stale and wasteful.',
        'Hybrid: precomputed deck in Redis, async refill below a threshold, on-demand light build on miss, serve-time freshness filters.',
        'Rebuild triggers: low card count, TTL, significant movement, preference change.',
        'Enforce two-way eligibility at generation so likes are never sent to people who cannot see you.',
        '10M DAU x 200 ids is only ~16 GB of Redis; deck storage is cheap.',
      ],
      checkpoint: {
        question:
          'A user lands in a new city after a flight and opens the app. Their precomputed deck is full of people from home. What should happen?',
        answer:
          'The location update shows movement far beyond the threshold, so the deck is invalidated. The first fetch does an on-demand light build from the new city\'s geo cells (a smaller pool, lighter ranking) so the user sees relevant cards within ~100 ms, while a full background rebuild replaces it shortly after.',
      },
    },
    {
      id: 'swipes-and-matching',
      title: 'Storing swipes and detecting a match',
      body: `A swipe is a fact: user A saw user B at time t and swiped left or right. At ~2 billion per day it is one of the largest write streams in consumer apps, and the match check that follows every right swipe must be instant.

**Swipe storage.** Swipes are append-only, never updated, and read in two ways: "has A swiped B?" and "list of people who liked A". A wide-column store fits: Cassandra or ScyllaDB (or DynamoDB) with partition key \`swiper_id\`, clustering key \`swipee_id\`, columns \`direction, ts\`. Writes are O(1) and spread across the cluster because swiper ids are uniformly distributed. At 2B/day x ~50 bytes that is 100 GB/day, ~36 TB/year before replication; with RF=3 about 110 TB/year. Left swipes can be TTL'd after some months (many apps re-show left-swiped profiles eventually, which conveniently bounds the seen-set); right swipes are kept.

**The swipe write path.** The client sends the swipe; the API writes it to Cassandra (or to Kafka first for durability and async fan-out, with Cassandra written by a consumer). Also update the derived structures the feed needs: add \`swipee\` to A's seen-set, and if it is a right swipe, add A to B's **likes-received** set.

**Match detection.** When A swipes right on B, a match exists if B has already swiped right on A. The naive check reads Cassandra: \`SELECT direction FROM swipes WHERE swiper=B AND swipee=A\`. That is a single-partition point read, a few milliseconds, and it is fine. Faster: maintain in Redis a set \`likes_received:{userId}\` of everyone who liked that user. On A's right swipe, check \`SISMEMBER likes_received:A B\`; if true, it is a match. O(1) and sub-millisecond, and the set is also the source for the "people who liked you" premium feature.

**Creating the match exactly once.** If A and B swipe right on each other at nearly the same instant, both requests see the other's like and both try to create the match. Use a canonical key: \`match:{min(A,B)}:{max(A,B)}\`. Create with \`SET ... NX\` in Redis or an \`INSERT\` into a table with a unique constraint on the ordered pair; whichever request wins creates the match record and emits the match event; the loser sees the conflict and does nothing. The match event goes to Kafka, where consumers create the chat conversation, send push notifications to both and update analytics.

**Blocks and unmatches.** A block or unmatch is a write to a small \`blocks\` table and an eviction from both users' decks and likes-received sets. Candidate generation excludes blocked pairs in both directions.`,
      mentalModel:
        'Every right swipe is dropping your card into someone\'s mailbox. A match is opening your own mailbox and finding their card already there. The mailbox lock (the ordered-pair key) ensures that if you both reach for the door at once, only one of you announces the good news.',
      diagram: `A swipes right on B
   |-- write swipe (A,B,right,ts) -> Cassandra (partition A)
   |-- SADD seen:A B
   |-- SADD likes_received:B A
   |-- SISMEMBER likes_received:A B ?
         | no  -> done
         | yes -> SET match:{min}:{max} NX
                    | won  -> Kafka "match" -> chat, push A & B
                    | lost -> other request already created it`,
      keyPoints: [
        'Swipes are append-only; store in Cassandra/DynamoDB partitioned by swiper id: ~100 GB/day at 2B swipes.',
        'On each swipe update derived sets: seen-set of the swiper and likes-received of the swipee.',
        'Match check is SISMEMBER on the swiper\'s likes-received set: O(1).',
        'Create the match exactly once with a canonical ordered-pair key and SETNX or a unique constraint.',
        'Match events flow through Kafka to chat creation, notifications and analytics.',
      ],
      checkpoint: {
        question:
          'Redis loses the likes_received sets in a failover. What breaks and how do you recover?',
        answer:
          'Match detection would miss mutual likes (no false matches, only missed ones), and the "who liked you" feature would be empty. Recover by rebuilding the sets from the swipe store (a scan of right swipes by swipee, or from a Kafka replay) and in the meantime fall back to the Cassandra point read for the match check, which is slower but correct.',
      },
    },
    {
      id: 'scoring',
      title: 'Ranking: desirability, ELO and a balanced market',
      body: `Candidate generation produces hundreds of eligible people. The order in which they appear decides the match rate, and the naive orderings fail.

**Recency or distance only** is fair but ignores the strongest signal you have: what this user and others have liked. **Popularity only** (most right swipes received) sends everyone to the same few profiles, who cannot reciprocate at that volume, and buries everyone else.

**ELO-style desirability.** Tinder publicly described (and later said it moved beyond) an ELO-like score. The idea borrows from chess: every swipe is a game. If a highly rated user swipes right on you, your rating rises a lot; if a low-rated user does, it rises a little; a left swipe from a high-rated user costs little, from a low-rated user costs more. Formally, expected outcome \`E = 1 / (1 + 10^((R_other - R_me)/400))\`, update \`R_me += K x (actual - E)\`. The score converges to a stable estimate of how the population responds to a profile.

**Why it matters for ranking.** Showing users candidates of **similar** desirability maximises the probability of reciprocation. A rating far above yours is unlikely to swipe back; far below and you are unlikely to swipe right. So the ranker prefers candidates within a band around your score, mixed with some exploration outside the band so ratings can move and new users get data.

**Beyond ELO.** Modern rankers are learned models predicting P(A likes B) x P(B likes A) from features: desirability scores, mutual-like history with similar profiles (collaborative filtering), activity recency (an active user will actually see and answer your like), distance, profile completeness, photo quality signals, and shared interests. The product of the two probabilities is the expected-match objective, which directly encodes two-sidedness. Training data is abundant: every swipe is a label.

**Freshness and diversity rules** sit on top: boost new users so they get early data and encouragement, boost users active in the last hour, cap how many times a profile is shown per day so nobody is over-exposed, and avoid runs of very similar profiles.

**Computing scores.** Desirability updates are incremental per swipe (a Kafka consumer of the swipe stream updates a Redis hash or a Cassandra row). Model features are precomputed per user in a feature store and joined at ranking time; the ranking itself runs in the refill worker over a few hundred candidates, so it can afford a few milliseconds per candidate.`,
      mentalModel:
        'A chess ladder for attention: beating a grandmaster (being liked by someone highly sought after) moves you up far more than beating a beginner. Pairing players of similar rating produces the most interesting games, and the most matches.',
      keyPoints: [
        'Popularity-only ranking floods top profiles and starves the rest; matches, not likes, are the goal.',
        'ELO-style: a right swipe from a high-rated user raises your score more; converges to a population estimate of desirability.',
        'Rank candidates within a band around the user\'s own score, with exploration for new users.',
        'Learned rankers optimise P(A likes B) x P(B likes A), the expected-match objective.',
        'Scores update incrementally from the swipe stream; ranking happens in the refill worker over hundreds of candidates.',
      ],
      checkpoint: {
        question:
          'A brand-new user has no swipes received. What rating do you give them and how do you avoid them being invisible?',
        answer:
          'Start them at the population median (like a chess provisional rating with a high K factor so it moves quickly) and apply a new-user boost for the first days so they are shown widely, gathering the swipes needed for the rating to converge. Without the boost, a median rating in a competitive area could leave them rarely shown.',
      },
    },
    {
      id: 'avoiding-repeats',
      title: 'Never show the same profile twice: seen-sets and Bloom filters',
      body: `Repeats are the most visible failure of a swipe feed. Preventing them means, for every card served, answering "has this user ever seen this profile?" against a set that can hold tens of thousands of ids per heavy user and billions in total.

**Exact seen-set.** A Redis set \`seen:{userId}\` of swiped ids. Checking is O(1), adding is O(1). Memory: a user who has swiped 50,000 profiles holds 50k x 8 bytes plus set overhead, roughly 1-2 MB. Across 10M active users with an average of 3,000 swipes each that is 30 billion entries and several hundred GB, which is expensive in RAM. The exact set also lives durably in Cassandra (it is just the swipes table partitioned by swiper), so Redis is a cache, not the source of truth.

**Bloom filter.** A probabilistic set that answers "definitely not seen" or "probably seen". With k hash functions over an m-bit array, an element is inserted by setting k bits and queried by checking them all. At about 10 bits per element it gives ~1% false positives; 15 bits gives ~0.1%. A heavy user's 50k swipes fit in ~60 KB instead of ~1.5 MB, a 25x saving. Redis supports it via the RedisBloom module (\`BF.ADD\`, \`BF.EXISTS\`, \`BF.MADD\`, \`BF.MEXISTS\`), and scalable Bloom filters grow as the user swipes more.

**Which error is acceptable?** A Bloom filter never has false negatives: if it says "not seen", the profile was truly never inserted, so it is safe to serve. A false positive says "probably seen" about a profile the user never saw, so that profile is skipped. For a feed with hundreds of candidates, skipping 1% of never-seen profiles is invisible to the user. The asymmetry is exactly right: the cheap error (hide a fresh profile) is the only one possible, and the expensive error (show a repeat) cannot happen. If exactness matters for a premium feature, check the Bloom first and confirm positives against Cassandra; with 1% positives that is 1 point read per 100 candidates.

**Where the check runs.** In the refill worker, filter the candidate pool through the Bloom filter (one \`BF.MEXISTS\` with hundreds of ids) before ranking, and again at serve time for the handful of cards being popped, because the user may have swiped on another device since the deck was built. Insert into the filter on every swipe write.

**Bounding the set.** Many apps recycle left swipes after some months: the seen-set for left swipes expires (Cassandra TTL, and a fresh Bloom filter built periodically from the non-expired swipes), so the deck never runs completely dry in a small town. Right swipes and matches stay excluded permanently; they are in the likes-received and matches structures anyway.`,
      mentalModel:
        'A bouncer with a perfect memory for faces (exact set) versus a bouncer who remembers a hash of each face (Bloom filter): the second one occasionally turns away someone new who resembles a regular, but never lets a regular in twice.',
      diagram: `Bloom filter, m bits, k hashes
insert(x): set bits h1(x), h2(x), h3(x)
query(y):  all k bits set?  -> "probably seen" (maybe false positive)
           any bit clear?   -> "definitely not seen" (safe to serve)

Memory per heavy user (50k swipes):
  exact Redis set  ~1.5 MB   |   Bloom @10 bits/elem  ~60 KB (1% FP)

Pipeline: candidates(1000) --BF.MEXISTS--> unseen(~990) --rank--> deck
serve:    LPOP 10 --BF.MEXISTS--> drop any swiped since build`,
      keyPoints: [
        'The exact seen-set is the swipes table by swiper; caching it in Redis for all users is hundreds of GB.',
        'A Bloom filter at ~10 bits per element gives ~1% false positives and a 20-25x memory saving.',
        'Bloom filters have no false negatives, so a repeat is impossible; false positives only hide fresh profiles, which is cheap.',
        'Filter candidates in bulk with BF.MEXISTS in the refill worker and again at serve time for multi-device consistency.',
        'Recycling left swipes after months bounds the set and keeps small-town decks from running dry.',
      ],
    },
    {
      id: 'end-to-end-and-scale',
      title: 'End-to-end flow, caching and hot spots',
      body: `Putting the pieces together, two request paths dominate: **fetch deck** and **swipe**.

**Fetch deck.** The client calls \`GET /feed?count=10\`. The API checks \`deck:{userId}\` in Redis. If it has enough cards, it pops 10 ids, runs the serve-time filters (Bloom filter for recent swipes, block list, deactivated flag), hydrates profiles (photos, name, age, distance, bio) from a profile cache (Redis hash per user, backed by Postgres or Cassandra; photos are CDN URLs), and returns. Hydration is the biggest cost: 10 profile fetches, batched with \`MGET\`. If the deck is low, it enqueues a refill; if missing, it does an on-demand light build. Target p99 under 100 ms.

**Swipe.** \`POST /swipe {target, direction}\`. The API validates that the target was actually served to this user recently (prevents scripted mass-liking of ids never shown), writes to Kafka topic \`swipes\` (durability, ordering per swiper via partition key), and synchronously performs the Redis updates needed for correctness now: \`SADD seen\`/\`BF.ADD\`, \`SADD likes_received:target\` on right, and the match check plus \`SETNX\` on the ordered pair. It returns \`{ matched: true|false }\` so the client can show the match animation immediately. Consumers of the \`swipes\` topic write Cassandra, update desirability scores, feed the ranking model's training data, and trigger deck refills for the swipee when they receive many likes.

**Caching layers.** Deck lists, seen Bloom filters, likes-received sets, profile hashes, and location cell sets all live in Redis, sharded by user id (deck, seen, likes, profile) or by geohash prefix (location index). Together they are the hot path; Cassandra is the durable, rebuildable backing.

**Hot spots.** Evening peak in a timezone means the shards for that region\'s geohash prefixes and that region\'s users are hot simultaneously. Use consistent hashing with virtual nodes for user-id shards so load spreads; for the location index, split dense cells to finer prefixes and cache the candidate lists of the hottest cells (\`candidates:{cell}:{ageBand}:{gender}\` with a 1-minute TTL) so 100k users opening the app in Mumbai do not each scan the same sets. A single celebrity profile being shown to everyone is a hot key on the profile cache; per-day exposure caps in the ranker limit this.

**Multi-region.** Users are local, so data can be region-affine: deploy the full stack per region (Americas, Europe, Asia) with users pinned to the region of their home location. Travellers query the region they are in; their swipe and match data can be looked up cross-region on the rare occasions it is needed.`,
      mentalModel:
        'The deck cache is the dealer\'s shoe in blackjack: cards are pre-shuffled (ranked) and dealt instantly, and the dealer reshuffles a fresh shoe behind the table before the current one runs out.',
      diagram: `GET /feed --> Redis deck:{u} --LPOP 10--> serve-time filters
                 |                       BF.MEXISTS seen, blocks, active?
                 |                       MGET profile:{id} x10 -> CDN photo URLs
                 \\-- low? --> Kafka refill:{u} --> worker: geo -> filter -> rank -> RPUSH

POST /swipe --> Kafka swipes (key u) --> Cassandra, desirability, training
             \\-> Redis: BF.ADD seen:u, SADD likes_received:t, match check, SETNX`,
      keyPoints: [
        'Fetch deck: pop from the Redis list, serve-time filter, batch-hydrate profiles; enqueue refill when low.',
        'Swipe: Kafka for durability plus synchronous Redis updates for seen, likes-received and the match check; return matched flag.',
        'Validate that swiped ids were actually served to defeat scripted mass-liking.',
        'Handle hot metros with finer cells and short-TTL cached candidate lists; cap exposure of hot profiles.',
        'Deploy region-affine stacks since users and their candidates are local.',
      ],
      checkpoint: {
        question:
          'Why write the swipe to Kafka and also do synchronous Redis updates, rather than only one of them?',
        answer:
          'Kafka gives durability and an ordered, replayable log for Cassandra, scoring and training, but consumers are asynchronous. The match check and seen-set update must be correct immediately (the client needs the matched flag now and must never be shown the profile again on the next fetch), so those few Redis writes happen synchronously in the request.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'Why does a geohash-based radius query fetch the user\'s cell plus its 8 neighbours?',
      options: [
        'To increase the number of candidates for ranking',
        'Because two nearby points can fall on opposite sides of a cell boundary and have different geohashes',
        'Because Redis requires at least 9 keys per query',
        'To spread load across 9 shards',
      ],
      answerIndex: 1,
      explanation:
        'Geohash cells have hard boundaries; a person 100 m away may be in an adjacent cell. Fetching the neighbours and then filtering by exact distance fixes this. It is a correctness measure, not a load or candidate-volume tactic.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'Which data should be sharded by geohash prefix, and which by user id?',
      options: [
        'Both profiles and the location index by geohash',
        'The location index by geohash prefix; profiles, decks and swipes by user id',
        'Both by user id',
        'Profiles by geohash; the location index by user id',
      ],
      answerIndex: 1,
      explanation:
        'Sharding the index by geography makes "who is near me" a single-shard query. Profiles and swipes are keyed by user and users move, so geo-sharding them would mean migrating data on every trip. Keep them keyed by user id.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'What is the main drawback of fully precomputed decks?',
      options: [
        'They cannot be stored in Redis',
        'They are slower to serve than on-demand generation',
        'Staleness: candidates may have moved, deactivated or swiped left since the build, and new or moved users get a cold start',
        'They require a GPU',
      ],
      answerIndex: 2,
      explanation:
        'Precomputed decks are the fastest to serve, but the data ages between build and consumption, and users whose context changed (new, moved, new preferences) have nothing useful cached. The hybrid design adds serve-time filters and on-demand fallbacks to cover this.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which events should trigger a rebuild of a user\'s precomputed deck? Select all that apply.',
      options: [
        'The deck has fewer than 20 cards left',
        'The user moved more than a few kilometres',
        'The user changed their age range or gender preference',
        'The user viewed their own profile',
        'The deck is older than its TTL',
      ],
      answerIndices: [0, 1, 2, 4],
      explanation:
        'Low card count, significant movement, changed preferences and TTL expiry all invalidate or exhaust the deck. Viewing your own profile changes nothing about your candidates.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement: 'A Bloom filter used as a seen-set can cause the feed to show a user a profile they have already swiped on.',
      answer: false,
      explanation:
        'Bloom filters have no false negatives: anything inserted is always reported as present. The only error is a false positive, which hides a profile the user has not seen, a harmless outcome for a feed of hundreds of candidates.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question: 'Users A and B swipe right on each other within the same millisecond on different API servers. How do you ensure exactly one match is created?',
      options: [
        'Use a global lock across all API servers for every swipe',
        'Create the match with a canonical key match:{min(A,B)}:{max(A,B)} using SETNX or a unique constraint; the loser does nothing',
        'Delay all match creation by 5 seconds and deduplicate',
        'Let both create a match; the client merges them',
      ],
      answerIndex: 1,
      explanation:
        'An ordered-pair key makes both requests target the same record; an atomic create-if-absent guarantees one winner. A global lock would serialise 100k swipes/s through one point; delays hurt the instant match animation; duplicate matches leak into chat and notifications.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question: 'Under ELO-style desirability scoring, which event raises a profile\'s score the most?',
      options: [
        'A right swipe from a low-rated user',
        'A left swipe from a high-rated user',
        'A right swipe from a high-rated user',
        'Being shown many times without swipes',
      ],
      answerIndex: 2,
      explanation:
        'As in chess, beating (being liked by) a strong opponent yields the largest gain because the expected outcome was low. A like from a low-rated user was expected and moves the score little; a left swipe lowers it; exposure alone is not a game outcome.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: 'Storing swipes in Cassandra partitioned by swiper id gives O(1) writes and a single-partition read for "has A swiped B?".',
      answer: true,
      explanation:
        'Partition key swiper_id and clustering key swipee_id make each write a single-partition append and the existence check a point read. Swiper ids are uniformly distributed, so load spreads evenly.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 2,
      question: 'Why enforce two-way eligibility (the candidate\'s preferences must also match the viewer) at deck generation?',
      options: [
        'It reduces Redis memory',
        'Otherwise a like can be sent to someone who will never see the liker, wasting the like and lowering match rates',
        'It is required by geohash indexing',
        'It makes ELO scores converge faster',
      ],
      answerIndex: 1,
      explanation:
        'If B\'s filters exclude A, B will never be shown A and can never reciprocate, so A\'s right swipe is dead on arrival. Filtering both directions roughly halves the candidate pool but raises the fraction of likes that can become matches.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'Approximately how much memory does a Bloom filter need to hold 50,000 swiped ids at a 1% false-positive rate, compared with an exact Redis set?',
      options: [
        'About 60 KB vs about 1.5 MB',
        'About 6 MB vs about 60 KB',
        'They use the same memory',
        'About 500 bytes vs 50 KB',
      ],
      answerIndex: 0,
      explanation:
        'At roughly 10 bits per element, 50k elements need ~500 kbits = ~60 KB. An exact set of 8-byte ids plus Redis overhead is around 1-2 MB. The Bloom filter is a 20-25x saving.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Estimate storage and throughput for swipes at 2 billion per day, and describe the storage layout and what can be expired.',
      modelAnswer: `**Throughput:** 2B/day = ~23k/s average; evening peaks in populous timezones reach ~80-100k/s. Kafka partitioned by swiper id absorbs this; Cassandra writes at 100k/s need roughly 10-20 nodes depending on hardware.

**Size:** each swipe ~50 bytes (swiper 8, swipee 8, direction 1, ts 8, overhead). 2B x 50 B = 100 GB/day, ~36 TB/year raw, ~110 TB/year at RF=3.

**Layout:** Cassandra table \`swipes (swiper_id PK, swipee_id CK, direction, ts)\` for "has A swiped B" and the seen-set rebuild; a second table or the Redis \`likes_received\` set keyed by swipee for "who liked me" and match detection; \`matches (pair_key PK, a, b, ts)\`.

**Expiry:** left swipes can carry a TTL of, say, 6-12 months (recycling left-swiped profiles bounds the seen-set and keeps small-market decks alive); right swipes and matches are retained. Redis holds Bloom filters for seen-sets and exact sets for likes-received as caches rebuildable from Cassandra or a Kafka replay.`,
      rubric: [
        'Converts daily volume to average and peak per-second rates.',
        'Estimates per-row size and yearly storage including replication.',
        'Describes partitioning by swiper with swipee as clustering key.',
        'Mentions the swipee-keyed structure for matches / who-liked-me.',
        'Identifies left swipes as expirable and explains why.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 3,
      question:
        'Design the deck refill worker: inputs, steps, outputs and how it interacts with the serving path.',
      modelAnswer: `**Trigger:** message on the refill queue (Kafka/SQS) for user U, produced when the deck drops below 20 cards, expires (TTL a few hours), or U moves > 3 km or changes preferences.

**Steps:**
1. Load U's preferences, location, desirability score and blocks.
2. Compute the geohash cell at the precision matching U's radius; fetch user ids from the cell and 8 neighbours (Redis sets, optionally scored by last-active to take only recent users). Cap at ~2,000.
3. Filter: exact distance within radius; age and gender both ways (U matches their prefs too); active within N days; not blocked either way.
4. Exclude seen: one BF.MEXISTS against U's seen Bloom filter; drop positives.
5. Rank: score each remaining candidate with the model (desirability band around U's score, activity recency, distance, exploration boost for new users); apply exposure caps and diversity rules.
6. Write: RPUSH the top ~200 ids to deck:U with a TTL; record build time and location.

**Interaction with serving:** the API only LPOPs and applies cheap serve-time filters (seen since build, blocks, deactivated), so serving stays sub-10 ms plus profile hydration. The worker is idempotent: if two refills race, the deck may temporarily contain duplicates, so the API dedups the few ids it pops against the Bloom filter and a small recently-served set.`,
      rubric: [
        'Names the triggers for a refill.',
        'Describes geo cell lookup with neighbours and two-way filtering.',
        'Uses the Bloom filter for bulk exclusion before ranking.',
        'Describes ranking inputs and writing the list with TTL.',
        'Explains the split between heavy worker work and light serve-time checks.',
      ],
    },
    {
      type: 'mcq',
      id: 'q13',
      difficulty: 1,
      question: 'Why should the swipe API verify that the swiped profile was actually served to this user recently?',
      options: [
        'To reduce Cassandra writes',
        'To prevent scripts from mass-liking arbitrary ids that were never shown, which distorts scores and spams likes-received sets',
        'Because Kafka requires message validation',
        'To compute the distance for ranking',
      ],
      answerIndex: 1,
      explanation:
        'Bots that like every id inflate desirability signals and flood real users\' likes-received sets. Checking against a short-lived set of ids recently served to the user closes this hole cheaply.',
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Geohash', back: 'Interleaved lat/long bits encoded base-32; shared prefix means nearby. 5 chars ~5x5 km, 6 chars ~1.2x0.6 km. Enables prefix/cell lookups instead of distance scans.' },
    { id: 'f2', front: 'Why query 9 geohash cells', back: 'Cell boundaries split close neighbours; fetch the cell plus its 8 neighbours, then filter by exact haversine distance.' },
    { id: 'f3', front: 'What to shard by geo vs by user id', back: 'Location index by geohash prefix (single-shard nearby queries). Profiles, decks, swipes by user id (users move).' },
    { id: 'f4', front: 'Hot geo shard fix', back: 'Split dense cells to finer prefixes (adaptive depth), consistent-hash cells onto nodes, and cache hot cells\' candidate lists with a short TTL.' },
    { id: 'f5', front: 'Precomputed vs on-demand decks', back: 'Precomputed: sub-ms serve, smooth peaks, but stale and cold-start. On-demand: fresh but 50-150 ms and heavy at synchronised peaks. Use a hybrid.' },
    { id: 'f6', front: 'Deck refill triggers', back: 'Fewer than ~20 cards left, TTL expired (few hours), moved > few km, preferences changed. Refill runs async via a queue; on miss do a light on-demand build.' },
    { id: 'f7', front: 'Serve-time filters', back: 'Cheap checks on popped cards: swiped since build (Bloom), blocked, deactivated. Covers staleness without a rebuild.' },
    { id: 'f8', front: 'Two-way eligibility', back: 'Candidate must match viewer\'s filters AND viewer must match candidate\'s filters; otherwise likes go to people who can never see you.' },
    { id: 'f9', front: 'Swipe storage', back: 'Append-only in Cassandra/DynamoDB: partition swiper_id, clustering swipee_id, direction, ts. ~2B/day x 50 B = 100 GB/day.' },
    { id: 'f10', front: 'Match detection', back: 'On A right-swipes B: SISMEMBER likes_received:A B (Redis set of who liked A). O(1). Fallback: Cassandra point read of B\'s swipe on A.' },
    { id: 'f11', front: 'Exactly-once match creation', back: 'Canonical key match:{min(A,B)}:{max(A,B)} created with SETNX or a unique constraint; loser of the race does nothing. Emit match event to Kafka.' },
    { id: 'f12', front: 'ELO-style desirability', back: 'Each swipe is a game: E = 1/(1+10^((R_other-R_me)/400)); R += K(actual-E). Likes from high-rated users raise you most; rank within a band around your own score.' },
    { id: 'f13', front: 'Expected-match objective', back: 'Rank by P(A likes B) x P(B likes A); encodes two-sidedness so popular profiles are not shown to everyone.' },
    { id: 'f14', front: 'Bloom filter as seen-set', back: '~10 bits/element for 1% false positives; 50k swipes ~60 KB vs ~1.5 MB exact. No false negatives, so repeats are impossible; false positives only hide fresh profiles.' },
    { id: 'f15', front: 'Where the seen check runs', back: 'Bulk BF.MEXISTS on candidates in the refill worker before ranking, and again on popped cards at serve time for multi-device consistency.' },
    { id: 'f16', front: 'Recycling left swipes', back: 'TTL left swipes after months and rebuild the Bloom filter so small-market decks do not run dry; keep right swipes and matches excluded permanently.' },
    { id: 'f17', front: 'Swipe request path', back: 'Validate id was served; write to Kafka (key swiper); sync Redis: BF.ADD seen, SADD likes_received:target, match check + SETNX; return matched flag.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Geohash and finding nearby users',
      prompt: 'Explain to a junior developer how the app finds everyone within 10 km without checking the distance to 100 million people.',
      modelExplanation: `Imagine dividing the world into a grid of squares and giving each square a short code, like a postcode. A geohash is exactly that: it turns a latitude and longitude into a string such as "tdr1w", and the more characters you keep, the smaller the square. Five characters is a square about 5 km on a side.

Now store, for each square, the list of users currently in it. To find people within 10 km of you, compute your own square, and look up that square and the eight squares around it (because someone across the street might be just over the edge into the next square). That is nine list lookups instead of 100 million distance calculations. Then run the exact distance formula only on those few thousand people to trim the corners.

We also spread these lists across servers by the first few characters of the code, so a whole city lives together on one server and the query never has to ask every machine. Cities with millions of people get split into smaller squares so no single server melts.`,
      mustMention: [
        'Geohash turns lat/long into a prefix-based string; more characters means a smaller cell',
        'Store user ids per cell; query the cell plus 8 neighbours',
        'Exact distance filter afterwards',
        'Shard the index by prefix for locality; split hot cities',
      ],
    },
    {
      id: 'fe2',
      concept: 'Why decks are precomputed and how staleness is handled',
      prompt: 'Explain why the app prepares your stack of cards in advance and what it does about cards that go out of date.',
      modelExplanation: `Building your stack is real work: find people nearby, check that you fit each other's age and gender preferences, remove everyone you have already seen, then sort by who is most likely to like you back. Doing all of that the moment you open the app would take a noticeable fraction of a second, and at 9 p.m. everyone in your timezone opens the app at once, so the servers would be crushed.

So a background worker builds a stack of about 200 cards for each active user and stores it in Redis. When you fetch cards, the server just pops a few off the list, which takes under a millisecond. When the stack gets low, the worker builds more.

The catch is that the stack ages. Someone in it may have moved away, deleted their account, or swiped left on you since it was built. So before handing you each card, the server runs a couple of cheap checks against live data and silently drops anything that no longer qualifies. And if you land in a new city, the stack is thrown away and a quick, lighter build gives you local cards immediately while the full rebuild runs behind.`,
      mustMention: [
        'Deck building is expensive and peaks are synchronised',
        'Background worker builds ~200 cards into a Redis list; serving pops',
        'Async refill when low',
        'Serve-time filters handle staleness',
        'Invalidate and rebuild on significant movement',
      ],
    },
    {
      id: 'fe3',
      concept: 'Bloom filters for never repeating a profile',
      prompt: 'Explain how the app remembers everyone you have swiped on without storing a huge list in memory, and why the errors it makes are harmless.',
      modelExplanation: `Some users have swiped on 50,000 profiles. Keeping every id in memory for every active user adds up to hundreds of gigabytes. Instead we use a Bloom filter, which is a long row of bits plus a few hash functions. To remember a profile, hash its id a few ways and switch on those bits. To ask "have I seen this?", hash it the same ways and check whether all those bits are on.

If any bit is off, the answer is a guaranteed no: that profile was never inserted, so it is safe to show. If all bits are on, the answer is "probably yes": either you saw it, or a few other profiles happened to switch on the same bits by coincidence. That coincidence is the only kind of error a Bloom filter makes, and here it just means we skip a profile you had not actually seen. Out of hundreds of candidates, skipping one in a hundred is invisible. The error we truly cannot afford, showing you someone twice, is impossible by construction. And the filter for 50,000 swipes is about 60 kilobytes instead of over a megabyte.`,
      mustMention: [
        'Bit array plus k hash functions; insert sets bits, query checks bits',
        'No false negatives: "not seen" is certain, so repeats are impossible',
        'False positives only hide unseen profiles, a cheap error',
        'About 10 bits per element for 1% false positives; large memory saving',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a grand casino floor built inside a city map, from the entrance where you are seated by district, past the card tables, to the vault. Each stop anchors one part of the swipe feed.',
    stops: [
      { locus: 'The entrance floor mosaic', concept: 'Geohash grid and 9-cell lookup', image: 'The floor is a giant mosaic map divided into squares, each tile stamped with a code like TDR1W. You stand on your tile and eight spotlights snap on around you, lighting exactly your square and its eight neighbours while the rest of the floor stays dark.' },
      { locus: 'The district cashier cages', concept: 'Geo-sharding and hot cells', image: 'Cashier cages are labelled by the first three letters of the tile codes. The MUMBAI cage has a queue around the building; a manager slams a hammer down and the cage splits into eight smaller cages, and the queue dissolves.' },
      { locus: 'The dealer\'s pre-shuffled shoe', concept: 'Precomputed deck with async refill', image: 'A dealer deals cards instantly from a pre-shuffled shoe labelled with your name. Behind her, a croupier is already shuffling the next shoe; when hers drops to twenty cards, a red light flashes and the fresh shoe slides in. A card with a coffee stain (stale) is flicked into the discard pile before it ever reaches you.' },
      { locus: 'The two-key gate to each table', concept: 'Two-way eligibility', image: 'Every table has a gate with two locks. Your key fits, but the gate only opens if the person on the other side also turns their key. Gates with only one key turned stay shut, and no one wastes a chip on them.' },
      { locus: 'The mailroom wall of pigeonholes', concept: 'Swipe storage and match detection', image: 'Every right swipe is a chip dropped into someone\'s pigeonhole, filed by whose hand dropped it. You open your own pigeonhole, find their chip already there, and a bell rings MATCH. Two people lunging for the same bell at once find it rings only once: the bell has a single ordered nameplate.' },
      { locus: 'The chess ladder above the bar', concept: 'ELO desirability scoring', image: 'A huge leaderboard above the bar reshuffles with every hand. A newcomer beats the top-ranked player and rockets up twenty rungs; beating the bottom player moves nobody. The floor manager seats people of neighbouring rungs together because those tables produce the most handshakes.' },
      { locus: 'The bouncer with the bead curtain', concept: 'Bloom filter seen-set', image: 'A bouncer guards the re-entry door with a curtain of thousands of beads, some flipped black. He flips a few beads for every face he sees. If any of your beads is still white he waves you in with certainty; if all are black he says "probably seen you" and turns you away, occasionally wrongly, but never lets a regular in twice.' },
      { locus: 'The vault of ledgers', concept: 'Cassandra as durable backing, Redis as cache', image: 'Behind steel doors, endless ledgers record every chip ever dropped, one shelf per player. Upstairs, the fast card tables run on chalkboards that can be wiped and instantly rewritten from these ledgers.' },
    ],
  },
  designPractice: {
    problem:
      'Design the swipe feed for a Tinder-like dating app with 100M registered users, 10M daily active users, and about 2 billion swipes per day. Users see nearby profiles matching their preferences, never see the same profile twice, get an instant match when two users like each other, and the next card must always be ready.',
    steps: [
      {
        title: 'Functional requirements',
        prompt: 'List the functional requirements for the feed, swipes, matching and settings; mark what is out of scope.',
        reference: `**Feed**
- Fetch a deck of N profiles (10-20 per request) that: are within the user's radius (1-160 km); match age range and gender preference in both directions; were active within a recency window; are not already swiped by the user; are not blocked either way; are not the user themself.
- Ranked so that likely mutual matches appear first; new users get exposure.
- Cards contain profile id, name, age, distance (rounded), photos (CDN URLs), bio, and a few verified badges.

**Swipes**
- Record left/right (and super-like) swipes; idempotent per (swiper, swipee).
- Reject swipes on profiles not recently served to the user.
- Undo the last swipe (premium) within a short window.

**Matching**
- Detect mutual right swipes and create exactly one match; notify both users immediately; open a chat conversation.
- Unmatch and block; blocked users disappear from each other's feeds permanently.
- "Who liked you" list (premium).

**Settings**
- Update location (automatic), radius, age range, gender preferences; changes take effect on the next fetch.
- Pause/hide profile; deactivate.

**Out of scope**
- Chat messaging internals, payments, photo moderation, verification flows, and the profile editing UI (we only read profiles).`,
      },
      {
        title: 'Non-functional requirements & estimation',
        prompt: 'Set latency, throughput and consistency targets and estimate QPS, storage and cache sizes.',
        reference: `**NFRs**
- Feed fetch p99 < 100 ms server-side; client prefetches so per-card latency is ~0.
- Swipe p99 < 50 ms including the match answer; the matched flag must be correct immediately.
- No repeats within the retention window; at most ~1% of unseen candidates may be hidden (Bloom false positives).
- Deck freshness: no candidate more than a few hours stale without serve-time filtering; location changes reflected within one fetch.
- Availability 99.95% for feed and swipe; degraded (less fresh) is acceptable, down is not.
- Region-affine data with cross-region lookups for travellers.

**Estimation**
- 10M DAU, ~200 swipes/user/day = 2B swipes/day = ~23k/s average, ~100k/s peak (evening in the largest timezones).
- Feed fetches: one per ~10 swipes = 200M/day = ~2.3k/s average, ~10k/s peak. Each hydrates 10 profiles -> 100k profile reads/s peak from cache.
- Swipe row ~50 B -> 100 GB/day, 36 TB/year raw, ~110 TB/year at RF=3 in Cassandra; TTL left swipes after 6 months to cap at ~60 TB.
- Deck cache: 10M DAU x 200 ids x 8 B = 16 GB (+ overhead ~25 GB) in Redis.
- Seen Bloom filters: average 3,000 swipes/user/6 months for active users, ~10 bits each = ~4 KB; heavy users up to 60 KB. 10M x ~5 KB = 50 GB in Redis.
- Likes-received sets: right swipes ~40% of swipes = 800M/day; average user receives ~80/day, retained 6 months in Redis for active users: 10M x 15k x 8 B ~ 1.2 TB, too large. Keep last 30 days hot in Redis (~200 GB) and full history in Cassandra by swipee; match check falls back to Cassandra for older likes.
- Location index: 100M users x 8 B in cell sets = ~1 GB plus overhead; trivial. Hot cells cached.
- Profile cache: 100M x ~1 KB = 100 GB; keep active users hot (10M x 1 KB = 10 GB).
- Match events: ~1-2% of right swipes -> ~10-15M matches/day, ~150/s; tiny.`,
      },
      {
        title: 'API design',
        prompt: 'Design the feed, swipe, match and settings APIs with request/response shapes and idempotency semantics.',
        reference: `\`\`\`
GET /v1/feed?count=10
-> 200 { "cards": [ { "userId": "u_77", "name": "Asha", "age": 27, "distanceKm": 3,
                      "photos": ["https://cdn/.../1.jpg"], "bio": "...", "servedToken": "st_9k1" } ],
          "deckRemaining": 43 }
   servedToken (or a server-side "served:{me}" set with TTL 1 h) proves the card was shown.

POST /v1/swipes
Idempotency-Key: {me}:{target}
{ "targetId": "u_77", "direction": "right" | "left" | "super", "servedToken": "st_9k1" }
-> 200 { "matched": true, "matchId": "m_4a2" } | { "matched": false }
-> 409 if already swiped on target (return the original result)
-> 422 if target was not served recently

POST /v1/swipes:undo           (premium; only the most recent swipe within 60 s)
GET  /v1/matches?cursor=...    -> [{ matchId, userId, matchedAt, lastMessageAt }]
DELETE /v1/matches/{matchId}   (unmatch)
POST /v1/blocks { "userId": "u_77" }
GET  /v1/likes/received?cursor=...   (premium)

PUT /v1/me/location  { "lat": 19.07, "lng": 72.87 }   -> 204 (client sends on open and on > 500 m movement)
PUT /v1/me/preferences { "radiusKm": 25, "ageMin": 24, "ageMax": 34, "showMe": ["women"] } -> 204
PUT /v1/me/visibility { "paused": true } -> 204
\`\`\`

**Semantics**
- Feed is not idempotent: each call pops cards and moves them to a short-lived "served" set; a client retry after a network failure may lose those 10 cards, which is acceptable (they are re-eligible after the served TTL if unswiped).
- Swipe idempotency is per (swiper, target); a duplicate returns the stored outcome including matched.
- Match notification is delivered via push (through the notification service) and via the WebSocket if the app is open; the swipe response already carries matched so the animation is instant.`,
      },
      {
        title: 'Data model & storage',
        prompt: 'Define the tables and cache structures for profiles, location index, decks, swipes, likes, matches, blocks and scores, with storage choices and keys.',
        reference: `**profiles** (Postgres for source of truth and editing; Redis hash cache for reads)
- \`user_id PK, name, birth_date, gender, show_me, bio, photos (json), last_active_at, paused, geohash6, lat, lng, desirability_score, created_at\`
- Redis \`profile:{id}\` hash, TTL 1 h, invalidated on edit. Photos are S3 objects behind a CDN.

**location index** (Redis)
- \`cell:{geohash5}\` -> sorted set of user ids scored by last_active_at (so ZRANGEBYSCORE takes recent users only). Sharded by prefix (first 3 chars) across a Redis Cluster; hot cells split to geohash6 with a per-cell flag.
- Optionally Redis GEO (\`GEOADD locations lng lat user\`) per prefix shard with \`GEOSEARCH BYRADIUS\`.
- Durable copy: \`geohash6\` column in profiles, so the index can be rebuilt.

**decks** (Redis)
- \`deck:{userId}\` list of candidate ids, TTL 6 h; \`deck_meta:{userId}\` hash { builtAt, lat, lng, prefsHash }.
- \`served:{userId}\` set of ids served in the last hour (TTL) for swipe validation and dedup.

**swipes** (Cassandra/ScyllaDB)
- \`swipes_by_swiper (swiper_id PK, swipee_id CK, direction, ts)\` ; TTL 180 days on left swipes.
- \`likes_by_swipee (swipee_id PK, ts CK desc, swiper_id)\` for who-liked-you and match fallback.
- Redis \`seen:{userId}\` scalable Bloom filter (RedisBloom) rebuilt weekly from swipes_by_swiper; \`likes_received:{userId}\` set of recent likers (30-day sliding, trimmed by a job).

**matches**
- Cassandra or Postgres \`matches (pair_key PK = min:max, user_a, user_b, matched_at, state)\`; per-user view \`matches_by_user (user_id PK, matched_at CK desc, match_id, other_user)\`.
- Redis \`match:{pair_key}\` with NX for the creation race; the durable insert follows.

**blocks**
- \`blocks (blocker_id PK, blocked_id CK, ts)\` in Cassandra; Redis set \`blocked:{userId}\` (both directions materialised) for feed filtering.

**scores / features**
- \`desirability:{userId}\` in a Redis hash plus a periodic snapshot to Cassandra; feature store (per-user aggregates) in Cassandra or a purpose-built store, refreshed by the swipe-stream consumer.

**streams**
- Kafka \`swipes\` (key swiper_id, 7-day retention), \`matches\`, \`location_updates\`, \`deck_refill\` (key user_id).`,
      },
      {
        title: 'High-level design',
        prompt: 'Draw the architecture and walk through a feed fetch, a swipe that produces a match, and a location change.',
        reference: `\`\`\`
 mobile app --> [API gateway / LB] --> [Feed service]      [Swipe service]    [Profile/Settings svc]
                                          |                     |                    |
              Redis Cluster (by user id): deck, served, seen(BF), likes_received, blocked, profile cache
              Redis Cluster (by geo prefix): cell:{geohash} sorted sets
                                          |                     |
                              Kafka: deck_refill, swipes, matches, location_updates
                                 |             |          |            |
                        [Refill workers]  [Swipe sink] [Match fanout] [Index updater]
                              |               |             |              |
                     rank model + features  Cassandra   chat svc,      cell sets,
                                         swipes/likes   notif svc      profiles.geohash
                              [Score updater] <- swipes ->  desirability, training data (S3)
\`\`\`

**Feed fetch.** \`GET /feed?count=10\` for user U in Bangalore. Feed service reads \`deck:U\` (LRANGE/LTRIM 10). For each id it pipelines: \`BF.MEXISTS seen:U ids\`, \`SISMEMBER blocked:U\`, and \`HMGET profile:{id} paused last_active\`; drops anything stale. If fewer than 10 survive, pops more. Adds the served ids to \`served:U\` (TTL 1 h). Hydrates via \`MGET profile:*\` (misses go to Postgres and backfill), computes rounded distance from U's last location, returns. If \`LLEN deck:U\` < 20 it publishes to \`deck_refill\`. If the deck is missing it runs an on-demand light build (one cell layer, 300 candidates, heuristic ranking) and still publishes a full refill. p99 well under 100 ms; the Redis pipeline dominates.

**Swipe with match.** \`POST /swipes {target: V, right}\`. Swipe service checks \`SISMEMBER served:U V\` (else 422), writes to Kafka \`swipes\` (key U), then in one Redis pipeline: \`BF.ADD seen:U V\`, \`SADD likes_received:V U\`, \`SISMEMBER likes_received:U V\`. It returns true, so it runs \`SET match:{min(U,V)}:{max(U,V)} 1 NX\`. It wins, writes the match row, publishes to \`matches\`, and responds \`{matched: true}\` in ~10 ms. The match fan-out consumer creates the conversation in the chat service and calls the notification service for V (and U if the app is backgrounded). The swipe sink consumer writes both Cassandra tables; the score updater adjusts V's desirability upward according to U's rating.

**Location change.** The app reports U now in Mumbai. Settings service updates \`profiles.lat/lng/geohash6\`, publishes to \`location_updates\`. The index updater does \`ZREM cell:{oldCell} U\` and \`ZADD cell:{newCell} now U\`. The feed service compares U's new location with \`deck_meta:U\`; the delta exceeds 3 km, so it deletes \`deck:U\` and publishes a refill; the next fetch goes through the on-demand light path with Mumbai candidates.`,
      },
      {
        title: 'Deep dive & bottlenecks',
        prompt: 'Go deep on (1) the refill worker and ranking, (2) match correctness under concurrency and Redis failure, and (3) hot metros at evening peak. Name the bottlenecks and mitigations.',
        reference: `**1. Refill worker and ranking**
- Consumes \`deck_refill\` keyed by user id so one user's refills serialise on one partition (avoids duplicate concurrent builds; also coalesce: if a build finished in the last 60 s, skip).
- Candidate generation: cells at precision from radius (3 chars for 160 km, 5 for 10-25 km, 6 for < 3 km); \`ZRANGEBYSCORE cell:X (now-14d) +inf LIMIT 0 500\` across 9 cells for recently active users; cap 2,000. Dense cells: sample rather than take the first 500 (ZRANDMEMBER or random offset) to avoid everyone getting the same candidates.
- Filters: exact distance; age (from cached birth_date); gender both ways; paused; blocked either way (SISMEMBER on \`blocked:U\` and a reverse-block set); Bloom seen check in one \`BF.MEXISTS\`.
- Ranking: score = w1 x P(U likes c) + w2 x P(c likes U) from a lightweight model over features (desirability gap, distance, activity recency, profile completeness, mutual interests, collaborative signals), with a new-user boost and an exposure cap per candidate per day (Redis counter \`exposure:{c}:{day}\`). Sort, take 200, RPUSH with TTL.
- Cost: ~20-40 ms per build; peak refills ~10k/s x 1/10 fetches -> ~1k builds/s, ~40 CPU-seconds/s: a few dozen worker instances. Bottleneck: Redis round trips; pipeline aggressively and co-locate workers in the same zone as Redis.

**2. Match correctness**
- Race: both users swipe right simultaneously. Each request adds itself to the other's likes_received, then checks the other's set. Order within a single Redis pipeline is not atomic across two different keys on two shards, so both may see the other's like (good) or, in theory, neither sees it if both check before both add. Fix: perform ADD-then-CHECK as two steps in that order per request; then at least one request must observe the other's add (the second ADD to complete happens-before that request's CHECK). Both may observe it, which is why the SETNX on the canonical key is required.
- Redis failover loses recent likes_received entries: match detection degrades to missed matches. Mitigations: AOF with everysec fsync plus replicas; on failover run a reconciliation job that replays the last N minutes of the Kafka swipes topic to rebuild sets; and a periodic batch job over \`likes_by_swipee\` that finds mutual likes with no match row and creates the match late (a "you matched!" notification a minute late beats never).
- Idempotency: \`Idempotency-Key {U}:{V}\` stored with the outcome so a client retry returns the same matched flag; Cassandra writes are naturally idempotent (same primary key).

**3. Hot metros at peak**
- Symptom: 8-11 p.m. IST, Mumbai and Delhi cells and their users' deck/seen/likes keys all peak together, and every refill scans the same few cells.
- Cache the filtered candidate pool per (cell, age band, gender pair) for 60 s: \`pool:{cell}:{band}:{g}\` so 50k refills in one metro share the same base list and only do per-user exclusion and ranking.
- Split hot cells to geohash6 automatically when \`ZCARD\` exceeds ~50k; the refill reads 9 finer cells, more keys but each small.
- Redis Cluster with many small shards and consistent hashing spreads user-keyed load; rebalance slots ahead of predictable peaks.
- Pre-warm: refill decks for users likely to open the app in the next hour (predicted from habit) during the 6-8 p.m. lull.
- Exposure cap prevents the metro's top profiles from becoming hot keys in the profile cache; replicate the profile cache read-only for hot ids if needed.
- Kafka: 100k swipes/s x 100 B = 10 MB/s, trivial; Cassandra at 100k writes/s is the real sizing item: ~15-20 nodes with SSDs, partition by swiper spreads evenly.`,
      },
      {
        title: 'Failure modes & trade-offs',
        prompt: 'Enumerate failure scenarios and the system\'s behaviour, then summarise the trade-offs you chose and what you would revisit at 10x scale.',
        reference: `**Failure scenarios**
- *Redis deck shard down*: feed falls back to on-demand light builds (slower, p99 ~150 ms, higher CPU); autoscale feed service. Degraded, not down.
- *Redis seen (Bloom) shard down*: cannot guarantee no repeats from cache. Options: fall back to Cassandra \`swipes_by_swiper\` point reads for the 10 popped cards (10 reads, ~5 ms), or serve only from decks built before the outage (already filtered). Chose the Cassandra fallback; never serve unchecked.
- *Redis likes_received down*: match check falls back to a Cassandra point read on \`swipes_by_swiper(V, U)\`; slower but correct. Reconciliation job after recovery.
- *Cassandra degraded*: swipes still land in Kafka (durable); Redis structures still update, so the product keeps working; the sink catches up. Kafka retention of 7 days bounds the risk.
- *Kafka down*: swipe service writes Redis and spools swipe events to local disk or a fallback queue; alarms. Feed continues from cached decks. Losing swipe durability is the worst outcome, so the spool is mandatory.
- *Refill workers lag*: decks run dry; the feed's on-demand path absorbs; alert on \`deck_refill\` consumer lag > 30 s.
- *Location index corruption or drift*: rebuild from \`profiles.geohash6\` (a scan of 100M rows, minutes with parallelism); meanwhile queries hit slightly stale cells.
- *Duplicate deck entries from racing refills*: serve-time dedup against \`served:U\` and the Bloom filter; coalescing builds in the worker reduces the race.
- *Scripted mass-liking / bots*: served-token check, per-user swipe rate limits (e.g. 1 swipe/s sustained), velocity anomaly detection on the swipe stream, and exclusion of flagged accounts from desirability updates.
- *Traveller sees empty deck in a small town*: widen radius progressively at generation (10 -> 25 -> 50 km) and recycle expired left swipes; tell the user honestly when the pool is exhausted.
- *Match created twice*: prevented by the canonical NX key; the durable insert uses the same key as the primary key, so even a Redis flush cannot cause a second row.
- *Undo swipe*: remove from likes_received and the exact swipe row; the Bloom filter cannot delete, so an undone profile stays hidden until the weekly rebuild. Acceptable and documented; or use a counting Bloom filter / cuckoo filter (RedisBloom CF) if undo must re-show immediately.

**Key trade-offs**
- *Precomputed + serve-time filters vs pure on-demand*: chose the hybrid for peak smoothing and latency; pays with staleness handling and worker infrastructure.
- *Bloom filter vs exact seen-set in Redis*: chose Bloom for a 20x memory saving; pays with ~1% hidden fresh profiles and no deletes (undo limitation).
- *Sync Redis + async Kafka on the swipe path*: chose both for immediate correctness and durable replay; pays with dual-write reconciliation.
- *Geohash vs H3/S2*: geohash is simple and native to Redis; H3 gives uniform neighbour geometry and better handling of dense areas. Would revisit at 10x scale or for driver-style matching.
- *ELO-style scoring vs learned two-sided model*: start with ELO (cheap, explainable), evolve to a learned P(match) model once swipe data is plentiful; both need exploration and exposure caps.
- *Region-affine deployment*: simpler, lower latency, but travellers need cross-region reads; accepted because travel is a small fraction of sessions.

**At 10x scale (100M DAU, 20B swipes/day)**: Cassandra grows to hundreds of nodes; move the Bloom filters and likes sets to a tiered cache (hot users in Redis, others rebuilt on demand from Cassandra); consider H3 and a dedicated candidate-retrieval service with approximate nearest neighbour on embeddings for ranking-aware retrieval.`,
      },
    ],
  },
  interviewQuestions: [
    'Design the Tinder swipe feed. How do you find users within 10 km efficiently for 100M users?',
    'Would you precompute each user\'s deck or generate it on demand? Describe the hybrid and its triggers.',
    'How do you store 2 billion swipes a day and answer "has A swiped B?" and "who liked B?" quickly?',
    'Two users swipe right on each other at the same instant on different servers. How do you create exactly one match?',
    'Explain ELO-style desirability scoring. Why not just show the most popular profiles to everyone?',
    'How do you guarantee a user never sees the same profile twice without storing every swiped id in RAM?',
    'What happens when a user flies to another city and opens the app?',
    'How do you handle the evening peak in a dense metro where millions of users are in the same few geohash cells?',
  ],
}

export default chapter
