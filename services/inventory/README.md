# inventory

Interview question: **"How do you prevent double booking when thousands of users fight for the same seats?"**

## Requirements
- FR: hold 1-8 seats for 10 minutes, confirm a hold into a sale, show availability.
- FR: holds expire without a background job (expiry is evaluated at read/write time).
- NFR: a seat is never sold or held twice (correctness beats availability).
- NFR: flash sale of a 20k-seat event: ~50k users in 60 s, p99 < 100 ms for a hold.

## API
`POST /events/:id/holds?strategy=atomic-update|for-update` `{seatIds, userId}` -> 201 / 409
`POST /events/:id/confirm` `{seatIds, userId}` -> 200 / 409
`GET  /events/:id/availability`

## Data model
`seats(event_id, seat_id, status, held_by, hold_until)`, PK `(event_id, seat_id)`. One row per seat. Status is `free|held|sold`; a held row with `hold_until < now()` counts as free.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).
Run: `docker compose up -d postgres && pnpm --filter @boxoffice/inventory test`
