const number = new Intl.NumberFormat("en-GB");
export const formatted = (value: number) => number.format(value);
export const percent = (share: number) => `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`;
/** A position, to one decimal: dashes when nothing was shown. */
export const positionOf = (position: number | null) => (position === null ? "–" : position.toFixed(1));

export const dayLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export interface DayValue {
  date: string;
  value: number;
}

const NOT_YET = "not reported yet";

/**
 * One measure over days, as columns growing from one baseline, with the busiest day, which the scale
 * reads, in the eye's colour. Each column's whole height answers the pointer, since a quiet day's mark
 * is too small to aim at, and the numbers are one click away as a table, so nothing depends on seeing the chart.
 * A day no engine has reported yet is drawn hollow: as a zero, the end of every chart would read as a crash.
 */
export function DayColumns({ days, measure, reportedUpTo }: { days: DayValue[]; measure: string; reportedUpTo?: string }) {
  const notYet = (date: string) => reportedUpTo !== undefined && date > reportedUpTo;
  const most = Math.max(...days.filter(({ date }) => !notYet(date)).map(({ value }) => value), 1);
  return (
    <figure>
      <figcaption className="sr-only">
        {measure} per day, {dayLabel(days[0].date)} to {dayLabel(days[days.length - 1].date)}
      </figcaption>
      <div className="flex h-40 border-b">
        <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{formatted(most)}</span>
        <div className="flex min-w-0 flex-1 items-end gap-0.5">
          {days.map(({ date, value }) => (
            <div key={date} tabIndex={0} aria-label={`${dayLabel(date)}: ${notYet(date) ? NOT_YET : formatted(value)}`} className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none">
              {notYet(date) ? <div data-not-reported className="h-full w-full max-w-6 rounded-t-[3px] border border-b-0 border-dashed border-muted-foreground/40" /> : <div className={`w-full max-w-6 rounded-t-[3px] transition-colors group-hover:bg-eye group-focus:bg-eye ${value === most ? "bg-eye" : "bg-data"}`} style={{ height: `${(value / most) * 100}%` }} />}
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground group-hover:block group-focus:block">
                {dayLabel(date)}: <span className="font-mono">{notYet(date) ? NOT_YET : formatted(value)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 ml-14 flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{dayLabel(days[0].date)}</span>
        <span>{dayLabel(days[days.length - 1].date)}</span>
      </div>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">As a table</summary>
        <table className="mt-2 w-full max-w-xs">
          <tbody>
            {days.map(({ date, value }) => (
              <tr key={date}>
                <td className="py-0.5">{dayLabel(date)}</td>
                <td className="py-0.5 text-right font-mono text-foreground">{notYet(date) ? NOT_YET : formatted(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** A small one for a row in a list: the shape of its days, nothing to read off it. */
export function MiniColumns({ values, notYet = 0 }: { values: number[]; notYet?: number }) {
  const known = values.slice(0, values.length - notYet);
  const most = Math.max(...known, 1);
  return (
    <span aria-hidden className="flex h-6 w-28 shrink-0 items-end gap-px">
      {known.map((value, index) => (
        <span key={index} className="min-w-0 flex-1 rounded-t-[2px] bg-data" style={{ height: value === 0 ? "1px" : `${(value / most) * 100}%`, opacity: value === 0 ? 0.25 : 1 }} />
      ))}
      {Array.from({ length: notYet }, (_, index) => (
        <span key={`not yet ${index}`} data-not-reported className="h-full min-w-0 flex-1 rounded-t-[2px] border border-b-0 border-dashed border-muted-foreground/40" />
      ))}
    </span>
  );
}

/** How a figure moved against the period before. Up isn't always good: a position goes down as it improves. */
export function Change({ now, before, lowerIsBetter = false }: { now: number | null; before: number | null; lowerIsBetter?: boolean }) {
  if (now === null || !before) return <span className="text-xs text-muted-foreground">nothing to compare</span>;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.005) return <span className="text-xs text-muted-foreground">no change</span>;
  const good = lowerIsBetter ? change < 0 : change > 0;
  return <span className={`font-mono text-xs ${good ? "text-calm" : "text-alert"}`}>{`${change > 0 ? "+" : "−"}${percent(Math.abs(change))}`}</span>;
}
