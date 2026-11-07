import { listContainers, NAME_PREFIX, removeByPrefix } from "../docker";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Before the run: remove containers that a crashed earlier run left behind (their owner pid is gone). After the run: the leak check.
 * Every scenario removes its own containers; anything still there at the end is a failure of the suite, reported and removed.
 */
export default async function setup() {
  const run = String(process.pid);
  process.env.E2E_FAULTS_RUN = run; // inherited by the test workers: it is part of every container name
  for (const name of await listContainers()) {
    const owner = Number(name.slice(NAME_PREFIX.length).split("-")[0]);
    if (Number.isFinite(owner) && !alive(owner)) await removeByPrefix(name);
  }
  return async () => {
    const left = await removeByPrefix(`${NAME_PREFIX}${run}-`);
    const other = (await listContainers(`${NAME_PREFIX}${run}-`));
    if (left.length || other.length) throw new Error(`LEAK: containers left behind by this run (now removed): ${[...left, ...other].join(", ")}`);
    console.log("leak check: no boxoffice-e2e- containers of this run left");
  };
}
