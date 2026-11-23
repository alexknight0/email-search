"""Build data/emails.json from the Gmail mbox and the UQ Outlook .olm export.

The output holds private email text. It is gitignored and must never be pushed:
the public site only reads it from a file you pick in the browser.
"""
import email.header
import email.utils
import html
import json
import mailbox
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

DOWNLOADS = Path.home() / "Downloads"
MBOX = DOWNLOADS / "Takeout/Mail/All mail Including Spam and Trash.mbox"
OLM = DOWNLOADS / "all-uq-outlook-emails.olm"
OUT = Path(__file__).resolve().parent.parent / "data" / "emails.json"
BODY_LIMIT = 4000


def decode_header(value):
    if not value:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(str(value))))
    except Exception:
        return str(value)


def html_to_text(src):
    soup = BeautifulSoup(src, "lxml")
    for tag in soup(["script", "style", "head"]):
        tag.decompose()
    return soup.get_text(" ")


def squash(text):
    return re.sub(r"\s+", " ", text).strip()


def part_text(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    return payload.decode(part.get_content_charset() or "utf-8", "replace")


def mbox_body(msg):
    plain, markup = "", ""
    for part in msg.walk():
        if part.get_filename():
            continue
        kind = part.get_content_type()
        if kind == "text/plain" and not plain:
            plain = part_text(part)
        elif kind == "text/html" and not markup:
            markup = part_text(part)
    return squash(plain or (html_to_text(markup) if markup else ""))


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d %H:%M")


def from_mbox(docs):
    box = mailbox.mbox(str(MBOX))
    for i, msg in enumerate(box):
        if i % 1000 == 0:
            print(f"gmail {i}", flush=True)
        try:
            when = email.utils.parsedate_to_datetime(msg["Date"]).timestamp()
        except Exception:
            when = 0
        labels = decode_header(msg["X-Gmail-Labels"])
        docs.append(
            {
                "id": f"g{i}",
                "source": "Gmail",
                "subject": squash(decode_header(msg["Subject"])),
                "from": squash(decode_header(msg["From"])),
                "to": squash(decode_header(msg["To"])),
                "date": iso(when) if when else "",
                "folder": labels,
                "body": mbox_body(msg)[:BODY_LIMIT],
            }
        )


def tag(xml, name):
    m = re.search(rf"<{name}[^>]*>(.*?)</{name}>", xml, re.S)
    return html.unescape(m.group(1)) if m else ""


def people(xml, name):
    block = tag_raw(xml, name)
    out = []
    for m in re.finditer(r'<emailAddress[^>]*?OPFContactEmailAddressAddress="([^"]*)"(?:[^>]*?OPFContactEmailAddressName="([^"]*)")?', block):
        addr, nm = html.unescape(m.group(1)), html.unescape(m.group(2) or "")
        out.append(f"{nm} <{addr}>" if nm else addr)
    return ", ".join(out)


def tag_raw(xml, name):
    m = re.search(rf"<{name}[^>]*>(.*?)</{name}>", xml, re.S)
    return m.group(1) if m else ""


def from_olm(docs):
    zf = zipfile.ZipFile(OLM)
    names = [n for n in zf.namelist() if re.search(r"Accounts/.*__Messages/.*/message_\d+\.xml$", n)]
    for i, name in enumerate(names):
        if i % 500 == 0:
            print(f"uq {i}/{len(names)}", flush=True)
        xml = zf.read(name).decode("utf-8", "replace")
        folder = name.split("__Messages/")[1].rsplit("/", 1)[0]
        body = tag(xml, "OPFMessageCopyBody")
        text = html_to_text(body) if "<" in body else body
        when = tag(xml, "OPFMessageCopyReceivedTime") or tag(xml, "OPFMessageCopySentTime")
        docs.append(
            {
                "id": f"u{i}",
                "source": "UQ",
                "subject": squash(tag(xml, "OPFMessageCopySubject")),
                "from": people(xml, "OPFMessageCopyFromAddresses"),
                "to": people(xml, "OPFMessageCopyToAddresses"),
                "date": when.replace("T", " ")[:16],
                "folder": folder,
                "body": squash(text)[:BODY_LIMIT],
            }
        )


def main():
    docs = []
    from_mbox(docs)
    from_olm(docs)
    docs.sort(key=lambda d: d["date"], reverse=True)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(docs, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(docs)} emails, {OUT.stat().st_size / 1e6:.1f} MB to {OUT}")


if __name__ == "__main__":
    sys.exit(main())
