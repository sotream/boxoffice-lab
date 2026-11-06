# waiting-room

Interview question: **"50 000 people open the sale page at the same second. How do you keep the backend alive?"**

## Requirements
- FR: join a virtual queue, poll position and ETA, get admitted for 5 minutes, re-join is idempotent.
- FR: admitted users, and only they, may call `inventory`.
- NFR: queue and polling must survive 10x more traffic than the protected service could ever take.
- NFR: FIFO fairness; no user overtakes another because of clock skew.

## API
`POST /events/:id/queue/join` `{userId}` -> `{position}`
`GET  /events/:id/queue/status?userId=` -> `waiting {position, etaSeconds} | admitted {ttl} | unknown`

## Design
Redis sorted set `wr:{event}:queue`; score = `INCR` sequence (not a timestamp), `ZADD NX` makes join idempotent. A tick every 100 ms does `ZPOPMIN n` and writes `admitted:{user}` keys with a 300 s TTL. The admission rate is a configured budget (`ADMIT_PER_SECOND`), derived from the protected service's capacity. Lab limit: `main.ts` runs the tick for event 1 only.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).
