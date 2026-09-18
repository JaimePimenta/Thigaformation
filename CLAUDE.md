# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, shared todo app for a Product Manager and their POs (Product Owners). Zero external
dependencies by design: the backend is Python 3 standard library only (`http.server`), and the
frontend is plain HTML/CSS/JS with no build step. Data persists to a JSON file on disk. Meant to
run on a single machine for local/test use — not deployed, no real auth.

## Commands

Run the server:
```bash
python3 server.py
```
Then open `http://localhost:8765`.

There is no build step, package manager, linter, or test suite — files are served/executed as-is.
To verify a change, restart the server and exercise the flow manually in a browser (see "Manual
verification" below).

## Architecture

Everything lives in one process (`server.py`), a single-threaded `http.server.HTTPServer` handling
both static file serving and a small JSON API:

- **Static routes**: `/` → `public/index.html` (login), `/dashboard` → `public/dashboard.html`,
  plus `/app.js` and `/styles.css`.
- **API routes**: `/api/users`, `/api/session`, `/api/me`, `/api/tasks` (GET/POST),
  `/api/tasks/<id>` (GET/PATCH/DELETE), `/api/tasks/<id>/comments` (GET/POST),
  `/api/tasks/<id>/activity` (GET), `/api/overview`.
- **Identity**: no passwords. `config/users.json` is a fixed list of `{id, name, role}` (`role` is
  `"pm"` or `"po"`). Logging in (`POST /api/session`) just sets a `pm_todo_user` cookie to a user
  id; `get_current_user()` reads that cookie on every request.
- **Storage**: three flat JSON files under `data/`, each read and rewritten in full on every
  mutation (no concurrency control beyond the server being single-threaded — fine for a handful of
  local users, not a general-purpose design):
  - `tasks.json` — the tasks themselves. Beyond the core fields (`status`, `space`, `ownerId`), a
    task also carries optional `priority` (one of `PRIORITIES` in `server.py`), `category` (free
    text), `dueDate` (`YYYY-MM-DD`) and `description`.
  - `comments.json` — flat list of `{id, taskId, authorId, text, createdAt}`.
  - `activity.json` — an append-only log of `{id, taskId, userId, action, details, at}`, written by
    `log_activity()` whenever a task field changes or a comment is added. `handle_patch_task`
    diffs the incoming body against the current task (`apply_field` helper) and logs one entry per
    changed field — never trust the client to say what changed.
- **Visibility model** — the core piece of business logic, enforced server-side in `can_view()` /
  `can_edit()` (not just hidden in the UI):
  - `space: "team"` — visible and editable by everyone.
  - `space: "personal"` (has an `ownerId`) — a PO's own board; visible to that PO and the PM, but
    only the owning PO can edit it (the PM view is read-only).
  - `space: "private"` (has an `ownerId`) — a 1:1 channel between the PM and one specific PO;
    visible/editable only by the PM and that PO, invisible to other POs.
  - Every task-mutating endpoint re-derives `space`/`ownerId` and re-checks these functions — never
    trust a client-supplied permission. Comments and activity entries inherit the same visibility
    as their parent task (checked via `can_view` on the task, not stored redundantly on the comment).
- **Frontend** (`public/app.js`): a single script branches on `document.body.dataset.page`
  (`"login"` vs `"dashboard"`) to decide what to initialize. The dashboard builds its tab list
  dynamically based on the logged-in user's role (a PO sees Équipe/Mes tâches/Espace privé; the PM
  sees Équipe/Vue d'ensemble/one Privé tab per PO), then fetches `/api/tasks?space=...&ownerId=...`
  per tab and filters/searches client-side over that result (`getFilteredTasks`) — there is no
  server-side filtering. Kanban drag-and-drop uses the native HTML5 DnD API (no library) to PATCH a
  task's `status`. Clicking a card opens a detail modal (`openTaskDetail`) that fetches the task,
  its comments and its activity in parallel and lets an editor update every field at once via a
  single PATCH.

## Key files

- `server.py` — entire backend: routing, session cookie, visibility rules, JSON persistence,
  activity logging.
- `config/users.json` — the fixed roster of PM + POs. Edit names here for real usage.
- `data/tasks.json`, `data/comments.json`, `data/activity.json` — the database; safe to reset any
  of them to `[]`.
- `public/app.js` — all frontend logic (both pages: login and dashboard, including the task detail
  modal and the overview table), `public/dashboard.html` / `index.html` are thin shells,
  `public/styles.css` for styling.

## Manual verification

Since there's no test suite, changes should be checked by logging in as different users (log out by
navigating back to `/`, log in as a different id from the dropdown) and confirming:
- a `team` task created under one identity appears for everyone;
- a PO's `personal` task doesn't leak to another PO but does show up in the PM's `/api/overview`;
- a `private` task between the PM and PO A never appears for PO B;
- a comment or activity entry on a `private`/`personal` task is only visible to the users who can
  view that task (same rule as the task itself);
- `/api/overview`'s `overdue`/`completionRate`/`doneLast7Days` numbers move when you set a task's
  `dueDate` in the past or drag it to "Fait".
