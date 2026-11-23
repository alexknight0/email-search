import MiniSearch from "https://cdn.jsdelivr.net/npm/minisearch@7.2.0/dist/es/index.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  initializeAuth, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, collection } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore-lite.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC7xqykvaKbyWjJw90NJFym29llPQjQjdU",
  authDomain: "email-search-8ea7e1.firebaseapp.com",
  projectId: "email-search-8ea7e1",
  appId: "1:818446598641:web:c76016af45483fe26bc450",
};
const app = initializeApp(FIREBASE_CONFIG);
// Sign-in lives in localStorage, not Firebase's shared IndexedDB (all of Alex's sites share one origin).
const auth = initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver });
const db = getFirestore(app);

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

const saveDocs = (value) => dbRun("readwrite", (s) => s.put(value, "docs"));
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

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

// Downloads every chunk from Firestore when the stored version differs from the cached one.
async function sync(cachedVersion) {
  const meta = await getDoc(doc(db, "meta", "index"));
  if (!meta.exists()) throw new Error("No emails have been uploaded yet. Run tools/upload.py.");
  const { version, chunks } = meta.data();
  if (version === cachedVersion) return null;
  $("load-status").textContent = `Downloading ${chunks} chunks…`;
  const snap = await getDocs(collection(db, "emails"));
  const parts = snap.docs.sort((a, b) => a.id.localeCompare(b.id));
  const list = [];
  for (const [i, d] of parts.entries()) {
    $("load-status").textContent = `Unpacking ${i + 1}/${parts.length}…`;
    list.push(...(await gunzip(d.data().data.toUint8Array())));
  }
  await saveDocs({ version, list });
  return list;
}

function showSignIn(message) {
  $("signin").hidden = false;
  $("load-status").textContent = message || "";
}

let cachedVersion = null;
async function start() {
  const saved = await loadDocs();
  if (saved && saved.list) {
    cachedVersion = saved.version;
    build(saved.list);
  }
  onAuthStateChanged(auth, async (user) => {
    $("signout").hidden = !user;
    if (!user) {
      if (!engine) showSignIn();
      return;
    }
    $("signin").hidden = true;
    try {
      const fresh = await sync(cachedVersion);
      if (fresh) {
        cachedVersion = (await loadDocs()).version;
        build(fresh);
      } else if (!engine) {
        build((await loadDocs()).list);
      }
      $("load-status").textContent = "";
    } catch (err) {
      const denied = err.code === "permission-denied";
      showSignIn(denied ? `${user.email} doesn't have access. Sign out and use the owner's account.` : `Could not load emails: ${err.message}`);
      $("signout").hidden = false;
    }
  });
}

$("signin").addEventListener("click", () =>
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => showSignIn(`Sign-in failed: ${err.message}`)),
);
$("signout").addEventListener("click", async () => {
  await signOut(auth);
  await clearDocs();
  location.reload();
});

start();
