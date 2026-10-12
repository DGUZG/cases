# SMS audit: crash edits, investigations, reports without an investigation

`sms_audit_console.js` runs in the browser console on the SMS site. It uses your
logged-in session to read the same data the app uses and answers:

1. **Which crashes were edited**: who, when, what changed, and what the user
   was working on at the time.
2. **Which investigations exist**: name, creator, creation date, *Reason for
   Investigation*, and location.
3. **Which crash report PDFs generated in 2026 have no investigation saved**
   for the same route and milepoints.

It only reads data; nothing in SMS is changed.

## Run it

1. Log in to the test site, `https://smst.nts.scdot.net/SMS/` (any page, e.g. *Manage Logs*).
2. Press **F12 → Console**. Edge/Chrome may ask you to type `allow pasting` first.
3. Paste the whole `sms_audit_console.js` and press Enter.

Reading 2026 takes about one request per week of logs (~40 requests). The
results appear as console tables, `window.SMS_AUDIT` holds all parsed data, and
these CSVs download (allow multiple downloads if the browser asks):

| File | One row per |
| --- | --- |
| `sms_edited_crashes_….csv` | edited crash (edit count, users, edit types, last change, context) |
| `sms_crash_edit_events_….csv` | edit (time, user, what changed, context, raw log SQL) |
| `sms_investigations_all.csv` | investigation (name, created, creator, reason, location, matched reports) |
| `sms_reports_2026.csv` | distinct report (repeat runs collapsed), with `HAS_INVESTIGATION` |
| `sms_reports_without_investigation_2026.csv` | report with `HAS_INVESTIGATION = NO` |

To change options, run it again without pasting, for example:

```js
SMSAudit.run({ START_DATE: '06/01/2026', MATCH_WINDOW_DAYS: 30 })
```

| Option | Default | Meaning |
| --- | --- | --- |
| `START_DATE` / `END_DATE` | `01/01/2026` / today | Log range to read (MM/DD/YYYY) |
| `REPORT_YEAR` | `2026` | Only reports generated in this year |
| `MATCH_WINDOW_DAYS` | `null` | `null`: any investigation at the location counts. `30`: it must be created within ±30 days of the report |
| `MP_TOLERANCE` | `0.05` | Milepoint slack when comparing locations |
| `CONTEXT_MINUTES` | `60` | How far back to look for the query or report a user ran before an edit |
| `CHUNK_DAYS` | `7` | Days of logs per request |

## How it works and its limits

- **Edit reasons are not stored by SMS.** Saving a crash sends only `CRASH_ID`,
  `USER_ID` and the changed columns, and the log records the resulting SQL. The
  script therefore reports:
  - `WHAT_CHANGED`: relocated to route/MP, marked unlocatable, or attribute
    changes such as `MANNER_OF_COLLISION=80`, with the code description.
  - `WORKING_ON`: the query or report the user ran just before the edit.
  - `INVESTIGATIONS_AT_LOCATION`: any investigation covering the crash
    location, with its reason.
- **Who did it.** Users come from the log's session id, matched to the login
  line or to the `user id` in Advanced Query entries. Many entries are logged
  under session `0`, which carries no user. For those, `USER_HINT` names
  whoever ran an Advanced Query within 30 minutes, followed by `?`. Treat it
  as a guess.
- **Reports.** Every crash report PDF logs `Report Service.getHeaderInformation`
  lines with the route LRS and BMP/EMP (segment) or intersection milepoint and
  crossing routes. Reports from queries without a main route log only
  `No Main Route LRS designated`. These are listed as `n/a`, because they have
  no location to match.
- **Matching a report to an investigation.** The LRS key
  (`CC TT NNNNN AA D` = county, route type, route number, auxiliary, direction)
  is compared with the investigation's `COUNTY`, `ROUTE_TYPE`, `ROUTE_NUMBER`
  and mainline/auxiliary route. The milepoints must overlap within
  `MP_TOLERANCE`.
- **Coverage.** The script only sees what *Manage Logs* still keeps. If older
  logs are purged, older edits and reports will not appear.

# Download a PDF from a HAR capture

`download_pdf_from_har.py` extracts the real PDF referenced in a `.har`
capture and saves it to disk (optionally into Google Drive on Colab).

## The gotcha this solves

On sites like HBSP, the URL you see
(`hbsp.harvard.edu/download?url=...`) returns an **HTML viewer page**
(`content-type: text/html`), **not** the PDF. Saving that as `.pdf`
gives a blank file. The real PDF comes from a *different* request whose
response `content-type` is `application/pdf` (e.g.
`services.hbsp.harvard.edu/api/.../content`).

This script finds the entry **by response MIME type**, not by URL/filename,
so it grabs the actual PDF. If the bytes are embedded in the HAR it saves
them with no network call; otherwise it replays that exact request with the
captured headers/cookies.

## Usage

```bash
python3 download_pdf_from_har.py case.har              # -> case.pdf
python3 download_pdf_from_har.py case.har -o mycase.pdf
python3 download_pdf_from_har.py case.har --list       # inspect candidates
```

On Google Colab, mount Drive and save under `MyDrive/Downloaded_PDFs/`:

```bash
python3 download_pdf_from_har.py case.har --drive -o mycase.pdf
```

## If it can't get the bytes

Record a **fresh HAR with response bodies enabled**, and open the PDF while
recording so the `application/pdf` response is actually captured. Chrome
often strips large binary bodies from HARs — if so, the script falls back to
replaying the request, which needs a still-valid session (run it promptly
after recording).
