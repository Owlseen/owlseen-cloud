export const DAY_MS = 86_400_000;

/** A moment's day, in UTC. */
export const dayOf = (at: Date | string) => new Date(at).toISOString().slice(0, 10);

/** The day after another. */
export const dayAfter = (day: string) => dayOf(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + DAY_MS));

/** The day halfway between two, the earlier one when it falls between them. */
export const dayBetween = (from: string, to: string) => dayOf(new Date(Math.floor((new Date(`${from}T00:00:00.000Z`).getTime() + new Date(`${to}T00:00:00.000Z`).getTime()) / 2 / DAY_MS) * DAY_MS));

/** The day this many days before another. */
export const daysBefore = (day: string, days: number) => dayOf(new Date(new Date(`${day}T00:00:00.000Z`).getTime() - days * DAY_MS));
