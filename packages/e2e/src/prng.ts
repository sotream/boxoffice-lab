/** Tiny seeded PRNG (mulberry32). Same seed, same sequence: the load shape is reproducible, only the interleaving is not. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent stream per (seed, index): a user's choices do not depend on how many other users there are or on scheduling. */
export const streamFor = (seed: number, index: number) => prng((seed * 2654435761 + index * 40503 + 12345) >>> 0);
