const state = {
  data: null,
  eventsCsv: []
};
const APP_TIMEZONE = "America/Los_Angeles";

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || "Request failed");
  }

  return response.json();
}

async function refreshState() {
  const [data, eventsCsvText] = await Promise.all([
    fetchJson("/api/state"),
    fetch("/api/events.csv").then(async (response) => {
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || "Failed to load events CSV");
      }
      return response.text();
    })
  ]);
  state.data = data;
  state.eventsCsv = parseCsv(eventsCsvText);
  render();
}

async function deleteEvent(eventId) {
  await fetchJson(`/api/events/${eventId}`, {
    method: "DELETE"
  });
}

async function deleteTask(taskId) {
  await fetchJson(`/api/tasks/${taskId}`, {
    method: "DELETE"
  });
}

function render() {
  renderConnections();
  renderTasks();
  renderEvents();
  renderPlan();
  renderChat();
  hydrateSetup();
}

function renderConnections() {
  const target = document.getElementById("connectionStatus");
  const { config, summaries } = state.data;
  target.innerHTML = `
    <div class="status-card">
      <strong>Telegram</strong>
      <p>${config.telegramConnected ? "Connected" : "Local simulator mode"}</p>
    </div>
    <div class="status-card">
      <strong>Google Calendar</strong>
      <p>${config.googleConnected ? "Connected with manual token" : "Not configured"}</p>
    </div>
    <div class="status-card">
      <strong>Pipeline</strong>
      <p>${summaries.pendingTasks} pending tasks, ${summaries.proposedBlocks} proposed blocks, ${summaries.acceptedBlocks} accepted blocks.</p>
    </div>
  `;
}

function hydrateSetup() {
  const form = document.getElementById("setupForm");
  if (!state.data?.user || form.dataset.hydrated === "true") {
    return;
  }
  Object.entries(state.data.user).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (!field) {
      return;
    }
    field.value = Array.isArray(value) ? value.join(",") : value;
  });
  form.dataset.hydrated = "true";
}

function renderTasks() {
  const target = document.getElementById("taskList");
  const summary = document.getElementById("taskSummary");
  const tasks = state.data.tasks || [];
  summary.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  target.innerHTML = "";

  if (tasks.length === 0) {
    target.innerHTML = `<div class="task-card"><p>No tasks yet. Add one in natural language to get started.</p></div>`;
    return;
  }

  const template = document.getElementById("taskTemplate");
  tasks.forEach((task) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = task.title;
    node.querySelector(".task-meta").textContent = [
      `${task.estimatedDuration} min`,
      `priority ${task.priority}`,
      task.deadline ? `deadline ${formatDateTime(task.deadline)}` : "no deadline",
      task.status
    ].join(" • ");
    node.querySelector(".delete-task-btn").addEventListener("click", async () => {
      await deleteTask(task.id);
      await refreshState();
    });
    target.appendChild(node);
  });
}

function renderPlan() {
  const notesTarget = document.getElementById("planNotes");
  const grid = document.getElementById("calendarGrid");
  const blocks = buildCalendarBlocks()
    .slice()
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  notesTarget.innerHTML = (state.data.plan?.notes || []).map((note) => `<div class="note-card">${note}</div>`).join("");
  grid.innerHTML = "";

  const days = buildCalendarDays(blocks);
  days.forEach((day) => {
    const dayEl = document.createElement("div");
    dayEl.className = "calendar-day";
    dayEl.innerHTML = `<h3>${day.label}</h3>`;

    if (day.blocks.length === 0) {
      dayEl.innerHTML += `<p class="muted">No blocks planned.</p>`;
    }

    day.blocks.forEach((block) => {
      const blockEl = document.createElement("div");
      blockEl.className = `calendar-block ${block.source} ${block.status}`;
      const removable = block.kind === "event" && Boolean(block.eventId);
      if (removable) {
        blockEl.classList.add("has-remove");
      }
      blockEl.innerHTML = `
        <div class="block-time">${formatTime(block.startTime)} - ${formatTime(block.endTime)}</div>
        <strong>${block.title}</strong>
        <div class="muted">${block.source} • ${block.status}</div>
      `;

      if (removable) {
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "remove-block-btn";
        removeButton.setAttribute("aria-label", `Remove ${block.title}`);
        removeButton.textContent = "×";
        removeButton.addEventListener("click", async () => {
          await deleteEvent(block.eventId);
          await refreshState();
        });
        blockEl.appendChild(removeButton);
      }

      dayEl.appendChild(blockEl);
    });

    grid.appendChild(dayEl);
  });
}

function renderEvents() {
  const target = document.getElementById("eventList");
  const summary = document.getElementById("eventSummary");
  const events = state.eventsCsv || [];
  summary.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  target.innerHTML = "";

  if (events.length === 0) {
    target.innerHTML = `<div class="task-card"><p>No events yet. Add one in natural language and it will show up here and in the calendar.</p></div>`;
    return;
  }

  events
    .slice()
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .forEach((event) => {
      const card = document.createElement("div");
      card.className = "task-card";
      const details = document.createElement("div");
      details.innerHTML = `
        <h3>${event.title || "Untitled event"}</h3>
        <p class="event-meta">${formatEventMeta(event)}</p>
      `;

      const actions = document.createElement("div");
      actions.className = "button-row compact";

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "secondary";
      removeButton.textContent = "Delete";
      removeButton.addEventListener("click", async () => {
        await deleteEvent(event.id);
        await refreshState();
      });

      actions.appendChild(removeButton);
      card.appendChild(details);
      card.appendChild(actions);
      target.appendChild(card);
    });
}

function renderChat() {
  const target = document.getElementById("chatHistory");
  const messages = state.data.conversationHistory || [];
  target.innerHTML = "";

  if (messages.length === 0) {
    target.innerHTML = `<div class="chat-empty muted">No messages yet. Start with a task, event, or a slash command.</div>`;
    return;
  }

  messages.forEach((message) => {
    const row = document.createElement("div");
    row.className = `chat-row ${message.role === "user" ? "user" : "assistant"}`;

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${message.role === "user" ? "user" : "assistant"}`;

    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = `${message.role === "user" ? "You" : "Planner"} • ${formatMessageTime(message.createdAt)}`;

    const body = document.createElement("div");
    body.className = "chat-text";
    body.textContent = message.text || "";

    bubble.appendChild(meta);
    bubble.appendChild(body);
    row.appendChild(bubble);
    target.appendChild(row);
  });

  target.scrollTop = target.scrollHeight;
}

function buildCalendarDays(blocks) {
  const days = new Map();
  const today = getTimeZoneDayAnchor(new Date());
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + offset);
    const key = toTimeZoneDateKey(date);
    days.set(key, {
      key,
      label: formatDateLabel(date),
      blocks: []
    });
  }

  blocks.forEach((block) => {
    const key = toTimeZoneDateKey(block.startTime);
    if (!days.has(key)) {
      days.set(key, {
        key,
        label: formatDateLabel(block.startTime),
        blocks: []
      });
    }
    days.get(key).blocks.push(block);
  });

  return [...days.values()];
}

function buildCalendarBlocks() {
  const planBlocks = (state.data.plan?.blocks || []).map((block) => ({ ...block }));
  const existingEventIds = new Set(
    planBlocks
      .filter((block) => block.kind === "event" && block.eventId)
      .map((block) => block.eventId)
  );

  const csvEvents = (state.eventsCsv || [])
    .filter((event) => event.id && !existingEventIds.has(event.id))
    .map((event) => ({
      id: `csv_${event.id}`,
      eventId: event.id,
      title: event.title || "Event",
      startTime: event.startTime,
      endTime: event.endTime,
      location: event.location || "",
      address: event.address || "",
      kind: "event",
      source: "event",
      status: event.status || "proposed"
    }));

  return [...planBlocks, ...csvEvents];
}

function formatEventMeta(event) {
  return [
    `${formatDateTime(event.startTime)} - ${formatTime(event.endTime)}`,
    event.location ? `at ${event.location}` : "location pending",
    event.status || "proposed"
  ].join(" • ");
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      if (current.length > 0 || row.length > 0) {
        row.push(current);
        rows.push(row);
      }
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  if (rows.length === 0) {
    return [];
  }

  const [header, ...dataRows] = rows;
  return dataRows
    .filter((dataRow) => dataRow.some((cell) => cell !== ""))
    .map((dataRow) => Object.fromEntries(header.map((key, index) => [key, dataRow[index] || ""])));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatMessageTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateLabel(value) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function toTimeZoneDateKey(value) {
  const parts = getTimeZoneDateParts(value);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  });
  return `${map.year}-${map.month}-${map.day}`;
}

function getTimeZoneDateParts(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
}

function getTimeZoneDayAnchor(value) {
  const parts = getTimeZoneDateParts(value);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  });
  return new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), 12, 0, 0));
}

document.getElementById("setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  payload.planHorizonDays = Number(payload.planHorizonDays);
  payload.healthyTaskTypes = payload.healthyTaskTypes;
  await fetchJson("/api/setup", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  event.currentTarget.dataset.hydrated = "false";
  await refreshState();
});

document.getElementById("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const text = String(form.get("text") || "").trim();
  if (!text) {
    return;
  }
  await fetchJson("/api/telegram/webhook", {
    method: "POST",
    body: JSON.stringify({
      message: {
        text,
        chat: {
          id: "demo-chat"
        }
      }
    })
  });
  event.currentTarget.reset();
  await refreshState();
});

document.getElementById("generatePlanBtn").addEventListener("click", async () => {
  await fetchJson("/api/plan/generate", {
    method: "POST",
    body: JSON.stringify({})
  });
  await refreshState();
});

document.getElementById("importCalendarBtn").addEventListener("click", async () => {
  await fetchJson("/api/calendar/import", {
    method: "POST",
    body: JSON.stringify({})
  });
  await refreshState();
});

document.getElementById("replanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await fetchJson("/api/plan/replan", {
    method: "POST",
    body: JSON.stringify({
      delayMinutes: Number(form.get("delayMinutes"))
    })
  });
  await refreshState();
});

document.getElementById("acceptPlanBtn").addEventListener("click", async () => {
  await fetchJson("/api/plan/accept", {
    method: "POST",
    body: JSON.stringify({})
  });
  await refreshState();
});

document.getElementById("rejectPlanBtn").addEventListener("click", async () => {
  await fetchJson("/api/plan/reject", {
    method: "POST",
    body: JSON.stringify({})
  });
  await refreshState();
});

refreshState().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main class="app-shell"><div class="panel"><h1>Planner failed to load</h1><p>${error.message}</p></div></main>`;
});
