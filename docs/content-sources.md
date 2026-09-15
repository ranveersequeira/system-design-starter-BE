# Chapter references

The case studies are illustrative designs; traffic,
storage, and freshness figures are stated exercise assumptions, not measurements
or descriptions of the named companies' implementations.

## Technical references

Primary documentation consulted for selected protocol and product guarantees:

| Chapter | Reference | Details checked |
| --- | --- | --- |
| 6: Database Scaling | [PostgreSQL standby servers](https://www.postgresql.org/docs/current/warm-standby.html) | Asynchronous replay, standby reads, synchronous acknowledgment |
| 11: Populating And Scaling A Cache | [Microsoft cache-aside pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside) | Miss loading, database-first invalidation, consistency limitations |
| 15: Realtime PubSub | [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/) | At-most-once delivery and disconnected subscribers |
| 16: Load Balancers | [How Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html) | Routing, health checks, and connection behavior |
| 20: Communication Protocols | [MDN HTTP overview](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview), [HTTP/3 RFC 9114](https://www.rfc-editor.org/rfc/rfc9114.html), [gRPC concepts](https://grpc.io/docs/what-is-grpc/core-concepts/) | HTTP semantics, QUIC transport, RPC and streaming forms |
| 21: Blob Storages And S3 | [S3 overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html), [presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) | Object consistency, upload completion, delegated access |
| 25: Product Listing | [Elasticsearch pagination](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results) | Search-after, tie-breakers, and point-in-time views |
| 26: Rate Limiter | [Redis rate limiting](https://redis.io/tutorials/rate-limiting-in-java-spring-with-redis/) | Shared limiter state and atomic scripting |
| 30: Twitter Trends | [Flink timely stream processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/) | Event time, processing time, and watermarks |
| 31: URL Shorteners | [MDN 302 Found](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/302) | Temporary redirect behavior |
| 35: Web Crawler | [Robots Exclusion Protocol RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) | Robots interpretation and distinction from access control |

## Verification

Run `pnpm validate` and `pnpm build` from the repository root. Validation fails if any
chapter ID from 1 through 35 is missing. It also retains the existing quantity,
quiz-answer, unique-ID, diagram, and case-study checks.

The eleven added chapters contain 55 lesson sections, 110 quiz questions,
132 flashcards, 22 Feynman prompts, 66 memory-palace stops, and five case studies
with seven design steps each. Every added lesson has a mental model, key points,
and a prediction checkpoint. Existing chapter identifiers remain unchanged so
saved browser progress continues to refer to the same content.
