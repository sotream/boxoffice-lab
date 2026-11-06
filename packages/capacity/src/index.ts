/** Seconds in a day. Interview shortcut: ~100k (86_400 rounded). */
export const SECONDS_PER_DAY = 86_400;

export interface TrafficInput {
  /** Daily active users. */
  dau: number;
  /** Average actions per user per day. */
  actionsPerUser: number;
  /** Peak-to-average ratio (3 normal, 50-100 for flash sales). */
  peakFactor: number;
}

/** avg RPS = DAU x actions / 86_400 */
export function avgRps({ dau, actionsPerUser }: TrafficInput): number {
  return (dau * actionsPerUser) / SECONDS_PER_DAY;
}

/** peak RPS = avg RPS x peakFactor */
export function peakRps(t: TrafficInput): number {
  return avgRps(t) * t.peakFactor;
}

/** instances = ceil(peak / (perInstance x utilisation)); utilisation is headroom, 0.6 is a safe default. */
export function instancesNeeded(peak: number, perInstanceRps: number, utilisation = 0.6): number {
  return Math.ceil(peak / (perInstanceRps * utilisation));
}

/** Little's law: concurrent requests = RPS x latency (seconds). Sizes pools and connections. */
export function concurrency(rps: number, latencySeconds: number): number {
  return rps * latencySeconds;
}

export interface StorageInput {
  /** New records per day. */
  recordsPerDay: number;
  /** Average record size in bytes (including indexes overhead if known). */
  bytesPerRecord: number;
  years: number;
  /** Replication factor (3 for a typical replicated store). */
  replication?: number;
}

/** storage = records/day x size x 365 x years x replication, in bytes */
export function storageBytes(s: StorageInput): number {
  return s.recordsPerDay * s.bytesPerRecord * 365 * s.years * (s.replication ?? 1);
}

/** bandwidth (bytes/s) = RPS x average payload bytes */
export function bandwidth(rps: number, payloadBytes: number): number {
  return rps * payloadBytes;
}

/** Pareto cache: caching the hot 20% of the data set serves ~80% of reads. */
export function cacheBytes(dailyReadBytes: number, hotFraction = 0.2): number {
  return dailyReadBytes * hotFraction;
}

/** Shards needed so each shard stays below its write capacity at peak. */
export function shardsNeeded(peakWritesPerSec: number, writesPerShard: number, utilisation = 0.6): number {
  return Math.ceil(peakWritesPerSec / (writesPerShard * utilisation));
}

/** Human readable bytes (decimal units, as interviewers expect). */
export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = bytes;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Numbers every engineer should know (orders of magnitude, from Dean/Norvig and later hardware). */
export const LATENCY_NS = {
  l1Cache: 1,
  mainMemory: 100,
  ssdRandomRead: 100_000,
  sameDcRoundTrip: 500_000,
  diskSeek: 10_000_000,
  crossRegionRoundTrip: 150_000_000
} as const;
