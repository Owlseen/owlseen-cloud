import type { Services } from "./services";

/** A job's time ran out: what's left is for its next run. Not a failure of anything it was doing. */
export class OutOfTime extends Error {
  constructor() {
    super("The time for this run ran out.");
    this.name = "OutOfTime";
  }
}

/** Services whose waiting stops at a deadline: a provider asking to be left alone mustn't hold a job past what it has. */
export const withinBudget = (services: Services, deadline: number): Services => ({
  ...services,
  wait: async (ms) => {
    if (services.now().getTime() + ms >= deadline) throw new OutOfTime();
    await services.wait(ms);
  },
});

/** Runs this many at once, each taking the next thing to do when it's free, until there's nothing left. */
export async function atOnce<T>(count: number, next: () => T | undefined, work: (item: T) => Promise<void>): Promise<void> {
  const oneAfterAnother = async () => {
    for (let item = next(); item !== undefined; item = next()) await work(item);
  };
  await Promise.all(Array.from({ length: count }, oneAfterAnother));
}
