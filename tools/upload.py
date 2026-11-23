"""Upload data/emails.json to Firestore as gzipped chunks.

Collection `emails` holds chunk docs (`c0000`, ...) with a gzipped JSON array in `data`
(Bytes), and the doc `meta/index` holds {version, count, chunks}. Chunks go up first, so a
half-finished upload never changes what the site sees. Uses gcloud credentials, which
bypass the rules (the rules only let Alex read and write from the site).
"""
import base64
import gzip
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = "email-search-8ea7e1"
SRC = Path(__file__).resolve().parent.parent / "data" / "emails.json"
RAW_PER_CHUNK = 2_500_000  # raw JSON bytes per chunk; gzip leaves it far below Firestore's 1 MiB
MAX_DOC = 900_000
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"


def token():
    return subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True, check=True).stdout.strip()


def call(method, url, tok, body=None):
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {tok}", "x-goog-user-project": PROJECT, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def chunks(docs):
    group, size = [], 0
    for d in docs:
        n = len(json.dumps(d, ensure_ascii=False).encode())
        if group and size + n > RAW_PER_CHUNK:
            yield group
            group, size = [], 0
        group.append(d)
        size += n
    if group:
        yield group


def main():
    docs = json.loads(SRC.read_text(encoding="utf-8"))
    tok = token()
    version = int(time.time())
    count = 0
    for i, group in enumerate(chunks(docs)):
        blob = gzip.compress(json.dumps(group, ensure_ascii=False).encode(), 9)
        if len(blob) > MAX_DOC:
            sys.exit(f"chunk {i} is {len(blob)} bytes, too big; lower RAW_PER_CHUNK")
        name = f"c{i:04d}"
        call("PATCH", f"{BASE}/emails/{name}", tok, {"fields": {"data": {"bytesValue": base64.b64encode(blob).decode()}, "version": {"integerValue": str(version)}}})
        count = i + 1
        print(f"uploaded {name}: {len(group)} emails, {len(blob) / 1000:.0f} KB", flush=True)
    call("PATCH", f"{BASE}/meta/index", tok, {"fields": {"version": {"integerValue": str(version)}, "count": {"integerValue": str(len(docs))}, "chunks": {"integerValue": str(count)}}})
    # Remove chunks left over from an older, longer upload.
    listing = call("GET", f"{BASE}/emails?pageSize=500", tok)
    for doc in listing.get("documents", []):
        if int(doc["fields"]["version"]["integerValue"]) != version:
            urllib.request.urlopen(urllib.request.Request(f"https://firestore.googleapis.com/v1/{doc['name']}", method="DELETE", headers={"Authorization": f"Bearer {tok}", "x-goog-user-project": PROJECT}))
            print("deleted old", doc["name"].rsplit("/", 1)[1])
    print(f"done: {len(docs)} emails in {count} chunks, version {version}")


if __name__ == "__main__":
    main()
