/** ioredis rejects with a plain Error for these (a command that outlived `commandTimeout`, a closed or refused connection), so match on the message. */
const UNAVAILABLE = /^Command timed out$|^Connection is closed|Stream isn't writeable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|^(LOADING|MASTERDOWN|READONLY|CLUSTERDOWN|TRYAGAIN) /;

/**
 * The queue lives in Redis, so "Redis does not answer in time" is the one failure this service names: the controller answers 503 with `Retry-After: 1`,
 * which every client already retries (the load generator, and the gateway's limiter says the same when Redis is gone on its side).
 * Anything else is a bug and stays a 500.
 */
export const isRedisUnavailable = (e: unknown): boolean =>
  e instanceof Error && (e.name === "MaxRetriesPerRequestError" || UNAVAILABLE.test(e.message)); // the class is not exported by ioredis
