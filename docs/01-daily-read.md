# The daily read

Whether a day's reading fits, for a large workspace: 200 sites, each on Google and Bing. Everything here is an estimate until Owlseen has run on real accounts; section 5 says what to measure then.

## 1. What it's worked out from

- **Calls take about 0.7 seconds, writes included.** A daily job of about 200 sites, making 3 Google calls a site and one Bing call, one after another, has been seen to fit inside a 300-second function: at most about 0.45 seconds a call. Allow more.
- **An index check takes about 1 second.** This is a guess: nothing has measured it yet.
- **Google allows far more than this.** Its published limits are 1,200 Search Analytics queries a minute per site and per user, and 2,000 inspections a site a day with 600 a minute. Four at once is about 6 calls a second, or 360 a minute.

## 2. What one site costs

| | Google | Bing | Calls | Time, one at a time |
|---|---|---|---|---|
| A day's read | totals, keywords, pages, sitemaps: 4 | totals, sitemaps: 2 | 6 | 4 seconds |
| A first read | totals 1, keywords 7, pages 7, sitemaps 1: 16 | 2 | 18 | 13 seconds |

A first read asks 480 days of totals and 90 days of keywords and pages, 14 days at a time. A property with more than 100,000 rows in those 14 days is read again in halves, which costs more, and a large one takes more than a single run: it saves each slice and carries on from there.

## 3. What a run has, and what a day needs

A run has 270 seconds. Reading gets the first 200, and a read under way may finish within 30 more. Index checks get the rest, and all of it when reading is done. Both go four at a time.

| | Calls or pages | Time, four at once | Runs |
|---|---|---|---|
| A day's read, 200 sites | 1,200 calls | 210 seconds | 1 or 2 |
| A first read, 200 sites | 3,600 calls | 630 seconds | 4 |
| Index checks in a run with no reading | about 1,080 pages | 270 seconds | |
| Index checks in a run that reads for 200 seconds | about 280 pages | 70 seconds | |

One at a time, a day's read would take 14 minutes and use more than three whole runs, leaving none for index checks: that's why it's four at once.

**The schedule is six runs, hourly from 05:00 to 10:00 UTC** (`0 5-10 * * *`). Three would hold on a good day, with nothing to spare: a first read would take more than a day, and a morning of quotas or errors would leave sites unread until the next. Six give:

- **A normal day.** The first run reads nearly everything and checks about 280 pages, and a few sites may wait for the second. The other runs check about 1,080 pages each, or about 5,500 pages a day and 38,000 a week.
- **The first day.** Four runs for the first read, the other two for index checks, once there are pages to check.
- **Room for what fails.** Sites that were failing get the last fifth of reading's time in each run, however many others wait, and are tried up to six times a day.

Vercel's Pro plan allows this: its limit is on the number of cron jobs, not how often they run. A run with nothing left to do makes two small queries, which wakes a sleeping database for its idle timeout, at most six times a day.

## 4. When it doesn't fit

Nothing is lost, and nothing has to be done by hand.

- **Sites left over are read by the next run**, those read longest ago first, and the job's answer says how many are left. A site unread for days is read back from the last time each engine was read to the end, so no day goes missing.
- **Index checks are the first to give way**, by design: their share is what's left. Pages asked longest ago go first, so what slips is how soon a page is asked again. Each site's pages take turns, and the site asked longest ago goes first, so a short run still reaches every site in the end. "A week" is the soonest a page is asked again, not a promise.
- **A deployment past about 1,000 sites**, across all its workspaces, wouldn't finish a day's read in six runs, at about 190 sites a run, and has to be given more: add hours to the schedule, up to one run an hour around the clock. Past that, the job would need to run in parts.

## 5. What to measure on real accounts

The job answers with how many sites it read, failed and left, and how many pages it checked. On the first days, check that:

- `left` reaches 0 by the second run on a normal day.
- A run's reading stays within 200 seconds for a normal day.
- Index checks reach about 4 a second. If Google is slower, or the 2,000 a site a day ever matters, this is the first number to change.
