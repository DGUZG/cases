#!/usr/bin/env python3
"""
Download the real PDF referenced in a .har capture and save it to disk
(optionally into Google Drive when run in Google Colab).

Why earlier attempts produced a blank PDF
-----------------------------------------
The URL  hbsp.harvard.edu/download?url=/content/.../content&metadata=...
does NOT return a PDF. Its response is `content-type: text/html` (the
pdf.js *viewer* page). Saving that HTML as a `.pdf` gives a blank file.

The actual PDF bytes are delivered by a *different* request that the viewer
makes (typically services.hbsp.harvard.edu/api/.../content), whose response
`content-type` is `application/pdf`.

So this script does NOT guess by filename or URL. It scans the HAR for the
entry whose RESPONSE mime type is a PDF, and then either:
  1. saves the PDF bytes already embedded in the HAR (no network needed), or
  2. replays that exact request (URL + the request's own headers/cookies)
     to fetch the bytes.

Usage
-----
    python3 download_pdf_from_har.py case.har
    python3 download_pdf_from_har.py case.har -o mycase.pdf
    python3 download_pdf_from_har.py case.har --list        # just show candidates

In Colab, pass --drive to mount Google Drive and save under
MyDrive/Downloaded_PDFs/.
"""

import argparse
import base64
import json
import os
import sys
import urllib.request


def load_har(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8", "replace"))


def header_value(headers, name):
    """Case-insensitive lookup in a HAR headers list."""
    name = name.lower()
    for h in headers or []:
        if h.get("name", "").lower() == name:
            return h.get("value", "")
    return ""


def is_pdf_mime(mime):
    mime = (mime or "").lower()
    return "application/pdf" in mime or "application/octet-stream" in mime


def embedded_bytes(entry):
    """Return PDF bytes stored inside the HAR response, or None."""
    content = entry.get("response", {}).get("content", {}) or {}
    text = content.get("text")
    if not text:
        return None
    if content.get("encoding") == "base64":
        try:
            return base64.b64decode(text)
        except Exception:
            return None
    # Non-base64 text almost certainly isn't a binary PDF, but try anyway.
    data = text.encode("utf-8", "replace")
    return data if data.startswith(b"%PDF") else None


def find_pdf_entries(har):
    """All entries whose response looks like a PDF, best first."""
    entries = har.get("log", {}).get("entries", []) or []
    hits = []
    for e in entries:
        resp = e.get("response", {}) or {}
        content = resp.get("content", {}) or {}
        mime = content.get("mimeType") or header_value(
            resp.get("headers"), "content-type"
        )
        url = e.get("request", {}).get("url", "")
        looks_pdf = is_pdf_mime(mime) or url.lower().endswith(".pdf")
        if looks_pdf:
            hits.append(e)
    # Prefer entries that already carry the bytes, then larger bodies.
    hits.sort(
        key=lambda e: (
            embedded_bytes(e) is not None,
            e.get("response", {}).get("content", {}).get("size", 0) or 0,
        ),
        reverse=True,
    )
    return hits


def replay_request(entry):
    """Re-issue the captured request with its own headers/cookies."""
    req = entry.get("request", {})
    url = req.get("url")
    # Copy the request headers, dropping HTTP/2 pseudo-headers (":authority",
    # ":method", ...) which urllib/requests cannot send.
    headers = {}
    for h in req.get("headers", []) or []:
        name = h.get("name", "")
        if name.startswith(":"):
            continue
        if name.lower() in ("content-length", "host"):
            continue
        headers[name] = h.get("value", "")
    r = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(r, timeout=60) as resp:
        return resp.read(), resp.headers.get("content-type", "")


def save(data, out_path):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("har", help="path to the .har file")
    ap.add_argument("-o", "--output", help="output .pdf path")
    ap.add_argument("--drive", action="store_true",
                    help="(Colab) mount Google Drive and save under MyDrive/Downloaded_PDFs")
    ap.add_argument("--list", action="store_true",
                    help="only list PDF candidates found in the HAR")
    args = ap.parse_args()

    if not os.path.exists(args.har):
        sys.exit(f"HAR not found: {args.har}")

    har = load_har(args.har)
    hits = find_pdf_entries(har)

    if not hits:
        sys.exit(
            "No PDF response found in the HAR.\n"
            "Make sure you recorded the capture while the PDF actually loaded,\n"
            "and that DevTools was NOT set to discard response bodies."
        )

    if args.list:
        print(f"Found {len(hits)} PDF candidate(s):")
        for i, e in enumerate(hits):
            resp = e.get("response", {})
            content = resp.get("content", {})
            print(f"  [{i}] {e['request']['url']}")
            print(f"       status={resp.get('status')} "
                  f"mime={content.get('mimeType')} "
                  f"size={content.get('size')} "
                  f"embedded={'yes' if embedded_bytes(e) else 'no'}")
        return

    # Decide output location.
    out = args.output
    if args.drive:
        from google.colab import drive  # noqa: only available in Colab
        drive.mount("/content/drive")
        folder = "/content/drive/MyDrive/Downloaded_PDFs"
        os.makedirs(folder, exist_ok=True)
        if not out:
            out = os.path.join(folder, "case.pdf")
        elif not os.path.isabs(out):
            out = os.path.join(folder, out)
    if not out:
        out = "case.pdf"

    # Try each candidate until one yields real PDF bytes.
    last_err = None
    for e in hits:
        data = embedded_bytes(e)
        source = "embedded in HAR"
        if data is None:
            try:
                data, ctype = replay_request(e)
                source = f"re-downloaded ({ctype})"
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                continue
        if data and data[:5] == b"%PDF-":
            save(data, out)
            print(f"Saved PDF ({len(data):,} bytes, {source})")
            print(f"  from: {e['request']['url']}")
            print(f"  to:   {out}")
            return
        else:
            last_err = (
                "candidate returned non-PDF data "
                f"(starts with {data[:8]!r}) from {e['request']['url']}"
            )

    sys.exit(
        "Could not obtain real PDF bytes.\n"
        f"Last problem: {last_err}\n\n"
        "If replay failed with 401/403, the session likely expired. Record a\n"
        "fresh HAR *with response bodies enabled* and run this again promptly:\n"
        "  DevTools > Network > gear icon > uncheck 'disable cache' is fine,\n"
        "  but make sure 'Do not persist' / body-stripping is OFF, then reload\n"
        "  and open the PDF so the application/pdf response is captured."
    )


if __name__ == "__main__":
    main()
