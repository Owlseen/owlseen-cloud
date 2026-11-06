import { dayOf, daysBefore } from "@/domain/days";

/** A period of whole days, named by the UTC date: what every screen, tool and API reads. */
export interface Period {
  from: string;
  to: string;
  days: string[];
  /** Its last day that's over: whatever's stored for today says little, and compares with nothing. */
  lastWholeDay: string;
}

export const LONGEST_PERIOD_DAYS = 365;

export const boundedDays = (days: unknown, fallback = 28) => Math.min(Math.max(Math.trunc(Number(days)) || fallback, 1), LONGEST_PERIOD_DAYS);

const daysEndingOn = (to: string, length: number, lastWholeDay: string): Period => {
  const days = Array.from({ length }, (_, index) => daysBefore(to, length - 1 - index));
  return { from: days[0], to, days, lastWholeDay };
};

/** A period ending today. Search engines report late, so its last days fill in as they do. */
export function periodEndingAt(now: Date, length: number): Period {
  const today = dayOf(now);
  return daysEndingOn(today, length, daysBefore(today, 1));
}

/** A period of days that are all over, ending yesterday: for a rule that compares and shows no chart. */
export function wholeDaysUpTo(now: Date, length: number): Period {
  const yesterday = daysBefore(dayOf(now), 1);
  return daysEndingOn(yesterday, length, yesterday);
}

/** The period of the same length just before: what a change is measured against. */
export const periodBefore = ({ from, days }: Pick<Period, "from" | "days">): Pick<Period, "from" | "to"> => ({ from: daysBefore(from, days.length), to: daysBefore(from, 1) });
