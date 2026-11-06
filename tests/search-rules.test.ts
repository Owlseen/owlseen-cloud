import { describe, expect, it } from "vitest";
import { alertOf, combined, ctrOf, expectedCtrAt, indexStandingOf, isDecaying, lastReported, moveOf, opportunityOf, rankBandOf, reachOfProperty, type IndexState } from "@/domain/search";

describe("click-through", () => {
  it("is clicks over impressions", () => {
    expect(ctrOf({ clicks: 3, impressions: 60 })).toBe(0.05);
  });

  it("is zero when nothing was shown, not a division by nothing", () => {
    expect(ctrOf({ clicks: 0, impressions: 0 })).toBe(0);
  });
});

describe("figures added up", () => {
  it("weigh each position by how often it was shown", () => {
    // (2 × 100 + 8 × 300) / 400 = 6.5, where a plain average would say 5.
    const added = combined([
      { clicks: 10, impressions: 100, position: 2 },
      { clicks: 5, impressions: 300, position: 8 },
    ]);
    expect(added).toEqual({ clicks: 15, impressions: 400, position: 6.5 });
  });

  it("count a row with no position in the totals, and not in the position", () => {
    const added = combined([
      { clicks: 3, impressions: 100, position: 4 },
      { clicks: 2, impressions: 900, position: null },
    ]);
    expect(added).toEqual({ clicks: 5, impressions: 1000, position: 4 });
  });

  it("have no position when nothing says one, or nothing was shown", () => {
    expect(combined([])).toEqual({ clicks: 0, impressions: 0, position: null });
    expect(combined([{ clicks: 1, impressions: 10, position: null }]).position).toBeNull();
    expect(combined([{ clicks: 0, impressions: 0, position: 5 }]).position).toBeNull();
  });
});

describe("rank bands", () => {
  it.each([
    [1, "1-3"],
    [3, "1-3"],
    [3.01, "4-10"],
    [10, "4-10"],
    [10.01, "11-20"],
    [20, "11-20"],
    [20.01, "21+"],
    [87, "21+"],
  ])("put position %d in %s", (position, band) => {
    expect(rankBandOf(position)).toBe(band);
  });
});

describe("the click curve", () => {
  it.each([
    [0.5, 0.28],
    [1, 0.28],
    [2, 0.15],
    [3, 0.1],
    [9, 0.024],
    [10, 0.02],
    [10.01, 0.012],
    [50, 0.012],
  ])("expects at position %d a share of %d", (position, share) => {
    expect(expectedCtrAt(position)).toBe(share);
  });

  it("goes in a straight line between two positions", () => {
    // Halfway from 15% to 10%, and from 2.4% to 2%.
    expect(expectedCtrAt(2.5)).toBeCloseTo(0.125, 10);
    expect(expectedCtrAt(9.5)).toBeCloseTo(0.022, 10);
  });
});

describe("whether a keyword is worth working on", () => {
  const at = (position: number | null, impressions = 1000, clicks = 30) => opportunityOf({ clicks, impressions, position });

  it("wants a position to work from", () => {
    expect(at(null)).toBeNull();
  });

  it("wants at least 20 impressions", () => {
    expect(at(8, 19, 0)).toBeNull();
    expect(at(8, 20, 0)).toEqual({ clicks: 0, impressions: 20, position: 8, potential: 2 });
  });

  it("is from position 4 to 20, those ends included", () => {
    expect(at(3.99)).toBeNull();
    expect(at(4)).not.toBeNull();
    expect(at(20)).not.toBeNull();
    expect(at(20.01)).toBeNull();
  });

  it("is worth the clicks position 3 would bring, less those it has", () => {
    // 10% of 1,000 is 100, and it has 30.
    expect(at(8)?.potential).toBe(70);
    // 10% of 125 is 12.5, which rounds up.
    expect(at(8, 125, 0)?.potential).toBe(13);
  });

  it("is never worth less than nothing", () => {
    // 10% of 100 is 10, and it already has 50.
    expect(at(8, 100, 50)?.potential).toBe(0);
  });
});

describe("a week against the one before", () => {
  it("says nothing below 10 clicks: a swing there means little", () => {
    expect(alertOf(0, 9)).toBeNull();
    expect(alertOf(90, 9)).toBeNull();
    expect(alertOf(5, 10)).toEqual({ severity: "high", change: -0.5, clicks: 5, clicksBefore: 10 });
  });

  it.each([
    [0, "high", -1],
    [50, "high", -0.5],
    [51, "medium", -0.49],
    [75, "medium", -0.25],
    [150, "info", 0.5],
    [300, "info", 2],
  ])("from 100 clicks to %d is %s", (clicks, severity, change) => {
    expect(alertOf(clicks, 100)).toEqual({ severity, change, clicks, clicksBefore: 100 });
  });

  it.each([76, 100, 149])("from 100 clicks to %d says nothing", (clicks) => {
    expect(alertOf(clicks, 100)).toBeNull();
  });
});

describe("whether a keyword moved", () => {
  it("is 30% of the larger figure, either way", () => {
    expect(moveOf(70, 100)).toEqual({ clicks: 70, clicksBefore: 100, gained: -30 });
    expect(moveOf(100, 70)).toEqual({ clicks: 100, clicksBefore: 70, gained: 30 });
    expect(moveOf(71, 100)).toBeNull();
    expect(moveOf(100, 71)).toBeNull();
  });

  it("counts exactly 30% in figures where a fraction lands just over it", () => {
    expect(moveOf(63, 90)).toEqual({ clicks: 63, clicksBefore: 90, gained: -27 });
  });

  it("needs ten clicks on one side to mean something", () => {
    expect(moveOf(9, 0)).toBeNull();
    expect(moveOf(0, 9)).toBeNull();
    expect(moveOf(10, 0)).toEqual({ clicks: 10, clicksBefore: 0, gained: 10 });
    expect(moveOf(0, 10)).toEqual({ clicks: 0, clicksBefore: 10, gained: -10 });
  });

  it("says nothing of no change", () => {
    expect(moveOf(50, 50)).toBeNull();
    expect(moveOf(0, 0)).toBeNull();
  });
});

describe("a site gone quiet", () => {
  it("is falling hard, whatever the fall so far", () => {
    expect(alertOf(300, 400, "2026-10-31")).toEqual({ severity: "high", quietSince: "2026-10-31", change: -0.25, clicks: 300, clicksBefore: 400 });
    expect(alertOf(0, 700, "2026-10-21")).toMatchObject({ severity: "high", change: -1 });
  });

  it("needs to have had something to lose", () => {
    expect(alertOf(0, 9, "2026-10-21")).toBeNull();
  });
});

describe("how far the engines have reported", () => {
  it("is the latest of them, and nothing when none has", () => {
    expect(lastReported({ google: "2026-11-03", bing: "2026-11-05" })).toBe("2026-11-05");
    expect(lastReported({})).toBeUndefined();
  });
});

describe("which property covers most", () => {
  it("goes domain, https root, http root, then anything narrower", () => {
    expect(["https://a.example/blog/", "http://a.example/", "sc-domain:a.example", "https://a.example/", "not an address"].map(reachOfProperty)).toEqual([3, 2, 0, 1, 3]);
  });
});

describe("a page losing its traffic", () => {
  it("has lost at least 30%", () => {
    expect(isDecaying({ clicks: 70, clicksBefore: 100 })).toBe(true);
    expect(isDecaying({ clicks: 71, clicksBefore: 100 })).toBe(false);
    expect(isDecaying({ clicks: 0, clicksBefore: 100 })).toBe(true);
  });

  it.each([
    [63, 90],
    [119, 170],
    [126, 180],
    [231, 330],
  ])("has lost exactly 30% going to %d from %d, whatever fractions make of the sum", (clicks, clicksBefore) => {
    expect(isDecaying({ clicks, clicksBefore })).toBe(true);
    expect(isDecaying({ clicks: clicks + 1, clicksBefore })).toBe(false);
  });

  it("had at least 10 clicks to lose", () => {
    expect(isDecaying({ clicks: 0, clicksBefore: 9 })).toBe(false);
    expect(isDecaying({ clicks: 7, clicksBefore: 10 })).toBe(true);
  });

  it("isn't one that grew", () => {
    expect(isDecaying({ clicks: 200, clicksBefore: 100 })).toBe(false);
  });
});

describe("where a page stands", () => {
  const check = (day: string, verdict: string, coverage: string | null = null): IndexState => ({ day, verdict, coverage });
  const inBothOrders = (checks: IndexState[]) => [indexStandingOf(checks), indexStandingOf([...checks].reverse())];

  it("is indexed when its latest check passes", () => {
    for (const standing of inBothOrders([check("2026-10-01", "NEUTRAL"), check("2026-10-08", "PASS")])) expect(standing).toEqual({ state: "indexed" });
    expect(indexStandingOf([check("2026-10-08", "PASS")])).toEqual({ state: "indexed" });
  });

  it("is not indexed when no check ever passed", () => {
    for (const standing of inBothOrders([check("2026-10-01", "NEUTRAL"), check("2026-10-08", "FAIL")])) expect(standing).toEqual({ state: "not-indexed" });
    expect(indexStandingOf([check("2026-10-08", "VERDICT_UNSPECIFIED")])).toEqual({ state: "not-indexed" });
  });

  it("has dropped when one was indexed and the latest isn't, saying why", () => {
    const checks = [check("2026-10-01", "PASS", "Submitted and indexed"), check("2026-10-08", "NEUTRAL", "Crawled - currently not indexed")];
    for (const standing of inBothOrders(checks)) expect(standing).toEqual({ state: "dropped", since: "2026-10-08", coverage: "Crawled - currently not indexed" });
  });

  it("has dropped since the first check that missed it, not the latest", () => {
    const checks = [check("2026-10-01", "PASS"), check("2026-10-08", "NEUTRAL", "Crawled"), check("2026-10-15", "NEUTRAL", "Discovered"), check("2026-10-22", "FAIL", "Blocked")];
    for (const standing of [indexStandingOf(checks), indexStandingOf([checks[2], checks[0], checks[3], checks[1]])]) expect(standing).toEqual({ state: "dropped", since: "2026-10-08", coverage: "Blocked" });
  });

  it("counts from the last time it was indexed, when it came and went", () => {
    const checks = [check("2026-09-01", "NEUTRAL"), check("2026-09-08", "PASS"), check("2026-09-15", "FAIL"), check("2026-09-22", "PASS"), check("2026-09-29", "FAIL"), check("2026-10-06", "FAIL")];
    for (const standing of inBothOrders(checks)) expect(standing).toMatchObject({ state: "dropped", since: "2026-09-29" });
  });
});
