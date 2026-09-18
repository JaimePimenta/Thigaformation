#!/usr/bin/env python3
"""Todo partagée PM/POs — serveur local, bibliothèque standard uniquement.

Lancer avec: python3 server.py
Puis ouvrir http://localhost:8765
"""

import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_PATH = os.path.join(BASE_DIR, "config", "users.json")
TASKS_PATH = os.path.join(BASE_DIR, "data", "tasks.json")
COMMENTS_PATH = os.path.join(BASE_DIR, "data", "comments.json")
ACTIVITY_PATH = os.path.join(BASE_DIR, "data", "activity.json")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
COOKIE_NAME = "pm_todo_user"
PRIORITIES = ("low", "medium", "high", "urgent")

STATIC_FILES = {
    "/app.js": ("application/javascript", "app.js"),
    "/styles.css": ("text/css", "styles.css"),
}


def load_users():
    with open(USERS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def find_user(user_id):
    return next((u for u in load_users() if u["id"] == user_id), None)


def load_tasks():
    with open(TASKS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_tasks(tasks):
    with open(TASKS_PATH, "w", encoding="utf-8") as f:
        json.dump(tasks, f, indent=2, ensure_ascii=False)


def load_comments():
    with open(COMMENTS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_comments(comments):
    with open(COMMENTS_PATH, "w", encoding="utf-8") as f:
        json.dump(comments, f, indent=2, ensure_ascii=False)


def load_activity():
    with open(ACTIVITY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_activity(activity):
    with open(ACTIVITY_PATH, "w", encoding="utf-8") as f:
        json.dump(activity, f, indent=2, ensure_ascii=False)


def log_activity(task_id, user_id, action, details=None):
    activity = load_activity()
    activity.append({
        "id": str(uuid.uuid4()),
        "taskId": task_id,
        "userId": user_id,
        "action": action,
        "details": details,
        "at": now_iso(),
    })
    save_activity(activity)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def can_view(user, space, owner_id):
    if space == "team":
        return True
    if space in ("personal", "private"):
        return user["id"] == owner_id or user["role"] == "pm"
    return False


def can_edit(user, space, owner_id):
    if space == "team":
        return True
    if space == "personal":
        return user["id"] == owner_id
    if space == "private":
        return user["id"] == owner_id or user["role"] == "pm"
    return False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # silence default request logging

    # ---------- helpers ----------

    def get_current_user(self):
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(COOKIE_NAME)
        if not morsel:
            return None
        return find_user(morsel.value)

    def send_json(self, data, status=200, set_cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status=status)

    def send_file(self, relative_path, content_type):
        full_path = os.path.join(PUBLIC_DIR, relative_path)
        if not os.path.isfile(full_path):
            self.send_error_json(404, "Not found")
            return
        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # ---------- routing ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/":
            self.send_file("index.html", "text/html")
            return
        if path == "/dashboard":
            self.send_file("dashboard.html", "text/html")
            return
        if path in STATIC_FILES:
            content_type, filename = STATIC_FILES[path]
            self.send_file(filename, content_type)
            return

        if path == "/api/users":
            self.send_json({"users": load_users()})
            return
        if path == "/api/me":
            self.handle_api_me()
            return
        if path == "/api/tasks":
            self.handle_get_tasks(query)
            return
        if path == "/api/overview":
            self.handle_get_overview()
            return
        if path.startswith("/api/tasks/"):
            rest = path[len("/api/tasks/"):]
            if rest.endswith("/comments"):
                self.handle_get_comments(rest[: -len("/comments")])
                return
            if rest.endswith("/activity"):
                self.handle_get_activity(rest[: -len("/activity")])
                return
            self.handle_get_task(rest)
            return

        self.send_error_json(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/session":
            self.handle_post_session()
            return
        if path == "/api/tasks":
            self.handle_post_task()
            return
        if path.startswith("/api/tasks/") and path.endswith("/comments"):
            task_id = path[len("/api/tasks/"): -len("/comments")]
            self.handle_post_comment(task_id)
            return

        self.send_error_json(404, "Not found")

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/tasks/"):
            task_id = path.split("/api/tasks/", 1)[1]
            self.handle_patch_task(task_id)
            return
        self.send_error_json(404, "Not found")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/tasks/"):
            task_id = path.split("/api/tasks/", 1)[1]
            self.handle_delete_task(task_id)
            return
        self.send_error_json(404, "Not found")

    # ---------- API handlers ----------

    def handle_api_me(self):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        users = load_users()
        pos = [u for u in users if u["role"] == "po"]
        self.send_json({"user": user, "pos": pos})

    def handle_post_session(self):
        body = self.read_json_body()
        user_id = body.get("userId")
        user = find_user(user_id)
        if not user:
            self.send_error_json(400, "Utilisateur inconnu")
            return
        cookie = f"{COOKIE_NAME}={user_id}; Path=/; HttpOnly"
        self.send_json({"ok": True, "user": user}, set_cookie=cookie)

    def handle_get_tasks(self, query):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        space = (query.get("space") or [None])[0]
        owner_id = (query.get("ownerId") or [None])[0]
        if space not in ("team", "personal", "private"):
            self.send_error_json(400, "Paramètre 'space' invalide")
            return
        if space == "team":
            owner_id = None
        else:
            owner_id = owner_id or user["id"]
            if not can_view(user, space, owner_id):
                self.send_error_json(403, "Accès refusé")
                return
        tasks = load_tasks()
        filtered = [
            t for t in tasks
            if t["space"] == space and t.get("ownerId") == owner_id
        ]
        comment_counts = {}
        for c in load_comments():
            comment_counts[c["taskId"]] = comment_counts.get(c["taskId"], 0) + 1
        for t in filtered:
            t["commentCount"] = comment_counts.get(t["id"], 0)
        self.send_json({"tasks": filtered, "canEdit": can_edit(user, space, owner_id)})

    def handle_get_task(self, task_id):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        tasks = load_tasks()
        task = next((t for t in tasks if t["id"] == task_id), None)
        if not task:
            self.send_error_json(404, "Tâche introuvable")
            return
        if not can_view(user, task["space"], task.get("ownerId")):
            self.send_error_json(403, "Accès refusé")
            return
        self.send_json({"task": task, "canEdit": can_edit(user, task["space"], task.get("ownerId"))})

    def handle_post_task(self):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        body = self.read_json_body()
        title = (body.get("title") or "").strip()
        space = body.get("space")
        owner_id = body.get("ownerId")
        if not title:
            self.send_error_json(400, "Titre requis")
            return
        if space not in ("team", "personal", "private"):
            self.send_error_json(400, "Paramètre 'space' invalide")
            return
        if space == "team":
            owner_id = None
        else:
            owner_id = owner_id or user["id"]
        if not can_edit(user, space, owner_id):
            self.send_error_json(403, "Accès refusé")
            return
        priority = body.get("priority") if body.get("priority") in PRIORITIES else None
        category = (body.get("category") or "").strip() or None
        due_date = (body.get("dueDate") or "").strip() or None
        description = (body.get("description") or "").strip() or None
        task = {
            "id": str(uuid.uuid4()),
            "title": title,
            "status": "todo",
            "space": space,
            "ownerId": owner_id,
            "priority": priority,
            "category": category,
            "dueDate": due_date,
            "description": description,
            "createdBy": user["id"],
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        tasks = load_tasks()
        tasks.append(task)
        save_tasks(tasks)
        log_activity(task["id"], user["id"], "created")
        self.send_json({"task": task}, status=201)

    def handle_patch_task(self, task_id):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        body = self.read_json_body()
        tasks = load_tasks()
        task = next((t for t in tasks if t["id"] == task_id), None)
        if not task:
            self.send_error_json(404, "Tâche introuvable")
            return
        if not can_edit(user, task["space"], task.get("ownerId")):
            self.send_error_json(403, "Accès refusé")
            return

        changes = []

        def apply_field(key, action, new_value):
            if new_value != task.get(key):
                changes.append((action, task.get(key), new_value))
                task[key] = new_value

        if "status" in body and body["status"] in ("todo", "in_progress", "done"):
            apply_field("status", "status_changed", body["status"])
        if "title" in body and body["title"].strip():
            apply_field("title", "title_changed", body["title"].strip())
        if "priority" in body:
            apply_field("priority", "priority_changed", body["priority"] if body["priority"] in PRIORITIES else None)
        if "category" in body:
            apply_field("category", "category_changed", (body["category"] or "").strip() or None)
        if "dueDate" in body:
            apply_field("dueDate", "dueDate_changed", (body["dueDate"] or "").strip() or None)
        if "description" in body:
            apply_field("description", "description_changed", (body["description"] or "").strip() or None)

        if changes:
            task["updatedAt"] = now_iso()
            save_tasks(tasks)
            for action, old_value, new_value in changes:
                log_activity(task_id, user["id"], action, {"from": old_value, "to": new_value})
        self.send_json({"task": task})

    def handle_delete_task(self, task_id):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        tasks = load_tasks()
        task = next((t for t in tasks if t["id"] == task_id), None)
        if not task:
            self.send_error_json(404, "Tâche introuvable")
            return
        if not can_edit(user, task["space"], task.get("ownerId")):
            self.send_error_json(403, "Accès refusé")
            return
        tasks = [t for t in tasks if t["id"] != task_id]
        save_tasks(tasks)
        self.send_json({"ok": True})

    def handle_get_comments(self, task_id):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        task = next((t for t in load_tasks() if t["id"] == task_id), None)
        if not task:
            self.send_error_json(404, "Tâche introuvable")
            return
        if not can_view(user, task["space"], task.get("ownerId")):
            self.send_error_json(403, "Accès refusé")
            return
        comments = [c for c in load_comments() if c["taskId"] == task_id]
        self.send_json({"comments": comments})

    def handle_post_comment(self, task_id):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        task = next((t for t in load_tasks() if t["id"] == task_id), None)
        if not task:
            self.send_error_json(404, "Tâche introuvable")
            return
        if not can_view(user, task["space"], task.get("ownerId")):
            self.send_error_json(403, "Accès refusé")
            return
        body = self.read_json_body()
        text = (body.get("text") or "").strip()
        if not text:
            self.send_error_json(400, "Commentaire vide")
            return
        comment = {
            "id": str(uuid.uuid4()),
            "taskId": task_id,
            "authorId": user["id"],
            "text": text,
            "createdAt": now_iso(),
        }
        comments = load_comments()
        comments.append(comment)
        save_comments(comments)
        log_activity(task_id, user["id"], "commented")
        self.send_json({"comment": comment}, status=201)

    def handle_get_activity(self, task_id):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        task = next((t for t in load_tasks() if t["id"] == task_id), None)
        if not task:
            self.send_error_json(404, "Tâche introuvable")
            return
        if not can_view(user, task["space"], task.get("ownerId")):
            self.send_error_json(403, "Accès refusé")
            return
        activity = [a for a in load_activity() if a["taskId"] == task_id]
        activity.sort(key=lambda a: a["at"])
        self.send_json({"activity": activity})

    def handle_get_overview(self):
        user = self.get_current_user()
        if not user:
            self.send_error_json(401, "Pas connecté")
            return
        if user["role"] != "pm":
            self.send_error_json(403, "Réservé au PM")
            return
        users = load_users()
        pos = [u for u in users if u["role"] == "po"]
        tasks = load_tasks()
        today_str = datetime.now(timezone.utc).date().isoformat()
        week_ago_str = (datetime.now(timezone.utc) - timedelta(days=7)).date().isoformat()

        def build_counts(relevant):
            total = len(relevant)
            done = sum(1 for t in relevant if t["status"] == "done")
            overdue = sum(
                1 for t in relevant
                if t.get("dueDate") and t["dueDate"] < today_str and t["status"] != "done"
            )
            done_last_7_days = sum(
                1 for t in relevant
                if t["status"] == "done" and t["updatedAt"][:10] >= week_ago_str
            )
            return {
                "todo": sum(1 for t in relevant if t["status"] == "todo"),
                "in_progress": sum(1 for t in relevant if t["status"] == "in_progress"),
                "done": done,
                "total": total,
                "overdue": overdue,
                "completionRate": round((done / total) * 100) if total else 0,
                "doneLast7Days": done_last_7_days,
            }

        overview = [
            {
                "po": po,
                "counts": build_counts([
                    t for t in tasks if t.get("ownerId") == po["id"] and t["space"] == "personal"
                ]),
            }
            for po in pos
        ]
        team_counts = build_counts([t for t in tasks if t["space"] == "team"])
        self.send_json({"overview": overview, "team": team_counts})


def main():
    port = 8765
    server = HTTPServer(("localhost", port), Handler)
    print(f"Serveur lancé sur http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt du serveur.")
        server.server_close()


if __name__ == "__main__":
    main()
