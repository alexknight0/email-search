import MiniSearch from "https://cdn.jsdelivr.net/npm/minisearch@7.2.0/dist/es/index.js";

const DB_NAME = "email-search";
const STORE = "kv";
const PAGE = 50;
const $ = (id) => document.getElementById(id);

let docs = [];
let byId = new Map();
let engine = null;
let hits = [];
let shown = 0;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRun(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const saveDocs = (list) => dbRun("readwrite", (s) => s.put(list, "docs"));
const loadDocs = () => dbRun("readonly", (s) => s.get("docs"));
const clearDocs = () => dbRun("readwrite", (s) => s.delete("docs"));

function build(list) {
  docs = list;
  byId = new Map(list.map((d) => [d.id, d]));
  engine = new MiniSearch({
    fields: ["subject", "from", "to", "body"],
    storeFields: [],
    searchOptions: { prefix: true, fuzzy: 0.15, combineWith: "AND", boost: { subject: 3, from: 2 } },
  });
  engine.addAll(list);
  $("load").hidden = true;
  $("app").hidden = false;
  $("count").textContent = `${list.length.toLocaleString()} emails`;
  run();
  $("q").focus();
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function highlight(text, terms) {
  let out = escapeHtml(text);
  for (const t of terms) {
    if (t.length < 2) continue;
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return out;
}

function snippet(body, terms) {
  if (!body) return "";
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  const start = Math.max(0, at - 60);
  return (start ? "…" : "") + body.slice(start, start + 220);
}

function run() {
  const q = $("q").value.trim();
  const source = $("source").value;
  const sort = $("sort").value;
  let list;
  let terms = [];
  if (q) {
    const found = engine.search(q);
    terms = [...new Set(found.flatMap((r) => r.queryTerms))];
    list = found.map((r) => byId.get(r.id));
    if (sort === "rank") {
      // keep relevance order
    }
  } else {
    list = docs.slice();
  }
  if (source) list = list.filter((d) => d.source === source);
  if (sort === "new") list.sort((a, b) => b.date.localeCompare(a.date));
  if (sort === "old") list.sort((a, b) => a.date.localeCompare(b.date));
  hits = list.map((d) => ({ d, terms }));
  shown = 0;
  $("results").replaceChildren();
  $("summary").textContent = q
    ? `${list.length.toLocaleString()} result${list.length === 1 ? "" : "s"}`
    : "Type to search. Showing all emails, newest first.";
  more();
}

function more() {
  const frag = document.createDocumentFragment();
  for (const { d, terms } of hits.slice(shown, shown + PAGE)) {
    const li = document.createElement("li");
    li.className = "mail";
    const subject = d.subject || "(no subject)";
    li.innerHTML =
      `<div class="top"><span class="subj">${highlight(subject, terms)}</span>` +
      `<span class="date">${escapeHtml(d.date)}</span></div>` +
      `<div class="who"><span class="tag ${d.source === "UQ" ? "uq" : ""}">${d.source}</span>` +
      `${highlight(d.from || "", terms)}</div>` +
      `<div class="snip">${highlight(snippet(d.body, terms), terms)}</div>`;
    li.addEventListener("click", () => {
      const open = li.classList.toggle("open");
      li.querySelector(".snip").innerHTML = highlight(open ? d.body : snippet(d.body, terms), terms);
    });
    frag.append(li);
  }
  $("results").append(frag);
  shown += PAGE;
  $("more").hidden = shown >= hits.length;
}

let timer;
$("q").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(run, 150);
});
$("source").addEventListener("change", run);
$("sort").addEventListener("change", run);
$("more").addEventListener("click", more);

$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("load-status").textContent = "Reading file…";
  try {
    const list = JSON.parse(await file.text());
    $("load-status").textContent = "Saving in this browser…";
    await saveDocs(list);
    build(list);
  } catch (err) {
    $("load-status").textContent = `Could not load that file: ${err.message}`;
  }
});

$("reset").addEventListener("click", async () => {
  await clearDocs();
  location.reload();
});

const saved = await loadDocs();
if (saved && saved.length) build(saved);
