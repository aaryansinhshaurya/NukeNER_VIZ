"""
NukeNER_VIZ — Backend
==================================
Flask + SQLite REST API.

Endpoints:
  POST /api/project/upload        — upload CSV or JSON, creates a project
  GET  /api/projects              — list all projects
  GET  /api/project/<id>/data     — get all sentences + entities for a project
  GET  /api/project/<id>/annotations?user=X  — get user's annotations
  POST /api/project/<id>/annotate — save/update a single annotation
  GET  /api/project/<id>/metrics  — compute per-class TP/FP/FN/P/R/F1 per user
  POST /api/project/<id>/invite   — send email invite to collaborator (SMTP)
  GET  /api/project/<id>/users    — list users who have annotated

Run:
  pip install flask flask-cors
  python server.py
"""

import os, json, csv, io, re, sqlite3, uuid, smtplib, hashlib
from datetime import datetime
from email.mime.text import MIMEText
from flask import Flask, request, jsonify, g
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["https://nuke-ner-viz.vercel.app"])  # allow frontend on any origin during dev

DB_PATH = os.path.join(os.path.dirname(__file__), "nukener_viz.db")

# ── SMTP config (edit or set as env vars) ────────────────────────────────────
SMTP_HOST     = os.environ.get("SMTP_HOST",     "smtp.gmail.com")
SMTP_PORT     = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER     = os.environ.get("SMTP_USER",     "your@gmail.com")
SMTP_PASS     = os.environ.get("SMTP_PASS",     "your_app_password")
APP_BASE_URL  = os.environ.get("APP_BASE_URL",  "http://localhost:5000")

# ── DB helpers ────────────────────────────────────────────────────────────────

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop("db", None)
    if db: db.close()

def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        owner_email TEXT
    );

    CREATE TABLE IF NOT EXISTS sentences (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        doc_id      TEXT NOT NULL,
        sent_id     TEXT NOT NULL,
        text        TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS model_entities (
        id          TEXT PRIMARY KEY,
        sentence_id TEXT NOT NULL,
        project_id  TEXT NOT NULL,
        span_text   TEXT NOT NULL,
        label       TEXT NOT NULL,
        start_char  INTEGER,
        end_char    INTEGER,
        FOREIGN KEY(sentence_id) REFERENCES sentences(id)
    );

    -- Human annotations: each (user, model_entity) pair is one row
    -- verdict: 'tp' | 'fp'
    -- For FN: rows with no model_entity_id (user manually added a missed span)
    CREATE TABLE IF NOT EXISTS annotations (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        sentence_id      TEXT NOT NULL,
        model_entity_id  TEXT,          -- NULL for user-added FN spans
        user_name        TEXT NOT NULL,
        verdict          TEXT NOT NULL, -- 'tp' | 'fp' | 'fn'
        span_text        TEXT,          -- for FN spans added by user
        label            TEXT,          -- for FN spans added by user
        created_at       TEXT NOT NULL,
        UNIQUE(model_entity_id, user_name),
        FOREIGN KEY(project_id)      REFERENCES projects(id),
        FOREIGN KEY(sentence_id)     REFERENCES sentences(id),
        FOREIGN KEY(model_entity_id) REFERENCES model_entities(id)
    );

    CREATE TABLE IF NOT EXISTS project_users (
        project_id  TEXT NOT NULL,
        email       TEXT NOT NULL,
        name        TEXT NOT NULL,
        invite_token TEXT,
        joined_at   TEXT,
        PRIMARY KEY(project_id, email),
        FOREIGN KEY(project_id) REFERENCES projects(id)
    );
    """)
    db.commit()
    db.close()

# ── CSV / JSON parsers (mirrors frontend logic) ───────────────────────────────

def parse_entities_field(raw):
    """Parse the entities column — Python-style or JSON list of dicts."""
    if not raw or raw.strip() in ("", "[]"):
        return []
    j = raw.replace("'", '"').replace("None", "null").replace("True", "true").replace("False", "false")
    try:
        ents = json.loads(j)
    except Exception:
        # regex fallback
        ents = []
        for m in re.finditer(r'\{[^{}]*?"?text"?\s*:\s*"([^"]+)"[^{}]*?"?label"?\s*:\s*"([^"]+)"', j):
            ents.append({"text": m.group(1), "label": m.group(2)})
    return [{"text": e.get("text",""), "label": e.get("label","")} for e in ents if e.get("text") and e.get("label")]

def normalise_ents(arr):
    out = []
    for e in arr:
        text  = e.get("text")  or e.get("word")  or e.get("span")  or e.get("mention","")
        label = e.get("label") or e.get("entity_group") or e.get("type") or e.get("tag","")
        if text and label:
            out.append({"text": text, "label": label})
    return out

def records_from_csv(content: str):
    reader = csv.DictReader(io.StringIO(content))
    records = []
    # case-insensitive header lookup
    for row in reader:
        low = {k.lower().strip(): v for k,v in row.items()}
        doc_id   = low.get("doc_id","Document")
        sent_id  = low.get("sentence_id","")
        text     = low.get("sentence","")
        ents_raw = low.get("entities","")
        if not text:
            continue
        records.append({"doc_id": doc_id, "sent_id": sent_id,
                         "text": text, "ents": parse_entities_field(ents_raw)})
    return records

def records_from_json(content: str):
    raw = json.loads(content)
    records = []
    if isinstance(raw, list):
        for item in raw:
            if "sentences" in item and isinstance(item["sentences"], list):
                doc_id = item.get("doc_id") or item.get("id","Document")
                for s in item["sentences"]:
                    records.append({"doc_id": doc_id,
                                    "sent_id": s.get("sentence_id") or s.get("id",""),
                                    "text":    s.get("sentence") or s.get("text",""),
                                    "ents":    normalise_ents(s.get("entities") or s.get("ents",[]))})
            else:
                records.append({"doc_id":  item.get("doc_id") or item.get("document","Document"),
                                 "sent_id": item.get("sentence_id") or item.get("id",""),
                                 "text":    item.get("sentence") or item.get("text",""),
                                 "ents":    normalise_ents(item.get("entities") or item.get("ents",[]))})
    elif isinstance(raw, dict):
        for doc_id, sent_map in raw.items():
            if isinstance(sent_map, dict):
                for sent_id, sent_obj in sent_map.items():
                    if isinstance(sent_obj, dict):
                        records.append({"doc_id": doc_id, "sent_id": sent_id,
                                         "text":  sent_obj.get("sentence") or sent_obj.get("text",""),
                                         "ents":  normalise_ents(sent_obj.get("entities") or sent_obj.get("ents",[]))})
    return records

# ── find char offsets for entity spans ───────────────────────────────────────

def find_offsets(text, span_text):
    idx = text.find(span_text)
    if idx == -1:
        return None, None
    return idx, idx + len(span_text)

# ─────────────────────────────────────────────────────────────────────────────
# API routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/projects", methods=["GET"])
def list_projects():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, created_at, owner_email FROM projects ORDER BY created_at DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/project/<pid>", methods=["DELETE"])
def delete_project(pid):
    """Delete a project and all related records."""
    db = get_db()
    exists = db.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone()
    if not exists:
        return jsonify({"error": "Project not found"}), 404

    db.execute("DELETE FROM annotations   WHERE project_id=?", (pid,))
    db.execute("DELETE FROM model_entities WHERE project_id=?", (pid,))
    db.execute("DELETE FROM sentences     WHERE project_id=?", (pid,))
    db.execute("DELETE FROM project_users WHERE project_id=?", (pid,))
    db.execute("DELETE FROM projects      WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True, "project_id": pid})


@app.route("/api/project/upload", methods=["POST"])
def upload_project():
    db = get_db()
    file     = request.files.get("file")
    name     = request.form.get("name", "Untitled Project")
    owner    = request.form.get("owner_email", "")

    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    content  = file.read().decode("utf-8", errors="replace").strip()
    filename = file.filename.lower()

    try:
        if filename.endswith(".json") or content.startswith("{") or content.startswith("["):
            records = records_from_json(content)
        else:
            records = records_from_csv(content)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400

    if not records:
        return jsonify({"error": "No records parsed from file"}), 400

    project_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()

    db.execute("INSERT INTO projects VALUES (?,?,?,?)", (project_id, name, now, owner))

    for rec in records:
        sent_pk = str(uuid.uuid4())
        db.execute("INSERT INTO sentences VALUES (?,?,?,?,?)",
                   (sent_pk, project_id, rec["doc_id"], rec["sent_id"], rec["text"]))
        for ent in rec["ents"]:
            start, end = find_offsets(rec["text"], ent["text"])
            db.execute("INSERT INTO model_entities VALUES (?,?,?,?,?,?,?)",
                       (str(uuid.uuid4()), sent_pk, project_id,
                        ent["text"], ent["label"], start, end))

    # add owner as first user
    if owner:
        name_part = owner.split("@")[0]
        db.execute("INSERT OR IGNORE INTO project_users VALUES (?,?,?,?,?)",
                   (project_id, owner, name_part, None, now))

    db.commit()
    return jsonify({"project_id": project_id, "record_count": len(records)})


@app.route("/api/project/<pid>/data", methods=["GET"])
def project_data(pid):
    db = get_db()
    sents = db.execute(
        "SELECT id,doc_id,sent_id,text FROM sentences WHERE project_id=? ORDER BY rowid",
        (pid,)
    ).fetchall()

    result = []
    for s in sents:
        ents = db.execute(
            "SELECT id,span_text,label,start_char,end_char FROM model_entities WHERE sentence_id=?",
            (s["id"],)
        ).fetchall()
        result.append({
            "id":     s["id"],
            "doc_id": s["doc_id"],
            "sent_id":s["sent_id"],
            "text":   s["text"],
            "entities": [dict(e) for e in ents]
        })
    return jsonify(result)


@app.route("/api/project/<pid>/annotations", methods=["GET"])
def get_annotations(pid):
    user = request.args.get("user","")
    db   = get_db()
    rows = db.execute(
        "SELECT id,sentence_id,model_entity_id,user_name,verdict,span_text,label,created_at "
        "FROM annotations WHERE project_id=? AND user_name=?",
        (pid, user)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/project/<pid>/annotate", methods=["POST"])
def annotate(pid):
    data   = request.json or {}
    user   = data.get("user_name","")
    sent_id= data.get("sentence_id","")
    ent_id = data.get("model_entity_id")   # None for FN
    verdict= data.get("verdict","tp")      # 'tp' | 'fp' | 'fn' | 'clear'
    span   = data.get("span_text","")
    label  = data.get("label","")

    if not user or not sent_id:
        return jsonify({"error": "user_name and sentence_id required"}), 400

    if verdict not in ("tp", "fp", "fn", "clear"):
        return jsonify({"error": "verdict must be one of: tp, fp, fn, clear"}), 400

    if verdict == "clear" and not ent_id:
        return jsonify({"error": "model_entity_id required for clear verdict"}), 400

    db  = get_db()
    now = datetime.utcnow().isoformat()
    ann_id = str(uuid.uuid4())

    if ent_id and verdict == "clear":
        cur = db.execute(
            "DELETE FROM annotations WHERE project_id=? AND model_entity_id=? AND user_name=?",
            (pid, ent_id, user)
        )
        db.commit()
        return jsonify({"ok": True, "cleared": cur.rowcount > 0})

    if ent_id:
        # upsert: on conflict (model_entity_id, user_name) update verdict
        db.execute("""
            INSERT INTO annotations(id,project_id,sentence_id,model_entity_id,user_name,verdict,span_text,label,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(model_entity_id,user_name) DO UPDATE SET verdict=excluded.verdict, created_at=excluded.created_at
        """, (ann_id, pid, sent_id, ent_id, user, verdict, span, label, now))
    else:
        # FN span added by user — no conflict key on model_entity_id (NULL)
        db.execute("""
            INSERT INTO annotations(id,project_id,sentence_id,model_entity_id,user_name,verdict,span_text,label,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)
        """, (ann_id, pid, sent_id, None, user, verdict, span, label, now))

    # ensure user is registered
    email_guess = f"{user}@project"
    db.execute("INSERT OR IGNORE INTO project_users VALUES(?,?,?,?,?)",
               (pid, email_guess, user, None, now))

    db.commit()
    return jsonify({"ok": True, "annotation_id": ann_id})


@app.route("/api/project/<pid>/metrics", methods=["GET"])
def metrics(pid):
    """
    For each (user, label):
      TP = model predicted AND user said 'tp'
      FP = model predicted AND user said 'fp'
      FN = model predicted but user left no annotation (implicit miss)
           + user-added FN spans
    Precision = TP / (TP+FP)
    Recall    = TP / (TP+FN)
    F1        = 2*P*R / (P+R)
    """
    user_filter = request.args.get("user")   # optional single-user filter
    db = get_db()

    # all model entities for this project
    model_ents = db.execute(
        "SELECT id, label FROM model_entities WHERE project_id=?", (pid,)
    ).fetchall()

    # all annotations for this project
    ann_q = "SELECT model_entity_id,user_name,verdict,label FROM annotations WHERE project_id=?"
    ann_params = [pid]
    if user_filter:
        ann_q += " AND user_name=?"
        ann_params.append(user_filter)
    anns = db.execute(ann_q, ann_params).fetchall()

    # build lookup: (entity_id, user) → verdict
    ann_map = {}
    for a in anns:
        ann_map[(a["model_entity_id"], a["user_name"])] = a["verdict"]

    # all users who have annotated
    users_q = "SELECT DISTINCT user_name FROM annotations WHERE project_id=?"
    users_params = [pid]
    if user_filter:
        users_q += " AND user_name=?"
        users_params.append(user_filter)
    users = [r["user_name"] for r in db.execute(users_q, users_params).fetchall()]

    result = {}
    for u in users:
        counts = {}  # label → {tp,fp,fn}
        for ent in model_ents:
            lbl = ent["label"]
            if lbl not in counts:
                counts[lbl] = {"tp":0,"fp":0,"fn":0}
            verdict = ann_map.get((ent["id"], u))
            if verdict == "tp":
                counts[lbl]["tp"] += 1
            elif verdict == "fp":
                counts[lbl]["fp"] += 1
            else:
                # no annotation = not reviewed yet; treat as unreviewed (skip)
                pass

        # add user-annotated FNs
        fn_rows = db.execute(
            "SELECT label FROM annotations WHERE project_id=? AND user_name=? AND verdict='fn'",
            (pid, u)
        ).fetchall()
        for fn in fn_rows:
            lbl = fn["label"] or "Unknown"
            if lbl not in counts: counts[lbl] = {"tp":0,"fp":0,"fn":0}
            counts[lbl]["fn"] += 1

        # compute metrics
        per_label = {}
        macro_p, macro_r, macro_f1, n_labels = 0,0,0,0
        for lbl, c in counts.items():
            tp,fp,fn = c["tp"],c["fp"],c["fn"]
            p  = tp/(tp+fp) if (tp+fp) > 0 else 0.0
            r  = tp/(tp+fn) if (tp+fn) > 0 else 0.0
            f1 = 2*p*r/(p+r) if (p+r) > 0 else 0.0
            per_label[lbl] = {"tp":tp,"fp":fp,"fn":fn,
                               "precision":round(p,4),"recall":round(r,4),"f1":round(f1,4)}
            macro_p += p; macro_r += r; macro_f1 += f1; n_labels += 1

        total_tp = sum(c["tp"] for c in counts.values())
        total_fp = sum(c["fp"] for c in counts.values())
        total_fn = sum(c["fn"] for c in counts.values())
        micro_p  = total_tp/(total_tp+total_fp) if (total_tp+total_fp) > 0 else 0
        micro_r  = total_tp/(total_tp+total_fn) if (total_tp+total_fn) > 0 else 0
        micro_f1 = 2*micro_p*micro_r/(micro_p+micro_r) if (micro_p+micro_r) > 0 else 0

        result[u] = {
            "per_label": per_label,
            "macro": {
                "precision": round(macro_p/n_labels,4) if n_labels else 0,
                "recall":    round(macro_r/n_labels,4) if n_labels else 0,
                "f1":        round(macro_f1/n_labels,4) if n_labels else 0,
            },
            "micro": {
                "precision": round(micro_p,4),
                "recall":    round(micro_r,4),
                "f1":        round(micro_f1,4),
                "tp": total_tp, "fp": total_fp, "fn": total_fn
            }
        }

    return jsonify(result)


@app.route("/api/project/<pid>/users", methods=["GET"])
def project_users(pid):
    db   = get_db()
    rows = db.execute(
        "SELECT email,name,joined_at FROM project_users WHERE project_id=?", (pid,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/project/<pid>/invite", methods=["POST"])
def invite_user(pid):
    """Send an email invite with a direct link to the project."""
    data  = request.json or {}
    email = data.get("email","")
    uname = data.get("name", email.split("@")[0])
    if not email:
        return jsonify({"error": "email required"}), 400

    token = hashlib.sha256(f"{pid}{email}{uuid.uuid4()}".encode()).hexdigest()[:16]
    db = get_db()
    db.execute("INSERT OR REPLACE INTO project_users VALUES(?,?,?,?,?)",
               (pid, email, uname, token, None))
    db.commit()

    link = f"{APP_BASE_URL}?project={pid}&user={uname}&token={token}"

    # If default placeholder credentials are still configured, skip SMTP attempt.
    if SMTP_USER == "your@gmail.com" or SMTP_PASS == "your_app_password":
        return jsonify({
            "ok": False,
            "link": link,
            "error": "SMTP credentials are not configured.",
            "note": "Set SMTP_USER and SMTP_PASS (Gmail App Password) and restart backend. Link is valid to share manually."
        })

    body = f"""Hi {uname},

You've been invited to collaborate on a NukeNER_VIZ annotation project.

Click the link below to open your annotation workspace:
{link}

When you open the link, enter your name ({uname}) in the user field and start reviewing entities.

—NukeNER_VIZ
"""
    try:
        msg = MIMEText(body)
        msg["Subject"] = f"NukeNER_VIZ — Project Invite"
        msg["From"]    = SMTP_USER
        msg["To"]      = email
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_USER, email, msg.as_string())
        return jsonify({"ok": True, "link": link})
    except Exception as ex:
        # Return the link even if email fails, so you can share it manually
        err = str(ex)
        note = "Email failed but link is valid — share it manually"
        if "BadCredentials" in err or "5.7.8" in err:
            note = "Gmail rejected login. Use SMTP_USER as your Gmail address and SMTP_PASS as a 16-char Google App Password (not normal Gmail password)."
        return jsonify({"ok": False, "error": err, "link": link, "note": note})


@app.route("/api/project/<pid>/export", methods=["GET"])
def export_annotations(pid):
    """Export all annotations as JSON for offline analysis."""
    user = request.args.get("user")
    db   = get_db()
    q    = "SELECT * FROM annotations WHERE project_id=?"
    p    = [pid]
    if user:
        q += " AND user_name=?"; p.append(user)
    rows = db.execute(q, p).fetchall()
    return jsonify([dict(r) for r in rows])


# ── Serve frontend (optional — remove if using a separate static server) ──────
@app.route("/")
def serve_index():
    frontend = os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html")
    if os.path.exists(frontend):
        with open(frontend, encoding="utf-8") as f:
            return f.read(), 200, {"Content-Type": "text/html"}
    return "Frontend not found. Serve the /frontend folder separately.", 404


if __name__ == "__main__":
    init_db()
    print("✅  DB initialised:", DB_PATH)
    print("🚀  Starting server on http://localhost:5000")
    app.run(debug=True, port=5000)
