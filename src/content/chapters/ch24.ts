import type { Chapter } from '../types'

const chapter: Chapter = {
  id: 24,
  slug: 'introduction-to-big-data-tools',
  title: 'Introduction To Big Data Tools',
  module: 'building-blocks',
  estimatedMinutes: 40,
  summary:
    'Big data tools exist for one reason: the data or the computation no longer fits on one machine, so storage and processing must be spread across a cluster while hiding the failures that a cluster guarantees. This chapter maps the landscape: HDFS and MapReduce, Spark, stream processors like Flink, data lakes versus warehouses, columnar formats like Parquet, ETL versus ELT, and the lambda and kappa architectures. It closes with the most useful skill of all: recognising when none of this is needed.',
  objectives: [
    'Distinguish batch from stream processing and pick the right one for a given latency requirement.',
    'Explain how HDFS and MapReduce split storage and computation across machines and why Spark is faster for iterative work.',
    'Describe stream-processing concepts (event time, windows, watermarks, checkpoints, exactly-once) using Flink and Kafka Streams as examples.',
    'Compare data lakes, data warehouses and lakehouses, and explain why columnar formats like Parquet dominate analytics.',
    'Contrast ETL with ELT and lambda with kappa architectures, and judge when big data tooling is overkill.',
  ],
  quickRevision: [
    'Big data = data or compute that does not fit one machine; the tools trade single-node simplicity for horizontal scale plus fault tolerance.',
    'Batch processes a bounded dataset with high throughput and minutes-to-hours latency; stream processes unbounded events one (or a micro-batch) at a time with sub-second to seconds latency.',
    'HDFS: NameNode holds metadata, DataNodes hold 128 MB blocks replicated 3x; write-once, read-many; move compute to the data.',
    'MapReduce: map emits key-value pairs, shuffle groups by key, reduce aggregates; every stage writes to disk, so multi-stage and iterative jobs are slow.',
    'Spark keeps intermediate data in memory as RDDs / DataFrames, builds a DAG of lazy transformations, recomputes lost partitions from lineage; 10-100x faster than MapReduce on iterative workloads.',
    'Flink is a true event-at-a-time stream processor with event-time semantics, watermarks, windowed and keyed state (RocksDB backend), periodic checkpoints and exactly-once via two-phase-commit sinks.',
    'Kafka Streams is a library inside your service, not a cluster; Spark Structured Streaming is micro-batch on the Spark engine.',
    'Data lake: raw files (Parquet, JSON, Avro) on cheap object storage (S3 at about 2.3 cents per GB-month), schema-on-read. Data warehouse: structured, schema-on-write, SQL, columnar MPP (Snowflake, BigQuery, Redshift). Lakehouse: table formats (Delta, Iceberg, Hudi) give lake files ACID tables.',
    'Parquet is columnar: a query touching 3 of 100 columns reads about 3% of the bytes; per-column encoding and min/max statistics enable compression and predicate pushdown.',
    'Partition data on disk by a common filter (dt=2026-09-15/) so engines prune whole directories; avoid millions of tiny files.',
    'ETL transforms before loading (compute outside the warehouse); ELT loads raw then transforms with SQL inside the warehouse (dbt), keeping raw data and using elastic warehouse compute.',
    'Lambda architecture runs a batch layer for accuracy and a speed layer for freshness and merges them: two codebases. Kappa treats everything as a stream and reprocesses by replaying the log: one codebase.',
    'Overkill test: if the data fits on one machine (hundreds of GB, even a few TB) Postgres, DuckDB, ClickHouse or Polars will be faster, cheaper and simpler than a cluster.',
    'Managed services (BigQuery, Athena, EMR, Databricks, Kinesis Data Analytics) remove cluster operations but not the need to understand the model.',
  ],
  sections: [
    {
      id: 'batch-vs-stream',
      title: 'What makes data "big", and batch versus stream',
      body: `Data becomes "big" at the moment a single machine can no longer store it, scan it fast enough, or keep up with its arrival rate. That threshold moves every year: a 2026 server can hold several terabytes of RAM and tens of terabytes of NVMe, so many "big data" problems from 2010 are single-node problems today. The tools in this chapter are for when you are genuinely past the line: petabytes in storage, terabytes scanned per query, or millions of events per second.

Once you cross the line you must split the work across machines, and that forces two things you did not have before: **coordination** (which machine does which part?) and **fault tolerance** (with 1,000 disks, one fails every day; the job must still finish). Every tool here is a particular answer to those two problems.

The first split in the landscape is **how the data arrives**.

**Batch processing** operates on a *bounded* dataset: yesterday's logs, the full orders table, a month of clickstream. You read all of it, compute, and write results. Throughput is the goal; latency is minutes to hours. Nightly reports, model training, backfills and reconciliation are batch. Hadoop MapReduce, Spark and warehouse SQL are batch engines.

**Stream processing** operates on an *unbounded* sequence of events as they arrive: each click, payment or sensor reading is processed within milliseconds to seconds of happening. Fraud scoring, live dashboards, alerting and feeding a realtime feature store are streams. Flink, Kafka Streams and Spark Structured Streaming are stream engines, almost always fed by Kafka or Kinesis.

The dividing question is **how stale may the answer be?** If "as of last night" is acceptable, batch is simpler, cheaper per byte, and easier to reprocess. If the business value decays in seconds (blocking a fraudulent card, showing a trending topic), you pay the complexity of streaming: state that lives across events, out-of-order arrival, and the fact that there is never a moment when the input is "complete". Many systems use both, and the last section of this chapter is about how to combine them sanely.`,
      mentalModel:
        'Batch is doing the laundry once a week in one big load: efficient, but you wait. Streaming is washing each sock the moment you take it off: always clean, but you need a machine that never stops and must cope with socks arriving in the wrong order.',
      keyPoints: [
        'Big data begins where one machine cannot store, scan, or ingest fast enough; the line moves every year.',
        'Distribution forces coordination and fault tolerance; every tool is an answer to those.',
        'Batch: bounded input, high throughput, minutes-hours latency, easy reprocessing.',
        'Stream: unbounded input, seconds latency, stateful, must handle out-of-order events.',
        'Choose by how stale the answer may be.',
      ],
      checkpoint: {
        question:
          'A retailer wants (a) a daily sales report per store and (b) an alert within 30 seconds when a payment terminal stops sending heartbeats. Which is batch, which is stream, and why not do both the same way?',
        answer:
          '(a) is batch: bounded daily data, freshness of hours is fine, and a nightly Spark or SQL job is simplest. (b) is stream: the value of the alert decays in seconds, so events must be processed as they arrive with a per-terminal timer. Running (a) as a stream adds state and ordering complexity for no benefit; running (b) as a batch job every 30 seconds would thrash the cluster and still miss the window under load.',
      },
    },
    {
      id: 'hadoop',
      title: 'Hadoop: HDFS and MapReduce',
      body: `Hadoop (2006, modelled on Google's GFS and MapReduce papers) established the pattern that everything since refines: **distributed storage below, distributed compute above, and move the computation to the data instead of the data to the computation**.

**HDFS (Hadoop Distributed File System)** splits every file into large blocks, **128 MB by default**, and stores each block on **three DataNodes**, preferably in two different racks. A single **NameNode** keeps the metadata in memory: which blocks make up which file and which DataNodes hold each block. Files are write-once (append-only); you never edit a byte in place. The design choices follow from the workload: huge sequential scans, not random access. Large blocks keep the NameNode's metadata small (a petabyte is about 8 million blocks) and make each read a long streaming transfer rather than a seek. Three replicas make disk failure routine: a DataNode heartbeat stops, the NameNode notices, and re-replicates the lost blocks from the survivors. The NameNode itself was the famous single point of failure; production clusters run an active/standby pair with a shared edit log (JournalNodes) and ZooKeeper for failover.

**MapReduce** is the compute model. A job has two user-written functions. **Map** takes one input record and emits zero or more (key, value) pairs. The framework then **shuffles**: it partitions and sorts all pairs by key and delivers each key with all its values to one **Reduce** call, which emits the result. Word count is the canonical example: map emits (word, 1) for each word; reduce sums the ones. The framework schedules map tasks on the DataNodes that already hold the input block (data locality), reruns any task whose machine dies, and writes every stage's output back to HDFS. Resource scheduling was later split out into **YARN** (ResourceManager, NodeManagers, one ApplicationMaster per job), so that Spark, Hive and others could share the same cluster.

**Why MapReduce faded.** Every job is exactly one map and one reduce, with a full round trip to disk in between and after. A real pipeline (join, filter, aggregate, rank) becomes a chain of 5-10 jobs, each reading and writing HDFS. Iterative algorithms such as PageRank or k-means, which re-read the same data dozens of times, are painfully slow. Writing joins by hand in Java map and reduce functions was also tedious, which is why Hive (SQL to MapReduce) and Pig appeared almost immediately. HDFS survives as a storage layer (and its ideas live on in object storage); MapReduce as a programming model has been almost entirely replaced by Spark.`,
      mentalModel:
        'HDFS is a warehouse that stores every pallet in three different aisles so a forklift breaking down never loses stock. MapReduce is sending a counter to every aisle (map), collecting all the tally sheets sorted by product (shuffle), and having one clerk per product add them up (reduce).',
      diagram: `HDFS                              MapReduce (word count)

 client --metadata--> NameNode      input blocks on DataNodes
                       |                 |        |        |
        block -> DN1  DN2  DN3         map      map      map
        (128 MB, 3 replicas,        (w,1)...  (w,1)... (w,1)...
         2 racks)                        \\       |       /
                                       shuffle + sort by key
                                         /       |       \\
                                      reduce   reduce   reduce
                                      (the,9)  (cat,4)  (sat,2)
                                         |        |        |
                                        HDFS output (disk)`,
      keyPoints: [
        'HDFS: NameNode metadata, DataNodes hold 128 MB blocks replicated 3x across racks; write-once.',
        'Move compute to data: map tasks run where the block already lives.',
        'MapReduce = map (emit key-values) -> shuffle/sort by key -> reduce (aggregate).',
        'Every stage hits disk; multi-stage and iterative jobs are slow, which motivated Spark.',
        'YARN separated resource scheduling so many engines share one cluster.',
      ],
      checkpoint: {
        question:
          'Why does HDFS use 128 MB blocks when a typical filesystem uses 4 KB blocks?',
        answer:
          'Two reasons. The NameNode holds every block\'s metadata in RAM, so small blocks would blow up memory (a petabyte in 4 KB blocks is 250 billion entries). And the workload is large sequential scans: a 128 MB block streams off disk at full bandwidth for about a second, making seek time negligible, whereas 4 KB blocks would make the job seek-bound. The cost is that HDFS is terrible for millions of small files.',
      },
    },
    {
      id: 'spark',
      title: 'Spark: in-memory DAG execution',
      body: `Apache Spark (Berkeley, 2010; Apache 2013) kept Hadoop's storage and cluster model and replaced the compute model. Its two ideas explain why it displaced MapReduce almost completely.

**Idea 1: arbitrary DAGs, not map-then-reduce.** You write a program that applies a chain of transformations (map, filter, join, groupBy, ...). Spark does not execute them as you go; it records them **lazily** into a directed acyclic graph and only runs when you ask for a result (an *action* such as count, collect, or write). The DAG scheduler then groups consecutive narrow transformations (no shuffle needed) into a single **stage** that runs as one pass over the data, and inserts a shuffle only at wide dependencies like groupBy or join. A pipeline that was ten MapReduce jobs becomes two or three stages with two shuffles, and nothing touches disk in between.

**Idea 2: keep data in memory, recover by recomputing.** Intermediate datasets are **RDDs** (resilient distributed datasets): partitioned collections that can be **cached** in executor memory. Iterative algorithms read the input from HDFS or S3 once, cache it, and run 50 iterations against RAM. Fault tolerance does not come from replicating memory (too expensive) but from **lineage**: each RDD remembers the transformations that produced it, so if an executor dies, Spark recomputes only the lost partitions from their parents. This is why the paper reported 10-100x speedups on iterative and interactive workloads.

**The modern API.** Nobody writes raw RDDs any more. **DataFrames** (typed columns, like a distributed Pandas or SQL table) go through the **Catalyst** optimizer, which reorders filters, prunes columns, chooses join strategies (broadcast a small table instead of shuffling both sides) and generates JVM bytecode via **Tungsten**. Spark SQL, PySpark, Structured Streaming and MLlib all sit on the same engine, so a data scientist's PySpark notebook and an analyst's SQL query share optimisations and cluster.

**Operational reality.** Spark runs on YARN, Kubernetes, or standalone, and is sold managed as Databricks, EMR, Dataproc and Synapse. Its pain points are memory tuning (executor sizes, spills when data exceeds RAM), **shuffle** cost (still writes shuffle files to local disk and moves them over the network), and **data skew** (one hot key makes one task run for an hour while 999 finish in a minute; fix with salting or adaptive query execution). Spark's streaming mode, **Structured Streaming**, processes micro-batches typically every 100 ms to a few seconds; that is fine for dashboards and ETL but not for per-event millisecond latency, which is Flink's territory.`,
      mentalModel:
        'MapReduce is a relay race where every runner writes the baton\'s position to a notebook and the next runner reads it. Spark is one runner who plans the whole route first, carries everything in hand, and, if they trip, re-runs only the last leg because they remember where they came from.',
      diagram: `Spark job as a DAG

 read(S3) -> filter -> map -> [shuffle] -> groupBy -> join -> write
 \\________ stage 1 ________/            \\____ stage 2 ____/
   narrow ops fused, run in            one shuffle boundary,
   memory partition by partition       data grouped by key

 lost partition?  recompute from lineage: read -> filter -> map
 cached RDD?      50 iterations hit RAM, disk read once`,
      keyPoints: [
        'Lazy transformations build a DAG; stages fuse narrow ops and shuffle only at wide dependencies.',
        'RDDs can be cached in memory; lost partitions are recomputed from lineage rather than replicated.',
        'DataFrames + Catalyst optimizer + Tungsten codegen: SQL, Python, streaming and ML on one engine.',
        '10-100x faster than MapReduce for iterative and multi-stage work.',
        'Pain points: memory tuning, shuffle I/O, data skew; streaming is micro-batch.',
      ],
      checkpoint: {
        question:
          'A Spark job joins a 2 TB events table with a 50 MB countries table. What join strategy should the optimizer pick, and what happens if it does not?',
        answer:
          'A broadcast hash join: ship the 50 MB table to every executor and probe it while streaming through events, with no shuffle of the 2 TB side. If instead it picks a sort-merge join, both tables are hashed by key and shuffled across the network; the 2 TB table gets rewritten to shuffle files and moved, turning a minutes job into an hour. Catalyst does this automatically below spark.sql.autoBroadcastJoinThreshold (default 10 MB), so you may need to raise it or add a broadcast hint.',
      },
    },
    {
      id: 'streaming',
      title: 'Stream processing: Flink, Kafka Streams and the hard parts',
      body: `A stream processor consumes events from a log (Kafka, Kinesis, Pulsar), keeps **state** across events, and emits results continuously. The difficulty is not throughput; it is that the input never ends and never arrives in order.

**Event time versus processing time.** A click that happened at 12:00:01 on a phone in a tunnel may reach Kafka at 12:03. If you count clicks per minute by arrival time, that click lands in the wrong minute and your numbers change depending on network conditions. Serious pipelines use **event time**, the timestamp inside the event, and must then answer: when is the 12:00 window complete? The answer is a **watermark**: a running estimate ("all events up to 12:00:00 have probably arrived") that advances as the stream progresses. When the watermark passes a window's end, the window fires. Events arriving after the watermark are **late**; you drop them, emit corrections, or hold windows open for an allowed lateness. This is a latency versus completeness trade-off you cannot avoid.

**Windows.** Tumbling (fixed, non-overlapping: every 1 minute), sliding (every 1 minute over the last 5), and session (gap-based: a user's activity until 30 minutes of silence). All need per-key state that must survive machine failure.

**Apache Flink** is the reference true-streaming engine: event-at-a-time processing, event-time semantics with watermarks, keyed state stored locally (in memory or the **RocksDB** state backend for state larger than RAM), and **checkpoints** taken with asynchronous barrier snapshots (a Chandy-Lamport variant) every few seconds to durable storage. On failure, Flink restores the last checkpoint and rewinds Kafka offsets to match, so each event affects state exactly once. To extend that to outputs it uses **two-phase-commit sinks** (Kafka transactions, idempotent writes), giving end-to-end exactly-once. Flink also runs batch jobs as a special case of streaming (bounded streams), which is the unified model Apache Beam and Google Dataflow also promote.

**Kafka Streams** is a Java library, not a cluster: your service embeds it, state lives in local RocksDB backed by Kafka changelog topics, and scaling means starting more instances of your service. It is ideal when a team already runs Kafka and wants stream processing without a second cluster to operate. **Spark Structured Streaming** offers the same DataFrame API as batch but executes in micro-batches; good for unifying code with existing Spark ETL, weaker for very low latency and complex event-time logic.

**Choosing.** Sub-second latency, large keyed state, complex windows: Flink. Stream processing embedded in an existing service on Kafka: Kafka Streams. A team that lives in Spark and tolerates seconds of latency: Structured Streaming. All three assume the log (Kafka) is the durable source of truth that can be replayed.`,
      mentalModel:
        'Counting people entering a stadium per minute from turnstile tickets that arrive by post with random delays. Event time is the time printed on the ticket; the watermark is the steward saying "I am fairly sure all tickets for 12:00 are in now"; late tickets either get thrown away or trigger a corrected count.',
      diagram: `event time vs processing time (1-minute tumbling window 12:00-12:01)

 events (event time):  12:00:05  12:00:40  12:00:58    12:00:20 (late)
 arrive (proc time):   12:00:06  12:00:41  12:01:10    12:03:00
                                               ^
 watermark passes 12:01:00 here -> window fires with count 3
 late event at 12:03: drop | emit correction | allowed lateness

 Flink: keyed state (RocksDB) --checkpoint every N s--> S3/HDFS
        failure -> restore state + rewind Kafka offsets`,
      keyPoints: [
        'Use event time, not arrival time; watermarks decide when a window is complete.',
        'Late data forces a trade-off: drop, correct, or wait longer.',
        'Windows (tumbling, sliding, session) need durable per-key state.',
        'Flink: true streaming, RocksDB state, checkpoints, exactly-once via two-phase-commit sinks.',
        'Kafka Streams is a library in your service; Spark Structured Streaming is micro-batch.',
      ],
      checkpoint: {
        question:
          'A Flink job computes revenue per minute. A mobile client buffers events offline and uploads them an hour later. What happens to those events, and what are your options?',
        answer:
          'By the time they arrive, the watermark has passed their windows by an hour, so they are late. Default behaviour drops them and revenue is understated. Options: set allowed lateness (say 2 hours) so windows stay open and emit updated results, at the cost of holding an hour of extra state; emit late events to a side output and reconcile them in a batch job; or accept the loss if the dashboard is only indicative and the authoritative number comes from the nightly batch.',
      },
    },
    {
      id: 'storage',
      title: 'Data lakes, warehouses, lakehouses and columnar formats',
      body: `Processing engines need somewhere to read from and write to. Two storage philosophies emerged and are now converging.

**Data warehouse.** A database built for analytics: you define a schema, load clean structured data (**schema-on-write**), and query with SQL. Under the hood it is a **columnar, massively parallel** engine: Teradata and Vertica historically; Redshift, BigQuery and Snowflake today. Strengths: fast aggregations over billions of rows, governance, a single source of truth for the business. Weaknesses: storage is priced at a premium, semi-structured or raw data (logs, images, JSON blobs) fits badly, and loading requires you to decide the schema before you know all the questions.

**Data lake.** Dump everything as files into cheap object storage (**S3, GCS, ADLS**, or HDFS) in whatever shape it arrives (**schema-on-read**). S3 Standard costs about 2.3 cents per GB-month, so keeping petabytes of raw history is affordable, and any engine (Spark, Presto/Trino, Athena, Flink, Python) can read the files. Weaknesses: no transactions (a job that fails halfway leaves partial files), no schema enforcement, and without discipline it becomes a **data swamp** nobody can navigate.

**Lakehouse.** Open **table formats** (Delta Lake, Apache Iceberg, Apache Hudi) put a transaction log next to the Parquet files in the lake. That gives ACID commits, schema evolution, time travel (query the table as of yesterday), and efficient metadata so engines skip files without listing directories. The result is warehouse-like reliability on lake-priced storage, queried by both Spark and SQL engines; Snowflake and BigQuery now read Iceberg tables directly, which is the convergence.

**Why columnar: Parquet.** A row format (CSV, JSON, Avro) stores each record contiguously, ideal for writing an event or reading a whole row. Analytics does the opposite: scan millions of rows but touch three columns. **Parquet** stores data column by column inside row groups (typically 128 MB to 1 GB): all values of "amount" together, then all values of "country". Consequences:

- **Projection pushdown:** reading 3 of 100 columns reads about 3% of the bytes.
- **Compression:** a column of similar values compresses far better than mixed rows; dictionary encoding turns "country" strings into small integers, run-length encoding collapses repeats, and Snappy or Zstd on top gives 5-10x smaller files than CSV.
- **Predicate pushdown:** each column chunk stores min/max statistics, so a filter of amount > 1000 skips chunks whose max is 900 without reading them.

**Partitioning and file sizing** matter as much as the format. Lay files out by a common filter, such as dt=2026-09-15/region=eu/, so engines prune whole directories. Aim for files of 128 MB to 1 GB; a million 10 KB files makes listing and opening dominate the query (the small-files problem), which is why streaming writers compact their output periodically. Avro remains the right format for the Kafka wire (row-oriented, schema registry); convert to Parquet when landing in the lake.`,
      mentalModel:
        'A warehouse is a library with a strict catalogue: every book shelved by rule, fast to find, expensive to run. A lake is a giant attic where you keep every box because storage is cheap. A lakehouse is the attic with an inventory ledger on the door. Parquet is storing all the receipts\' amounts in one envelope and all the dates in another, so adding up the amounts never requires unfolding the dates.',
      diagram: `row format (CSV/Avro)         columnar (Parquet)
 id,country,amount,ts          row group 1 (128 MB..1 GB)
 1,IN,250,...                    col id      [1,2,3,...]  min 1 max 9999
 2,US,80,...                     col country [IN,US,IN..] dict {IN:0,US:1}
 3,IN,4000,...                   col amount  [250,80,4000] min 80 max 4000
 ...                             col ts      [...]
 SELECT sum(amount)              -> read only 'amount' chunk
 WHERE amount > 5000             -> skip row group (max 4000)

 lake layout: s3://bucket/events/dt=2026-09-15/region=eu/part-000.parquet`,
      keyPoints: [
        'Warehouse: schema-on-write, SQL, columnar MPP, premium storage (Snowflake, BigQuery, Redshift).',
        'Lake: raw files on cheap object storage, schema-on-read, any engine; risk of a swamp.',
        'Lakehouse table formats (Delta, Iceberg, Hudi) add ACID, schema evolution and time travel to lake files.',
        'Parquet columnar layout gives projection pushdown, strong compression and min/max predicate pushdown.',
        'Partition by common filters and keep files 128 MB-1 GB; avoid the small-files problem.',
      ],
      checkpoint: {
        question:
          'An analyst\'s query on 5 TB of CSV in S3 via Athena costs about 25 dollars and takes 10 minutes. The same data converted to partitioned Parquet: estimate the change and explain why.',
        answer:
          'Athena bills per byte scanned (about 5 dollars per TB). Parquet with Snappy is typically 5-10x smaller than CSV, and the query reads only the needed columns (say 5 of 40) and only the partitions matching the WHERE clause on date. Bytes scanned drop by 50-100x or more, so the query costs cents instead of 25 dollars and finishes in seconds. This is the single most common big-data cost win.',
      },
    },
    {
      id: 'architectures',
      title: 'ETL vs ELT, and lambda vs kappa architectures',
      body: `Two pairs of acronyms describe how the pieces are wired together.

**ETL (extract, transform, load).** Pull data from sources, clean and reshape it in a processing engine (Informatica in the old days, Spark jobs today), then load the finished tables into the warehouse. This made sense when warehouse compute was scarce and expensive and storage was small: you loaded only curated data. Costs: transformations are decided up front, raw data is often discarded, and a new question may require re-extracting from the source.

**ELT (extract, load, transform).** Land raw data first, in the lake or straight into the warehouse's cheap storage tier, then transform *inside* the warehouse with SQL, typically orchestrated by **dbt** and scheduled by Airflow or Dagster. Cloud warehouses separate storage from elastic compute, so transforming in place is cheap, raw history is preserved for reprocessing, and analysts can iterate in SQL without a Spark engineer. ELT is the default for modern analytics stacks; ETL persists where transformation needs code, not SQL (ML feature pipelines, PII masking before data may legally land), or where the target is not a warehouse.

**Lambda architecture** (Nathan Marz, 2011) answered "how do I get both accurate and fresh results?" with two parallel paths. The **batch layer** recomputes views from the complete master dataset (Hadoop, then Spark) every few hours: accurate, handles late data, easy to fix by re-running. The **speed layer** processes the stream (Storm, then Flink) to produce approximate, incremental views for the most recent hours. The **serving layer** merges them: batch results up to the last batch cutoff plus speed-layer results since. It works, and many companies still run it, but it has a famous flaw: **the same business logic is written twice**, in two frameworks, by two teams, and the two versions drift.

**Kappa architecture** (Jay Kreps, 2014) argues the batch layer is unnecessary if your stream processor is good enough and your log retains history. Everything is a stream. Need to fix a bug or change a metric? Deploy the new version of the streaming job, point it at offset zero of the Kafka topic (with long or tiered retention, or with the topic mirrored to S3), let it reprocess history into a new output table, then swap consumers over. One codebase, one engine. Flink's checkpointing and exactly-once sinks, Kafka's tiered storage, and table formats that accept streaming upserts made kappa practical. Its costs: replaying years of data through a stream processor is slower than a batch scan, and some computations (giant joins, ML training) are still naturally batch.

**In practice** most 2026 platforms are kappa-leaning hybrids: Kafka as the log, Flink or Kafka Streams for realtime features, and Spark or warehouse SQL over the same events landed in Iceberg for heavy analytics, with the stream landing the data rather than a separate ingestion path. The point of knowing both names is to recognise, when you see two implementations of the same metric, that you are paying lambda's price and to ask whether you still need to.`,
      mentalModel:
        'Lambda is keeping two sets of accounts: a careful ledger closed monthly and a rough tally on a whiteboard for today, then adding them up. Kappa is a single running ledger you can always re-total from page one if you find a mistake.',
      diagram: `LAMBDA                               KAPPA
 sources                              sources
   |                                    |
 Kafka ---------------.               Kafka (long retention / tiered)
   |                  |                 |
 batch layer      speed layer         stream job v1 ---> table v1
 (Spark, hourly)  (Flink, realtime)    stream job v2 ---> table v2
 accurate views   approximate views     (replay from offset 0)
   \\                /                        |
    serving layer (merge)              swap readers to v2
    two codebases, drift risk           one codebase`,
      keyPoints: [
        'ETL transforms before load; ELT loads raw then transforms in the warehouse with SQL (dbt).',
        'ELT wins with cheap storage and elastic compute; ETL persists for code-heavy or compliance-bound transforms.',
        'Lambda: batch layer for accuracy + speed layer for freshness + merge; logic duplicated in two frameworks.',
        'Kappa: everything is a stream; reprocess by replaying the log into a new job; one codebase.',
        'Modern stacks are kappa-leaning hybrids: Kafka log, Flink for realtime, Spark/SQL over the same data for heavy analytics.',
      ],
    },
    {
      id: 'overkill',
      title: 'When big data tools are overkill',
      body: `The most expensive mistake in this area is not choosing the wrong big data tool; it is choosing a big data tool at all when a single machine would do.

**The numbers have changed.** A single cloud VM in 2026 offers 1-4 TB of RAM and tens of TB of NVMe, and single-node engines have caught up with the hardware. **DuckDB** aggregates a 100 GB Parquet file on a laptop in seconds. **Polars** processes tens of GB in memory in Python faster than a small Spark cluster. **ClickHouse** on one box serves billions of rows of analytics with sub-second queries. **Postgres** with proper indexes and partitioning comfortably runs a terabyte-scale operational database plus reporting. Adam Drake's 2014 essay showed shell tools beating a Hadoop cluster by 235x on a few GB of data; the ratio has only grown.

**What a cluster actually costs.** Every distributed engine adds: network shuffles (slower than RAM by orders of magnitude), JVM start-up and scheduling overhead (a Spark job that does nothing takes 10-30 seconds), operational burden (YARN or Kubernetes, memory tuning, skew, small files), a second skill set on the team, and a bill that scales with idle executors. A job that runs in 40 seconds on DuckDB can take 3 minutes on a 10-node Spark cluster because the data was small enough that overhead dominated.

**A decision rule.**
1. **Measure the data.** Hundreds of GB, even a few TB compressed? Single node first: Postgres, DuckDB, ClickHouse, Polars.
2. **Measure the arrival rate.** Under a few thousand events per second, a single consumer writing to Postgres or ClickHouse keeps up; stream processors earn their keep at 100k+ events per second or when stateful event-time logic is genuinely needed.
3. **Ask who else needs it.** Big data platforms pay off when many teams share one lake and one set of tables. One team with one report does not need a platform.
4. **Prefer managed and serverless.** If you are past the line, BigQuery, Athena over Iceberg, Snowflake, Databricks or Kinesis Data Analytics remove cluster operations. Running your own Hadoop cluster in 2026 needs a specific justification (data sovereignty, cost at extreme scale, existing investment).
5. **Start with the simplest thing that meets the freshness requirement** and keep the raw data in cheap object storage in Parquet, so migrating to a bigger engine later is a config change, not a rewrite.

**When it is genuinely needed.** Petabyte lakes, queries that scan terabytes with sub-minute SLAs, joins between multi-TB tables, millions of events per second with sub-second stateful processing, or training on datasets that do not fit one machine. Those are real and common at large companies. The skill is telling them apart from the far more common case of a few hundred gigabytes and a nightly report.`,
      mentalModel:
        'Hiring a shipping fleet to move a sofa across town. The fleet is magnificent at moving a city\'s worth of cargo, but for one sofa a van is faster, cheaper, and does not require a harbour master.',
      keyPoints: [
        'Single-node tools (DuckDB, Polars, ClickHouse, Postgres) handle hundreds of GB to a few TB faster than small clusters.',
        'Distributed engines add shuffle, scheduling, operations and skill costs that dominate on small data.',
        'Decide by data size, event rate, number of consuming teams, and freshness requirement.',
        'Past the line, prefer managed/serverless engines over self-run clusters.',
        'Keep raw data in Parquet on object storage so scaling up later is cheap.',
      ],
      checkpoint: {
        question:
          'A startup has 300 GB of event data growing 2 GB per day and wants daily dashboards plus ad hoc analyst queries. An engineer proposes a 6-node Spark cluster with Hive. What would you propose instead, and when would you revisit?',
        answer:
          'Land events as Parquet in S3 partitioned by date (a few dollars a month), and query with DuckDB or Athena, or load into a single ClickHouse or Postgres instance for dashboards. At 2 GB per day it takes years to reach 5 TB, which is still single-node or serverless territory. Revisit when queries routinely scan multiple TB with tight SLAs, when several teams need a shared lake with governance, or when a realtime requirement with high event rates appears. Because the data is already Parquet on S3, moving to Spark or a lakehouse later needs no data migration.',
      },
    },
  ],
  quiz: [
    {
      type: 'mcq',
      id: 'q1',
      difficulty: 1,
      question: 'What is the default block size in HDFS and why is it so large compared with a normal filesystem?',
      options: [
        '4 KB, to minimise wasted space',
        '128 MB, to keep NameNode metadata small and make reads long sequential transfers',
        '1 GB, because DataNodes have large disks',
        '64 bytes, to allow fine-grained random access',
      ],
      answerIndex: 1,
      explanation:
        'Large blocks mean fewer metadata entries for the in-memory NameNode and stream off disk for about a second, so seek time is negligible. 4 KB blocks would make a petabyte impossible to index in RAM; HDFS is designed for sequential scans, not random access.',
    },
    {
      type: 'mcq',
      id: 'q2',
      difficulty: 2,
      question: 'Why is Spark typically 10-100x faster than MapReduce for iterative algorithms such as k-means?',
      options: [
        'Spark uses a faster programming language',
        'Spark caches intermediate data in memory and fuses stages, while MapReduce writes to HDFS between every map and reduce',
        'Spark replicates all data three times in RAM',
        'Spark skips the shuffle step entirely',
      ],
      answerIndex: 1,
      explanation:
        'MapReduce round-trips disk after every stage; Spark keeps RDDs/DataFrames in memory across iterations and fuses narrow transformations into single stages. It still shuffles at wide dependencies, does not replicate memory (it uses lineage for recovery), and language is not the reason.',
    },
    {
      type: 'mcq',
      id: 'q3',
      difficulty: 2,
      question: 'In stream processing, what is a watermark?',
      options: [
        'A digital signature proving an event was not tampered with',
        'A running estimate that all events with event time up to T have arrived, used to decide when windows can fire',
        'The maximum throughput the stream processor can sustain',
        'A marker written to Kafka to indicate the end of a topic',
      ],
      answerIndex: 1,
      explanation:
        'Watermarks are the mechanism for reasoning about completeness in event time; when the watermark passes a window\'s end the window emits and later events are "late". The other options describe unrelated concepts.',
    },
    {
      type: 'mcq',
      id: 'q4',
      difficulty: 1,
      question: 'Which statement best distinguishes a data lake from a data warehouse?',
      options: [
        'A lake stores structured tables with schema-on-write; a warehouse stores raw files with schema-on-read',
        'A lake stores raw files in cheap object storage with schema-on-read; a warehouse stores curated structured data with schema-on-write and SQL',
        'A lake is always on-premises; a warehouse is always in the cloud',
        'They are the same thing with different marketing names',
      ],
      answerIndex: 1,
      explanation:
        'Lakes are raw and cheap (S3, GCS), any format, schema applied at read; warehouses (Snowflake, BigQuery, Redshift) are structured, governed, columnar SQL engines. Option A has them reversed; deployment location is irrelevant.',
    },
    {
      type: 'mcq',
      id: 'q5',
      difficulty: 3,
      question:
        'A query computes SUM(amount) WHERE dt = \'2026-09-01\' over 10 TB of event data with 60 columns. Which storage choice reduces bytes scanned the most?',
      options: [
        'Gzipped CSV in a single directory',
        'JSON lines partitioned by date',
        'Parquet partitioned by dt, so only one day\'s files and only the amount column chunks are read',
        'Avro files sorted by amount',
      ],
      answerIndex: 2,
      explanation:
        'Partition pruning skips every other day\'s directory, and Parquet\'s columnar layout reads only the amount column (1 of 60). JSON partitioned by date prunes days but still reads whole rows; CSV and Avro are row formats and CSV in one directory cannot prune at all.',
    },
    {
      type: 'mcq',
      id: 'q6',
      difficulty: 3,
      question:
        'A company runs the same "orders per minute" logic in a nightly Spark job (for the dashboard\'s history) and in a Flink job (for the last few hours), and the numbers sometimes disagree. What architecture is this, and what is the kappa remedy?',
      options: [
        'ELT; move the transformation into dbt',
        'Lambda; keep only the streaming job and reprocess history by replaying the Kafka log with the same code',
        'Kappa; add a batch layer to reconcile the numbers',
        'A lakehouse; convert the tables to Iceberg',
      ],
      answerIndex: 1,
      explanation:
        'Two implementations of one metric (batch + speed layers) is the lambda architecture, and drift between them is its known flaw. Kappa removes the batch layer: one streaming codebase, with history recomputed by replaying the retained log. Adding a batch layer or changing table formats does not address duplicated logic.',
    },
    {
      type: 'multi',
      id: 'q7',
      difficulty: 2,
      question: 'Which of the following are advantages of the Parquet format for analytical queries? Select all that apply.',
      options: [
        'Only the columns referenced by the query are read from storage',
        'Per-column encoding and compression shrink files 5-10x versus CSV',
        'Min/max statistics let engines skip row groups that cannot match a filter',
        'It is the ideal format for appending single events to a Kafka topic',
        'It supports in-place updates of individual rows',
      ],
      answerIndices: [0, 1, 2],
      explanation:
        'Projection pushdown, columnar compression and predicate pushdown via statistics are Parquet\'s core wins. It is a large-file, write-once columnar format, so it is wrong for per-event streaming writes (use Avro) and does not support in-place row updates (table formats like Iceberg handle updates by rewriting files).',
    },
    {
      type: 'multi',
      id: 'q8',
      difficulty: 3,
      question: 'A team is deciding between a Spark cluster and a single-node solution. Which facts argue that a cluster is overkill? Select all that apply.',
      options: [
        'Total data is 400 GB compressed and grows 1 GB per day',
        'Queries must join two 20 TB tables hourly',
        'Only one team consumes the output, as a daily report',
        'Ingest is about 500 events per second',
        'The platform must process 2 million events per second with per-user session state',
      ],
      answerIndices: [0, 2, 3],
      explanation:
        'Hundreds of GB, a single consuming team and a few hundred events per second are comfortably handled by DuckDB, ClickHouse or Postgres. Multi-TB joins and millions of events per second with keyed state are the cases where distributed engines earn their cost.',
    },
    {
      type: 'truefalse',
      id: 'q9',
      difficulty: 1,
      statement: 'Kafka Streams requires deploying a separate processing cluster like Flink or Spark.',
      answer: false,
      explanation:
        'Kafka Streams is a Java library embedded in your own service; state lives in local RocksDB backed by Kafka changelog topics, and you scale by running more instances. That is its main appeal over Flink for teams already operating Kafka.',
    },
    {
      type: 'truefalse',
      id: 'q10',
      difficulty: 2,
      statement: 'In ELT, raw data is loaded into the warehouse or lake first and transformed afterwards with SQL, which preserves raw history for reprocessing.',
      answer: true,
      explanation:
        'ELT relies on cheap storage and elastic warehouse compute: land raw, then build curated tables with SQL (often via dbt). Because raw data is kept, new questions can be answered without re-extracting from source systems.',
    },
    {
      type: 'short',
      id: 'q11',
      difficulty: 3,
      question:
        'Design the storage and processing layout for 50 TB of clickstream events (growing 200 GB per day) that must support (a) sub-second dashboards on the last hour, (b) ad hoc SQL over all history, and (c) monthly ML training. Name tools and formats and justify each.',
      modelAnswer: `**Ingestion:** producers write Avro events (schema registry) to Kafka. Kafka is the durable log and the single ingestion path (kappa-leaning).

**(a) Realtime dashboards:** a Flink (or Kafka Streams) job consumes the topic, aggregates per-minute metrics with event-time windows and a short allowed lateness, and writes to a serving store such as ClickHouse or Redis. Sub-second freshness needs a true stream processor; the state is small (per-minute counters).

**(b) Ad hoc SQL over history:** a second consumer (Flink sink or Kafka Connect) lands the raw events as Parquet in S3, partitioned by dt=YYYY-MM-DD/hour, compacted to 256 MB-1 GB files, registered as an Iceberg table. Query with Trino/Athena or Snowflake/BigQuery external tables. Columnar plus partition pruning keeps scans and cost low; Iceberg gives ACID commits so half-written files are never visible; S3 at 2.3 cents per GB-month makes 50 TB about 1,150 dollars a month.

**(c) Monthly training:** Spark (Databricks/EMR) or a Python job reads the Iceberg table for the needed columns and months; batch is fine because freshness of a month is acceptable. Feature definitions in SQL/dbt over the same table avoid duplicating logic from the stream job.

**Why not simpler:** 50 TB and a sub-second requirement exceed single-node comfort; but note that the Parquet-on-S3 layer would be identical at 500 GB, so the design scales down too.`,
      rubric: [
        'Kafka as the single durable ingestion log.',
        'Stream processor for the realtime path with event-time windows and a fast serving store.',
        'Parquet on object storage, partitioned by time, with a table format for history.',
        'Batch engine (Spark or SQL) for training/ad hoc; avoids duplicated logic.',
        'Justifies choices with latency, cost or scale numbers.',
      ],
    },
    {
      type: 'short',
      id: 'q12',
      difficulty: 2,
      question: 'Explain how Spark recovers from an executor failure without replicating in-memory data, and what the limits of that approach are.',
      modelAnswer: `Each RDD or DataFrame partition records its **lineage**: the chain of deterministic transformations and the input partitions that produced it. When an executor dies, the driver marks its partitions lost and re-schedules only those partitions, recomputing them from their parents (ultimately from the durable input in HDFS or S3). No memory replication is needed, so caching is cheap.

Limits: if the lineage is long (hundreds of iterations) recomputation can take almost as long as the original job, so Spark lets you **checkpoint** an RDD to durable storage to truncate lineage. Shuffle outputs are written to local disk on the executor; if that machine is lost, upstream stages must be re-run to regenerate the shuffle files (an external shuffle service mitigates this). And if the **driver** dies, the whole job fails, because lineage and scheduling state live there; cluster managers restart the application rather than recovering it.`,
      rubric: [
        'Lineage: partitions know how they were computed from parents.',
        'Only lost partitions are recomputed, from durable input.',
        'Long lineage needs checkpointing; shuffle files can be lost.',
        'Driver failure is not recovered by lineage.',
      ],
    },
    {
      type: 'short',
      id: 'q13',
      difficulty: 3,
      question:
        'Compare lambda and kappa architectures. Under what conditions does kappa become practical, and what remains hard?',
      modelAnswer: `**Lambda** runs a batch layer (full recomputation over the master dataset for accuracy and late data) alongside a speed layer (stream processing for freshness) and merges their views at serving time. It delivers both fresh and correct results but duplicates business logic in two frameworks, which drift and double the maintenance cost.

**Kappa** treats all data as a stream: one streaming job computes the views, and reprocessing (bug fix, new metric) is done by starting a new version of the job from the beginning of the retained log, producing a new output table, then switching readers.

**Kappa becomes practical when:** the log retains full history (Kafka tiered storage to S3, or topics mirrored to a lake), the stream processor offers exactly-once state and sinks (Flink checkpoints plus transactional sinks), replay throughput is high enough to reprocess history in acceptable time, and the output store supports upserts or table swaps (Iceberg/Delta, ClickHouse, key-value stores).

**What remains hard:** replaying years of data through a stream processor is slower than a columnar batch scan; huge joins and ML training are still naturally batch; late-data corrections require the serving store to accept updates; and cost of retaining the full log. Most real platforms are hybrids that avoid duplicated logic by landing the stream into a lake once and running both realtime and batch consumers from the same events.`,
      rubric: [
        'Lambda: batch + speed layers merged; duplicated logic is the flaw.',
        'Kappa: single streaming codebase; reprocess by replaying the log.',
        'Prerequisites: retained log, exactly-once processing, replay throughput, upsertable sinks.',
        'Remaining difficulties: replay speed, batch-natural workloads, corrections.',
      ],
    },
  ],
  flashcards: [
    { id: 'f1', front: 'Batch vs stream processing', back: 'Batch: bounded data, high throughput, minutes-hours latency. Stream: unbounded events, seconds or less latency, stateful, must handle out-of-order arrival.' },
    { id: 'f2', front: 'HDFS architecture', back: 'NameNode (in-memory metadata) + DataNodes storing 128 MB blocks replicated 3x across racks. Write-once, read-many, sequential scans. HA via standby NameNode + JournalNodes + ZooKeeper.' },
    { id: 'f3', front: 'MapReduce phases', back: 'Map: emit (key, value) per record. Shuffle: partition and sort by key. Reduce: aggregate all values of a key. Each stage writes to HDFS.' },
    { id: 'f4', front: 'Why MapReduce is slow for iterative jobs', back: 'Every job is one map + one reduce with disk writes in between and after; iterative algorithms re-read data from disk every iteration and pipelines become chains of jobs.' },
    { id: 'f5', front: 'Spark core ideas', back: 'Lazy DAG of transformations fused into stages; in-memory RDD/DataFrame caching; fault tolerance via lineage recomputation; Catalyst optimizer and Tungsten codegen.' },
    { id: 'f6', front: 'Spark narrow vs wide dependency', back: 'Narrow (map, filter): each output partition depends on one input partition; fused into a stage. Wide (groupBy, join): needs a shuffle; forms a stage boundary.' },
    { id: 'f7', front: 'Event time vs processing time', back: 'Event time: timestamp inside the event (when it happened). Processing time: when the engine sees it. Use event time for correct windows; requires watermarks.' },
    { id: 'f8', front: 'Watermark', back: 'A running estimate that all events up to time T have arrived. When it passes a window\'s end, the window fires; later events are late (drop, correct, or allowed lateness).' },
    { id: 'f9', front: 'Flink fault tolerance and exactly-once', back: 'Periodic checkpoints of keyed state (RocksDB) via asynchronous barrier snapshots; on failure restore state and rewind Kafka offsets; two-phase-commit sinks extend exactly-once to outputs.' },
    { id: 'f10', front: 'Flink vs Kafka Streams vs Spark Structured Streaming', back: 'Flink: true streaming cluster, lowest latency, rich event-time. Kafka Streams: library in your service, no extra cluster. Structured Streaming: micro-batch on Spark, unified with batch code.' },
    { id: 'f11', front: 'Data lake vs data warehouse', back: 'Lake: raw files on object storage (S3), schema-on-read, cheap, any engine, swamp risk. Warehouse: curated, schema-on-write, columnar MPP SQL (Snowflake, BigQuery, Redshift), premium.' },
    { id: 'f12', front: 'Lakehouse / table formats', back: 'Delta Lake, Apache Iceberg, Apache Hudi: a transaction log over Parquet files giving ACID commits, schema evolution, time travel and file-skipping metadata on lake storage.' },
    { id: 'f13', front: 'Why Parquet (columnar) for analytics', back: 'Reads only needed columns (projection pushdown), compresses similar values 5-10x (dictionary, RLE, Snappy/Zstd), skips row groups via min/max stats (predicate pushdown).' },
    { id: 'f14', front: 'Partitioning and small-files problem', back: 'Lay out files by common filters (dt=.../region=...) for pruning. Keep files 128 MB-1 GB; millions of tiny files make listing/opening dominate, so compact streaming output.' },
    { id: 'f15', front: 'ETL vs ELT', back: 'ETL: transform in an engine before loading curated data. ELT: load raw, transform inside the warehouse with SQL (dbt); keeps raw history, uses elastic warehouse compute.' },
    { id: 'f16', front: 'Lambda architecture', back: 'Batch layer (accurate full recompute) + speed layer (fresh approximate stream) + serving layer that merges. Flaw: business logic duplicated in two frameworks.' },
    { id: 'f17', front: 'Kappa architecture', back: 'Everything is a stream; one streaming codebase. Reprocess by replaying the retained log (Kafka) into a new job/table and swapping readers. Needs exactly-once and long retention.' },
    { id: 'f18', front: 'Big-data overkill test', back: 'If data is hundreds of GB to a few TB and events are under thousands per second, single-node tools (DuckDB, Polars, ClickHouse, Postgres) beat a cluster on speed, cost and ops.' },
  ],
  feynman: [
    {
      id: 'fe1',
      concept: 'HDFS + MapReduce and why Spark replaced MapReduce',
      prompt: 'Explain to a junior developer how Hadoop spreads a computation over many machines, and why Spark took over.',
      modelExplanation: `Imagine a warehouse of paper records too big for any one room. Hadoop first solves storage: it cuts every file into big 128 MB chunks and stores each chunk in three different rooms, so a room burning down loses nothing. One clerk, the NameNode, keeps the index of which chunks are where.

To compute something, say count how often each word appears, Hadoop sends the counting to the rooms instead of hauling paper to a central desk. In each room a worker reads its chunks and writes down "word, 1" for every word (map). All those notes are then sorted by word and delivered to a worker responsible for that word, who adds them up (reduce). If a worker dies, the same notes are simply redone elsewhere.

The problem is that every step writes its notes to disk and the next step reads them back. A real analysis has many steps, and algorithms that loop over the same data many times spend all their time on disk. Spark keeps the notes in memory between steps, plans all the steps at once so it can merge them, and if a worker dies it recomputes only that worker's notes from the recipe it remembers. That is why Spark is 10 to 100 times faster on those workloads.`,
      mustMention: [
        'HDFS: large blocks replicated 3x, NameNode metadata',
        'Move compute to data; map, shuffle, reduce',
        'MapReduce writes to disk between every stage',
        'Spark keeps data in memory, plans a DAG, recovers via lineage',
      ],
    },
    {
      id: 'fe2',
      concept: 'Event time, watermarks and late data',
      prompt: 'Explain to a product manager why the realtime dashboard\'s numbers for the last minute sometimes change a little after the fact.',
      modelExplanation: `The dashboard counts events by the time they actually happened, not by the time our servers received them. That is the right choice: a purchase made at 12:00:30 on a phone with a weak signal is still a 12:00 purchase even if it reaches us at 12:03.

But it creates a puzzle: when can we say the 12:00 minute is finished? We cannot wait forever. So the system keeps a moving estimate, called a watermark, that says "we are confident nearly everything up to 12:01 has now arrived". When that estimate passes the end of the minute, we publish the count.

Occasionally an event shows up after that, a late arrival. We have three choices: ignore it (fast, slightly undercounted), publish a corrected number (accurate, but the figure changes after the fact), or wait longer before publishing (accurate and stable, but the dashboard lags). We chose to publish quickly and correct, which is why you sometimes see a number tick up a little. The overnight report waits for everything and is the authoritative figure.`,
      mustMention: [
        'Event time versus arrival (processing) time',
        'Watermark as an estimate of completeness',
        'Late events and the three options',
        'Latency versus completeness trade-off',
      ],
    },
    {
      id: 'fe3',
      concept: 'Why columnar storage wins for analytics',
      prompt: 'Explain to a backend engineer who only knows Postgres row storage why analytics systems store data in Parquet.',
      modelExplanation: `Postgres stores each row together on disk: id, name, country, amount, all side by side. That is perfect for the operational questions you ask: fetch this customer, update that order. You touch a few rows and want every field.

Analytics asks the opposite: sum the amount column over a billion rows, and ignore the other fifty fields. With row storage you still have to read all fifty fields off disk to get at the one you need, so you read fifty times more bytes than you use.

Parquet flips the layout. Within a big chunk of rows it stores all the amounts together, then all the countries, and so on. Summing amounts reads only the amounts. As a bonus, a column of similar values compresses extremely well, so files are five to ten times smaller than CSV. Each column chunk also records its minimum and maximum, so a filter like amount greater than 5,000 can skip whole chunks whose maximum is 4,000 without reading them. Fewer bytes read is the entire game in analytics, and on services billed per byte scanned it is also the entire bill.`,
      mustMention: [
        'Row storage suits fetching or updating whole rows',
        'Analytics touches few columns over many rows',
        'Parquet stores columns together: read only needed columns',
        'Compression and min/max statistics skip data',
      ],
    },
  ],
  memoryPalace: {
    setting:
      'You tour a river-port city at dawn: from the docks where cargo arrives, through the old warehouse district, to a gleaming new terminal and finally a tiny van by the exit gate.',
    stops: [
      { locus: 'The two docks at the river mouth', concept: 'Batch vs stream', image: 'On the left dock a colossal barge unloads once a night, mountains of crates at a time. On the right a never-ending conveyor of single parcels rattles past 24 hours a day, some arriving out of order with yesterday\'s postmark.' },
      { locus: 'The old brick warehouse with triple shelves', concept: 'HDFS', image: 'Every crate is sawn into 128 MB slabs and each slab sits on three shelves in different aisles. A single clerk (the NameNode) stands on a ladder holding the entire inventory in his head, sweating.' },
      { locus: 'The counting hall behind the warehouse', concept: 'MapReduce', image: 'Hundreds of clerks each tally one slab and scribble "word, 1" on slips; slips are sorted into pigeonholes by word; a clerk per pigeonhole sums them. Between every step the slips are hauled down to the basement and back up again, and everyone waits.' },
      { locus: 'The glass office above the hall', concept: 'Spark', image: 'One planner draws the whole day\'s work as a single flowchart on the window, keeps every slip on the desk instead of the basement, and when a clerk faints simply redoes that clerk\'s slips from the flowchart. The hall below is ten times quieter.' },
      { locus: 'The conveyor control room', concept: 'Flink: event time, watermarks, checkpoints', image: 'A controller stamps each parcel with the time it was sent, not received. A red tide-mark on the wall creeps upward: "everything before 12:01 has arrived". Every ten seconds a camera flash photographs the whole room so a crash can be rewound.' },
      { locus: 'The lake and the library', concept: 'Data lake vs warehouse vs lakehouse', image: 'A vast lake where crates float freely, dirt cheap to keep but hard to find anything. Beside it a marble library with everything catalogued and expensive shelving. A new pier is being built on the lake with a leather ledger nailed to its gate: Iceberg.' },
      { locus: 'The envelope sorting table', concept: 'Parquet columnar format', image: 'Instead of filing whole receipts, a clerk tears every receipt into strips and puts all the amounts in one envelope, all the dates in another. Each envelope is labelled "min 80, max 4000" so a search for 5,000 never opens it.' },
      { locus: 'The twin ledgers on the harbour master\'s desk', concept: 'Lambda vs kappa', image: 'Two ledgers, one closed monthly with care and one scribbled hourly, whose totals never quite agree; the harbour master tears both up and replaces them with a single scroll he can re-total from page one whenever he likes.' },
      { locus: 'The small van at the exit gate', concept: 'When big data is overkill', image: 'Outside the port, a delivery van labelled DuckDB carries a single sofa across town in ten minutes while the shipping fleet is still filling out paperwork. A sign on the gate reads: "measure the data before you hire the fleet".' },
    ],
  },
  interviewQuestions: [
    'When would you choose batch processing over stream processing, and what changes in the design when you move from one to the other?',
    'Explain how HDFS achieves fault tolerance and why its block size is 128 MB.',
    'Why is Spark faster than MapReduce? What does Spark still write to disk?',
    'What are event time, processing time and watermarks? How would you handle events that arrive an hour late while preserving exactly-once results end to end?',
    'Compare a data lake, a data warehouse and a lakehouse. Where would you land raw clickstream data and why?',
    'Why does converting CSV to partitioned Parquet reduce query cost so dramatically on Athena or BigQuery?',
    'Describe the lambda and kappa architectures. What is the main criticism of lambda, and what makes kappa feasible today?',
    'A team wants to set up a Spark cluster for 200 GB of data. How would you push back, and what would you propose?',
  ],
}

export default chapter
