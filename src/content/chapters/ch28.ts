import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 28,
  slug: 'designing-realtime-abuse-masker',
  title: 'Designing Realtime Abuse Masker',
  module: 'case-studies',
  estimatedMinutes: 40,
  summary:
    'A realtime abuse masker sits in the path of live chat and comments and replaces profanity, slurs and harassment with masked text before other users see it, within a latency budget of a few milliseconds. The design forces you to choose between in-line and asynchronous moderation, between deterministic word matching and ML classifiers, and between masking and blocking, all while handling evasion, false positives and a feedback loop that keeps the system honest.',
  objectives: [
    'Decide when abuse detection must run in-line on the hot path and when it can run asynchronously after publish.',
    'Explain why Aho-Corasick beats a list of regexes for matching thousands of banned terms in one pass, and where it falls short.',
    'Layer a fast deterministic matcher with an ML classifier under a strict per-message latency budget.',
    'Design the pub/sub fan-out so every recipient sees the masked version and the system cannot leak the original.',
    'Handle evasion (l33t, spacing, Unicode), false positives (the Scunthorpe problem) and a feedback loop that updates rules safely.',
  ],
  quickRevision: [
    'Two placement options: in-line (mask before publish, adds latency, no leak) or async (publish, then retract/edit; low latency, brief leak). Live chat wants in-line.',
    'Latency budget for in-line masking is single-digit milliseconds per message; a p99 over ~20 ms is felt in a live stream chat.',
    'Aho-Corasick builds one automaton over all banned words and scans the text in O(n + matches), independent of dictionary size; 10k words is as fast as 10.',
    'A trie alone finds words that start at a position; Aho-Corasick adds failure links so one pass finds every occurrence of every pattern.',
    'Normalise before matching: lowercase, strip diacritics, map l33t (a<-4, e<-3, s<-$), collapse repeated letters, remove separators; keep an offset map back to the original text for masking.',
    'The Scunthorpe problem: naive substring matching flags innocent words. Use word boundaries, allowlists and context rules.',
    'Word lists catch known terms; ML classifiers (fastText, DistilBERT) catch harassment without keywords but cost 1-30 ms and produce probabilities, not certainties.',
    'Layered pipeline: normalise -> Aho-Corasick (sub-ms) -> cheap ML on the remainder (few ms) -> heavy ML async for review.',
    'Masking (replace with ****) keeps conversation flowing; blocking (reject) is for slurs and doxxing. Shadow-masking shows the sender their original text so they do not immediately probe the filter.',
    'Fan-out: mask once at ingest, publish only the masked payload to the pub/sub topic; store the original encrypted and access-controlled for appeals.',
    'Dictionary updates propagate via a versioned artifact in S3 plus a Redis pub/sub "reload" signal; rebuilding a 50k-term automaton takes milliseconds.',
    'Feedback loop: user reports + moderator decisions -> label store -> retrain classifier, update word list, run in shadow mode before promoting.',
    'Measure precision and recall separately per language and per community; a filter tuned for English gaming chat will misfire on Hindi or medical forums.',
  ],
  sections: [
    {
      id: 'problem-and-placement',
      title: 'The problem and where the masker sits',
      body: `Live chat on a streaming platform, comments on a news site, in-game messages: wherever strangers talk in real time, some of them will post slurs, harassment and spam. A **realtime abuse masker** intercepts each message, detects abusive content and replaces it (\`you are a ****\`) or drops it before other participants see it.

The first design decision is **where the check runs relative to publishing**.

**In-line (synchronous).** The message goes: client -> chat service -> masker -> pub/sub -> recipients. Nothing abusive is ever fanned out, because masking happens before publish. Cost: the masker is on the hot path, so every millisecond it spends is added to message latency, and if it is down, chat is down (or unfiltered). This is the right default for live chat, where a slur seen by 50,000 viewers for even two seconds is a real harm.

**Asynchronous (post-publish).** The message is published immediately and the masker runs after, sending a "retract" or "edit" event if it finds abuse. Latency is minimal and the masker can be slow and heavy (large ML models), but the original content leaks for the detection window (typically 100 ms to a few seconds) and clients must support retraction, which screenshots ignore. This fits comment sections with lower velocity and higher tolerance, or as a second heavy pass behind an in-line light pass.

**Hybrid.** Most production systems do both: a fast deterministic layer in-line that catches the obvious 95%, and an asynchronous ML layer that catches subtle harassment and retroactively removes or escalates it. Twitch's AutoMod and YouTube live chat follow this shape.

The **scale** sets the budget. A large live event can generate 50k-100k messages per second across all channels; a single popular stream sees 1k-5k/s. Each message is small (median ~40 characters, capped at 500). The masker is therefore a CPU-bound, high-QPS, low-latency service, closer to a load balancer than to a batch job.`,
      mentalModel:
        'A live TV broadcast runs a few seconds behind reality so a censor can bleep a swear word before it airs. In-line masking is that delay; async masking is issuing an apology after it has aired.',
      diagram: `In-line:
client --> chat svc --> [masker <5ms] --> pub/sub --> 50k viewers
                          never leaks, on hot path

Async:
client --> chat svc --> pub/sub --> 50k viewers (see original)
                 \\--> [masker, heavy ML] --> retract event -> viewers

Hybrid: in-line light pass + async heavy pass`,
      keyPoints: [
        'In-line masking never leaks but adds latency and a hot-path dependency; async is fast but leaks for the detection window.',
        'Live chat with large audiences justifies in-line; low-velocity comments tolerate async.',
        'Hybrid is standard: a deterministic in-line pass and a heavier asynchronous ML pass.',
        'Scale is tens of thousands of small messages per second; the masker is CPU-bound and latency-sensitive.',
      ],
      checkpoint: {
        question:
          'A news site has 50 comments per minute per article and a 5-second moderation window is acceptable to the product team. Which placement do you pick and why?',
        answer:
          'Asynchronous: velocity is low, the leak window is acceptable, and it lets you run heavier and more accurate classifiers without worrying about hot-path latency or availability. You might still keep a tiny in-line word list for the most egregious slurs where even 5 seconds is unacceptable.',
      },
    },
    {
      id: 'latency-budget',
      title: 'The latency budget and what it rules out',
      body: `In live chat, users perceive their own message appearing after roughly 100-200 ms as instant; beyond ~500 ms the chat feels laggy. That end-to-end budget is already spent on network hops, the chat service, pub/sub and WebSocket delivery. The masker gets what is left: a realistic target is **p50 under 2 ms and p99 under 10-20 ms** per message, for the in-line path.

**What fits in 2 ms.** Normalisation (a few microseconds), an Aho-Corasick scan over 500 characters (tens of microseconds), a handful of regex rules for structured abuse such as phone numbers or URLs (tens of microseconds each, if anchored and non-backtracking), and a linear model such as fastText or a logistic regression over character n-grams (under 1 ms on CPU). That whole pipeline runs in well under a millisecond and needs no GPU.

**What does not fit.** A transformer classifier (DistilBERT-sized) costs 5-30 ms on CPU per message and requires batching to be efficient on GPU, which adds queueing delay. A call to an external moderation API costs 50-300 ms. Both belong on the asynchronous path or must be reserved for the small fraction of messages the cheap layers flag as uncertain.

**Throughput.** At 50k messages/s and 0.5 ms CPU per message, you need 25 CPU-seconds per second: a handful of 16-core machines, with headroom for bursts. Deploy the masker as a stateless library or sidecar next to the chat service to avoid a network hop; a separate service adds 0.5-1 ms of RPC plus a failure mode.

**Fail behaviour.** When the masker exceeds its timeout, the chat service must decide: publish unmasked (fail open) or drop (fail closed). For a family-friendly stream, fail closed on slur-list matches and fail open on the ML layer; the deterministic layer is so cheap that it should effectively never time out.`,
      mentalModel:
        'The masker is a security guard at the door of a stadium. A glance at each ticket (the word list) takes a second; a full bag search (the big model) takes a minute and cannot be done for everyone, so it is done for the few who look suspicious, or after they are already inside.',
      diagram: `Per-message in-line budget (~2 ms p50)
|-- normalise .............. 5 us
|-- Aho-Corasick scan ...... 20-50 us
|-- structured regexes ..... 50 us
|-- fastText / linear ML ... 200-800 us
|-- masking + encode ....... 10 us
Excluded from hot path:
|-- transformer classifier . 5-30 ms  -> async / uncertain only
|-- external API ........... 50-300 ms -> async`,
      keyPoints: [
        'Target p50 under 2 ms, p99 under 10-20 ms for the in-line masker; the rest of the chat budget is spent elsewhere.',
        'Automaton matching, anchored regexes and linear ML fit comfortably; transformers and external APIs do not.',
        'Co-locate the masker as a library or sidecar to avoid an RPC hop.',
        'Define fail-open versus fail-closed per layer before the first outage.',
        'Capacity is CPU-seconds: 50k msg/s at 0.5 ms each is ~25 cores plus headroom.',
      ],
      checkpoint: {
        question:
          'A data scientist proposes replacing the word list with a fine-tuned BERT model running in-line for every message. What is your response?',
        answer:
          'BERT costs 5-30 ms per message on CPU and blows the in-line budget at 50k msg/s; it would need a GPU fleet and batching that adds queueing latency. Keep the deterministic layer in-line, run the BERT model asynchronously or only on the messages the cheap layers mark uncertain, and use its outputs to improve the word list and the linear model.',
      },
    },
    {
      id: 'word-matching',
      title: 'Word matching: from tries to Aho-Corasick',
      body: `The deterministic layer answers one question fast: does this text contain any of N banned terms, and where? With N in the thousands and messages arriving at 50k/s, the naive approaches fail.

**Naive: loop over patterns.** For each banned word, call \`contains\`. Cost is O(N x message length). With 10,000 terms and a 200-character message that is 2 million character comparisons per message; at 50k msg/s it is 100 billion comparisons per second. Not viable.

**Regex alternation.** \`(word1|word2|...|word10000)\` compiled once. Better, but most regex engines (PCRE, Java, Python's re) are backtracking; a huge alternation can degrade badly and is hard to reason about. RE2-style automaton regex engines (Go, Rust regex) handle it well and are effectively building the next structure for you.

**Trie.** Insert all banned terms into a prefix tree. To check whether a word starting at position i is banned, walk the trie from the root. This finds matches that start at i in O(word length), but you must restart from the root at every position, giving O(n x longest pattern) in the worst case, and it wastes the work already done when a partial match fails.

**Aho-Corasick.** A trie plus **failure links**: when the walk cannot continue on the next character, jump to the longest proper suffix of the current path that is also a prefix of some pattern, without rescanning the text. Also add **output links** so that reaching a node reports every pattern that ends there. The scan is now a single left-to-right pass in **O(n + number of matches)**, independent of the number of patterns. Building the automaton is O(total pattern length); 50,000 terms build in a few milliseconds and occupy a few megabytes. This is the algorithm inside grep -F, intrusion detection systems like Snort, and most production profanity filters.

**What it does not do.** It matches exact byte sequences. It knows nothing about word boundaries, spelling variants, or meaning. Those are the jobs of normalisation before the scan and of rules after it, which the next section covers. It also cannot express wildcards; for "phone number" or "URL" patterns, a few anchored regexes run alongside.`,
      mentalModel:
        'A trie is a phone-tree menu you restart from the top each time you mis-press. Aho-Corasick remembers that the digits you already pressed are also the start of a different valid menu path and jumps you there instantly.',
      diagram: `Patterns: {he, she, his, hers}      Text: "ushers"
Trie with failure links (---> = fail):
 root -h-> h -e-> he* -r-> her -s-> hers*
  |         \\-i-> hi -s-> his*
  \\-s-> s -h-> sh -e-> she*  (she ---> he : suffix "he")
Scan "ushers": u(root) s(s) h(sh) e(she*, via fail -> he*)
               r(her) s(hers*)   => matches: she, he, hers
One pass. Cost ~ len(text) + matches, not len(text) x patterns.`,
      keyPoints: [
        'Looping over N patterns is O(N x n) and collapses at thousands of terms and tens of thousands of messages per second.',
        'A trie finds matches starting at one position; Aho-Corasick adds failure and output links for all matches in one pass.',
        'Scan is O(n + matches) regardless of dictionary size; build is O(total pattern length), milliseconds for 50k terms.',
        'Aho-Corasick is exact byte matching; normalisation, boundaries and semantics are separate layers.',
        'Use anchored regexes only for structured patterns (phone numbers, URLs), not for the word list.',
      ],
      checkpoint: {
        question:
          'Your dictionary grows from 5,000 to 50,000 terms after adding 10 languages. How does per-message scan time change with Aho-Corasick, and with a naive loop?',
        answer:
          'Aho-Corasick scan time is essentially unchanged (O(n + matches)); only build time and memory grow roughly 10x, still milliseconds and a few tens of MB. The naive loop would get 10x slower per message, since it is O(N x n).',
      },
    },
    {
      id: 'normalisation-evasion-false-positives',
      title: 'Normalisation, evasion and the Scunthorpe problem',
      body: `Users adapt within minutes of a filter going live. \`sh1t\`, \`s h i t\`, \`shiiiit\`, \`s.h.i.t\`, Cyrillic lookalike letters, zero-width joiners between characters. A masker that matches only the canonical spelling is decorative.

**Normalise first, match second.** Before the automaton runs, produce a canonical form: lowercase; Unicode NFKC normalisation and confusable mapping (Cyrillic \`а\` -> Latin \`a\`); strip diacritics; map common l33t substitutions (\`4->a, 3->e, 1->i, 0->o, $->s, @->a\`); remove zero-width and separator characters between letters; collapse runs of three or more identical letters to two. Keep an **offset map** from each normalised character back to its original index, so that when the automaton reports a match at normalised positions [12, 16) you can mask the correct original characters, including the dots and spaces the user inserted.

**The Scunthorpe problem.** The English town of Scunthorpe was famously blocked by AOL's filter because of the substring in its name. Substring matching flags "class", "assassin", "Essex", "therapist". Mitigations, in order of cheapness:

1. **Word boundaries.** Only report matches whose neighbours in the normalised text are non-letters, or use two dictionaries: whole-word terms and always-match terms (the worst slurs, which are rarely innocent substrings).
2. **Allowlist.** A second automaton of known-safe words containing banned substrings ("scunthorpe", "assassin", "cockpit"); if a banned match lies inside an allowlisted match, drop it.
3. **Context rules.** Some words are abusive only when directed at a person ("you are a ...") or only in some communities; encode as simple patterns or hand to the ML layer.
4. **Per-language lists.** A harmless word in one language is a slur in another. Detect language (fastText langid, sub-millisecond) and pick the list, or scan with all lists and weight by detected language.

**Severity tiers.** Not every term deserves the same action. Tier 1 (slurs, sexual content aimed at minors): block and flag the account. Tier 2 (profanity): mask. Tier 3 (mild): allow but count towards a rate-based spam score. Tiers also decide fail-closed versus fail-open behaviour and which layer must be in-line.

**False positives are a product cost.** A masked medical question or a blocked place name erodes trust more than one missed swear word. Track the false-positive rate through appeals and moderator reversals, and prefer masking to blocking for anything below tier 1, because a masked word can be unmasked on appeal but a blocked message is a conversation that never happened.`,
      mentalModel:
        'A bouncer checking IDs learns to see through fake moustaches and hats (normalisation) but must not throw out everyone whose surname happens to contain a rude syllable (boundaries and allowlists).',
      diagram: `original:  "y0u  s.h.1.t  he4d"   idx 0..17
normalise: "you shit head"        offset map n->o
           [0..2]->[0..2], [4..7]->[5,7,9,11], [9..12]->[14..17]
scan:      match "shit" at n[4,8) -> original [5..12)
allowlist: none covers it
tier:      2 (profanity) -> mask
output:    "y0u  *******  he4d"`,
      keyPoints: [
        'Normalise (case, Unicode confusables, l33t, separators, repeats) before matching, and keep an offset map for masking the original.',
        'The Scunthorpe problem is substring matching flagging innocent words; fix with boundaries, allowlists and context rules.',
        'Per-language dictionaries and cheap language detection reduce cross-language false positives.',
        'Severity tiers decide block vs mask vs count, and fail-closed vs fail-open.',
        'Prefer masking to blocking below the top tier because masks are reversible on appeal.',
      ],
    },
    {
      id: 'ml-layer',
      title: 'Adding ML: catching abuse without keywords',
      body: `Word lists cannot see "go back to where you came from" or "nobody would miss you". Harassment, threats and targeted hate often contain no banned token. This is where a **classifier** earns its place, but it must be placed carefully relative to the latency budget.

**Cheap in-line models.** A fastText or logistic-regression model over character n-grams and word unigrams runs in a few hundred microseconds on CPU, needs no GPU, and reaches reasonable precision on toxicity datasets (Jigsaw, Civil Comments). It outputs a probability. Use two thresholds: above 0.95, mask or block in-line; between 0.6 and 0.95, publish but route to the async heavy layer; below, pass. This keeps the cheap model's false positives from hurting users while still catching blatant cases.

**Heavy asynchronous models.** A DistilBERT or similar transformer fine-tuned on your platform's labelled data, or a hosted moderation API, runs on the uncertain band and on a sampled fraction of all traffic for calibration. When it flags a published message, it emits a retract event to the pub/sub topic (clients replace the message with a mask), and may escalate the author to a moderator queue. Batch inference on GPU handles thousands of messages per second; latency of 200-500 ms is fine here.

**Context features.** Toxicity depends on who is speaking to whom. Features such as account age, prior violation count, message rate in the last minute, whether the message @-mentions someone, and whether the channel is flagged family-friendly are cheap to fetch from Redis and substantially improve precision. A new account posting its first message with an @-mention and a 0.7 toxicity score is a different risk from a five-year-old account.

**Why not ML only?** Deterministic lists are explainable ("blocked because it contains X"), instantly updatable when a new slur or a crisis-specific term appears, cheap, and predictable; a model retrain takes hours and can regress silently. Lists are also what legal and trust-and-safety teams can audit. Use both: the list for known terms and hard policy, the model for the long tail.

**Multilingual reality.** A model trained on English will emit noise on Hinglish or Portuguese. Either train per-language models selected by language detection or use a multilingual model and accept lower accuracy, but never let a model confidently mis-score a language it has not seen; gate by detected language and fall back to lists only.`,
      mentalModel:
        'The word list is the law book: precise, auditable, slow to amend but instant to enforce. The classifier is an experienced officer\'s judgement: catches things the book missed, but sometimes wrong, and you want a second opinion before acting on it alone.',
      keyPoints: [
        'Lists miss keyword-free harassment; a classifier fills the gap but outputs probabilities.',
        'Cheap linear models fit in-line with two thresholds: act above a high one, defer the uncertain band to async.',
        'Heavy transformers run asynchronously on the uncertain band and emit retract events.',
        'Context features (account age, rate, mentions, channel policy) sharpen precision cheaply.',
        'Keep the deterministic layer for explainability, instant updates and auditability; gate models by language.',
      ],
      checkpoint: {
        question:
          'The in-line linear model scores a message at 0.8 toxicity. What happens to it?',
        answer:
          'It is in the uncertain band: publish it (or mask it if the channel policy is strict), and asynchronously send it to the heavy model. If the heavy model confirms, emit a retract event so clients replace it with a mask, and increment the author\'s violation counter. The message and both scores are logged for training data.',
      },
    },
    {
      id: 'fanout-and-storage',
      title: 'Fan-out, storage and never leaking the original',
      body: `Masking is pointless if any path delivers the unmasked text. The architecture must make the masked payload the **only** payload that fans out.

**Mask once, at ingest.** The chat service receives the message, calls the masker (library or sidecar), and publishes the *masked* message to the channel topic in the pub/sub layer (Redis Pub/Sub or Redis Streams for small scale, Kafka or a purpose-built WebSocket fan-out tier for large streams). Fan-out servers holding WebSocket connections to viewers subscribe to the topic and forward. Because they never see the original, no fan-out bug can leak it. The per-message masker cost is paid once, not once per recipient; with 50,000 viewers that difference is 50,000x.

**Sender view: shadow masking.** Showing the sender their own message masked tells them exactly what the filter caught, which is free feedback for evasion. Many platforms echo the original back to the sender only (a client-side echo or a targeted message) while everyone else receives the masked version. For blocked messages, some platforms shadow-drop: the sender sees it posted, nobody else does. This slows evasion dramatically but must be used carefully for transparency reasons and disclosed in policy.

**Storing the original.** For appeals, moderator review, legal requests and training data, keep the original text, but treat it as sensitive: encrypt at rest, restrict read access to the moderation service, set a retention period (30-90 days unless under investigation), and never write it to general application logs. The chat history store (Cassandra or ScyllaDB partitioned by channel and time bucket for a stream, Postgres for low-volume comments) holds the masked text plus a flag and a reference to the moderation record.

**Moderation record.** For every flagged message store: message id, author, channel, matched terms and offsets, model scores, action taken (mask/block/retract), rule and model versions, and timestamp. Versions matter: when a rule is found to be wrong, you need to find every message it affected. Kafka topic \`moderation.events\` feeds both the record store and the analytics pipeline.

**Retractions.** For the async layer, publish a \`retract {messageId, maskedText}\` event to the same channel topic. Clients replace the content in place. Late joiners who fetch history get the already-updated stored version, so the store must be updated before or atomically with the retract publish.`,
      mentalModel:
        'A translator at a press conference speaks into the one microphone that feeds every earpiece in the room. Filter the microphone, not each earpiece; and keep the raw recording locked in a safe for the fact-checkers.',
      diagram: `client --msg--> [chat svc] --> [masker lib]
                    |               | matched? tier?
                    |  original --> [moderation store, encrypted, ACL]
                    |  masked   --> Kafka topic channel:{id}
                    |                   |
                    |            [fan-out tier: WS servers] --> 50k viewers
                    \\-- echo original to sender only (shadow mask)
async heavy model --> retract {msgId} --> same topic --> clients edit in place`,
      keyPoints: [
        'Mask at ingest and publish only the masked payload; fan-out servers must never see the original.',
        'Masking once per message rather than per recipient saves a factor equal to audience size.',
        'Shadow masking echoes the original only to the sender to slow evasion.',
        'Originals are stored encrypted with strict access and retention, alongside a versioned moderation record.',
        'Retractions from the async layer go through the same topic and update the store first so late joiners see the masked version.',
      ],
    },
    {
      id: 'updates-and-feedback',
      title: 'Rule updates, feedback loop and measuring the filter',
      body: `A filter is a living system. New slurs appear, a crisis introduces new targeted terms, evasions evolve, and false positives surface through appeals. The design must make updates fast and safe.

**Dictionary distribution.** Word lists, allowlists and severity tiers are edited in a moderation console backed by Postgres. Publishing produces a versioned artifact (JSON or a pre-built serialised automaton) in S3, and a Redis pub/sub or Kafka control message tells every masker instance "reload version 2026-09-15-07". Instances fetch, build the new automaton (milliseconds for tens of thousands of terms), atomically swap the pointer, and report their active version to a health endpoint. A term added by a moderator is live everywhere in seconds without a deploy. Guard rails: reject a publish that removes more than X% of terms or adds a term shorter than 3 characters without whole-word mode, since those are the classic mistakes that either open the floodgates or mask half the alphabet.

**Shadow mode.** New rules and new model versions first run in shadow: they score every message and log what they *would* have done without acting. Compare against the live version for a day: how many extra masks, sampled and reviewed by humans. Only then promote. This is the single most effective defence against a bad rule masking a legitimate word across the whole platform.

**Feedback sources.** User reports on messages the filter passed (false negatives); appeals on masked or blocked messages (false positives); moderator decisions in the review queue; and periodic random sampling of passed messages for human labelling, which is the only unbiased estimate of recall. All land in a **label store** keyed by message id with the moderation record's rule and model versions.

**Retraining.** Weekly (or on drift alerts), retrain the classifiers on the label store, evaluate on a held-out set per language and per community, run in shadow, promote. Keep the last two model versions deployable for instant rollback.

**Metrics that matter.** Precision and recall per tier and per language from the sampled labels; appeal reversal rate (a rising rate means precision is falling); time-to-mask for the async path; p99 masker latency; automaton version skew across instances; and the fraction of traffic hitting the uncertain band, which tells you how much the cheap model is deferring. A word list that never changes and a model that is never retrained is a filter that has silently stopped working.`,
      mentalModel:
        'A spam filter for email works the same way: the "report spam" and "not spam" buttons are the feedback loop, and rules ship as updates you can roll back, not as a new email client.',
      keyPoints: [
        'Dictionaries publish as versioned artifacts with a reload signal; rebuild the automaton in milliseconds and swap atomically.',
        'Shadow mode runs new rules and models without acting, so bad rules are caught before they hit users.',
        'Feedback comes from reports (false negatives), appeals (false positives), moderator decisions and random sampling (unbiased recall).',
        'Retrain on the label store, evaluate per language and community, keep two versions for rollback.',
        'Track precision, recall, appeal reversal rate, latency and version skew; an unchanging filter is a failing filter.',
      ],
      checkpoint: {
        question:
          'A moderator adds the term "ass" to the tier-2 list during a live event and publishes immediately. What goes wrong, and which guard rails would have caught it?',
        answer:
          'Without whole-word mode, "class", "pass", "assassin" and "massive" are masked across the platform within seconds. Guard rails: reject or warn on terms under 4 characters not marked whole-word, require an allowlist check, and run the change in shadow mode for even a few minutes to see the projected mask count spike before promoting.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What is the main advantage of in-line (pre-publish) abuse masking over asynchronous (post-publish) masking?',
      options: [
        'It can use larger ML models',
        'The abusive content is never delivered to recipients',
        'It has lower latency for the sender',
        'It requires no storage of moderation records',
      ],
      answerIndex: 1,
      explanation:
        'In-line masking happens before fan-out, so nothing abusive ever reaches viewers. The price is that it sits on the hot path with a tight latency budget, which is exactly why it cannot use large models; async masking can, but leaks for the detection window.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'Why is Aho-Corasick preferred over looping through each banned word with a substring search?',
      options: [
        'It understands word meaning',
        'Its scan time is O(n + matches), independent of the number of patterns, versus O(N x n) for the loop',
        'It handles Unicode normalisation automatically',
        'It requires less memory than a single regex',
      ],
      answerIndex: 1,
      explanation:
        'Aho-Corasick builds one automaton over all patterns; a single pass finds every match. The naive loop multiplies message length by dictionary size. Aho-Corasick does not understand meaning or normalise Unicode; those are separate layers.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'What do failure links add to a plain trie in Aho-Corasick?',
      options: [
        'The ability to match regular expressions',
        'Compression of the trie into fewer nodes',
        'Jumping to the longest suffix of the current path that is also a pattern prefix, so the scan never rescans text',
        'Support for case-insensitive matching',
      ],
      answerIndex: 2,
      explanation:
        'Failure links let the automaton reuse the characters already consumed when a path dead-ends, instead of restarting from the root at the next position. This is what makes the scan linear. Regex support, compression and case handling are unrelated.',
    },
    {
      type: 'multi',
      id: 'q4',
      difficulty: 2,
      question: 'Which techniques mitigate the Scunthorpe problem (innocent words flagged by substring matching)? Select all that apply.',
      options: [
        'Enforcing word boundaries on matches',
        'An allowlist of safe words containing banned substrings',
        'Increasing the size of the banned word list',
        'Per-language dictionaries selected by language detection',
        'Lowering the ML threshold so more messages are masked',
      ],
      answerIndices: [0, 1, 3],
      explanation:
        'Boundaries, allowlists and language-specific lists all reduce false positives. A bigger banned list and a lower ML threshold both increase masking and therefore make false positives worse.',
    },
    {
      type: 'truefalse',
      id: 'q5',
      difficulty: 2,
      statement:
        'A transformer classifier such as DistilBERT comfortably fits in the in-line latency budget for a live chat processing 50,000 messages per second.',
      answer: false,
      explanation:
        'Transformers cost 5-30 ms per message on CPU and need GPU batching, which adds queueing delay; the in-line budget is single-digit milliseconds. Run them asynchronously or only on the uncertain band flagged by cheaper layers.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question: 'Why should the masked text, not the original, be the payload published to the pub/sub topic?',
      options: [
        'Because pub/sub systems cannot carry long strings',
        'So that fan-out servers, which never see the original, cannot leak it, and masking is paid once per message rather than once per recipient',
        'Because the original must be deleted immediately for privacy law',
        'To reduce Kafka partition count',
      ],
      answerIndex: 1,
      explanation:
        'Masking at ingest makes the masked version the only thing that fans out, structurally preventing leaks, and avoids repeating the work for each of thousands of viewers. The original is retained (encrypted, access-controlled) for appeals, not deleted.',
    },
    {
      type: 'mcq',
      id: 'q7',
      difficulty: 3,
      question: 'What is "shadow masking" and why is it used?',
      options: [
        'Running a new rule set without acting on it, to measure impact',
        'Showing the sender their original text while everyone else sees the masked version, so the sender does not learn what the filter caught',
        'Masking messages only in dark mode',
        'Deleting the message from history after 24 hours',
      ],
      answerIndex: 1,
      explanation:
        'Shadow masking denies the sender immediate feedback about what triggered the filter, slowing evasion. Option A describes shadow mode for rule deployment, a different (also important) technique.',
    },
    {
      type: 'truefalse',
      id: 'q8',
      difficulty: 1,
      statement: 'Normalisation such as lowercasing and l33t-speak mapping should happen before the dictionary scan, with an offset map kept to mask the original text correctly.',
      answer: true,
      explanation:
        'The automaton matches exact sequences, so evasions must be canonicalised first. Because normalisation changes lengths (removing separators, collapsing repeats), an offset map is needed to mask the right characters in the original.',
    },
    {
      type: 'mcq',
      id: 'q9',
      difficulty: 2,
      question: 'How should a new word-list version reach hundreds of masker instances?',
      options: [
        'Redeploy the chat service with the list compiled in',
        'Each instance polls Postgres for every message',
        'Publish a versioned artifact to S3 and send a reload signal via Redis pub/sub or Kafka; instances rebuild the automaton and swap atomically',
        'Email the list to the on-call engineer',
      ],
      answerIndex: 2,
      explanation:
        'Artifacts plus a control signal give seconds-level propagation without a deploy, and rebuilding an automaton for tens of thousands of terms takes milliseconds. Per-message DB polling would add latency on the hot path; redeploys are too slow for live events.',
    },
    {
      type: 'mcq',
      id: 'q10',
      difficulty: 2,
      question: 'Which feedback source gives an unbiased estimate of the filter\'s recall (missed abuse)?',
      options: [
        'Appeals on masked messages',
        'Random sampling of passed messages labelled by humans',
        'The number of terms in the dictionary',
        'Masker p99 latency',
      ],
      answerIndex: 1,
      explanation:
        'Only random sampling of what was passed reveals what was missed without selection bias. Appeals measure false positives (precision), not recall; user reports are biased toward what people notice and bother to report.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design the per-message pipeline for an in-line masker with a 2 ms p50 budget, listing each stage, its rough cost and its decision.',
      modelAnswer: `1. **Normalise** (~5 us): lowercase, NFKC + confusables, strip diacritics, l33t map, remove separators/zero-width chars, collapse repeats; build offset map.
2. **Language detect** (~100 us, fastText langid) to choose dictionaries and gate models.
3. **Aho-Corasick scan** (~20-50 us) over tier-1 (always-match) and tier-2 (whole-word) dictionaries; drop matches covered by the allowlist automaton.
4. **Structured regexes** (~50 us): phone numbers, URLs, emails for anti-doxxing/spam.
5. **Context fetch** (~200 us, Redis pipeline): account age, violation count, recent message rate, channel policy.
6. **Linear classifier** (~300-800 us): probability of toxicity with context features.
7. **Decide**: tier-1 match or score > 0.95 -> block or mask, record violation; tier-2 match -> mask; 0.6-0.95 -> publish and enqueue to async heavy model; else pass.
8. **Mask and emit** (~10 us): replace original spans via offset map, publish masked payload, write moderation record asynchronously.

Total well under 2 ms; Redis fetch is the largest and can be cached per user for a few seconds.`,
      rubric: [
        'Orders normalisation before matching and mentions the offset map.',
        'Uses Aho-Corasick for the dictionary and separate regexes for structured patterns.',
        'Places a cheap classifier in-line with thresholds and defers the uncertain band to async.',
        'Gives rough per-stage costs that sum under the budget.',
        'Describes the decision outcomes (block, mask, defer, pass).',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 3,
      question:
        'Describe the feedback loop that keeps the masker accurate over time, and the safeguards that stop an update from breaking the platform.',
      modelAnswer: `**Inputs:** user reports on passed messages (false negatives), appeals on masked/blocked messages (false positives), moderator decisions in the review queue, and random samples of passed messages labelled by humans (unbiased recall). All are stored in a label store keyed by message id with the rule and model versions that were active.

**Outputs:** dictionary edits (new terms, allowlist entries, tier changes) via a moderation console, and periodic classifier retraining evaluated per language and community.

**Safeguards:** every change runs in shadow mode first, scoring live traffic without acting, and its projected mask count and sampled examples are reviewed before promotion. Publishing has guard rails (reject very short non-whole-word terms, warn on large deletions). Artifacts are versioned so rollback is a pointer swap, and the last two model versions stay deployable. Metrics watched after promotion: appeal reversal rate, mask rate per tier, uncertain-band fraction and latency.`,
      rubric: [
        'Names at least three feedback sources and distinguishes false positives from false negatives.',
        'Mentions random sampling for unbiased recall.',
        'Describes shadow mode before promotion.',
        'Mentions versioning and rollback.',
        'Names post-promotion metrics.',
      ],
    },
    {
      type: 'mcq',
      id: 'q13',
      difficulty: 1,
      question: 'Why keep a deterministic word list at all once a good ML classifier exists?',
      options: [
        'Because ML models cannot run on CPUs',
        'For explainability, instant updates when new terms appear, predictability and auditability',
        'Because word lists have higher recall than any model',
        'Because regulators require regular expressions',
      ],
      answerIndex: 1,
      explanation:
        'Lists are auditable ("blocked because it contained X"), can be updated in seconds during a crisis, cost microseconds and never regress silently. Models have better recall on keyword-free harassment but are probabilistic and slow to retrain. The two are complementary.',
    },
  ],
  flashcards: [
    { id: 'f1', front: 'In-line vs async abuse masking', back: 'In-line: mask before publish; no leak, adds hot-path latency. Async: publish then retract; low latency, leaks for the detection window. Live chat favours in-line, often with an async heavy pass.' },
    { id: 'f2', front: 'In-line masker latency budget', back: 'Roughly p50 under 2 ms, p99 under 10-20 ms per message; the rest of the ~200 ms chat budget goes to network, chat service, pub/sub and WebSocket delivery.' },
    { id: 'f3', front: 'Aho-Corasick complexity', back: 'Build O(total pattern length); scan O(text length + matches), independent of dictionary size. 50k terms build in milliseconds.' },
    { id: 'f4', front: 'Failure link', back: 'In Aho-Corasick, a pointer from a trie node to the node for the longest proper suffix of its path that is also a pattern prefix; allows one-pass scanning without rescans.' },
    { id: 'f5', front: 'Trie limitation vs Aho-Corasick', back: 'A trie finds patterns starting at one position and restarts from the root each time; Aho-Corasick adds failure and output links to find all patterns in one pass.' },
    { id: 'f6', front: 'Normalisation steps before matching', back: 'Lowercase, NFKC + confusable mapping, strip diacritics, l33t map (4->a, 3->e, $->s), remove separators/zero-width chars, collapse repeats; keep an offset map to the original.' },
    { id: 'f7', front: 'Scunthorpe problem', back: 'Substring matching flags innocent words (Scunthorpe, assassin, class). Fix with word boundaries, allowlists, context rules and per-language lists.' },
    { id: 'f8', front: 'Two-threshold ML decision', back: 'Score > 0.95: act in-line. 0.6-0.95: publish, defer to async heavy model. Below: pass. Keeps cheap-model false positives away from users.' },
    { id: 'f9', front: 'Which ML fits in-line?', back: 'fastText / logistic regression over char n-grams: sub-millisecond on CPU. Transformers (5-30 ms) and external APIs (50-300 ms) go async or uncertain-band only.' },
    { id: 'f10', front: 'Mask once at ingest', back: 'Publish only the masked payload to the pub/sub topic so fan-out servers never see the original; cost is per message, not per recipient.' },
    { id: 'f11', front: 'Shadow masking', back: 'Echo the original only to the sender while everyone else gets the masked version, denying the sender feedback about what the filter caught.' },
    { id: 'f12', front: 'Storing originals', back: 'Encrypted at rest, ACL-restricted to moderation, retention 30-90 days, never in general logs; moderation record stores matched offsets, scores, action and rule/model versions.' },
    { id: 'f13', front: 'Dictionary update propagation', back: 'Versioned artifact in S3 + reload signal via Redis pub/sub or Kafka; instances rebuild automaton in ms and swap atomically; guard rails on short terms and mass deletions.' },
    { id: 'f14', front: 'Shadow mode (rules/models)', back: 'Run a new version on live traffic logging what it would do without acting; review projected mask counts and samples before promoting.' },
    { id: 'f15', front: 'Unbiased recall estimate', back: 'Random sampling of passed messages labelled by humans. Reports and appeals are biased toward what users notice.' },
    { id: 'f16', front: 'Masking vs blocking', back: 'Mask (****) for profanity: reversible on appeal, conversation continues. Block for tier-1 (slurs, doxxing, minors). Tier decides fail-open vs fail-closed too.' },
    { id: 'f17', front: 'Retraction event', back: 'Async layer publishes retract {msgId, maskedText} to the same channel topic after updating the store, so live clients edit in place and late joiners fetch the masked version.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'Aho-Corasick for banned-word matching',
      prompt: 'Explain to a junior developer why we do not just loop over the banned words, and what Aho-Corasick does differently.',
      modelExplanation: `Suppose we have 20,000 banned words and 50,000 chat messages arriving every second. If we check each word against each message, that is a billion substring checks per second. It does not scale, and it gets slower every time a moderator adds a word.

Aho-Corasick flips it around. We build one structure from all the banned words up front: a tree where each path from the root spells a word (a trie). Then we add shortcuts called failure links: when we are partway through matching "shers" and the next letter does not fit, the link jumps us to the longest ending of what we have read that is also the start of some other banned word, so we never re-read characters. We walk the message once, letter by letter, and every time we land on a node that ends a word, we report a match.

The result: scanning cost depends on message length plus the number of matches, not on how many words are banned. Adding 10,000 more words makes the build slightly slower (still milliseconds) and the scan no slower at all.`,
      mustMention: [
        'Naive loop cost grows with dictionary size x message length',
        'Single automaton built from all patterns (trie)',
        'Failure links avoid rescanning',
        'Scan is O(text + matches), independent of dictionary size',
      ],
    },
    {
      id: 'fe2',
      concept: 'Why in-line and async layers coexist',
      prompt: 'Explain why the masker has both a fast in-line layer and a slower asynchronous layer instead of just one.',
      modelExplanation: `Live chat has a tight time budget: a message should show up in a couple of hundred milliseconds, and most of that is spent on the network and delivery. The masker gets only a few milliseconds. In that time we can normalise the text, run the banned-word automaton and a small linear model. That catches the obvious stuff, and because it runs before publishing, nothing obvious ever leaks.

But subtle harassment often has no banned words. Catching it needs a large model that takes tens of milliseconds, which is too slow for the hot path. So we publish the message and, in parallel, send the uncertain ones to the big model. If it flags the message, we publish a retract event and every client replaces it with a mask. Viewers might see the message for half a second, which is acceptable for the subtle cases and unacceptable for slurs, so slurs stay in-line. The two layers split the work by how obvious the abuse is and how much harm a brief leak would do.`,
      mustMention: [
        'Hot-path budget of a few milliseconds',
        'In-line layer: deterministic plus cheap model, never leaks',
        'Async layer: heavy model on uncertain cases, emits retraction',
        'Split by obviousness of abuse and harm of a brief leak',
      ],
    },
    {
      id: 'fe3',
      concept: 'False positives and the feedback loop',
      prompt: 'Explain why a filter that blocks too much is a real problem and how the system learns to fix both over-blocking and under-blocking.',
      modelExplanation: `A filter that masks the town of Scunthorpe or a medical question about breast cancer makes the product feel broken and silences legitimate users, which is often worse for trust than one missed swear word. So we treat false positives as a cost, not as free safety. We use word boundaries so "class" is not flagged, an allowlist for known safe words containing rude substrings, and we mask rather than block anything that is not top-tier, because a mask can be reversed on appeal.

To keep improving, we collect signals: appeals tell us what we wrongly masked, user reports tell us what we missed, moderators give final decisions, and we randomly sample passed messages for human labelling so we know our real miss rate without bias. These labels feed dictionary edits and model retraining. Every change first runs in shadow mode, where it logs what it would have done without acting, so a bad rule shows up as a projected spike in masking before any user sees it.`,
      mustMention: [
        'False positives erode trust and silence legitimate users',
        'Boundaries, allowlists, mask rather than block',
        'Feedback sources: appeals, reports, moderators, random sampling',
        'Shadow mode before promoting changes',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You walk backstage at a live television studio, from the stage door through the control room to the transmitter, following the path a spoken word takes before it reaches millions of screens.',
    stops: [
      { locus: 'The stage door with a seven-second clock', concept: 'In-line vs async placement', image: 'A huge red clock above the door counts a broadcast delay. Inside the delay window, a censor holds a bleep button; a second, slower censor sits in a back room reviewing a recording and shouting "pull it back!" after it already aired.' },
      { locus: 'The stopwatch on the censor\'s wrist', concept: 'Latency budget', image: 'The censor has a stopwatch that explodes at 2 milliseconds. A sweating intern tries to wheel in a wardrobe-sized supercomputer labelled BERT; the censor waves it to the back room because it takes thirty times too long.' },
      { locus: 'The teleprompter with glowing threads', concept: 'Aho-Corasick automaton', image: 'The script scrolls once, left to right. Above it hangs a spider-web of banned words strung as one tree; when a path dead-ends, a glowing thread yanks your finger sideways to a matching branch so you never re-read a letter. Thousands of words, one pass.' },
      { locus: 'The make-up mirror with a distortion lens', concept: 'Normalisation and evasion', image: 'A guest arrives with a fake moustache, numbers for letters and dots between syllables. The mirror strips them all away to show the real face, while a chalk line on the floor maps every dot back to where it stood so the censor bleeps exactly the right spots.' },
      { locus: 'The town sign reading SCUNTHORPE', concept: 'False positives and allowlists', image: 'A bewildered mayor of Scunthorpe stands with his mouth taped over. A producer rips the tape off and pins a green ALLOWLIST badge on him, then draws thick word-boundary lines around every name on the guest list.' },
      { locus: 'The seasoned floor manager', concept: 'ML classifier layer', image: 'A grey-haired floor manager with no rulebook narrows her eyes at a guest saying nothing on the banned list but dripping with menace. She holds up a card reading 0.8 and points to the slow back room rather than bleeping herself.' },
      { locus: 'The single microphone and the locked tape vault', concept: 'Mask once, fan-out only the masked payload', image: 'One microphone with a bleep box feeds a thousand earpieces; you cannot hear the raw audio anywhere on the floor. Behind a steel door, the raw tape sits in a vault with an access log and a shredder set to 90 days.' },
      { locus: 'The rulebook printer and the rehearsal booth', concept: 'Updates, shadow mode, feedback loop', image: 'A printer spits out a new rulebook every few seconds, each stamped with a version. Before it reaches the censor, a rehearsal booth runs the whole show against it silently and flashes a red number of extra bleeps. Viewer complaint letters and appeal forms pile into a hopper feeding the printer.' },
    ],
  },
  designPractice: {
    problem:
      'Design a realtime abuse masking system for a live-streaming platform\'s chat and a companion comment section. Peak load is 50,000 chat messages per second across 200,000 concurrent channels, with individual channels reaching 5,000 messages per second. Profanity must be masked before any viewer sees it; subtle harassment may be removed shortly after. Support 20 languages, moderator-editable word lists, appeals, and continuous improvement.',
    steps: [
      {
        title: 'Functional requirements',
        prompt: 'List what the system must do for viewers, senders, moderators and the platform, and what is out of scope.',
        reference: `**Core**
- Intercept every chat message and comment; detect profanity, slurs, harassment, threats, doxxing (phone numbers, addresses), and spam links.
- Actions by severity tier: mask spans (replace with asterisks), block (reject before publish), retract (remove after publish), and escalate the author to a review queue.
- Sender sees their original text (shadow mask); all others see masked text.
- Per-channel policy: family-friendly channels use stricter thresholds; creators can add channel-specific banned terms.
- Multilingual: per-language dictionaries and models for 20 languages, with language detection.

**Moderation**
- Console to edit global and per-channel word lists, allowlists and tiers, with versioning, shadow preview and rollback.
- Review queue for escalated messages and appeals; decisions feed the label store.
- Look up any message's moderation record: matched terms, scores, versions, action.

**Users**
- Report a message; appeal a mask or block.

**Analytics**
- Precision/recall estimates per tier, language and channel; mask rate; latency; appeal reversal rate.

**Out of scope**
- Image/video moderation, voice chat, account-level bans policy (consumes our escalations), and legal takedown workflows beyond storing the record.`,
      },
      {
        title: 'Non-functional requirements & estimation',
        prompt: 'Set latency, throughput, availability and accuracy targets, then estimate CPU, memory and storage.',
        reference: `**NFRs**
- In-line masker: p50 < 2 ms, p99 < 15 ms added to message path. Async heavy layer: 95% of retractions within 1 s of publish.
- Throughput: 50k msg/s peak platform-wide; 5k msg/s in a single channel; 2x headroom.
- Availability: masker path 99.99%; if the ML layer is unavailable, the deterministic layer still runs (degrade, do not fail open on tier-1 terms).
- Accuracy targets (measured by sampling): tier-1 recall > 99%, tier-2 recall > 90%, overall precision > 98%; appeal reversal rate < 2%.
- Dictionary change propagation < 10 s platform-wide.

**Estimation**
- Message size: median 40 chars, cap 500 chars; average payload ~200 B with metadata.
- CPU: in-line pipeline ~0.5 ms CPU/msg (dominated by the linear model and Redis fetch). 100k msg/s (with headroom) x 0.5 ms = 50 CPU-seconds/s -> ~4 x 16-core hosts at 80% utilisation; deploy 8 across 2 zones.
- Memory: 50k terms x 20 languages = 1M patterns, automaton ~50-100 MB; linear models ~10-50 MB each; trivially fits per process.
- Redis context lookups: 100k/s pipelined GETs; a 3-node Redis cluster handles this easily. Cache per-user context in-process for 5 s to cut it by ~80% for chatty users.
- Async heavy layer: uncertain band ~5% of traffic = 2.5k msg/s + 1% random sample = ~3k msg/s. DistilBERT on GPU at batch 64 does ~2k-4k inferences/s per T4-class GPU -> 2-3 GPUs plus headroom.
- Storage: moderation records for flagged messages (~10% of traffic -> 5k/s x 500 B = 2.5 MB/s = ~216 GB/day); originals of flagged messages encrypted, 90-day retention -> ~20 TB. Chat history itself belongs to the chat service.
- Label store: ~50k human labels/day, tiny.
- Kafka: moderation.events at 50k/s x 300 B = 15 MB/s, modest.`,
      },
      {
        title: 'API design',
        prompt: 'Design the internal masking API (as called by the chat service), the moderation console APIs, the report/appeal APIs and the pub/sub event schemas.',
        reference: `**Masking (internal, library call or gRPC sidecar; must be idempotent and stateless)**
\`\`\`
Mask(request) -> response
request:  { messageId, channelId, authorId, text, lang?: "auto", policyId }
response: { action: "pass" | "mask" | "block" | "defer",
            maskedText, spans: [{start, end, tier, ruleId}],
            score: 0.81, langDetected: "en",
            versions: { dict: "2026-09-15-07", model: "tox-lin-v42" } }
\`\`\`
"defer" means publish (masked if spans exist) and enqueue for the heavy layer.

**Heavy layer (async consumer of Kafka topic \`moderation.defer\`)**
- Produces \`moderation.decisions\`: \`{ messageId, action: "retract" | "confirm_pass", score, modelVersion }\`.

**Pub/sub message schemas (channel topic)**
\`\`\`
{ type: "message", id, channelId, authorId, text (masked), ts, flags: { masked: true } }
{ type: "retract", id, channelId, text (fully masked or removed), reason: "policy" }
\`\`\`
Sender-only echo carries the original text over the sender's own WebSocket.

**Moderation console (admin, authenticated, audited)**
\`\`\`
GET  /v1/dictionaries?scope=global|channel:{id}&lang=en
POST /v1/dictionaries/{id}/terms   { term, tier, wholeWord: true, lang }
DELETE /v1/dictionaries/{id}/terms/{termId}
POST /v1/dictionaries/{id}/allowlist  { term }
POST /v1/dictionaries/{id}:preview    -> { projectedMaskRatePct, sampleMatches[] }  (shadow run over last 10 min)
POST /v1/dictionaries/{id}:publish    -> { version }   (guard rails enforced)
POST /v1/dictionaries/{id}:rollback   { version }
GET  /v1/messages/{id}/moderation     -> full record incl. original (ACL: moderators)
GET  /v1/review-queue?channelId=&cursor=
POST /v1/review-queue/{itemId}:decide { decision: "uphold" | "reverse", note }
\`\`\`

**User-facing**
\`\`\`
POST /v1/messages/{id}:report   { reason }
POST /v1/messages/{id}:appeal   { note }    (only by the author, only for mask/block)
\`\`\`

**Control plane**
- Redis pub/sub channel \`masker.reload\` carrying \`{ artifact: "s3://.../dict-2026-09-15-07.bin", version }\`.
- \`GET /healthz\` on each masker reports active dict and model versions for skew monitoring.`,
      },
      {
        title: 'Data model & storage',
        prompt: 'Define the entities (dictionaries, moderation records, originals, labels, policies) and choose storage for each with justification.',
        reference: `**dictionaries / terms** (small, edited by humans, read by publish job)
- \`term_id, dictionary_id (global | channel), lang, term, normalized_term, tier (1|2|3), whole_word, created_by, created_at\`
- \`allowlist\` same shape. Postgres; full audit table of edits.
- **published artifacts**: \`version, s3_path, checksum, created_at, created_by, status (shadow | live | rolled_back)\` in Postgres; binary in S3.

**policies** (per channel)
- \`channel_id, strictness (standard | strict), ml_thresholds {act, defer}, extra_dictionary_id\` in Postgres, cached in Redis and in-process (TTL 60 s).

**moderation_records** (write-heavy, read by id and by author)
- \`message_id (pk), channel_id, author_id, action, spans (json), score, lang, dict_version, model_version, heavy_score?, heavy_model_version?, created_at\`
- Cassandra/ScyllaDB partitioned by \`message_id\`; secondary table by \`(author_id, created_at)\` for reviewing a user's history; TTL 180 days. Volume ~216 GB/day for flagged-only records.

**originals** (sensitive)
- \`message_id, ciphertext, key_id, created_at\` in a separate keyspace/bucket with KMS envelope encryption; access only via the moderation service with audit logging; TTL 90 days unless placed on legal hold (a \`holds\` table prevents TTL deletion by re-writing without TTL).

**review_queue / appeals / reports**
- Postgres: \`item_id, message_id, kind (escalation | appeal | report), state, assigned_to, decision, decided_at\`.

**labels** (training data)
- \`message_id, label (abusive | not), tier?, source (moderator | appeal | sample), labeler, dict_version, model_version, created_at\`; Postgres or a Parquet lake in S3 partitioned by day for training jobs.

**context features** (hot, ephemeral)
- Redis: \`user:{id}:ctx -> { accountAgeDays, violations, msgRate1m }\` maintained by counters with sliding windows (INCR + EXPIRE or sorted sets), TTL 24 h.

**Kafka topics**
- \`moderation.defer\` (uncertain band to heavy layer), \`moderation.decisions\`, \`moderation.events\` (every decision, for analytics into ClickHouse), \`channel.{id}\` or a sharded fan-out topic set owned by the chat service.`,
      },
      {
        title: 'High-level design',
        prompt: 'Draw the architecture from client to viewers, including the async layer, the control plane and the feedback loop, and walk a profane message and a subtle harassment message through it.',
        reference: `\`\`\`
 sender --WS--> [Chat service] --> [Masker lib/sidecar]
                     |                 | normalise -> langid -> Aho-Corasick(+allowlist)
                     |                 | regexes -> Redis ctx -> linear model -> decide
                     |<-- action, maskedText, spans, versions
                     |
                     |-- publish masked msg --> [Fan-out tier (WS servers)] --> viewers
                     |-- echo original -------> sender only
                     |-- record --------------> Kafka moderation.events -> Cassandra + ClickHouse
                     |-- original (flagged) --> encrypted store
                     \\-- defer? --------------> Kafka moderation.defer
                                                     |
                                     [Heavy ML consumers, GPU batch] --> moderation.decisions
                                                     |
                     [Decision applier] -- update store, publish retract --> fan-out --> viewers
                                       \\-- escalate --> review queue (Postgres)

 Control plane: [Mod console] -> Postgres -> [Publisher: build artifact -> S3] -> Redis 'masker.reload'
                -> every masker fetches, rebuilds automaton, swaps, reports version on /healthz
 Feedback: reports, appeals, moderator decisions, random samples -> label store -> retrain -> shadow -> promote
\`\`\`

**Profane message.** "y0u  s.h.1.t  he4d" arrives in a standard channel. Normalisation yields "you shit head" with an offset map. Language detection says English. Aho-Corasick matches "shit" (tier 2, whole word) at original offsets [5,12); allowlist has no covering match. Regexes find nothing. Redis says the account is 400 days old with 0 violations. Linear model scores 0.4. Decision: mask. The chat service publishes "y0u  *******  he4d" to the channel topic and echoes the original only to the sender. A moderation record with spans and versions goes to Kafka. Total masker time ~0.6 ms.

**Subtle harassment.** "nobody here would notice if you disappeared, @sam" contains no banned term. Regexes find nothing. Context: account 2 days old, 3 messages in the last minute, @-mention present. Linear model scores 0.82: defer. The message is published (unmasked, since no spans) and enqueued to \`moderation.defer\`. The GPU consumer scores 0.97 within 400 ms; the decision applier updates the record, publishes a retract event that clients apply in place, and pushes the author into the review queue with the violation counter incremented. Viewers saw the message for under half a second; a moderator later upholds, adding a label for the next retrain.`,
      },
      {
        title: 'Deep dive & bottlenecks',
        prompt: 'Go deep on (1) the matching engine and normalisation, (2) the hot single channel at 5k msg/s, and (3) dictionary publishing and version skew. Identify bottlenecks and how to relieve them.',
        reference: `**1. Matching engine**
- Build one Aho-Corasick automaton per language over normalised terms, plus one allowlist automaton per language. Use a double-array or compact array representation for cache-friendliness; 50k terms fit in a few MB and stay in L2/L3. Scan cost ~20-50 us for 500 chars.
- Whole-word enforcement post-match: check that neighbouring normalised characters are non-letters, using Unicode letter classes so Devanagari and Cyrillic words work.
- Allowlist precedence: drop any banned span fully contained in an allowlisted span. Also apply a per-channel term automaton (creator-added words) merged at publish time into the channel's artifact, or as a small secondary automaton looked up by channel id.
- Normalisation must be idempotent and keep offset arrays; collapsing "shiiiit" to "shiit" then matching "shit" requires the collapse to reduce to 2 repeats and the dictionary to include common doubled forms, or a second scan with collapse-to-1. Two scans still cost under 100 us.
- Bottleneck: normalisation over Unicode is often slower than the scan. Pre-compute confusable tables; avoid regex for normalisation; use a single pass state machine.

**2. The hot channel (5k msg/s to 50k viewers)**
- Masking is per message, so the channel costs 5k x 0.6 ms = 3 CPU-seconds/s; spread across chat-service instances by consistent-hashing the channel to a few instances, not one.
- Fan-out is the real bottleneck: 5k msg/s x 50k viewers = 250M deliveries/s. That belongs to the fan-out tier: batch messages per 50-100 ms window into one frame per viewer connection, and shard viewers across WS servers subscribed to the channel topic. The masker's only job is to keep the frame content clean and small.
- Redis context lookups at 5k/s from one channel: cache per-author context in-process for 5 s (chatty authors dominate) and pipeline lookups.
- Retractions at high velocity: clients keep a small ring buffer of the last N message ids to apply retracts; retracts for messages already scrolled off are cheap no-ops.

**3. Dictionary publishing and skew**
- Publisher job: load terms from Postgres, normalise, build per-language automata, serialise to a versioned artifact, write to S3, record in Postgres, then publish reload. Guard rails run before write: minimum term length unless whole-word, projected mask-rate change from the shadow preview under a threshold, no removal of tier-1 terms without a second approver.
- Instances fetch the artifact (tens of MB), build in-memory (ms), swap an atomic pointer; in-flight requests finish on the old version. Report version on /healthz; an alert fires if instances disagree for more than 60 s. During the skew window, a message may be judged by two versions on retry; that is acceptable because decisions are recorded with versions.
- Rollback is a reload signal pointing to the previous artifact; no rebuild from Postgres needed.
- Bottleneck: S3 fetch storm from 200 instances at once is fine (tens of MB each); for thousands of instances, stagger by jitter or use a shared regional cache.

**Other bottlenecks**
- GPU heavy layer under a spike (a raid floods the uncertain band): bound the defer queue; when lag exceeds 2 s, raise the in-line "act" threshold for strict channels and sample the defer stream rather than drop the queue silently; alert.
- ClickHouse ingestion at 50k events/s: batch inserts via Kafka engine; it is designed for this.
- Cassandra hot partition by author for a spammer: bucket the author history table by day.`,
      },
      {
        title: 'Failure modes & trade-offs',
        prompt: 'Enumerate failure scenarios (masker down, Redis down, bad dictionary publish, model regression, raids, evasion) with the system\'s behaviour, and summarise the trade-offs.',
        reference: `**Failure scenarios**
- *Masker library throws or times out*: the chat service applies per-tier fail policy. Since the deterministic layer is in-process and sub-millisecond, it effectively never times out; if the process is unhealthy, the chat instance is drained. If a sidecar is used and unreachable: strict channels fail closed (queue messages briefly, then reject), standard channels fail open for the ML layer only and still run an embedded minimal tier-1 list.
- *Redis (context features) down*: skip context features; the linear model runs with defaults, slightly lower precision; rate-based spam detection degrades. Alert, no user-visible outage.
- *Bad dictionary publish (e.g. "ass" without whole-word)*: shadow preview should have shown a mask-rate spike; if promoted anyway, the mask-rate alarm fires within a minute and on-call rolls back by reload signal in seconds. Messages masked in the window are identifiable by dict_version for bulk appeal reversal.
- *Model regression after retrain*: shadow comparison catches most; post-promotion, appeal reversal rate and mask-rate alarms trigger rollback to the previous model version, kept warm.
- *Heavy ML layer down or lagging*: in-line still protects tier-1 and high-confidence cases; uncertain band publishes without a second opinion. Mitigation: raise in-line thresholds for strict channels temporarily; bounded queue prevents unbounded lag; catch-up processes retractions late (still valuable for history).
- *Kafka down*: moderation records buffer locally with disk spooling; masking continues because it depends on nothing but in-memory artifacts. Defers are lost for the outage window (degrade, not fail).
- *Coordinated raid* (thousands of new accounts flooding a channel): context features (account age, rate) push scores up; channel-level automatic strict mode when new-account message share exceeds a threshold; per-author and per-channel rate limits belong to the chat service but consume our violation signals.
- *Evasion wave* (new spelling spreads): random sampling and reports reveal it; moderators add terms and confusable mappings; propagation in seconds. Track "time from first report to rule live" as an operational metric.
- *Leak via a secondary path* (search index, notifications, replays): every consumer must read the masked text from the chat store, never the original; the original lives only in the encrypted moderation store with ACLs. Audit consumers.
- *Version skew across instances*: transient double standards for a few seconds; acceptable and recorded per message.

**Key trade-offs**
- *In-line vs async*: in-line for tier-1 and obvious tier-2 (no leak, tight budget); async for subtle abuse (accuracy, brief leak). Hybrid costs two pipelines.
- *Deterministic list vs ML*: lists are explainable and instantly updatable but miss keyword-free abuse; ML catches the long tail but is probabilistic and slower to change. Keep both.
- *Mask vs block*: masking preserves conversation and is reversible; blocking prevents harm for the worst content. Tiers encode the policy.
- *Shadow masking*: slows evasion but reduces transparency; disclose in policy and always allow appeals.
- *Library vs sidecar vs service*: library gives lowest latency and no network failure mode but couples deploys to the chat service; sidecar isolates crashes at ~0.3 ms cost; a remote service is simplest to operate but adds 1 ms and an availability dependency. Chose library/sidecar.
- *Storing originals*: needed for appeals and training but a privacy liability; encryption, ACLs and TTL are the compromise.
- *Per-language models vs one multilingual model*: per-language gives accuracy at 20x operational surface; start multilingual with per-language lists and add per-language models for the top 5 languages.`,
      },
    ],
  },
  interviewQuestions: [
    'Design a system that masks profanity in a live chat with 50k messages per second before viewers see it. Where does the check run and what is your latency budget?',
    'Why is Aho-Corasick a better fit than iterating regexes for a 50,000-term banned list? Walk through how it scans "ushers" against {he, she, his, hers}.',
    'How do you handle evasion like "s.h.1.t" and Cyrillic lookalikes without breaking the ability to mask the exact original characters?',
    'What is the Scunthorpe problem and how does your design avoid masking legitimate words?',
    'How would you add an ML classifier for harassment without blowing the hot-path latency budget?',
    'How do you make sure the unmasked message can never leak to viewers through any path, and where do you store the original for appeals?',
    'A moderator publishes a bad word-list change during a major live event. How does your system contain the damage and roll back?',
    'How do you measure whether the filter is getting better or worse over time, and what feedback do you use to retrain it?',
  ],
}

export default chapter
