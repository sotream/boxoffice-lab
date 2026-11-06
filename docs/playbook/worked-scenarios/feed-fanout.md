# Worked scenario: social feed (fan-out on write vs read)

[paper design] No code in this repo implements this system: every figure below is derived from stated assumptions with the formulas in [`packages/capacity`](../../../packages/capacity/src/index.ts), or borrowed from a measured component and cited. Nothing here was run.

Load shape: skewed fan-out. One write becomes many writes, the follower distribution has a heavy tail (the celebrity problem), reads are personal and cannot be shared by a CDN. Matching shape in the playbook: [workload-to-architecture.md](../workload-to-architecture.md) (fan-out / skewed write amplification). Related: [data-store-selection.md](../data-store-selection.md), [numbers-to-know.md](../../numbers-to-know.md).

Labels: [measured] lab figure with its source file, [derived] arithmetic shown, [folk] common ballpark not measured here, [paper design] a design with no code here.

## Requirements

Functional
- A user publishes a post; followers see it in their home feed, newest first, paginated 20 per page.
- Follow and unfollow take effect within seconds.
- Deleting a post removes it from feeds eventually (minutes are acceptable).

Non-functional (assumptions)
- 2M daily active users (DAU), 20 feed reads per user per day, 0.5 posts per DAU per day, so 1M posts per day.
- Average 200 followers per author, heavy tail: a few accounts above 1M followers.
- Peak factor 5 (evening).
- Feed read p99 under 100 ms. A post may take up to 5 s to reach a normal author's followers, up to 30 s for a very large account.
- Feed depth kept per user: 200 entries (older pages fall back to a slower query).

## Estimates

| Quantity | Formula and arithmetic | Result |
|---|---|---|
| Post writes | 1M posts/day: `traffic --dau 2M --actions 0.5 --peak 5` = 11.6 avg, 57.9 peak | 11.6 avg, 57.9 peak posts/s [derived] |
| Feed read RPS | `traffic --dau 2M --actions 20 --peak 5`: 2 000 000 x 20 / 86 400 = 463 avg; x 5 | 463 avg, 2 315 peak [derived] |
| Fan-out on write: timeline inserts | 1M posts x 200 followers = 200M inserts/day: `traffic --dau 200M --actions 1 --peak 5` | 2 315 avg, 11 574 peak inserts/s [derived] |
| Fan-out on read: lookups | 40M reads/day x 200 followees = 8e9/day: `traffic --dau 40M --actions 200 --peak 5` | 92 593 avg, 462 963 peak lookups/s [derived] |
| Work ratio | on-read 8e9 vs on-write 2e8 operations per day | on-read does 40x more operations at this read:post ratio [derived] |
| Timeline memory per user | 200 entries x ~100 B per sorted-set member | ~20 KB [derived]; 100 B per member is an assumption near the waiting-room measurement (7.68 MB for 57 497 queued users = up to 140 B each, an upper bound that includes other keys, [measured] [waiting-room RESULTS.md](../../../services/waiting-room/RESULTS.md)); at 140 B it would be 28 KB per user and 56 GB for 2M users [derived] |
| Timeline memory, active users | 2M x 20 KB = 40 GB | 40 GB [derived]; only active users hold a timeline |
| Posts storage | `storage --records-per-day 1M --bytes 1000 --years 1` | 1.1 TB with replication 3 [derived] |
| Hydration lookups | each page shows 20 posts: 2 315 x 20 | 46 300 post lookups/s at peak [derived], above a safe Postgres read budget ([folk] 10k-50k QPS), so posts are cached too |
| Celebrity burst | one post to 10M followers = 10M inserts; Redis ~100k ops/s [folk] | 100 s of one node at full speed, 167 s at 0.6 headroom (10M / 60 000) [derived] |
| Hybrid read cost | user follows ~5 celebrities, each pulled at read time: 2 315 x (1 + 5) | 13 890 range reads/s at peak [derived] |

## Design

Components: post service (writes posts to Postgres, publishes a `post.created` event through an outbox, same pattern as [payments adr/002](../../../services/payments/adr/001-saga-over-2pc.md)), fan-out workers consuming the log, Redis with one sorted set per user (`timeline:{user}`, member = post id, score = time-ordered id), a posts cache (`GET`/`MGET` by id), a feed read service that merges and hydrates.

Data model
- Postgres: `posts(id, author_id, body, created_at)`, `follows(follower_id, followee_id)` with an index on `followee_id` (fan-out reads followers by followee).
- Redis: `ZADD timeline:{u} <id> <id>`, trimmed to the newest 200 with `ZREMRANGEBYRANK`. Same structure family as the waiting-room queue ([adr/001](../../../services/waiting-room/adr/001-redis-sorted-set-queue.md)): sorted set, idempotent add, O(log n) rank.

Key decisions

1. Fan-out strategy: hybrid.
   - Fan-out on write for authors under a threshold of 10 000 followers (choose it so one post costs at most about 0.2 s of one Redis shard: 10 000 / 60 000 ops/s = 0.17 s [derived]).
   - Fan-out on read for authors above it: their posts are pulled at read time and merged with the precomputed timeline.
   - Rejected: pure fan-out on write. The 10M-follower burst above occupies a shard for 100 s and delays every other author's fan-out behind it. Rejected: pure fan-out on read. 462 963 lookups/s at peak and a read latency that grows with the number of followees.
   - Why write wins here: reads outnumber posts 40:1 (40M reads, 1M posts), so paying 200 inserts once per post beats paying 200 lookups per read. The break-even shifts to read-side if the read:post ratio drops near 1:1 or follower counts grow far beyond reads per follower.
2. Fan-out is asynchronous through a log keyed by author, one job per post, workers write in pipelined batches. Idempotent because `ZADD` of the same member and score is a no-op, so at-least-once delivery is safe ([payments adr/003](../../../services/payments/adr/001-saga-over-2pc.md) has the same "retries need idempotency" rule). Parallelism is bounded by partitions, so choose the count for the peak ([numbers-to-know.md](../../numbers-to-know.md) section e).
3. Inactive users: no timeline is maintained for users not seen for 30 days. On return the timeline is rebuilt on read (fan-out on read for that first request) and cached. Rejected: maintaining all registered users: memory scales with registered users instead of active ones (at 5 registered per 2 active that is 2.5x the memory, [derived]).
4. Redis loss is survivable: timelines are derived data, rebuilt from `follows` and `posts`. So no persistence tuning is required beyond what keeps restart times acceptable; the cost is a thundering herd of rebuilds, handled with single-flight and a rebuild rate limit (pattern as [catalog adr](../../../services/catalog/adr/001-postgres-fts-before-elasticsearch.md), ADR 002).
5. Delete and unfollow: lazy. The read service filters hydrated posts against a tombstone check; a background job trims. Rejected: synchronous removal from every follower timeline (same amplification as the write).

## What breaks at x10

x10 means 20M DAU, 10M posts per day, 2B timeline inserts per day.

1. First bottleneck: Redis memory, not operations.
   - Active timelines: 20M x 20 KB = 400 GB [derived]. With a placeholder node of 128 GB RAM and 0.6 headroom (76.8 GB usable): ceil(400 / 76.8) = 6 shards [derived]. Already at x1, 40 GB is more than half of one such node.
   - Insert rate at x10: `traffic --dau 2000M --actions 1 --peak 5` = 115 741 peak inserts/s; `shards --peak-writes 115741 --per-shard 100k` = 2 shards [derived], so memory (6) decides, not throughput (2).
   - Change: shard timelines by user id (consistent hashing); shorten depth to 100 entries (halves memory to 200 GB, 3 shards) if product allows; evict by last-seen.
2. Second bottleneck: hydration lookups.
   - Peak feed reads at x10: `traffic --dau 20M --actions 20 --peak 5` = 23 148; x 20 posts per page = 462 960 post lookups/s [derived]. `shards --peak-writes 462960 --per-shard 100k` = ceil(7.7) = 8 shards of posts cache [derived].
   - Change: cache posts with a high hit rate (the hot set is recent posts of followed authors); batch with `MGET`; cache rendered feed pages for 5-10 s for repeat refreshes; page size 10 on first load.
3. Third: fan-out lag for large authors as the tail grows. Lower the threshold when the p99 time to deliver a 10 000-follower post exceeds 5 s; measure it, there is no figure in this repo.

## What would be measured first

1. Redis sorted-set cost at the intended shape: a k6 script `load/feed-write.js` (pipelined `ZADD` plus trim, 200 members per user across 2M timelines) and `load/feed-read.js` (`ZREVRANGE` 20 plus `MGET` 20). Copy the structure of [services/waiting-room/load/join.js](../../../services/waiting-room/load/join.js) (k6 against a Redis-backed sorted-set service), and the memory-per-entry check from [waiting-room RESULTS.md](../../../services/waiting-room/RESULTS.md) to confirm or replace the 100 B per member (the waiting-room run bounds it at 140 B, not 100 B).
2. Fan-out consumer rate per partition: copy [services/notifications/load/bench.js](../../../services/notifications/load/bench.js) (a Node script, not k6: it produces N events with duplicates and poison messages into a 3-partition topic and verifies delivery counts) with a Zipf follower distribution including 10M-follower authors. Questions: inserts per second per worker, end-to-end lag p99, and duplicates after a worker kill (copy [drills/consumer-kill.mjs](../../../drills/consumer-kill.mjs)).
3. The threshold: sweep it (1 000, 10 000, 100 000) and report read RPS and fan-out lag at each.

## Where this is proven in the repo / what is still paper

Proven (other components): sorted set with 100-140 B per member and a Redis-backed handler at 10 134 RPS ([waiting-room RESULTS.md](../../../services/waiting-room/RESULTS.md)); consumer scaling with partitions, 447 to 1 393 deliveries/s for 1 to 3 partitions, 0 duplicates ([notifications RESULTS.md](../../../services/notifications/RESULTS.md)); outbox publication ([failure-drills.md](../../failure-drills.md) drill 2).

Still paper: the post and feed services, the hybrid threshold, the fan-out rate per worker, the hydration cache, every figure in the tables above that is labelled [derived].
