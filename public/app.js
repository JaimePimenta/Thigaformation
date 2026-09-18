const STATUS_LABELS = {
  todo: "À faire",
  in_progress: "En cours",
  done: "Fait",
};
const STATUS_ORDER = ["todo", "in_progress", "done"];

const PRIORITY_LABELS = {
  low: "Basse",
  medium: "Moyenne",
  high: "Haute",
  urgent: "Urgente",
};
const PRIORITY_ORDER = ["urgent", "high", "medium", "low"];

const ACTIVITY_LABELS = {
  created: "a créé la tâche",
  status_changed: "a changé le statut",
  title_changed: "a renommé la tâche",
  priority_changed: "a changé la priorité",
  category_changed: "a changé la catégorie",
  dueDate_changed: "a changé la date d'échéance",
  description_changed: "a modifié la description",
  commented: "a commenté",
};

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/";
    throw new Error("Pas connecté");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Erreur");
  }
  return data;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- Page: login ----------

async function initLoginPage() {
  const select = document.getElementById("user-select");
  const btn = document.getElementById("enter-btn");
  const { users } = await api("/api/users");
  select.innerHTML = users
    .map((u) => `<option value="${u.id}">${u.name}${u.role === "pm" ? " (PM)" : ""}</option>`)
    .join("");

  btn.addEventListener("click", async () => {
    const userId = select.value;
    await api("/api/session", { method: "POST", body: JSON.stringify({ userId }) });
    window.location.href = "/dashboard";
  });
}

// ---------- Page: dashboard ----------

let currentUser = null;
let currentPos = [];
let usersById = {};
let activeTabState = null;

async function initDashboardPage() {
  const [me, allUsers] = await Promise.all([api("/api/me"), api("/api/users")]);
  currentUser = me.user;
  currentPos = me.pos;
  usersById = Object.fromEntries(allUsers.users.map((u) => [u.id, u.name]));

  document.getElementById("who").textContent = `${currentUser.name} · ${
    currentUser.role === "pm" ? "PM" : "PO"
  }`;

  const tabs = buildTabs();
  renderTabs(tabs);
  selectTab(tabs[0].id, tabs);
}

function buildTabs() {
  const tabs = [{ id: "team", label: "Équipe", kind: "board", space: "team" }];

  if (currentUser.role === "po") {
    tabs.push({ id: "personal", label: "Mes tâches", kind: "board", space: "personal", ownerId: currentUser.id });
    tabs.push({ id: "private", label: "Espace privé (avec le PM)", kind: "board", space: "private", ownerId: currentUser.id });
  } else {
    tabs.push({ id: "overview", label: "Vue d'ensemble", kind: "overview" });
    currentPos.forEach((po) => {
      tabs.push({
        id: `private-${po.id}`,
        label: `Privé · ${po.name}`,
        kind: "board",
        space: "private",
        ownerId: po.id,
      });
    });
  }
  return tabs;
}

function renderTabs(tabs) {
  const nav = document.getElementById("tabs");
  nav.innerHTML = tabs
    .map((t) => `<button data-tab="${t.id}">${t.label}</button>`)
    .join("");
  nav.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => selectTab(btn.dataset.tab, tabs));
  });
}

function selectTab(tabId, tabs) {
  document.querySelectorAll("#tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  const tab = tabs.find((t) => t.id === tabId);
  if (tab.kind === "overview") {
    renderOverview();
  } else {
    loadBoard(tab);
  }
}

// ---------- Kanban board ----------

async function loadBoard(tab) {
  const main = document.getElementById("main");
  main.innerHTML = `
    <div class="filters" id="filters">
      <input type="text" id="filter-search" placeholder="Rechercher un mot-clé..." />
      <select id="filter-category"><option value="">Toutes les catégories</option></select>
      <select id="filter-priority"><option value="">Toutes les priorités</option></select>
    </div>
    <div class="board" id="board"></div>
  `;

  const params = new URLSearchParams({ space: tab.space });
  if (tab.ownerId) params.set("ownerId", tab.ownerId);
  const { tasks, canEdit } = await api(`/api/tasks?${params.toString()}`);

  activeTabState = { tab, tasks, canEdit };

  const categories = Array.from(new Set(tasks.map((t) => t.category).filter(Boolean))).sort();
  const categorySelect = document.getElementById("filter-category");
  categorySelect.innerHTML =
    `<option value="">Toutes les catégories</option>` +
    categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  const prioritySelect = document.getElementById("filter-priority");
  prioritySelect.innerHTML =
    `<option value="">Toutes les priorités</option>` +
    PRIORITY_ORDER.map((p) => `<option value="${p}">${PRIORITY_LABELS[p]}</option>`).join("");

  ["filter-search", "filter-category", "filter-priority"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderFilteredBoard);
    document.getElementById(id).addEventListener("change", renderFilteredBoard);
  });

  renderFilteredBoard();
}

function getFilteredTasks() {
  const { tasks } = activeTabState;
  const search = (document.getElementById("filter-search").value || "").toLowerCase().trim();
  const category = document.getElementById("filter-category").value;
  const priority = document.getElementById("filter-priority").value;

  return tasks.filter((t) => {
    if (category && t.category !== category) return false;
    if (priority && t.priority !== priority) return false;
    if (search) {
      const haystack = `${t.title} ${t.description || ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function renderFilteredBoard() {
  const { tab, canEdit } = activeTabState;
  const filtered = getFilteredTasks();
  const board = document.getElementById("board");
  board.innerHTML = STATUS_ORDER.map((status) => renderColumn(status, filtered, canEdit)).join("");
  wireBoardEvents(tab, canEdit);
}

function wireBoardEvents(tab, canEdit) {
  const board = document.getElementById("board");

  board.querySelectorAll(".column").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("drag-over");
      if (!canEdit) return;
      const taskId = e.dataTransfer.getData("text/plain");
      const status = col.dataset.status;
      await api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await loadBoard(tab);
    });
  });

  board.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
    });
    card.addEventListener("click", (e) => {
      if (e.target.closest(".delete-btn")) return;
      openTaskDetail(card.dataset.id, tab);
    });
  });

  board.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/tasks/${btn.dataset.id}`, { method: "DELETE" });
      await loadBoard(tab);
    });
  });

  if (canEdit) {
    const form = board.querySelector(".add-form-wrapper");
    if (form) {
      const submit = async () => {
        const input = form.querySelector("input");
        const title = input.value.trim();
        if (!title) return;
        await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ title, space: tab.space, ownerId: tab.ownerId || null }),
        });
        await loadBoard(tab);
      };
      form.querySelector("button").addEventListener("click", submit);
      form.querySelector("input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    }
  }
}

function renderColumn(status, tasks, canEdit) {
  const items = tasks.filter((t) => t.status === status);
  const cards = items.map((t) => renderCard(t, canEdit)).join("");

  const addForm =
    status === "todo"
      ? canEdit
        ? `<div class="add-form-wrapper">
            <div class="add-form">
              <input type="text" placeholder="Nouvelle tâche..." />
              <button>Ajouter</button>
            </div>
          </div>`
        : `<div class="readonly-note">Lecture seule</div>`
      : "";

  return `
    <div class="column" data-status="${status}">
      <h3><span class="dot ${status}"></span>${STATUS_LABELS[status]} (${items.length})</h3>
      ${cards || (status !== "todo" ? '<div class="empty-hint">Aucune tâche</div>' : "")}
      ${addForm}
    </div>`;
}

function renderCard(t, canEdit) {
  const overdue = t.dueDate && t.dueDate < todayStr() && t.status !== "done";
  const badges = [];
  if (t.priority) {
    badges.push(`<span class="badge priority-${t.priority}">${PRIORITY_LABELS[t.priority]}</span>`);
  }
  if (t.category) {
    badges.push(`<span class="badge category">${escapeHtml(t.category)}</span>`);
  }
  if (t.dueDate) {
    badges.push(`<span class="badge due ${overdue ? "overdue" : ""}">${formatDate(t.dueDate)}</span>`);
  }
  if (t.commentCount) {
    badges.push(`<span class="badge comments">💬 ${t.commentCount}</span>`);
  }

  return `
    <div class="card" draggable="${canEdit}" data-id="${t.id}">
      <div class="card-main">
        <span class="card-title">${escapeHtml(t.title)}</span>
        ${badges.length ? `<div class="card-badges">${badges.join("")}</div>` : ""}
      </div>
      ${canEdit ? `<button class="delete-btn" data-id="${t.id}">✕</button>` : ""}
    </div>`;
}

// ---------- Task detail modal ----------

async function openTaskDetail(taskId, tab) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal">Chargement...</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const [{ task, canEdit }, { comments }, { activity }] = await Promise.all([
    api(`/api/tasks/${taskId}`),
    api(`/api/tasks/${taskId}/comments`),
    api(`/api/tasks/${taskId}/activity`),
  ]);

  const modal = overlay.querySelector(".modal");
  modal.innerHTML = `
    <button class="modal-close" id="modal-close">✕</button>
    <label>Titre</label>
    <input type="text" id="detail-title" value="${escapeHtml(task.title)}" ${canEdit ? "" : "disabled"} />

    <div class="detail-row">
      <div>
        <label>Priorité</label>
        <select id="detail-priority" ${canEdit ? "" : "disabled"}>
          <option value="">Aucune</option>
          ${PRIORITY_ORDER.map(
            (p) => `<option value="${p}" ${task.priority === p ? "selected" : ""}>${PRIORITY_LABELS[p]}</option>`
          ).join("")}
        </select>
      </div>
      <div>
        <label>Catégorie</label>
        <input type="text" id="detail-category" value="${escapeHtml(task.category || "")}" placeholder="ex: Bug, Discovery..." ${canEdit ? "" : "disabled"} />
      </div>
      <div>
        <label>Échéance</label>
        <input type="date" id="detail-due" value="${task.dueDate || ""}" ${canEdit ? "" : "disabled"} />
      </div>
    </div>

    <label>Description</label>
    <textarea id="detail-description" rows="3" placeholder="Détails, contexte..." ${canEdit ? "" : "disabled"}>${escapeHtml(task.description || "")}</textarea>

    ${canEdit ? `<button class="btn-primary" id="detail-save">Enregistrer</button>` : ""}

    <h3>Commentaires</h3>
    <div class="comment-list" id="comment-list">
      ${
        comments.length
          ? comments
              .map(
                (c) => `
              <div class="comment">
                <div class="comment-meta">${escapeHtml(usersById[c.authorId] || c.authorId)} · ${formatDate(c.createdAt)}</div>
                <div class="comment-text">${escapeHtml(c.text)}</div>
              </div>`
              )
              .join("")
          : `<div class="empty-hint">Aucun commentaire</div>`
      }
    </div>
    <div class="comment-form">
      <input type="text" id="comment-input" placeholder="Ajouter un commentaire..." />
      <button id="comment-send">Envoyer</button>
    </div>

    <h3>Historique</h3>
    <div class="activity-list">
      ${
        activity.length
          ? activity
              .map((a) => `<div class="activity-item">${escapeHtml(usersById[a.userId] || a.userId)} ${ACTIVITY_LABELS[a.action] || a.action} · ${formatDate(a.at)}</div>`)
              .join("")
          : `<div class="empty-hint">Aucune activité</div>`
      }
    </div>
  `;

  modal.querySelector("#modal-close").addEventListener("click", () => overlay.remove());

  if (canEdit) {
    modal.querySelector("#detail-save").addEventListener("click", async () => {
      await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: modal.querySelector("#detail-title").value,
          priority: modal.querySelector("#detail-priority").value || null,
          category: modal.querySelector("#detail-category").value,
          dueDate: modal.querySelector("#detail-due").value,
          description: modal.querySelector("#detail-description").value,
        }),
      });
      overlay.remove();
      await loadBoard(tab);
    });
  }

  const sendComment = async () => {
    const input = modal.querySelector("#comment-input");
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify({ text }) });
    overlay.remove();
    openTaskDetail(taskId, tab);
  };
  modal.querySelector("#comment-send").addEventListener("click", sendComment);
  modal.querySelector("#comment-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendComment();
  });
}

// ---------- Overview (PM only) ----------

async function renderOverview() {
  const main = document.getElementById("main");
  const { overview, team } = await api("/api/overview");

  const rows = overview
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.po.name)}</td>
        <td>${row.counts.total}</td>
        <td>${renderBar(row.counts)}</td>
        <td>${row.counts.completionRate}%</td>
        <td class="${row.counts.overdue ? "overdue-cell" : ""}">${row.counts.overdue}</td>
        <td>${row.counts.doneLast7Days}</td>
      </tr>`
    )
    .join("");

  main.innerHTML = `
    <h2 style="font-size:15px;color:#6b7280;margin-bottom:12px;">Tâches perso par PO</h2>
    <table class="overview-table">
      <thead><tr><th>PO</th><th>Total</th><th>Répartition</th><th>Complétion</th><th>En retard</th><th>Faites (7j)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h2 style="font-size:15px;color:#6b7280;margin:24px 0 12px;">Équipe (commune)</h2>
    <table class="overview-table">
      <thead><tr><th>Total</th><th>Répartition</th><th>Complétion</th><th>En retard</th><th>Faites (7j)</th></tr></thead>
      <tbody>
        <tr>
          <td>${team.total}</td>
          <td>${renderBar(team)}</td>
          <td>${team.completionRate}%</td>
          <td class="${team.overdue ? "overdue-cell" : ""}">${team.overdue}</td>
          <td>${team.doneLast7Days}</td>
        </tr>
      </tbody>
    </table>
  `;
}

function renderBar(counts) {
  const total = counts.total || 1;
  const pct = (n) => (n / total) * 100;
  return `<div class="bar">
    <span class="todo" style="width:${pct(counts.todo)}%"></span>
    <span class="in_progress" style="width:${pct(counts.in_progress)}%"></span>
    <span class="done" style="width:${pct(counts.done)}%"></span>
  </div>`;
}

// ---------- Bootstrap ----------

const page = document.body.dataset.page;
if (page === "login") {
  initLoginPage();
} else if (page === "dashboard") {
  initDashboardPage();
}
