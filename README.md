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
