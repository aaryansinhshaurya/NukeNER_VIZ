/* ═══════════════════════════════════════════════════════
   NukeNER_VIZ — app.js
   ═══════════════════════════════════════════════════════ */

const API = (window.API_BASE || "http://localhost:5000") + "/api";

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  projectId:   null,
  projectName: "",
  projectNames:{},
  userName:    "",
  currentDoc:  null,
  currentTab:  "annotate",   // annotate | metrics | team
  sentences:   [],           // full project data from /data
  docsMap:     new Map(),
  entityIndex: new Map(),     // entity_id -> {entity, sentenceId}
  annotations: {},           // model_entity_id → {verdict, ann_id}
  openEntityId: null,
  savingVerdicts: new Set(),
  deletingProjects: new Set(),
  entityCounts:{},
  all:         new Set(),
  active:      new Set(),
  lStyle:      {},
  pi:          0,
};

// ── Colour palette ────────────────────────────────────────────────────────────
const PAL = [
  {bg:"rgba(59,130,246,0.13)",  bd:"rgba(59,130,246,0.68)",  dot:"#3b82f6"},
  {bg:"rgba(239,68,68,0.12)",   bd:"rgba(239,68,68,0.62)",   dot:"#ef4444"},
  {bg:"rgba(16,185,129,0.13)",  bd:"rgba(16,185,129,0.62)",  dot:"#10b981"},
  {bg:"rgba(245,158,11,0.13)",  bd:"rgba(245,158,11,0.68)",  dot:"#f59e0b"},
  {bg:"rgba(139,92,246,0.13)",  bd:"rgba(139,92,246,0.62)",  dot:"#8b5cf6"},
  {bg:"rgba(236,72,153,0.12)",  bd:"rgba(236,72,153,0.62)",  dot:"#ec4899"},
  {bg:"rgba(20,184,166,0.13)",  bd:"rgba(20,184,166,0.62)",  dot:"#14b8a6"},
  {bg:"rgba(249,115,22,0.13)",  bd:"rgba(249,115,22,0.68)",  dot:"#f97316"},
  {bg:"rgba(99,102,241,0.13)",  bd:"rgba(99,102,241,0.62)",  dot:"#6366f1"},
  {bg:"rgba(217,70,239,0.11)",  bd:"rgba(217,70,239,0.58)",  dot:"#d946ef"},
  {bg:"rgba(6,182,212,0.12)",   bd:"rgba(6,182,212,0.62)",   dot:"#06b6d4"},
  {bg:"rgba(132,204,22,0.12)",  bd:"rgba(132,204,22,0.62)",  dot:"#84cc16"},
  {bg:"rgba(251,113,133,0.13)", bd:"rgba(251,113,133,0.68)", dot:"#fb7185"},
  {bg:"rgba(52,211,153,0.13)",  bd:"rgba(52,211,153,0.62)",  dot:"#34d399"},
  {bg:"rgba(251,191,36,0.13)",  bd:"rgba(251,191,36,0.68)",  dot:"#fbbf24"},
];

function getStyle(label) {
  if (!state.lStyle[label]) {
    const s = PAL[state.pi % PAL.length];
    state.lStyle[label] = s; state.pi++;
    const el = document.createElement("style");
    el.textContent = `.entity[data-type="${label.replace(/"/g,'\\"')}"]{ background:${s.bg}; border-bottom-color:${s.bd}; }`;
    document.head.appendChild(el);
  }
  return state.lStyle[label];
}

function esc(s)  { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function escA(s) { return String(s).replace(/"/g,"&quot;"); }

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Check URL params for direct project link (from email invite)
  const params = new URLSearchParams(location.search);
  const pid    = params.get("project");
  const uname  = params.get("user");

  if (pid && uname) {
    state.userName = uname;
    openProject(pid);
  } else {
    showModal();
    loadProjectList();
  }

  // Drag & drop
  let dt;
  document.addEventListener("dragover",  e => { e.preventDefault(); document.body.classList.add("drag-active"); clearTimeout(dt); });
  document.addEventListener("dragleave", () => { dt = setTimeout(() => document.body.classList.remove("drag-active"), 80); });
  document.addEventListener("drop",      e => {
    e.preventDefault(); document.body.classList.remove("drag-active");
    if (e.dataTransfer.files[0]) handleUploadFile(e.dataTransfer.files[0]);
  });

  // Close inline verdict menu when clicking outside entities.
  document.addEventListener("click", e => {
    if (!e.target.closest(".entity")) closeEntityMenu();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeEntityMenu();
  });
});

// ── Modal — project picker ────────────────────────────────────────────────────
function showModal() {
  document.getElementById("modalOverlay").classList.remove("hidden");
  if (state.userName) document.getElementById("userName").value = state.userName;
}
function hideModal() { document.getElementById("modalOverlay").classList.add("hidden"); }

async function loadProjectList() {
  try {
    const res = await fetch(`${API}/projects`);
    const list = await res.json();
    const el = document.getElementById("projectList");
    state.projectNames = {};

    if (!list.length) {
      el.innerHTML = `<div class="no-data">No projects yet — upload a file to create one.</div>`;
      return;
    }

    for (const p of list) state.projectNames[p.id] = p.name;

    el.innerHTML = list.map(p => `
      <div class="project-row" onclick="openProject('${p.id}')">
        <div>
          <div class="project-row-name">${esc(p.name)}</div>
          <div class="project-row-date">${p.created_at.slice(0,10)}</div>
        </div>
        <div class="project-row-actions">
          <button class="btn btn-ghost btn-sm project-open-btn" onclick="event.stopPropagation(); openProject('${p.id}')">Open</button>
          <button class="btn btn-danger-glass btn-sm ${state.deletingProjects.has(p.id) ? 'is-busy' : ''}" ${state.deletingProjects.has(p.id) ? 'disabled' : ''} onclick="event.stopPropagation(); deleteProject('${p.id}')">${state.deletingProjects.has(p.id) ? 'Deleting...' : 'Delete'}</button>
        </div>
      </div>`).join("");
  } catch(e) {
    document.getElementById("projectList").innerHTML =
      `<div class="no-data">⚠️ Cannot reach backend at ${API}</div>`;
  }
}

async function deleteProject(pid) {
  if (state.deletingProjects.has(pid)) return;
  const name = state.projectNames[pid] || "this project";
  const ok = confirm(`Delete "${name}" permanently?\n\nThis will remove all sentences, annotations, and team entries for this project.`);
  if (!ok) return;

  state.deletingProjects.add(pid);
  await loadProjectList();
  document.getElementById("uploadStatus").textContent = `Deleting "${name}"…`;

  try {
    const res = await fetch(`${API}/project/${pid}`, { method:"DELETE" });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);

    if (state.projectId === pid) resetCurrentProjectUI();
    document.getElementById("uploadStatus").textContent = `🗑️ "${name}" deleted`;
  } catch(err) {
    document.getElementById("uploadStatus").textContent = `❌ ${err.message}`;
  } finally {
    state.deletingProjects.delete(pid);
    await loadProjectList();
  }
}

// ── Upload new project ────────────────────────────────────────────────────────
document.getElementById("uploadFileInput").addEventListener("change", e => {
  if (e.target.files[0]) handleUploadFile(e.target.files[0]);
});

async function handleUploadFile(file) {
  const name  = document.getElementById("newProjectName").value.trim() ||
                file.name.replace(/\.[^.]+$/, "");
  const owner = document.getElementById("ownerEmail").value.trim();
  const uname = document.getElementById("userName").value.trim();

  if (!uname) {
    document.getElementById("userName").focus();
    document.getElementById("userName").style.borderColor = "rgba(239,68,68,0.60)";
    return;
  }
  state.userName = uname;

  const fd = new FormData();
  fd.append("file", file);
  fd.append("name", name);
  fd.append("owner_email", owner);

  document.getElementById("uploadStatus").textContent = "Uploading…";
  try {
    const res  = await fetch(`${API}/project/upload`, { method:"POST", body:fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.projectNames[data.project_id] = name;
    state.projectName = name;
    document.getElementById("uploadStatus").textContent = `✅ ${data.record_count} sentences loaded`;
    openProject(data.project_id, name);
  } catch(err) {
    document.getElementById("uploadStatus").textContent = `❌ ${err.message}`;
  }
}

// ── Open project ──────────────────────────────────────────────────────────────
async function openProject(pid, projectName = "") {
  if (projectName) state.projectNames[pid] = projectName;

  state.projectId = pid;
  state.projectName = projectName || state.projectNames[pid] || `Project ${pid.slice(0,8)}`;
  Object.assign(state, {
    sentences:[], annotations:{}, entityCounts:{},
    docsMap:new Map(), entityIndex:new Map(), openEntityId:null, savingVerdicts:new Set(),
    all:new Set(), active:new Set(), lStyle:{}, pi:0, currentDoc:null
  });

  if (!state.userName) {
    const u = prompt("Enter your name to start annotating:");
    if (!u) return;
    state.userName = u.trim();
  }

  hideModal();
  document.getElementById("projectSubtitle").textContent = state.projectName;
  document.getElementById("userPillName").textContent = state.userName;
  document.getElementById("userAvatar").textContent = (state.userName[0] || "?").toUpperCase();
  document.getElementById("userPill").style.display = "flex";
  document.getElementById("statChips").style.display = "flex";

  // load project data
  try {
    const res  = await fetch(`${API}/project/${pid}/data`);
    state.sentences = await res.json();
  } catch(e) {
    alert("Failed to load project data.");
    showModal();
    return;
  }

  // load user's existing annotations
  await refreshAnnotations();

  // aggregate
  for (const sent of state.sentences) {
    for (const ent of sent.entities) {
      const lbl = ent.label;
      state.entityCounts[lbl] = (state.entityCounts[lbl]||0)+1;
      state.all.add(lbl); state.active.add(lbl);
      state.entityIndex.set(ent.id, { entity: ent, sentenceId: sent.id });
    }
  }

  // group by doc
  const docsMap = new Map();
  for (const s of state.sentences) {
    if (!docsMap.has(s.doc_id)) docsMap.set(s.doc_id,[]);
    docsMap.get(s.doc_id).push(s);
  }
  state.docsMap = docsMap;

  updateStats();
  buildDocList();
  buildLegend();

  const firstDoc = [...docsMap.keys()][0];
  if (firstDoc) {
    selectDoc(firstDoc);
  } else {
    document.getElementById("mainTitlebar").style.display = "none";
    document.getElementById("welcomeState").style.display = "flex";
    document.getElementById("sentencePane").innerHTML = `<div class="no-data">This project has no sentences.</div>`;
  }
}

function resetCurrentProjectUI() {
  state.projectId = null;
  state.projectName = "";
  state.currentDoc = null;
  state.currentTab = "annotate";
  state.sentences = [];
  state.docsMap = new Map();
  state.entityIndex = new Map();
  state.annotations = {};
  state.openEntityId = null;
  state.savingVerdicts = new Set();
  state.entityCounts = {};
  state.all = new Set();
  state.active = new Set();
  state.lStyle = {};
  state.pi = 0;

  document.getElementById("projectSubtitle").textContent = "No project open";
  document.getElementById("statChips").style.display = "none";
  document.getElementById("docCountBadge").textContent = "0";
  document.getElementById("docList").innerHTML = "";
  document.getElementById("legendItems").innerHTML = "";
  document.getElementById("legendCard").style.display = "none";
  document.getElementById("mainTitlebar").style.display = "none";
  document.getElementById("sentencePane").innerHTML = "";
  document.getElementById("metricsPanel").innerHTML = "";
  document.getElementById("teamPanel").innerHTML = "";
  document.getElementById("metricsPanel").classList.remove("visible");
  document.getElementById("teamPanel").classList.remove("visible");
  document.getElementById("welcomeState").style.display = "flex";

  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.getAttribute("data-tab") === "annotate"));
}

async function refreshAnnotations() {
  const res  = await fetch(`${API}/project/${state.projectId}/annotations?user=${encodeURIComponent(state.userName)}`);
  const data = await res.json();
  state.annotations = {};
  for (const a of data) {
    if (a.model_entity_id) state.annotations[a.model_entity_id] = { verdict:a.verdict, id:a.id };
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats() {
  const total = state.sentences.length;
  const ents  = Object.values(state.entityCounts).reduce((a,b)=>a+b,0);
  const reviewed = Object.keys(state.annotations).length;
  document.getElementById("sDoc").textContent  = state.docsMap?.size||0;
  document.getElementById("sSent").textContent = total;
  document.getElementById("sEnt").textContent  = ents;
  document.getElementById("sType").textContent = state.all.size;
}

// ── Doc list ──────────────────────────────────────────────────────────────────
function buildDocList() {
  const list = document.getElementById("docList");
  document.getElementById("docCountBadge").textContent = state.docsMap.size;
  list.innerHTML = "";
  for (const [docId, sents] of state.docsMap) {
    const total   = sents.reduce((n,s)=>n+s.entities.length,0);
    const reviewed= sents.reduce((n,s)=>n+s.entities.filter(e=>state.annotations[e.id]).length,0);
    const div = document.createElement("div");
    div.className = "doc-item";
    div.setAttribute("data-doc", docId);
    div.innerHTML = `<div class="doc-pip"></div>
      <div class="doc-item-name" title="${escA(docId)}">${esc(docId)}</div>
      <div class="doc-item-count">${sents.length}</div>`;
    div.onclick = () => selectDoc(docId);
    list.appendChild(div);
  }
}

function selectDoc(docId) {
  state.openEntityId = null;
  state.currentDoc = docId;
  document.querySelectorAll(".doc-item").forEach(el =>
    el.classList.toggle("active", el.getAttribute("data-doc")===docId));

  const sents    = state.docsMap.get(docId)||[];
  const entCount = sents.reduce((n,s)=>n+s.entities.length,0);
  const reviewed = sents.reduce((n,s)=>n+s.entities.filter(e=>state.annotations[e.id]).length,0);

  document.getElementById("mainDocTitle").textContent = docId;
  document.getElementById("mainDocBadge").textContent = `${sents.length} sentences · ${entCount} annotations`;
  document.getElementById("progressChip").textContent = `${reviewed}/${entCount} reviewed`;
  document.getElementById("mainTitlebar").style.display = "flex";
  document.getElementById("welcomeState").style.display = "none";

  showTab("annotate");
  renderSentences(docId);
}

// ── Sentence rendering ────────────────────────────────────────────────────────
function renderSentences(docId) {
  const sents = state.docsMap.get(docId)||[];
  let html = "";
  for (const sent of sents) {
    html += `<div class="sentence-block">
      ${sent.sent_id ? `<div class="sent-id">${esc(sent.sent_id)}</div>` : ""}
      <span>${buildSentenceHTML(sent)}</span>
    </div>`;
  }
  document.getElementById("sentencePane").innerHTML = html;
  document.getElementById("mainScroll").scrollTop = 0;
  updateVis();
}

function buildSentenceHTML(sent) {
  const text = sent.text;
  const ents = [...sent.entities].sort((a,b)=>(a.start_char||0)-(b.start_char||0));
  if (!ents.length) return esc(text);

  let html = "", cur = 0;
  for (const ent of ents) {
    const start = ent.start_char != null ? ent.start_char : text.indexOf(ent.span_text);
    const end   = ent.end_char   != null ? ent.end_char   : start + ent.span_text.length;
    if (start < 0 || start < cur) continue;
    if (start > cur) html += esc(text.slice(cur, start));
    html += buildEntitySpan(ent);
    cur = end;
  }
  if (cur < text.length) html += esc(text.slice(cur));
  return html;
}

function buildEntitySpan(ent) {
  const s         = getStyle(ent.label);
  const verdict   = state.annotations[ent.id]?.verdict || "none";
  const isOpen    = state.openEntityId === ent.id;
  const isSaving  = state.savingVerdicts.has(ent.id);
  const entId     = escA(ent.id);
  const lbl       = escA(ent.label);
  const span_text = esc(ent.span_text);

  return `<span class="entity verdict-${verdict} ${isOpen ? 'menu-open' : ''}" data-type="${lbl}" data-eid="${entId}" onclick="toggleEntityMenu('${entId}',event)">
    ${span_text}
    <span class="verdict-bar ${isSaving ? 'is-saving' : ''}" onclick="event.stopPropagation()">
      <span class="verdict-label">${lbl}</span>
      <button class="vbtn vbtn-tp ${verdict==='tp'?'active':''}" ${isSaving ? 'disabled' : ''} onclick="setVerdict('${entId}','tp',event)">✓ TP</button>
      <button class="vbtn vbtn-fp ${verdict==='fp'?'active':''}" ${isSaving ? 'disabled' : ''} onclick="setVerdict('${entId}','fp',event)">✗ FP</button>
      <button class="vbtn vbtn-clear ${verdict==='none'?'active':''}" ${isSaving ? 'disabled' : ''} onclick="setVerdict('${entId}','clear',event)">–</button>
      ${isSaving ? '<span class="verdict-saving">Saving...</span>' : ''}
    </span>
  </span>`;
}

function toggleEntityMenu(entId, ev) {
  ev.stopPropagation();
  const prev = state.openEntityId;
  state.openEntityId = (prev === entId) ? null : entId;
  if (prev && prev !== entId) rerenderEntity(prev);
  rerenderEntity(entId);
}

function closeEntityMenu() {
  if (!state.openEntityId) return;
  const prev = state.openEntityId;
  state.openEntityId = null;
  rerenderEntity(prev);
}

// ── Verdict ───────────────────────────────────────────────────────────────────
async function setVerdict(entId, verdict, ev) {
  ev.stopPropagation();

  if (!state.projectId || !state.userName) return;
  if (state.savingVerdicts.has(entId)) return;

  const ref = state.entityIndex.get(entId);
  if (!ref) return;

  const current = state.annotations[entId]?.verdict || "none";
  const nextVerdict = (verdict === "clear" || verdict === current) ? "clear" : verdict;
  const previous = state.annotations[entId] ? { ...state.annotations[entId] } : null;

  if (nextVerdict === "clear") {
    delete state.annotations[entId];
  } else {
    state.annotations[entId] = { ...(state.annotations[entId] || {}), verdict: nextVerdict };
  }
  state.savingVerdicts.add(entId);
  rerenderEntity(entId);
  updateProgressChip();

  try {
    const res = await fetch(`${API}/project/${state.projectId}/annotate`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        user_name:       state.userName,
        sentence_id:     ref.sentenceId,
        model_entity_id: entId,
        verdict:         nextVerdict
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);

    if (nextVerdict !== "clear") {
      state.annotations[entId] = { verdict: nextVerdict, id: data.annotation_id || state.annotations[entId]?.id };
    }
  } catch (err) {
    if (previous) state.annotations[entId] = previous;
    else delete state.annotations[entId];
    alert(`Could not save verdict: ${err.message}`);
  } finally {
    state.savingVerdicts.delete(entId);
    if (state.openEntityId === entId) state.openEntityId = null;
    rerenderEntity(entId);
    updateProgressChip();
  }
}

function rerenderEntity(entId) {
  const el = document.querySelector(`.entity[data-eid="${entId}"]`);
  const ref = state.entityIndex.get(entId);
  if (!el || !ref) return;
  const tmp = document.createElement("span");
  tmp.innerHTML = buildEntitySpan(ref.entity);
  el.replaceWith(tmp.firstChild);
}

function updateProgressChip() {
  if (state.currentDoc) {
    const sents    = state.docsMap.get(state.currentDoc)||[];
    const entCount = sents.reduce((n,s)=>n+s.entities.length,0);
    const reviewed = sents.reduce((n,s)=>n+s.entities.filter(e=>state.annotations[e.id]).length,0);
    document.getElementById("progressChip").textContent = `${reviewed}/${entCount} reviewed`;
  }
}

// ── Legend ────────────────────────────────────────────────────────────────────
function buildLegend() {
  document.getElementById("legendCard").style.display = "block";
  const sorted = [...state.all].sort((a,b)=>(state.entityCounts[b]||0)-(state.entityCounts[a]||0));
  document.getElementById("legendItems").innerHTML = sorted.map(type => {
    const s = getStyle(type);
    return `<div class="legend-tag active" data-type="${escA(type)}"
              style="background:${s.bg};border-color:${s.bd}"
              onclick="toggleLabel('${escA(type)}')">
      <div class="legend-dot" style="background:${s.dot}"></div>
      <span>${esc(type)}</span>
      <span style="opacity:0.40;font-size:10px;margin-left:2px">${state.entityCounts[type]||0}</span>
    </div>`;
  }).join("");
}

function toggleLabel(t) {
  if (state.active.has(t)) state.active.delete(t); else state.active.add(t);
  updateVis();
}
function selectAllLabels()   { state.active = new Set(state.all); updateVis(); }
function deselectAllLabels() { state.active.clear(); updateVis(); }

function updateVis() {
  document.querySelectorAll(".entity").forEach(el =>
    el.classList.toggle("filtered-out", !state.active.has(el.getAttribute("data-type"))));
  document.querySelectorAll(".legend-tag").forEach(el => {
    const t = el.getAttribute("data-type");
    el.classList.toggle("active",   state.active.has(t));
    el.classList.toggle("inactive", !state.active.has(t));
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.getAttribute("data-tab")===tab));
  document.getElementById("sentencePane").style.display    = tab==="annotate" ? "" : "none";
  document.getElementById("metricsPanel").classList.toggle("visible", tab==="metrics");
  document.getElementById("teamPanel").classList.toggle("visible",   tab==="team");
  if (tab==="metrics") loadMetrics();
  if (tab==="team")    loadTeam();
}

// ── Metrics panel ─────────────────────────────────────────────────────────────
async function loadMetrics() {
  if (!state.projectId) return;
  const panel = document.getElementById("metricsPanel");
  panel.innerHTML = `<div class="no-data">Loading metrics…</div>`;

  try {
    const res  = await fetch(`${API}/project/${state.projectId}/metrics`);
    const data = await res.json();
    if (!Object.keys(data).length) {
      panel.innerHTML = `<div class="no-data">No annotations yet — review some entities first.</div>`;
      return;
    }
    renderMetrics(data);
  } catch(e) {
    panel.innerHTML = `<div class="no-data">⚠️ Could not load metrics.</div>`;
  }
}

function renderMetrics(data) {
  const users   = Object.keys(data);
  let activeUser = users.includes(state.userName) ? state.userName : users[0];
  const panel   = document.getElementById("metricsPanel");

  function render(u) {
    const ud = data[u];
    const m  = ud.micro;
    const userTabs = users.map(uu =>
      `<button class="user-tab ${uu===u?'active':''}" onclick="renderMetricsForUser('${uu}')">${esc(uu)}</button>`
    ).join("");

    const rows = Object.entries(ud.per_label)
      .sort((a,b) => b[1].tp - a[1].tp)
      .map(([lbl,c]) => {
        const s = getStyle(lbl);
        return `<tr>
          <td><span style="display:inline-flex;align-items:center;gap:6px">
            <span style="width:8px;height:8px;border-radius:50%;background:${s.dot};display:inline-block"></span>
            ${esc(lbl)}</span></td>
          <td class="num"><span class="tp-chip">${c.tp}</span></td>
          <td class="num"><span class="fp-chip">${c.fp}</span></td>
          <td class="num"><span class="fn-chip">${c.fn}</span></td>
          <td class="num">${pct(c.precision)}</td>
          <td class="num">${pct(c.recall)}</td>
          <td class="num">
            <div class="f1-bar">
              ${pct(c.f1)}
              <div class="f1-track"><div class="f1-fill" style="width:${Math.round(c.f1*100)}%"></div></div>
            </div>
          </td>
        </tr>`;
      }).join("");

    panel.innerHTML = `
      <div class="metrics-user-tabs" id="metricsTabs">${userTabs}</div>
      <div class="micro-cards">
        <div class="micro-card">
          <div class="micro-val" style="color:#10b981">${pct(m.precision)}</div>
          <div class="micro-lbl">Micro Precision</div>
          <div class="micro-sub">TP=${m.tp} / FP=${m.fp}</div>
        </div>
        <div class="micro-card">
          <div class="micro-val" style="color:#3a7bd5">${pct(m.recall)}</div>
          <div class="micro-lbl">Micro Recall</div>
          <div class="micro-sub">TP=${m.tp} / FN=${m.fn}</div>
        </div>
        <div class="micro-card">
          <div class="micro-val" style="color:#8b5cf6">${pct(m.f1)}</div>
          <div class="micro-lbl">Micro F1</div>
          <div class="micro-sub">Macro F1=${pct(data[u].macro.f1)}</div>
        </div>
        <div class="micro-card">
          <div class="micro-val">${m.tp+m.fp+m.fn}</div>
          <div class="micro-lbl">Total Reviewed</div>
          <div class="micro-sub">${m.tp} TP · ${m.fp} FP · ${m.fn} FN</div>
        </div>
      </div>
      <table class="metrics-table">
        <thead>
          <tr>
            <th>Label</th>
            <th class="num">TP</th>
            <th class="num">FP</th>
            <th class="num">FN</th>
            <th class="num">Precision</th>
            <th class="num">Recall</th>
            <th class="num">F1</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    // wire up user tabs
    document.querySelectorAll(".user-tab").forEach(b =>
      b.onclick = () => render(b.textContent));
  }

  window.renderMetricsForUser = render;
  render(activeUser);
}

function pct(v) { return v != null ? (v*100).toFixed(1)+"%" : "—"; }

// ── Team panel ────────────────────────────────────────────────────────────────
async function loadTeam() {
  if (!state.projectId) return;
  const panel = document.getElementById("teamPanel");
  panel.innerHTML = `<div class="no-data">Loading…</div>`;

  try {
    const [usersRes, annRes] = await Promise.all([
      fetch(`${API}/project/${state.projectId}/users`),
      fetch(`${API}/project/${state.projectId}/metrics`)
    ]);
    const users   = await usersRes.json();
    const metrics = await annRes.json();

    const members = users.map(u => {
      const mc = metrics[u.name]?.micro;
      return `<div class="team-member">
        <div class="team-avatar">${esc(u.name.slice(0,1).toUpperCase())}</div>
        <div>
          <div class="team-name">${esc(u.name)}</div>
          <div class="team-email">${esc(u.email)}</div>
        </div>
        <div class="team-stats">
          <div class="team-ann-count">${mc ? mc.tp+mc.fp : 0}</div>
          <div class="team-ann-sub">annotations</div>
        </div>
      </div>`;
    }).join("") || `<div class="no-data">No team members yet.</div>`;

    panel.innerHTML = `
      <div class="team-grid">${members}</div>
      <div class="invite-form">
        <h4>Invite collaborator</h4>
        <div class="invite-row">
          <input class="invite-input" id="inviteEmail" type="email" placeholder="colleague@email.com">
          <input class="invite-input" id="inviteName"  type="text"  placeholder="Name" style="max-width:120px">
          <button class="btn btn-primary btn-sm" onclick="sendInvite()">Send</button>
        </div>
        <div id="inviteResult"></div>
      </div>`;
  } catch(e) {
    panel.innerHTML = `<div class="no-data">⚠️ Could not load team data.</div>`;
  }
}

async function sendInvite() {
  const email = document.getElementById("inviteEmail").value.trim();
  const name  = document.getElementById("inviteName").value.trim() || email.split("@")[0];
  if (!email) return;
  document.getElementById("inviteResult").textContent = "Sending…";
  try {
    const res  = await fetch(`${API}/project/${state.projectId}/invite`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({email, name})
    });
    const data = await res.json();
    const el   = document.getElementById("inviteResult");
    if (data.ok) {
      el.innerHTML = `<div class="invite-link-box">✅ Invite sent! Link: <a href="${data.link}" target="_blank">${data.link}</a></div>`;
    } else {
      el.innerHTML = `<div class="invite-link-box">⚠️ ${data.error || "Email failed"}<br>Share this link manually:<br><a href="${data.link}" target="_blank">${data.link}</a></div>`;
    }
  } catch(e) {
    document.getElementById("inviteResult").textContent = `❌ ${e.message}`;
  }
}