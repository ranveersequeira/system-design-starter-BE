import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 34,
  slug: 'designing-a-recommendation-engine',
  title: 'Designing A Recommendation Engine',
  module: 'case-studies',
  estimatedMinutes: 45,
  summary:
    'A recommendation engine chooses a few dozen items for a user from a catalogue of millions, in under 200 milliseconds, using signals the user never explicitly gave. This chapter covers the algorithms (collaborative, content-based, hybrid), the two-stage candidate-generation-then-ranking architecture that makes them tractable, the offline Spark pipeline and online serving stack (feature store, FAISS-style ANN index), and the operational realities of cold start, implicit feedback, A/B testing and feedback loops.',
  objectives: [
    'Compare collaborative filtering, content-based filtering and hybrid approaches, and pick one for a given data situation.',
    'Explain why recommendation is split into candidate generation and ranking, and what each stage optimises.',
    'Design the offline batch pipeline (Spark) and the online serving path (feature store, ANN index, ranker) with realistic numbers.',
    'Handle cold start for new users and new items, and reason about implicit versus explicit feedback.',
    'Design A/B tests and guard against feedback loops, popularity bias and filter bubbles.',
  ],
  quickRevision: [
    'Collaborative filtering (CF) uses only the user-item interaction matrix: "users who liked what you liked also liked X". Needs interaction history, works across domains, fails on new users/items.',
    'Content-based filtering uses item attributes (genre, text embedding, price) and a user profile built from what they consumed; handles new items instantly but over-specialises and cannot surprise.',
    'Hybrid systems combine both: content features cover cold start, CF captures taste; almost every production system is hybrid.',
    'Matrix factorisation (ALS, SGD) learns a k-dimensional embedding per user and per item so that dot(user, item) predicts affinity; k is typically 32-256.',
    'Two-stage architecture: candidate generation narrows millions of items to a few hundred cheaply; ranking scores those few hundred with a rich model. Never score the whole catalogue per request.',
    'Candidate generation = approximate nearest neighbour (ANN) search over item embeddings using FAISS, ScaNN or HNSW; query with the user embedding; 10-20 ms for 100M items.',
    'Ranking = a learned model (GBM or deep network) over user, item and context features predicting click/watch/purchase probability; scores 500 candidates in 20-50 ms.',
    'Offline batch (Spark, nightly/hourly): compute embeddings, train models, precompute candidate lists and popular items; write results to the feature store and ANN index.',
    'Online serving: fetch user features (Redis/DynamoDB), query ANN, fetch item features, rank, apply business rules (diversity, freshness, already-seen filter), return in <200 ms p99.',
    'Implicit feedback (clicks, watch time, dwell) is abundant but noisy and has no negatives; explicit feedback (ratings) is sparse and biased. Treat unobserved as weak negatives and weight by confidence.',
    'Cold start: new users get popularity/contextual recommendations and an onboarding questionnaire; new items get content-based embeddings and exploration slots (epsilon-greedy or bandits).',
    'A/B test on business metrics (engagement, retention, revenue) not offline metrics (RMSE, precision@k); offline metrics only gate which models deserve an online test.',
    'Feedback loop: the model recommends X, users click X because it was shown, the model learns X is good. Counter with exploration, position-debiasing (inverse propensity weighting) and diversity constraints.',
    'Precompute vs realtime: precompute per-user lists for cheap, stable serving; compute at request time to react to the current session. Most systems precompute candidates and rank in real time.',
  ],
  sections: [
    {
      id: 'problem-and-approaches',
      title: 'The problem and the three algorithm families',
      body: `A recommendation engine answers one question many times a second: **given this user, right now, which few items out of millions are most worth showing?** Netflix chooses rows of titles, Amazon chooses "customers also bought", Spotify builds Discover Weekly, an e-commerce home page fills its first screen. The catalogue is huge, the screen is small, and attention is scarce, so ranking quality translates directly into revenue.

There are three classical families.

**Collaborative filtering (CF).** Uses only the interaction matrix (users x items, with clicks, purchases, ratings). *User-based*: find users with similar histories and recommend what they consumed. *Item-based*: for each item, find items co-consumed with it (Amazon's original "item-to-item"). *Model-based*: matrix factorisation learns a dense vector per user and per item such that the dot product approximates affinity. CF needs no knowledge of what items *are*, so it works for movies, shoes and news alike and can surface surprising cross-category items. Its weakness is the **cold start**: a new user has an empty row and a new item an empty column, and sparse matrices (users interact with 0.01% of items) make similarity noisy.

**Content-based filtering.** Uses item attributes: genre, tags, description text embeddings, price, brand, image embeddings. Build a user profile as the aggregate of the attributes of items they consumed and recommend items with similar attributes. New items are recommendable the moment they have metadata. Weakness: over-specialisation. A user who watched two thrillers is shown only thrillers forever; the system cannot discover that thriller fans also love a particular comedy.

**Hybrid.** Combine both: use content features to embed new items into the same space as CF embeddings, blend scores, or feed both kinds of features into a single ranking model. Netflix, YouTube and Amazon are all hybrids. In practice the two-stage architecture (next section) makes hybridisation natural: candidate generators of different kinds feed one ranker.

**Which to pick?** With rich interaction data and a stable catalogue, CF dominates. With a fast-changing catalogue (news, marketplace listings) or little interaction data, content-based is the floor. Everyone ends up hybrid; the interview answer is to name the data situation that drives the choice.

**Scale to keep in mind.** 100M users, 10M items, 1B interactions/day. The dense user-item matrix has 10^15 cells; it is 99.99% empty. Everything downstream is about never materialising that matrix.`,
      mentalModel:
        'Three ways to recommend a restaurant. Collaborative: ask friends with similar taste where they ate. Content-based: you like spicy Sichuan, so here is another spicy Sichuan place. Hybrid: your friends with similar taste recently liked this new place whose menu reads like your favourites.',
      diagram: `Interaction matrix (users x items), ~99.99% empty
             item1 item2 item3 ... item10M
   user1       5     .     .          .
   user2       .     3     .          1
   user3       4     .     2          .
   ...
   user100M    .     .     .          4

CF: fill the dots from row/column similarity or factorisation
Content: describe columns with attributes, match to a user profile
Hybrid: both signals into one scorer`,
      keyPoints: [
        'CF uses interactions only; strong with history, blind to new users and items.',
        'Content-based uses item attributes; handles new items, over-specialises.',
        'Hybrids blend both and are the production norm.',
        'The interaction matrix is enormous and extremely sparse; never materialise it.',
        'Choice is driven by data availability and catalogue churn.',
      ],
      checkpoint: {
        question:
          'A news app publishes 5,000 new articles a day, each relevant for about 12 hours. Which family must carry most of the weight, and why?',
        answer:
          'Content-based (text embeddings, topics, recency), because by the time an article accumulates enough interactions for CF it is already stale. CF can still contribute at the topic or source level, but item-level CF is structurally too slow for this catalogue churn.',
      },
    },
    {
      id: 'embeddings-and-similarity',
      title: 'Embeddings and matrix factorisation',
      body: `Modern recommenders represent users and items as **embeddings**: dense vectors of 32-256 floats in a shared space where geometric closeness means affinity. This is the single idea that makes both candidate retrieval and hybridisation work.

**Matrix factorisation (MF).** Approximate the sparse interaction matrix R (users x items) as the product of two thin matrices U (users x k) and V (items x k), so that R[u,i] is approximately dot(U[u], V[i]). Training minimises squared error over observed entries plus L2 regularisation. **Alternating Least Squares (ALS)** fixes V and solves for U in closed form, then alternates; it parallelises beautifully and is what Spark MLlib ships. **SGD** variants handle streaming updates. For implicit data, the weighted variant (Hu, Koren, Volinsky) treats every unobserved cell as a weak negative with confidence proportional to observed interaction strength.

**Numbers.** 100M users x 10M items with k=64: U is 100M x 64 x 4 bytes = 25.6 GB, V is 10M x 64 x 4 = 2.56 GB. Both fit comfortably in a Spark cluster and the item matrix fits on a single serving node. Training ALS on 1B interactions with 10 iterations takes tens of minutes on a few hundred cores.

**Beyond MF.** Two-tower neural networks (YouTube, 2016 onwards) learn a user tower (from history, demographics, context) and an item tower (from id plus content features) trained so that dot products predict engagement. The item tower can embed a brand-new item from its content features alone, which is how deep hybrids solve item cold start. Word2vec-style sequence models (item2vec, prod2vec) embed items from co-occurrence in sessions, and transformers (SASRec, BERT4Rec) model the ordered sequence of a user's recent items.

**Similarity.** Given embeddings, "items similar to this item" is a nearest-neighbour search in V; "items for this user" is a nearest-neighbour search of U[u] against V by dot product or cosine. Exact search over 10M vectors is 10M x 64 multiply-adds = 640M FLOPs per query, about 50-100 ms on one core. That is too slow for thousands of QPS, which is why approximate indexes exist (next section).

**Why embeddings win.** They compress taste into a fixed-size vector that can be stored per user in a feature store, updated incrementally, queried in milliseconds, and combined with content features. They also enable serendipity: two items are close because users co-consume them, even if their metadata looks unrelated.

**Pitfalls.** Popular items dominate the embedding space (their vectors have large norms), so normalise or add popularity penalties. Embeddings drift between training runs, so do not compare vectors from different model versions; version the index with the model.`,
      mentalModel:
        'A map of a city where shops that attract the same customers are built next to each other. Your position on the map is where you would live given your shopping history. Recommendation is "list the shops within walking distance".',
      diagram: `   R (users x items)     ~     U (users x k)   x   V^T (k x items)
 +-------------------+       +----------+       +-------------------+
 | 5 . . 1 . . 4 . . |       | u1: 64 f |       | i1 i2 i3 ... i10M |
 | . 3 . . . 2 . . . |   =   | u2: 64 f |   x   | 64 floats each    |
 | . . . . 4 . . . 1 |       | ...      |       +-------------------+
 +-------------------+       +----------+
 100M x 10M sparse           25.6 GB               2.56 GB
 score(u,i) = dot(U[u], V[i])   -> nearest neighbours of U[u] in V`,
      keyPoints: [
        'Embeddings put users and items in one k-dimensional space where dot product means affinity.',
        'ALS (Spark MLlib) factorises the matrix in parallel; weighted variants handle implicit feedback.',
        'Two-tower networks embed new items from content features, solving item cold start inside CF.',
        'Exact nearest-neighbour over 10M items is ~50-100 ms per query; too slow, hence ANN.',
        'Normalise for popularity and version embeddings together with the index.',
      ],
    },
    {
      id: 'two-stage-architecture',
      title: 'Two stages: candidate generation, then ranking',
      body: `You cannot run a rich model over 10 million items for every request. The universal solution is a **funnel**: cheap retrieval to a few hundred candidates, then expensive ranking over those few hundred.

**Stage 1: candidate generation (retrieval).** Goal: high recall, low latency, cheap per item. Multiple generators run in parallel and their outputs are unioned:
- **ANN over embeddings**: nearest items to the user embedding via FAISS (IVF or HNSW index), ScaNN or Milvus; 100-500 candidates in 5-20 ms over 10M-100M vectors.
- **Item-to-item**: precomputed "similar items" for the last N items the user interacted with (a Redis list per item).
- **Popular / trending**: per region, per category, refreshed hourly.
- **Content and rules**: same author, same brand, new releases in followed categories, editorially curated.
- **Social**: what your follows engaged with.
Each generator is simple, so the union is diverse; a candidate found by two generators is a stronger signal.

**Stage 2: ranking.** Goal: precision. A learned model scores each of the ~500 candidates with hundreds of features: user features (embedding, demographics, long- and short-term interests, device), item features (embedding, category, price, age, quality signals), cross features (user-category affinity, has-seen-this-brand), and **context** (time of day, page, position, session so far). Models range from gradient-boosted trees to deep networks with multi-task heads (predict click, watch-completion, purchase, and combine with business weights). Scoring 500 candidates with a GBM is ~10 ms; with a deep model on CPU, 20-50 ms in a batch.

**Stage 3 (often folded into ranking): re-ranking and business logic.** Filter already-seen and out-of-stock items, enforce diversity (no more than 3 of one category in the top 10), inject freshness and exploration slots, apply sponsored placements, obey compliance rules. This is deterministic code, not a model, and it is where product managers get their levers.

**Why the split works.** Retrieval optimises "did the right items make it into the 500?" (recall@500). Ranking optimises "are the best of those 500 on top?" (NDCG@10). Each stage can be improved, tested and scaled independently; retrieval is typically shared across surfaces while rankers are surface-specific. YouTube's 2016 paper made this architecture canonical; nearly every large system has followed.

**Latency budget** for a 200 ms p99: user feature fetch 10 ms, parallel candidate generators 20 ms, item feature fetch for 500 candidates (batched Redis MGET) 15 ms, ranking 40 ms, re-rank and business rules 5 ms, network and serialisation 20 ms: about 110 ms with headroom for tails.`,
      mentalModel:
        'Hiring. A recruiter screens 10,000 CVs with keyword filters in an afternoon (retrieval); the hiring manager interviews 8 people in depth (ranking); HR checks references and salary bands before an offer (business rules).',
      diagram: `                 10M items
                     |
   +-----------------+------------------+---------------+
   | ANN (FAISS)     | item2item        | trending      | ... generators
   | user emb -> 300 | last 5 items->200| region top 100|
   +-----------------+------------------+---------------+
                     |  union, dedupe -> ~500 candidates
                     v
          +---------------------------+
          | Ranker (GBM / DNN)        |  user + item + context features
          | p(click), p(watch), ...   |  ~40 ms for 500
          +---------------------------+
                     |  top 50
                     v
          re-rank: seen filter, diversity, freshness, sponsored
                     |
                     v
                  top 20 shown`,
      keyPoints: [
        'Retrieval: many cheap generators, high recall, hundreds of candidates in ~20 ms.',
        'Ranking: one rich model with hundreds of features, precision on top positions, ~40 ms.',
        'Re-ranking: deterministic business rules for diversity, freshness, filtering, sponsorship.',
        'Stages are optimised and scaled independently; retrieval is shared, rankers are per surface.',
        'Never score the whole catalogue per request; the funnel is what makes it feasible.',
      ],
      checkpoint: {
        question:
          'Your ranker is excellent but users complain the recommendations are "all the same". Which stage is most likely at fault and what do you change?',
        answer:
          'Retrieval or re-ranking, not the ranker. If all candidates come from one ANN generator the pool is homogeneous; add diverse generators (trending, content, social). Then add a diversity constraint in re-ranking (cap per category, MMR-style penalty for similarity to already-selected items).',
      },
    },
    {
      id: 'offline-online',
      title: 'Offline batch pipeline and online serving',
      body: `A recommender is two systems glued by a feature store and an index: a **batch/offline** system that learns and precomputes, and an **online** system that serves in milliseconds.

**Offline (Spark, Airflow-scheduled)**
1. **Ingest** events (impressions, clicks, purchases, watch time) from Kafka into the lake as Parquet (1B events/day, ~1 TB raw).
2. **Build training data**: join events with the features that were logged at serving time (log features with each impression to avoid skew, exactly as in fraud detection).
3. **Train** retrieval embeddings (ALS or two-tower) and the ranker (LightGBM, or TensorFlow/PyTorch on GPUs); evaluate offline (recall@k, NDCG, AUC) against last week's holdout.
4. **Precompute**: item embeddings -> build the ANN index (FAISS IVF4096,PQ64 over 10M vectors: about 1 GB, build time minutes); user embeddings -> feature store; item-to-item lists (top 50 per item) -> Redis; trending per region -> Redis.
5. **Publish**: upload index and model artefacts to S3 with a version; serving nodes hot-load and swap.

Cadence: embeddings and index daily (hourly for fast catalogues), ranker weekly, trending every 15 minutes, user embeddings refreshed nightly plus incremental online updates.

**Online**
- **Feature store**: online half in Redis/DynamoDB holds per-user features (embedding, recent items, category affinities) and per-item features (embedding, stats). Reads: 1 user hash + 500 item hashes per request; batch with MGET. Item features are hot and few (10M items x 1 KB = 10 GB), so they often live in local memory on serving nodes with periodic refresh.
- **ANN service**: FAISS/ScaNN/Milvus/Vespa holding the item index in RAM, replicated across nodes; query latency 5-15 ms for top-300 with IVF and nprobe tuned to ~95% recall.
- **Ranker service**: model in memory, batched inference over candidates.
- **Orchestrator**: the recommendation API that calls these in the right order with timeouts and fallbacks (if ANN fails, use precomputed lists; if ranker fails, use retrieval order).
- **Session signals**: the last few clicks in the current session (from Kafka via a Flink job into Redis, or passed by the client) update a short-term user vector on the fly, so the page reacts within seconds even though the batch embedding is a day old.

**Precompute vs real time.** Fully precomputing each user's final top-100 nightly is cheap to serve (one Redis GET) and stable, but blind to what the user did five minutes ago and wasteful for the 90% of users who do not visit. Fully real-time is responsive but expensive. The common compromise: precompute *candidates* and item-side artefacts offline, compute *ranking* online with session context. Netflix precomputes heavily (rows are stable for a day); TikTok ranks in real time on every swipe because session signal dominates.`,
      mentalModel:
        'A restaurant. Overnight, the kitchen preps stocks, sauces and cut vegetables (offline batch). At service, the chef assembles each plate to order from the prepped components in minutes (online ranking). You would never make stock per order, nor pre-plate every dish at dawn.',
      diagram: `OFFLINE (Spark, nightly)                 ONLINE (per request, <200ms)
Kafka events -> S3 Parquet                 client --> Rec API (orchestrator)
      |                                               |
  training data (logged features)          user feats (Redis) --+
      |                                               |          |
  ALS / two-tower  -> item embeddings ---> FAISS index (RAM) ----+--> ~500
  LightGBM ranker  -> model artefact  ---> Ranker service       |
  item2item, trending -----------------> Redis lists -----------+
  user embeddings  -------------------> feature store (Redis)
      |                                               |
  S3 versioned artefacts  -- hot swap -->   rank -> re-rank -> top 20`,
      keyPoints: [
        'Offline: ingest, build point-in-time training data, train, precompute embeddings/lists/index, publish versioned artefacts.',
        'Online: orchestrator calls feature store, ANN, ranker with timeouts and fallbacks.',
        'FAISS IVF+PQ makes 10M-100M vectors searchable in ~10 ms within ~1-10 GB RAM.',
        'Session signals via Flink to Redis let a day-old embedding react within seconds.',
        'Precompute candidates and item artefacts; rank online with context.',
      ],
      checkpoint: {
        question:
          'A daily nightly job produces a new item embedding matrix and a new FAISS index. Why must the user embeddings in the feature store be refreshed in the same deployment?',
        answer:
          'Embeddings are only meaningful relative to the model run that produced them. A user vector from yesterday\'s run dotted against today\'s item vectors is noise (the spaces are rotated differently). Version user embeddings, item embeddings and the index together and swap atomically, or serve the old index until user vectors are updated.',
      },
    },
    {
      id: 'feedback-and-cold-start',
      title: 'Implicit feedback, cold start, and exploration',
      body: `The data a recommender learns from is not what it looks like, and the users it serves are not all equally knowable.

**Implicit versus explicit feedback.** Explicit ratings (1-5 stars, thumbs) are sparse (a few percent of users rate), biased (people rate extremes), and stale. Implicit signals (clicks, dwell time, watch completion, add-to-cart, purchase, skip) are abundant and honest about behaviour but have three problems:
- **No true negatives.** A user who did not click an item may not have seen it. Treat unobserved as weak negatives with low confidence (weighted MF), or only use *impressed but not clicked* as negatives when impression logs exist.
- **Noise.** An accidental click and a 2-hour watch are both "positives". Weight signals by strength (purchase > add-to-cart > click) and duration.
- **Position bias.** Items shown at the top get clicked more regardless of quality. Log position, and train with inverse propensity weighting or a position-aware model that learns and then neutralises the position effect at inference.

**Cold start: new users.** No history, no embedding. Strategies in order of effort: show popular and trending items for the region and device; use context (referrer, time, geo, language); run a short onboarding ("pick 3 genres") to seed a content-based profile; use demographics as features in a two-tower user tower; and shift quickly to session-based recommendations after the first few clicks, since two or three interactions already beat popularity.

**Cold start: new items.** No column in the matrix. Content-based embeddings (text, image, metadata) via the item tower place the item in the space immediately. Then give it **exploration**: reserve a few slots in results for under-exposed items so they can gather feedback. Epsilon-greedy (5% random relevant candidates) is the simplest; contextual bandits (Thompson sampling, UCB over item arms) allocate exposure to items whose value is uncertain but promising, and are what news and ad systems use.

**Feedback loops.** The recommender shapes what users see, which shapes the data it learns from. Without care, popular items get more popular (popularity bias), users get narrower (filter bubble), and the model's offline metrics improve while the catalogue's long tail dies. Countermeasures: exploration as above, diversity constraints in re-ranking, propensity-weighted training that corrects for what was shown, and business metrics that reward catalogue coverage and long-term retention rather than only next-click.

**Freshness and forgetting.** Tastes drift; last month's binge is not this month's. Use time-decayed interaction weights, separate long-term and short-term (session) embeddings, and let the ranker learn how to combine them.`,
      mentalModel:
        'A new bartender. For a stranger they pour the house favourite (popularity) and ask one question (onboarding). After two drinks they have a good idea (session signal). For a brand-new bottle they read the label (content) and offer tasters to a few regulars (exploration) before deciding whether it deserves shelf space.',
      keyPoints: [
        'Implicit feedback is abundant but lacks negatives and carries position bias; weight by strength, debias by propensity.',
        'New users: popularity + context + onboarding, then session-based quickly.',
        'New items: content-based embedding plus exploration slots (epsilon-greedy or bandits).',
        'Feedback loops cause popularity bias and filter bubbles; counter with exploration, diversity and propensity weighting.',
        'Separate long-term and short-term interest signals; decay old interactions.',
      ],
      checkpoint: {
        question:
          'You train a click model on impression logs where position 1 gets 30% CTR and position 10 gets 2%. What goes wrong if you ignore position, and what is the fix?',
        answer:
          'The model learns that whatever was shown at the top is good, reinforcing yesterday\'s ranking rather than learning item quality. Fix: include position as a training feature and set it to a fixed value (e.g. position 1) at inference, or reweight examples by inverse propensity of being shown at that position.',
      },
    },
    {
      id: 'evaluation-and-ab',
      title: 'Evaluation, A/B testing, and what to optimise',
      body: `Offline metrics tell you whether a model is worth testing; only online experiments tell you whether it is better.

**Offline evaluation.** Hold out the most recent week of interactions (time-based split, never random). Retrieval: recall@k (did the held-out items appear in the top k candidates?). Ranking: NDCG@10, MAP, AUC of click prediction, log-loss. Also measure coverage (fraction of catalogue ever recommended), diversity and novelty, because a model that recommends only the top 100 items can score well on precision. Offline gains of 1-2% in NDCG frequently do not translate online because offline data was generated by the previous policy (the same feedback loop problem). Counterfactual evaluation with inverse propensity scoring helps but has high variance.

**A/B testing.** Split users (not requests) into control and treatment by hashing user id with a salt per experiment, so a user has a consistent experience. Run for at least a full weekly cycle, usually 2-4 weeks, to capture novelty effects (new recommendations get clicked because they are new, then regress). Measure:
- **Primary**: the business metric the surface exists for: watch time, purchases, revenue per session, session length.
- **Guardrails**: retention (day-7, day-30 return rate), unsubscribes, complaint rate, latency, error rate, catalogue coverage.
- **Statistical care**: pre-register the metric, compute required sample size, watch for interference (a treatment that changes what is trending changes the control's trending list too; isolate shared components or use cluster-randomisation).

**Multi-objective trade-offs.** Clicks are easy to increase with clickbait and hurt long-term satisfaction. Netflix optimises for long-term retention and uses watch-completion as a proxy; YouTube moved from views to watch time to "satisfied watch time" with survey signals. Encode this in the ranker as a multi-task model whose heads (click, completion, like, share, report) are combined with weights chosen by the product team, then validated in A/B tests.

**Interleaving.** For ranking changes, interleave results from control and treatment on the same page and see which list's items get clicked; it needs 10-100x fewer users than A/B to detect ranking differences, but cannot measure long-term effects.

**Operational metrics.** Serving p99 latency, candidate pool size, fallback rate (how often ANN or ranker timed out), feature null rate, model age, index age, exploration share. A recommender silently degrading (stale index, features gone null) shows up first here, days before business metrics move.`,
      mentalModel:
        'Cooking a new recipe. Tasting it yourself (offline metrics) tells you whether it is worth serving. Only serving it to half the dinner guests and watching who asks for seconds (A/B) tells you whether it beats the old dish, and asking them a week later whether they would come back (retention guardrail) tells you if it was clickbait.',
      keyPoints: [
        'Offline: time-based holdout; recall@k for retrieval, NDCG@k for ranking, plus coverage and diversity.',
        'Online A/B by user hash, 2-4 weeks, primary business metric plus retention and latency guardrails.',
        'Beware novelty effects, interference through shared components, and optimising clickbait.',
        'Multi-task rankers with product-chosen weights encode long-term objectives.',
        'Interleaving detects ranking differences cheaply; operational metrics catch silent degradation.',
      ],
    },
    {
      id: 'scaling-and-failure',
      title: 'Scaling, failure modes, and trade-offs',
      body: `**Scaling the serving path.** Serving is stateless apart from in-memory artefacts, so it scales horizontally. At 10,000 recommendation requests/sec:
- ANN: a FAISS IVF index of 10M x 64-d vectors with PQ compression is about 0.7-1 GB; each node handles 1,000-2,000 queries/sec at 10 ms; 10-20 replicas. For 1B items, shard the index by item-id range and fan out, merging top-k.
- Feature store: 10,000 requests x (1 user + 500 items) reads = 5M key reads/sec if items are in Redis. This is why item features are usually held in local memory on serving nodes (10 GB, refreshed every few minutes) and only user features come from Redis (10,000 reads/sec, trivial).
- Ranker: 10,000 x 500 = 5M scorings/sec. A GBM at ~10 microseconds per row needs ~50 cores; a deep model needs GPUs or a smaller candidate set. Batch candidates per request into one inference call.
- Caching: cache the final list per user for 5-10 minutes for surfaces where staleness is fine (home page on reload); cache popular/trending lists in the API layer.

**Failure modes and graceful degradation**
- **ANN service down**: fall back to precomputed item-to-item lists and trending. The page still renders, quality dips.
- **Ranker down or slow**: return candidates in retrieval order (dot-product score). Set a hard timeout (e.g. 60 ms) and never block the page.
- **Feature store down**: serve popularity-based results for the region; log the fallback rate.
- **Bad model deployed**: canary at 1-5% with automatic rollback if CTR or latency guardrails breach. Keep previous artefacts loadable.
- **Stale batch**: if the nightly job fails, yesterday's index continues to serve; alert on artefact age exceeding 36 hours.
- **Skew between training and serving**: features computed differently offline and online. Log serving features with impressions and train from logs.
- **Hot items** (a viral product): item-to-item lists for it are read millions of times; local caches absorb it.

**Trade-offs to articulate**
- **Precompute vs real time**: cost and stability vs responsiveness; hybrid is standard.
- **Recall vs latency in ANN**: higher nprobe or ef gives better recall and slower queries; tune to ~95% recall@100 within budget.
- **Model complexity vs serving cost**: a deep ranker that adds 1% engagement may double compute; decide with revenue per 1%.
- **Exploration vs exploitation**: exploration slots cost short-term clicks and buy long-term catalogue health and better data.
- **Personalisation vs privacy**: fine-grained behavioural features raise privacy and regulatory concerns (GDPR right to erasure means deleting a user's embedding and their contribution to training data on request).
- **Consistency**: recommendations are eventually consistent by nature; a purchase may still appear as recommended for minutes. A cheap "recently purchased" filter at re-rank time from a real-time source fixes the most embarrassing cases.`,
      mentalModel:
        'A newspaper printing press with a fallback photocopier. When the fancy press (ranker) jams, you hand out the wire-service pages (precomputed lists) rather than no paper at all. Readers notice a duller paper; they do not notice a missing one.',
      diagram: `Degradation ladder (top = best quality)

  full: user feats + ANN + ranker + rerank      (~110 ms)
    |  ranker timeout 60 ms
  candidates in retrieval order                  (~60 ms)
    |  ANN unavailable
  precomputed item2item lists for recent items   (~20 ms)
    |  feature store unavailable
  trending per region (API-layer cache)          (~5 ms)
    |  everything down
  static editorial list                          (~1 ms)`,
      keyPoints: [
        'Item features live in serving-node memory; user features come from Redis; ANN and ranker scale horizontally.',
        'Define a degradation ladder: ranker -> retrieval order -> precomputed lists -> trending -> editorial.',
        'Canary models with automatic rollback on CTR/latency guardrails; alert on artefact age.',
        'Log serving-time features with impressions to avoid training-serving skew.',
        'Key trade-offs: precompute vs realtime, ANN recall vs latency, model cost vs lift, exploration vs exploitation, personalisation vs privacy.',
      ],
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What is the defining input of collaborative filtering?',
      options: [
        'Item metadata such as genre and description',
        'The user-item interaction matrix (who consumed or rated what)',
        'Editorial curation rules',
        'Real-time session context only',
      ],
      answerIndex: 1,
      explanation:
        'CF learns from interactions alone: similar users or co-consumed items. It needs no item attributes, which is both its strength (domain-agnostic, serendipitous) and its weakness (cold start). Item metadata is the input to content-based filtering.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'Why is recommendation split into candidate generation and ranking?',
      options: [
        'Because two teams need separate services',
        'Scoring millions of items with a rich model per request is infeasible; cheap retrieval narrows to hundreds, then an expensive model ranks those',
        'Because collaborative filtering requires two passes over the matrix',
        'To allow A/B testing',
      ],
      answerIndex: 1,
      explanation:
        'The funnel makes rich ranking affordable: retrieval optimises recall over the whole catalogue in ~20 ms, ranking optimises precision over ~500 items in ~40 ms. Organisational and testing benefits follow but are not the reason.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'A brand-new product with rich metadata but zero interactions needs to be recommendable today. Which mechanism makes that possible?',
      options: [
        'Item-based collaborative filtering',
        'Content-based embedding via an item tower plus exploration slots',
        'Matrix factorisation with ALS',
        'Increasing the ANN index nprobe',
      ],
      answerIndex: 1,
      explanation:
        'CF methods (item-based, ALS) have no signal for an item with no interactions. Embedding the item from its content (text, image, attributes) places it in the space immediately, and exploration exposes it so it can gather feedback. nprobe is an ANN accuracy knob unrelated to cold start.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which are genuine problems with implicit feedback (clicks, watch time)? Select all that apply.',
      options: [
        'It is too sparse to train on',
        'Unobserved items are not true negatives; the user may never have seen them',
        'Position bias inflates signals for items shown at the top',
        'Signals vary in strength (accidental click vs purchase) and must be weighted',
        'It requires users to fill in rating forms',
      ],
      answerIndices: [1, 2, 3],
      explanation:
        'Implicit feedback is abundant (not sparse) and requires no forms; those are its advantages. Its problems are missing negatives, position bias and heterogeneous signal strength, handled by weighted MF, propensity weighting and signal weighting respectively.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement:
        'If a new ranking model improves offline NDCG@10 by 3% on a held-out week, it is safe to assume it will improve engagement in production.',
      answer: false,
      explanation:
        'Offline data was generated by the previous recommendation policy, so offline metrics are biased toward models that mimic it, and they cannot capture novelty effects or long-term retention. Offline gains gate which models get an A/B test; only the A/B test decides.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'Your item-feature reads to Redis are 5 million per second at 10,000 requests/sec and Redis is saturating. What is the standard fix?',
      options: [
        'Add more Redis shards until it fits',
        'Hold item features (about 10 GB for 10M items) in local memory on each serving node with periodic refresh; read only user features from Redis',
        'Reduce the candidate set to 10 items',
        'Move item features to Postgres',
      ],
      answerIndex: 1,
      explanation:
        'Item features are a small, hot, slowly changing dataset that fits in RAM on every serving node; user features are large and per-request. Sharding Redis works but is expensive for a solvable problem; cutting candidates to 10 destroys ranking quality; Postgres is slower than Redis.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question: 'What is the main danger of a recommender training only on its own impression and click logs without correction?',
      options: [
        'The model becomes too slow',
        'A feedback loop: items the system chose to show get clicked and thus reinforced, amplifying popularity bias and narrowing exposure',
        'The embeddings become too large',
        'A/B tests become impossible',
      ],
      answerIndex: 1,
      explanation:
        'The system generates its own training data. Without exploration, propensity weighting and diversity constraints, popular items snowball and the long tail starves, while offline metrics look fine. Speed, size and testability are unrelated.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 3,
      statement:
        'User embeddings computed by last night\'s model run can safely be scored against item embeddings from this morning\'s run because both use 64 dimensions.',
      answer: false,
      explanation:
        'Each training run produces its own latent space; dimensions from different runs are not aligned (the space can be rotated or permuted arbitrarily). Dot products across runs are meaningless. Version user vectors, item vectors and the ANN index together and swap atomically.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 2,
      question: 'Why does an ANN index like FAISS IVF+PQ exist in the serving path?',
      options: [
        'To store the interaction matrix',
        'Exact nearest-neighbour search over 10M+ item vectors costs ~50-100 ms per query; ANN returns ~95% of the true neighbours in ~10 ms with a fraction of the memory',
        'To train the ranker faster',
        'To compute trending items',
      ],
      answerIndex: 1,
      explanation:
        'Retrieval needs nearest neighbours of the user vector among millions of item vectors thousands of times per second. Inverted-file clustering (IVF) limits the search to a few clusters and product quantisation (PQ) compresses vectors, trading a little recall for a 10x speedup and smaller memory.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'How should A/B tests for a recommender be randomised and how long should they run?',
      options: [
        'Per request, for one day',
        'Per user via a salted hash, for at least one full weekly cycle and usually 2-4 weeks to see past novelty effects',
        'Per item, until the first significant result appears',
        'Per region, for one hour at peak traffic',
      ],
      answerIndex: 1,
      explanation:
        'Users must have a consistent experience (per-user hashing), weekly seasonality must be covered, and novelty inflation fades over weeks. Stopping at first significance inflates false positives; per-request randomisation mixes experiences within a session.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Allocate a 200 ms p99 latency budget for a recommendation request across the two-stage pipeline and name the fallback if each major stage fails.',
      modelAnswer: `**Budget:** network and serialisation 20 ms; user feature fetch from Redis 10 ms; candidate generators in parallel (ANN top-300, item2item for last 5 items, trending) 20 ms; item feature lookup for ~500 candidates from local memory 5-15 ms; ranking 500 candidates with GBM/DNN in one batch 40 ms; re-rank and business rules 5 ms. Total about 110 ms, leaving 90 ms headroom.

**Fallbacks:** ranker timeout (60 ms) -> return candidates in retrieval score order; ANN unavailable -> precomputed item2item lists plus trending; feature store unavailable -> regional trending from an API-layer cache; everything down -> static editorial list. Each fallback is logged so the fallback rate is an alertable metric.`,
      rubric: [
        'Stage allocations summing well under 200 ms with explicit headroom.',
        'Candidate generators run in parallel; item features from local memory.',
        'A fallback for ranker, ANN and feature store failures.',
        'Mentions monitoring the fallback rate.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain how you would handle a brand-new user on their first visit and how recommendations evolve over their first session.',
      modelAnswer: `On the first request there is no history, so use what is available: geo, language, device, referrer and time to select regional popular and trending items, optionally with a short onboarding step ("choose 3 interests") that seeds a content-based profile. Demographic and context features can feed a two-tower user tower to produce a rough embedding.

After the first one or two interactions, switch to session-based signals: the clicked items\' embeddings (averaged, or fed to a sequence model) form a short-term user vector that drives ANN retrieval, and item-to-item lists for the clicked items supply candidates. A few interactions already outperform popularity. Overnight, the user gets a proper long-term embedding from the batch job. Throughout, keep some exploration slots to learn the user\'s breadth rather than locking onto the first click.`,
      rubric: [
        'Uses popularity plus context for the very first request.',
        'Mentions onboarding or demographic features.',
        'Switches to session-based retrieval after a few clicks.',
        'Mentions the overnight batch embedding and/or exploration.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question:
        'Compare precomputing each user\'s final recommendation list nightly against computing it at request time. When would you choose each, and what is the common compromise?',
      modelAnswer: `**Precompute nightly:** serving is one Redis GET, cheap and stable; the pipeline is simple. But it ignores everything the user did since last night, wastes compute on the majority of users who will not visit, and cannot use request context (page, device, time). Good for stable, low-context surfaces like an email digest or a home row that changes daily.

**Real time:** reacts to the current session and context, spends compute only on active users, but needs a low-latency serving stack (feature store, ANN, ranker) and is more expensive per request. Necessary for session-driven products (short video, news, search-like browsing).

**Compromise (the norm):** precompute item-side artefacts (embeddings, ANN index, item2item lists, trending) and long-term user embeddings offline; at request time retrieve candidates and rank with fresh session and context features. Cache final lists briefly (minutes) for surfaces that tolerate it.`,
      rubric: [
        'Names cost/stability advantages and staleness/waste disadvantages of precompute.',
        'Names responsiveness and cost of real time.',
        'Gives a scenario for each.',
        'Describes the hybrid: precompute artefacts and candidates, rank online.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Collaborative filtering', back: 'Recommends from the user-item interaction matrix alone: similar users or co-consumed items, or matrix factorisation. Domain-agnostic; suffers cold start and sparsity.' },
    { id: 'f2', front: 'Content-based filtering', back: 'Recommends items whose attributes (genre, text/image embeddings, price) match a profile built from the user\'s consumed items. Handles new items; over-specialises.' },
    { id: 'f3', front: 'Hybrid recommender', back: 'Combines CF and content signals, typically by feeding multiple candidate generators into one ranker or by embedding items from content into the CF space (two-tower).' },
    { id: 'f4', front: 'Matrix factorisation (ALS)', back: 'R (users x items) is approximated by U (users x k) times V^T (k x items); dot(U[u], V[i]) predicts affinity. ALS alternates closed-form solves; Spark MLlib implements it.' },
    { id: 'f5', front: 'Embedding sizes at scale', back: '100M users x 64 floats = 25.6 GB; 10M items x 64 floats = 2.56 GB. Item matrix fits on one serving node; user vectors go to the feature store.' },
    { id: 'f6', front: 'Two-stage architecture', back: 'Candidate generation (many cheap generators, high recall, ~500 items in ~20 ms) then ranking (rich model, precision, ~40 ms), then re-ranking with business rules.' },
    { id: 'f7', front: 'Candidate generators', back: 'ANN over embeddings (FAISS/ScaNN), item-to-item lists for recent items, trending per region, content/rule-based, social. Union and dedupe.' },
    { id: 'f8', front: 'ANN index (FAISS IVF+PQ)', back: 'Clusters vectors (IVF) and compresses them (PQ) so top-k search over 10M-100M vectors takes ~10 ms in ~1 GB RAM at ~95% recall. Exact search would be 50-100 ms.' },
    { id: 'f9', front: 'Ranker features', back: 'User (embedding, interests, device), item (embedding, category, price, age, quality), cross (user-category affinity), context (time, page, position, session). GBM or multi-task DNN.' },
    { id: 'f10', front: 'Re-ranking business rules', back: 'Filter seen/out-of-stock, diversity caps per category, freshness and exploration slots, sponsored placements, compliance. Deterministic code; product levers.' },
    { id: 'f11', front: 'Offline pipeline steps', back: 'Kafka -> Parquet; build point-in-time training data from logged features; train embeddings and ranker; build ANN index, item2item, trending; publish versioned artefacts to S3.' },
    { id: 'f12', front: 'Implicit feedback pitfalls', back: 'No true negatives (treat unobserved as weak negatives), noisy signal strength (weight purchase > click), position bias (log position, use propensity weighting).' },
    { id: 'f13', front: 'Cold start: new user', back: 'Regional popularity + context (geo, device, referrer), onboarding questionnaire, demographic tower; switch to session-based after 1-2 clicks.' },
    { id: 'f14', front: 'Cold start: new item', back: 'Content-based embedding from the item tower places it in the space; exploration slots (epsilon-greedy 5%, or bandits) gather feedback.' },
    { id: 'f15', front: 'Feedback loop countermeasures', back: 'Exploration, diversity constraints, inverse propensity weighting for what was shown, metrics rewarding coverage and long-term retention.' },
    { id: 'f16', front: 'Offline vs online evaluation', back: 'Offline (recall@k, NDCG@k on a time-based holdout) gates candidates; online A/B by user hash for 2-4 weeks on business metrics plus retention/latency guardrails decides.' },
    { id: 'f17', front: 'Degradation ladder', back: 'Full pipeline -> candidates in retrieval order (ranker timeout) -> precomputed item2item (ANN down) -> regional trending (features down) -> static editorial.' },
    { id: 'f18', front: 'Versioning embeddings', back: 'User vectors, item vectors and the ANN index from one training run belong together; cross-run dot products are meaningless. Swap all three atomically.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Two-stage candidate generation and ranking',
      prompt: 'Explain to a product manager why the recommendation system has two models instead of one, and what each is good at.',
      modelExplanation: `Think about hiring for a job with ten thousand applicants. You cannot interview everyone for an hour. So a recruiter does a quick screen on a few criteria and picks fifty, and then the hiring manager spends real time on those fifty.

Our recommender works the same way. The first stage, candidate generation, looks at all ten million items but uses only cheap signals: a nearest-neighbour search on taste vectors, "people who bought this also bought", what is trending in the region. It runs in about twenty milliseconds and returns a few hundred plausible items. Its job is not to miss good ones.

The second stage, ranking, takes those few hundred and applies a rich model with hundreds of features about the user, the item, and the moment: the time of day, the device, what they clicked a minute ago. It costs far more per item, which is fine because there are only a few hundred. Its job is to get the top ten exactly right.

Splitting them means we can add a new source of candidates, or improve the ranker, without touching the other, and we can measure each on its own job.`,
      mustMention: [
        'Scoring the whole catalogue with a rich model is infeasible',
        'Retrieval: cheap, many generators, optimises recall',
        'Ranking: expensive, rich features and context, optimises precision at the top',
        'Stages evolve and are measured independently',
      ],
    },
    {
      id: 'fe2',
      concept: 'Cold start and implicit feedback',
      prompt: 'Explain why recommenders struggle with new users and new items, and how a system copes on day one.',
      modelExplanation: `A recommender learns from behaviour: who clicked, watched or bought what. A new user has done none of that, so the system knows nothing about them. A new item has never been shown, so nobody has reacted to it. Collaborative methods, which work purely from behaviour, are blind in both cases.

For a new user we use whatever we do have: where they are, what device and language, how they arrived, and what is popular for people like that. A quick "pick three things you like" gives a starting profile. After just two or three clicks, we can switch to session-based suggestions, which already beat popularity.

For a new item we read its content: title, description, images, category. A model trained to map content to the same taste space as behaviour can place it near similar items immediately. Then we deliberately show it to a small number of users, an exploration slot, so it collects the behaviour it lacks. Without that exploration, new items would never be shown and therefore never learned about, and the catalogue would slowly freeze around old favourites.`,
      mustMention: [
        'Behaviour-based methods have no signal for new users or items',
        'New users: context, popularity, onboarding, then session signals',
        'New items: content-based embedding',
        'Exploration slots so new items gather feedback',
      ],
    },
    {
      id: 'fe3',
      concept: 'Feedback loops and A/B testing',
      prompt: 'Explain why a recommender cannot trust its own logs and why A/B tests are the final judge.',
      modelExplanation: `A recommender is unusual: it creates the data it learns from. If it shows item A at the top, A gets clicks, and the next training run concludes A is great and shows it even more. Items it never shows collect no clicks and look worthless. Left alone, the system converges on a small set of popular things and its offline metrics look wonderful, because it is being graded on a test it wrote.

We break the loop three ways. We keep a few exploration slots for uncertain items so they can prove themselves. We record the position each item was shown in and correct for the fact that top positions get clicked regardless. And we add diversity rules so one category cannot fill the page.

Because offline metrics are computed on that biased log, they can only tell us which models deserve a real test. The real test is an A/B experiment: split users by a hash, run for a few weeks to get past the novelty bump, and compare the metric the product actually cares about, with retention and latency as guardrails. Only that measures what the change does to people who have never seen it.`,
      mustMention: [
        'The system generates its own training data',
        'Popularity bias and narrowing without correction',
        'Exploration, position debiasing, diversity',
        'Offline metrics gate; A/B on business metrics decides',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk through a giant record shop with a listening lounge, from the entrance to the back office. Each stop anchors one part of the recommendation engine.',
    stops: [
      { locus: 'The entrance wall of customer receipts', concept: 'Interaction matrix (collaborative filtering)', image: 'A wall covered in a hundred million receipts pinned in a grid, almost all blank squares with a rare scribbled 5 or 3. A clerk squints at two rows and shouts "these two like the same records!"' },
      { locus: 'The genre stickers on every sleeve', concept: 'Content-based filtering', image: 'Every record wears a dozen coloured stickers: jazz, 1970s, trumpet, mellow. A customer\'s tote bag is covered in the same stickers, and the clerk matches bag to sleeves. A brand-new release already has its stickers.' },
      { locus: 'The floor map with glowing footprints', concept: 'Embeddings and matrix factorisation', image: 'The shop floor is a map where records that attract the same buyers are shelved side by side. Your glowing footprints mark where you "live". Distance on the floor is taste.' },
      { locus: 'The bouncer with a wide net and the DJ with a magnifying glass', concept: 'Two-stage: retrieval then ranking', image: 'A bouncer sweeps a huge fishing net across the shelves grabbing 500 records in seconds (retrieval). The DJ then studies each with a magnifying glass and the clock on the wall, picking the top 20 (ranking). A manager removes duplicates and adds one sponsored sleeve (re-rank).' },
      { locus: 'The card catalogue that answers in a blink', concept: 'ANN index (FAISS)', image: 'A brass cabinet labelled FAISS. You whisper your position on the map and drawers spring open with the 300 nearest records in ten milliseconds, occasionally missing one on purpose (approximate).' },
      { locus: 'The overnight stockroom crew', concept: 'Offline batch pipeline (Spark)', image: 'At 3 a.m., a crew in aprons re-labels every record, rebuilds the brass cabinet and reprints the floor map from yesterday\'s receipts, then stamps everything with a version number before opening.' },
      { locus: 'The "new arrivals" tasting booth', concept: 'Cold start and exploration', image: 'A booth where strangers get the top-40 playlist and a card asking "pick three moods"; a new unlabelled record is handed to every twentieth customer as a free taster so it can earn a place on the shelf.' },
      { locus: 'The hall of mirrors', concept: 'Feedback loop', image: 'A record shown at the front desk gets picked up, so it is put at the front desk again, until the mirrors reflect one album infinitely. A sign reads: rotate the display, log the shelf position, reserve a shelf for unknowns.' },
      { locus: 'The back office with two identical shops on CCTV', concept: 'A/B testing', image: 'Two screens show two halves of the shop, customers assigned by hashing their loyalty card. The manager refuses to read the results until four Sundays have passed, and watches a dial marked RETURN VISITS as much as the till.' },
    ],
  },
  designPractice: {
    problem:
      'Design a recommendation engine for a video streaming service with 100 million users and 10 million titles, receiving 1 billion interaction events per day. The home page must show personalised rows within 200 ms (p99), handle new users and new titles, and let the team run A/B tests on ranking changes.',
    steps: [
      {
        title: 'Functional requirements',
        prompt: 'List what the system must do for viewers, for the content and product teams, and for the ML team. Distinguish surfaces (home page, "because you watched", search-adjacent) and clarify what is out of scope.',
        reference: `**For viewers**
- Personalised home page: several rows ("Top picks", "Because you watched X", "Trending in your region", "New releases for you"), each 20-40 titles, personalised order.
- Item-to-item recommendations on a title page ("More like this").
- Continue-watching and recently-added are separate, deterministic lists (not modelled here beyond exclusion).
- React to in-session behaviour: a title just watched or dismissed changes subsequent rows.
- Respect explicit signals: "not interested", thumbs down, kids profile restrictions, maturity ratings.

**For content and product teams**
- Business rules: promote new originals, regional licensing constraints (only recommend what is licensed in the viewer\'s country), diversity constraints, sponsored or editorial slots.
- Dashboards: coverage, exposure per title, CTR by row.

**For the ML team**
- Train and deploy retrieval and ranking models; shadow, canary, A/B; roll back.
- Access to impression and interaction logs with serving-time features.
- Offline evaluation pipeline with time-based holdouts.

**Out of scope:** search ranking, playback, ad decisioning, the catalogue ingestion pipeline (we assume title metadata and embeddings of artwork/synopsis exist).`,
      },
      {
        title: 'Non-functional requirements & estimation',
        prompt: 'State latency, availability, freshness and consistency targets. Estimate request QPS, event volume, embedding storage, ANN index size, feature-store size, and ranking compute.',
        reference: `**Targets**
- Latency: home page recommendation call p99 under 200 ms; title page "more like this" p99 under 100 ms.
- Availability: 99.99% for the recommendation API, achieved through the degradation ladder (a fallback response counts as available).
- Freshness: session actions reflected within 5 seconds; new titles recommendable within 1 hour of metadata availability; embeddings retrained daily; trending refreshed every 15 minutes.
- Consistency: eventual; a title watched to completion should stop appearing within seconds via the real-time seen filter.
- Compliance: licensing filter is a hard constraint; GDPR erasure removes user data within 30 days including embeddings.

**Estimation**
- Users: 100M total, 20M daily active, peak concurrency ~2M; home page loads ~5,000/s average, 15,000/s peak.
- Events: 1B/day (impressions dominate), ~12k/s average, 40k/s peak; ~1 KB each -> 1 TB/day raw, ~150 GB/day compressed Parquet.
- Embeddings (k=64, float32): users 100M x 256 B = 25.6 GB; items 10M x 256 B = 2.56 GB.
- ANN index: FAISS IVF4096,PQ64 over 10M vectors: ~64 B/vector -> ~640 MB plus centroids; fits in RAM on every retrieval node.
- Online feature store (Redis): per-user features ~2 KB (embedding, last 50 items, affinities) x 100M = 200 GB; keep only 30-day-active users hot (40M -> 80 GB) and lazy-load the rest from DynamoDB/Cassandra.
- Item features: 10M x 1 KB = 10 GB, held in serving-node memory, refreshed every 10 minutes.
- Ranking compute: 15,000 req/s x 500 candidates = 7.5M scorings/s. GBM at 10 microseconds/row = 75 core-seconds/s, ~100 cores with headroom; a deep ranker would need ~20 GPUs or a smaller candidate set (200).
- Training: ALS over 1B implicit interactions, k=64, 10 iterations: ~30-60 min on 200 cores; ranker on 7 days of impressions (7B rows, sampled 10:1 negatives -> ~1B rows) on a GPU cluster in a few hours.`,
      },
      {
        title: 'API design',
        prompt: 'Design the client-facing recommendation API, the internal service APIs (retrieval, ranking, features), and the event ingestion contract. Include experiment assignment and impression logging.',
        reference: `\`\`\`
GET /v1/home?profile_id=&country=&device=&session_id=&limit_rows=8
  -> { request_id, experiment_ids: ["rank-v12:treatment"],
       rows: [ { row_id, title: "Because you watched Dune",
                 reason: { type: "item2item", seed_item: 123 },
                 items: [ { item_id, score, position, tracking_token } ] } ],
       ttl_seconds: 300 }

GET /v1/similar?item_id=&profile_id=&country=&limit=40
  -> { items: [...] }

POST /v1/events   (batched from clients, also from playback service)
  [{ profile_id, item_id, event: "impression"|"click"|"play"|"complete"|"dismiss"|"thumbs_down",
     ts, request_id, row_id, position, tracking_token, watch_seconds? }]
  202 Accepted (async to Kafka)

Internal (gRPC):
  FeatureService.GetUserFeatures(profile_id) -> embedding, recent_items[], affinities
  RetrievalService.Candidates(user_embedding, recent_items[], country, k=500)
      -> [ { item_id, source: "ann"|"i2i"|"trending"|"new", retrieval_score } ]
  RankingService.Score(profile_features, context, candidates[]) -> [ { item_id, scores{click,complete,like} } ]
  ExperimentService.Assign(profile_id, experiment_keys[]) -> { key: variant }
\`\`\`

**Contracts that matter**
- Every recommended item carries a \`tracking_token\` encoding request_id, row_id, position, model versions and experiment variant; clients echo it in events so impressions and clicks join back to the exact serving decision without a database lookup.
- \`experiment_ids\` returned so the client can log them; assignment is deterministic on hash(profile_id, experiment_salt).
- Home response is cacheable for a few minutes per profile (ETag on the response) unless a session event invalidates it.
- Licensing filter is applied server-side; the client never receives unlicensed titles.`,
      },
      {
        title: 'Data model & storage',
        prompt: 'Define what is stored where: raw events, training data, embeddings, ANN index, per-user and per-item online features, item-to-item lists, trending, experiment configs, and model artefacts. Justify each technology.',
        reference: `**Event log (Kafka -> S3/Iceberg via Spark Structured Streaming or Kafka Connect)**
- Topic \`viewer-events\`, 256 partitions keyed by profile_id, 7-day retention. Lake tables partitioned by date: \`impressions\`, \`interactions\`, each row includes the decoded \`tracking_token\` fields (request_id, model_versions, position, variant) and the serving-time features (logged by the API on each request into \`serving_logs\`).

**Training tables (Parquet/Iceberg)**
- \`train_rows(profile_id, item_id, label_click, label_complete, features_json, position, variant, ts)\` built by joining impressions with interactions within a 24 h window; time-partitioned for time-based splits.

**Embeddings and models (S3, versioned)**
- \`s3://reco/models/<run_id>/user_emb.parquet\`, \`item_emb.parquet\`, \`faiss.index\`, \`ranker.lgbm\`, \`manifest.json\` (run_id, metrics, feature list). A manifest pointer \`current\` is switched atomically after validation.

**Online feature store**
- Redis Cluster (hot users): \`u:{profile_id}\` HASH { emb (256 B binary), recent (50 item ids), aff:<genre> floats, updated_at }; TTL 30 days sliding.
- DynamoDB/Cassandra (all users): same schema, source of truth for cold users; Redis is a read-through cache.
- Session state: \`s:{session_id}\` LIST of last 20 events, TTL 2 h, written by a Flink job from \`viewer-events\` (or directly by the API on event receipt).

**Item-side (serving-node local memory, refreshed from S3 every 10 min)**
- item features: metadata, popularity stats, embedding, licensing bitmap per country (10M x ~1 KB).
- item2item: top-50 neighbours per item (10M x 50 x 4 B = 2 GB), computed nightly from co-watch and embedding neighbours.
- trending: per (country, category) top-200, refreshed every 15 min from a Flink windowed count; small, also cached in Redis for the API layer.

**Experiments and rules (Postgres)**
- \`experiments(key, salt, variants[], traffic_pct, start, end, metrics)\`, \`business_rules(surface, rule_json, priority, enabled)\`; loaded into memory by the API with a 30 s refresh.

**Why these choices:** Kafka + lake for replayable history and cheap storage; S3 for versioned immutable artefacts; Redis for sub-millisecond per-user reads with DynamoDB behind it for the long tail; local memory for the small hot item side to avoid millions of remote reads per second; Postgres for low-volume, audited configuration.`,
      },
      {
        title: 'High-level design',
        prompt: 'Draw the architecture with both the offline and online halves and trace one home page request end to end, including experiment assignment, retrieval, ranking, re-ranking, logging, and how a play event within the session changes the next request.',
        reference: `\`\`\`
OFFLINE                                        ONLINE
Kafka viewer-events                            Client app
  |-> S3 lake (impressions, interactions)         |  GET /home
  |-> Flink: session state -> Redis s:{sid}       v
  |-> Flink: trending 15m -> Redis/S3        [Reco API / orchestrator] <-> ExperimentService
                                                |  |  |  |
Airflow nightly:                                |  |  |  +-> Redis u:{pid}, s:{sid}  (user + session feats)
  Spark ALS / two-tower -> user_emb, item_emb   |  |  +----> RetrievalService (FAISS in RAM, i2i, trending, new)
  FAISS build -> faiss.index                    |  +-------> RankingService (LightGBM/DNN, item feats local)
  item2item, item features -> S3                +----------> re-rank (rules from Postgres), licensing filter
  LightGBM ranker train + offline eval          |
  manifest 'current' switch  ---- hot reload -->|-> response + tracking_tokens
                                                |-> serving_logs (features, versions) -> Kafka -> lake
\`\`\`

**Trace: home page request**
1. Client calls \`GET /home\` with profile, country, device, session_id.
2. Orchestrator asks ExperimentService for variant assignments (deterministic hash), selecting model versions and rule sets.
3. In parallel: fetch \`u:{pid}\` and \`s:{sid}\` from Redis (10 ms). If the user is cold, load from DynamoDB and fall back to context-only.
4. Build a short-term vector from session items (average of their item embeddings, from local memory) and blend with the long-term embedding.
5. RetrievalService runs generators in parallel: FAISS top-300 for the blended vector, item2item top-50 for each of the last 5 watched, trending top-100 for (country, device), new-releases matching top affinities; union to ~500 (20 ms).
6. Hard filters: licensed in country, maturity rating for the profile, not in seen/dismissed set (from \`s:{sid}\` and \`recent\`).
7. RankingService scores 500 with user, item, cross and context features in one batched call (40 ms); multi-task heads combined by variant-specific weights.
8. Re-rank: group into rows by reason (ANN -> "Top picks", i2i seed -> "Because you watched"), enforce per-row diversity (max 3 per genre), inject one exploration slot per row, apply promoted-title rules.
9. Respond with rows and tracking tokens (~110 ms total). Asynchronously publish serving_logs with features and versions.
10. Client logs impressions and clicks with tracking tokens to \`/events\` -> Kafka.

**Session reaction:** a \`play\` event arrives at Kafka; the Flink session job appends it to \`s:{sid}\` within 1-2 s; the client also invalidates its cached home response. The next home request blends the new item\'s embedding into the short-term vector and excludes the played title, so "Because you watched X" appears for the title just played.`,
      },
      {
        title: 'Deep dive & bottlenecks',
        prompt: 'Go deep on three areas: making retrieval fast and fresh (ANN tuning, index rebuilds, new items), making ranking affordable at 15,000 req/s, and building an unbiased training set from impression logs. Quantify.',
        reference: `**1. Retrieval: ANN tuning, rebuilds, new items**
- Index: FAISS \`IVF4096,PQ64\` over 10M x 64-d. Memory ~640 MB. Query with nprobe=32 gives ~95% recall@100 at ~5-8 ms on one core; nprobe=64 gives ~98% at ~12 ms. Pick nprobe per surface within the budget. HNSW (M=32, efSearch=128) is an alternative with better recall/latency but ~3-4 GB memory for 10M vectors; both fit.
- Throughput: 15,000 req/s x 1 ANN query = 15,000 QPS; at ~150 QPS per core that is ~100 cores, e.g. 12 nodes x 8 cores with the index replicated on each. Replication, not sharding, until the index exceeds node RAM (roughly 100M+ items).
- Rebuild: nightly full retrain rotates the space, so user embeddings, item embeddings and index are versioned together in a manifest; nodes download the new index (~1 GB) and swap atomically; user embeddings are bulk-loaded to Redis before the switch (25 GB at 500 MB/s is under a minute per node in parallel).
- New items between rebuilds: the item tower produces an embedding from metadata; add it to a small "delta" HNSW index (thousands of vectors) that is queried alongside the main index and merged into the nightly rebuild. Also inject new items via the "new releases" generator with exploration weight.
- Session freshness: the short-term vector is computed at request time from item embeddings held in local memory; no ANN rebuild needed.

**2. Ranking at scale**
- 15,000 x 500 = 7.5M rows/s. LightGBM with 300 trees, depth 8, ~300 features: ~8-12 microseconds/row single-threaded -> ~90 cores; 16 nodes x 8 cores gives 2x headroom. Batch the 500 candidates into one predict call to amortise overhead.
- Feature assembly is the hidden cost: 500 items x 300 features materialised per request. Keep item features as pre-serialised dense arrays in local memory and compute cross features vectorised (NumPy/Arrow, or a compiled service in Go/Rust/C++).
- If moving to a DNN ranker: reduce candidates to 200-300, run on GPU with dynamic batching across requests (Triton), target 20 ms per batch; or use a two-stage ranker (light model to 100, heavy model on 100).
- Cache: home page responses per profile for 5 minutes (ETag), invalidated on session events; at 20M DAU with ~3 loads/day, caching cuts ranking load by ~50%.
- Timeouts: ranker 60 ms hard; on timeout return retrieval order with a \`degraded\` flag; alert if degraded rate exceeds 1%.

**3. Unbiased training data**
- Join impressions to interactions by tracking_token within 24 h; label click, play, completion (>= 70% watched), thumbs.
- Negatives: only *impressed-and-not-engaged* items, never random catalogue items, so negatives reflect what the user actually saw.
- Position bias: include position as a feature during training; at inference set position to 1 for all candidates (or use a shallow position tower that is dropped at serving). Alternatively weight examples by 1/propensity(position) estimated from randomised-position experiments on 1% of traffic.
- Policy bias: reserve 1-2% of traffic where one slot per row is a uniformly random licensed candidate; these logs give unbiased estimates of item quality and feed counterfactual evaluation (IPS) of new rankers before A/B.
- Skew prevention: train on \`serving_logs\` features exactly as seen online; never recompute features offline for training the ranker. For retrieval models trained on interaction history, use point-in-time item and user attributes.
- Sampling: ~1B impressions/day with ~5% engagement; downsample negatives 10:1 and correct the intercept, or use per-example weights.

**Other bottlenecks**
- Redis hot user keys during a live event premiere: mostly item-side hot spots, absorbed by local item memory; user keys are spread by hashing.
- Nightly job runtime creeping past the window: monitor artefact age; run retrieval retrain daily and ranker weekly so one job\'s failure does not block the other.
- Licensing filter correctness: bitmap per item of licensed countries kept in local item memory; recomputed every 10 minutes from the rights database.`,
      },
      {
        title: 'Failure modes & trade-offs',
        prompt: 'Describe the degradation ladder and the behaviour when each component fails. Then articulate the main trade-offs: precompute vs realtime, CF vs content, ANN recall vs latency, model complexity vs cost, exploration vs exploitation, personalisation vs privacy. State what you rejected and why.',
        reference: `**Degradation ladder (each rung is monitored by fallback rate)**
1. Full path (~110 ms): user + session features, multi-generator retrieval, ranker, re-rank.
2. Ranker timeout (60 ms) or RankingService down: return candidates ordered by retrieval score, apply filters and diversity rules only.
3. RetrievalService/ANN down: item2item lists for recent items plus trending, from local memory and Redis.
4. Feature store (Redis) down: DynamoDB read-through if healthy; else context-only: trending per (country, device) and new releases.
5. Everything down: static editorial rows cached at the CDN/API layer for 15 minutes.

**Component failures**
- **Nightly batch fails**: yesterday\'s artefacts keep serving; alert at 36 h artefact age; delta index for new items still works.
- **Bad model promoted**: canary at 1% for 24 h with automatic rollback if CTR drops more than 5% relative, completion rate drops, or p99 latency rises more than 20 ms. Manifest pointer flips back in seconds.
- **Kafka lag**: session freshness degrades (client-side invalidation still hides just-played titles); trending goes stale; training data delayed but not lost (7-day retention).
- **Region outage**: active-active in two regions; artefacts in S3 with cross-region replication; Redis per region warmed from DynamoDB global tables; users may see slightly older session state after failover.
- **Licensing data outage**: keep last-known bitmap; never fail open to "all licensed"; if bitmap age exceeds 1 h, restrict to titles licensed globally.
- **Poisoned events** (bots inflating an item): rate-limit events per profile, filter non-human patterns before training, cap per-item daily interaction weight.

**Trade-offs**
- **Precompute vs realtime**: chose precomputed item-side artefacts and long-term user embeddings with realtime retrieval and ranking; full precompute would ignore session signal (a core requirement), full realtime embedding training is unnecessary.
- **CF vs content**: hybrid via two-tower retrieval (content in the item tower) plus multiple generators; pure CF fails new titles, pure content cannot surprise.
- **ANN recall vs latency**: nprobe tuned for ~95% recall; missing 5% of true neighbours barely moves NDCG because the ranker only needs good candidates, not all of them.
- **Ranker complexity vs cost**: GBM on 500 candidates chosen for CPU-only serving; a DNN with ~1% lift would cost a GPU fleet, justified only if 1% of watch time exceeds that cost.
- **Exploration vs exploitation**: one exploration slot per row (~3-5% of impressions) costs measurable short-term CTR and buys unbiased data and catalogue health; the split is itself A/B tested.
- **Personalisation vs privacy**: behavioural features are pseudonymised by profile id; embeddings and features are deleted on erasure requests; no sensitive attributes (inferred religion, health) are used as features.
- **Consistency**: eventually consistent recommendations accepted; the cheap real-time seen filter (client and session state) covers the visible cases.

**Rejected alternatives**
- Nightly per-user final lists only: cheap but blind to sessions; kept only as an email-digest path.
- Exact k-NN with brute force on GPUs: feasible for 10M items but costlier than IVF/PQ for no measurable quality gain.
- Random negatives from the catalogue for ranker training: teaches the model to distinguish shown from unshown items, not good from bad; use impressed negatives.
- Random train/test splits: leak future behaviour; use time-based splits.
- Storing item features in Redis: 7.5M reads/s is avoidable; local memory is the standard answer.`,
      },
    ],
  },
  interviewQuestions: [
    'Design a recommendation system for a streaming service. Walk me through the offline and online components.',
    'Compare collaborative filtering and content-based filtering. When does each fail, and how do hybrids combine them?',
    'Why is recommendation split into candidate generation and ranking? What does each stage optimise?',
    'How do you serve nearest-neighbour search over 10 million item embeddings in under 20 ms?',
    'How do you handle cold start for new users and new items?',
    'What is wrong with training a click model directly on impression logs, and how do you correct it?',
    'How would you A/B test a new ranking model, and what guardrail metrics would you watch?',
    'Your ranker service is down. What does the user see?',
  ],
}

export default chapter
