const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { routeNaturalLanguageMessage } = require("./agent-router");
const {
  DEFAULT_TIMEZONE,
  addDaysInTimeZone,
  combineDateAndTimeInTimeZone,
  formatInTimeZone,
  nextWeekdayInTimeZone,
  resolveNow,
  resolveTimeZone,
  startOfDayInTimeZone
} = require("./time-utils");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const EVENTS_CSV_FILE = path.join(DATA_DIR, "events.csv");

loadEnv(path.join(ROOT, ".env"));

const config = {
  port: Number(process.env.PORT || 3000),
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
  googleAccessToken: process.env.GOOGLE_ACCESS_TOKEN || "",
  timezone: process.env.TIMEZONE || "America/Los_Angeles",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.4"
};

ensureDir(DATA_DIR);
initializeDb();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer();

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`Planner running on ${config.appBaseUrl}`);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, config.appBaseUrl);

      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(req, res, requestUrl);
        return;
      }

      await serveStatic(req, res, requestUrl);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Internal server error" });
    }
  });
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/state") {
    const db = readDb();
    const state = await buildState(db);
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/events.csv") {
    const db = readDb();
    sendCsv(res, 200, buildEventsCsv(db.events || []));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/setup") {
    const body = await readBody(req);
    const db = readDb();
    db.user = {
      ...db.user,
      ...sanitizeUser(body)
    };
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, user: db.user });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/tasks") {
    const body = await readBody(req);
    const db = readDb();
    const task = createTaskFromInput(body);
    db.tasks.push(task);
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 201, { ok: true, task });
    return;
  }

  if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/tasks/")) {
    const taskId = requestUrl.pathname.split("/")[3];
    const db = readDb();
    const result = removeTask(db, taskId);
    if (!result.ok) {
      sendJson(res, 404, { error: result.error });
      return;
    }
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/events/")) {
    const eventId = requestUrl.pathname.split("/")[3];
    const db = readDb();
    const result = removeEvent(db, eventId);
    if (!result.ok) {
      sendJson(res, 404, { error: result.error });
      return;
    }
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/plan/generate") {
    const db = readDb();
    const body = await readBody(req);
    const plan = await generatePlan({
      db,
      reason: body.reason || "manual_generation",
      preserveAccepted: body.preserveAccepted !== false
    });
    db.plan = plan;
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, plan });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/plan/replan") {
    const body = await readBody(req);
    const db = readDb();
    const delayMinutes = Math.max(0, Number(body.delayMinutes || 0));
    shiftPendingBlocks(db, delayMinutes);
    const plan = await generatePlan({
      db,
      reason: "replan",
      preserveAccepted: true
    });
    db.plan = plan;
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, plan });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/plan/accept") {
    const db = readDb();
    const acceptedPlan = markPlanAccepted(db);
    const sync = await syncAcceptedPlanToGoogleCalendar(acceptedPlan);
    db.plan = acceptedPlan;
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, plan: acceptedPlan, sync });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/plan/reject") {
    const db = readDb();
    db.plan.status = "rejected";
    db.plan.blocks = db.plan.blocks.map((block) => ({
      ...block,
      status: block.status === "accepted" ? "accepted" : "skipped"
    }));
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, plan: db.plan });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname.startsWith("/api/tasks/") && requestUrl.pathname.endsWith("/split")) {
    const taskId = requestUrl.pathname.split("/")[3];
    const body = await readBody(req);
    const db = readDb();
    const splitCount = Math.max(2, Number(body.parts || 2));
    const result = splitTask(db, taskId, splitCount);
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/calendar/import") {
    const db = readDb();
    const events = await fetchGoogleCalendarEvents(db.user.planHorizonDays || 7);
    db.externalEvents = events;
    db.meta.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, events });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/telegram/webhook") {
    const body = await readBody(req);
    const result = await processTelegramUpdate(body);
    sendJson(res, 200, { ok: true, result });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, requestUrl) {
  if (requestUrl.pathname === "/data/events.csv") {
    if (!fs.existsSync(EVENTS_CSV_FILE)) {
      sendCsv(res, 200, buildEventsCsv([]));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
    fs.createReadStream(EVENTS_CSV_FILE).pipe(res);
    return;
  }

  const requestedPath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, path.normalize(requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function createTaskFromInput(input) {
  const parsed = parseTaskText(input.text || input.title || "", { now: input.now, timezone: input.timezone || config.timezone });
  return {
    id: randomId("task"),
    title: input.title || parsed.title,
    estimatedDuration: Number(input.estimatedDuration || parsed.estimatedDuration || 60),
    deadline: input.deadline || parsed.deadline || null,
    priority: input.priority || parsed.priority || "medium",
    splittable: input.splittable !== undefined ? Boolean(input.splittable) : parsed.splittable,
    preferredTimeWindow: input.preferredTimeWindow || parsed.preferredTimeWindow || "any",
    status: input.status || "pending",
    source: input.source || "manual",
    assumptions: Array.isArray(input.assumptions) ? input.assumptions : [],
    inferredEstimate: Boolean(input.inferredEstimate),
    createdAt: resolveNow(input.now).toISOString()
  };
}

function createEventFromInput(input) {
  const timeZone = resolveTimeZone(input.timezone || config.timezone);
  const startTime = normalizeDate(input.startTime) || addDaysInTimeZone(resolveNow(input.now), 1, timeZone).toISOString();
  const endTime = normalizeDate(input.endTime) || addMinutes(startTime, Number(input.durationMinutes || 60)).toISOString();
  return {
    id: randomId("event"),
    title: input.title || "Event",
    startTime,
    endTime,
    location: input.location || "",
    address: input.address || "",
    source: input.source || "manual_event",
    status: input.status || "proposed",
    kind: input.kind || "event",
    assumptions: Array.isArray(input.assumptions) ? input.assumptions : [],
    lookupSources: Array.isArray(input.lookupSources) ? input.lookupSources : [],
    locked: true,
    createdAt: resolveNow(input.now).toISOString()
  };
}

function sanitizeUser(input) {
  const healthyTaskTypes = Array.isArray(input.healthyTaskTypes)
    ? input.healthyTaskTypes
    : String(input.healthyTaskTypes || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  return {
    name: input.name || "Hackathon User",
    workdayStart: input.workdayStart || "09:00",
    workdayEnd: input.workdayEnd || "18:00",
    planHorizonDays: Math.max(1, Number(input.planHorizonDays || 7)),
    breakCadenceMinutes: Math.max(30, Number(input.breakCadenceMinutes || 120)),
    activeWindow: input.activeWindow || "17:00-20:00",
    timezone: input.timezone || config.timezone,
    wellnessMode: input.wellnessMode || "off",
    gymName: input.gymName || "",
    healthyTaskTypes
  };
}

async function buildState(db) {
  const events = db.events || [];
  return {
    config: {
      appBaseUrl: config.appBaseUrl,
      timezone: config.timezone,
      telegramConnected: Boolean(config.telegramBotToken),
      googleConnected: Boolean(config.googleAccessToken),
      aiConfigured: Boolean(config.openaiApiKey),
      openaiModel: config.openaiModel
    },
    user: db.user,
    tasks: db.tasks,
    events,
    externalEvents: db.externalEvents,
    plan: db.plan,
    conversationHistory: db.meta?.conversationHistory || [],
    summaries: {
      pendingTasks: db.tasks.filter((task) => task.status === "pending").length,
      proposedEvents: events.filter((event) => event.status === "proposed").length,
      acceptedBlocks: db.plan.blocks.filter((block) => block.status === "accepted").length,
      proposedBlocks: db.plan.blocks.filter((block) => block.status === "proposed").length
    }
  };
}

async function generatePlan({ db, reason, preserveAccepted, now }) {
  const currentTime = resolveNow(now);
  const timeZone = resolveTimeZone(db.user.timezone || config.timezone);
  const horizonDays = db.user.planHorizonDays || 7;
  const workdayStart = db.user.workdayStart || "09:00";
  const workdayEnd = db.user.workdayEnd || "18:00";
  const acceptedBlocks = preserveAccepted
    ? db.plan.blocks.filter((block) => block.status === "accepted" && block.kind !== "event")
    : [];

  const calendarEvents = (db.externalEvents || []).map((event) => ({
    id: event.id || randomId("cal"),
    title: event.summary || event.title || "Busy",
    startTime: normalizeDate(event.startTime || event.start?.dateTime || event.start),
    endTime: normalizeDate(event.endTime || event.end?.dateTime || event.end),
    kind: "calendar",
    source: "calendar",
    status: "busy"
  })).filter((event) => event.startTime && event.endTime);

  const plannerEvents = (db.events || [])
    .filter((event) => event.status === "proposed" || event.status === "accepted")
    .map((event) => ({
      id: randomId("block"),
      eventId: event.id,
      title: event.title,
      startTime: event.startTime,
      endTime: event.endTime,
      location: event.location,
      kind: "event",
      source: "event",
      status: event.status,
      assumptions: event.assumptions || [],
      lookupSources: event.lookupSources || [],
      locked: true
    }));

  const pendingTasks = db.tasks
    .filter((task) => task.status === "pending")
    .map((task) => ({
      ...task,
      remainingMinutes: task.estimatedDuration
    }))
    .sort(compareTasks);

  const planBlocks = [...plannerEvents, ...acceptedBlocks];
  const occupied = [...plannerEvents, ...acceptedBlocks, ...calendarEvents];

  for (let dayIndex = 0; dayIndex < horizonDays; dayIndex += 1) {
    const date = addDaysInTimeZone(currentTime, dayIndex, timeZone);
    const dayStart = combineDateAndTimeInTimeZone(date, workdayStart, timeZone);
    const dayEnd = combineDateAndTimeInTimeZone(date, workdayEnd, timeZone);
    const freeSlots = findFreeSlots(dayStart, dayEnd, occupied);

    for (const slot of freeSlots) {
      let cursor = new Date(slot.startTime);
      while (cursor < new Date(slot.endTime)) {
        const nextTask = pendingTasks.find((task) => task.remainingMinutes > 0 && canPlaceTask(task, cursor));
        if (!nextTask) {
          break;
        }

        const remaining = nextTask.remainingMinutes || nextTask.estimatedDuration;
        const availableMinutes = minutesBetween(cursor, slot.endTime);
        const chunkSize = chooseChunkSize(nextTask, remaining, availableMinutes);

        if (chunkSize < 15) {
          break;
        }

        const blockEnd = addMinutes(cursor, chunkSize);
        const block = {
          id: randomId("block"),
          taskId: nextTask.id,
          title: nextTask.title,
          startTime: cursor.toISOString(),
          endTime: blockEnd.toISOString(),
          kind: "task",
          source: "task",
          status: "proposed"
        };

        planBlocks.push(block);
        occupied.push(block);
        nextTask.remainingMinutes = remaining - chunkSize;
        if (nextTask.remainingMinutes <= 0) {
          nextTask.status = "planned";
        }
        cursor = blockEnd;
      }
    }

    maybeAddHealthySuggestion({
      db,
      dayStart,
      dayEnd,
      occupied,
      planBlocks,
      timeZone
    });
  }

  return {
    id: randomId("plan"),
    reason,
    status: "proposed",
    generatedAt: currentTime.toISOString(),
    blocks: sortBlocks(planBlocks),
    notes: buildPlanNotes(db, pendingTasks)
  };
}

function compareTasks(a, b) {
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;
  const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;
  if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  }
  if (aDeadline !== bDeadline) {
    return aDeadline - bDeadline;
  }
  return b.estimatedDuration - a.estimatedDuration;
}

function canPlaceTask(task, startTime) {
  if (!task.deadline) {
    return true;
  }
  return new Date(startTime).getTime() < new Date(task.deadline).getTime();
}

function chooseChunkSize(task, remaining, availableMinutes) {
  const upperBound = Math.min(remaining, availableMinutes);
  if (!task.splittable) {
    return remaining <= availableMinutes ? remaining : 0;
  }
  if (remaining <= 60) {
    return Math.min(remaining, availableMinutes);
  }
  return Math.min(90, upperBound);
}

function maybeAddHealthySuggestion({ db, dayStart, dayEnd, occupied, planBlocks, timeZone }) {
  if (db.user.wellnessMode !== "suggestions" || !Array.isArray(db.user.healthyTaskTypes) || db.user.healthyTaskTypes.length === 0) {
    return;
  }

  const activeWindow = db.user.activeWindow || "17:00-20:00";
  const [activeStart, activeEnd] = activeWindow.split("-");
  const suggestionStart = combineDateAndTimeInTimeZone(dayStart, activeStart || "17:00", timeZone);
  const suggestionEnd = combineDateAndTimeInTimeZone(dayStart, activeEnd || "20:00", timeZone);
  if (suggestionEnd <= suggestionStart) {
    return;
  }

  const freeSlots = findFreeSlots(
    suggestionStart > dayStart ? suggestionStart : dayStart,
    suggestionEnd < dayEnd ? suggestionEnd : dayEnd,
    occupied
  );

  const targetSlot = freeSlots.find((slot) => minutesBetween(slot.startTime, slot.endTime) >= 30);
  if (!targetSlot) {
    return;
  }

  const healthyType = db.user.healthyTaskTypes[planBlocks.length % db.user.healthyTaskTypes.length] || "walk";
  const block = {
    id: randomId("health"),
    suggestionType: healthyType,
    title: healthyType === "gym" && db.user.gymName ? `Gym session at ${db.user.gymName}` : `Optional ${healthyType}`,
    startTime: new Date(targetSlot.startTime).toISOString(),
    endTime: addMinutes(targetSlot.startTime, 30).toISOString(),
    kind: "health",
    source: "health",
    status: "proposed"
  };

  planBlocks.push(block);
  occupied.push(block);
}

function buildPlanNotes(db, pendingTasks) {
  const unscheduled = pendingTasks.filter((task) => task.status === "pending");
  const notes = [];
  if (!config.googleAccessToken) {
    notes.push("Google Calendar token missing: accepted plans stay local until a token is configured.");
  }
  if (!config.telegramBotToken) {
    notes.push("Telegram bot token missing: use the web UI or POST to /api/telegram/webhook for demo input.");
  }
  if (unscheduled.length > 0) {
    notes.push(`${unscheduled.length} task(s) still need time because they did not fit before their deadline or work window.`);
  }
  return notes;
}

function markPlanAccepted(db) {
  const taskIds = new Set();
  const eventIds = new Set();
  const blocks = db.plan.blocks.map((block) => {
    if (block.kind === "task") {
      taskIds.add(block.taskId);
    }
    if (block.kind === "event" && block.eventId) {
      eventIds.add(block.eventId);
    }
    return {
      ...block,
      status: block.status === "skipped" ? "skipped" : "accepted"
    };
  });

  db.tasks = db.tasks.map((task) => {
    if (!taskIds.has(task.id)) {
      return task;
    }
    return {
      ...task,
      status: "planned"
    };
  });

  db.events = db.events.map((event) => {
    if (!eventIds.has(event.id)) {
      return event;
    }
    return {
      ...event,
      status: "accepted"
    };
  });

  return {
    ...db.plan,
    status: "accepted",
    acceptedAt: new Date().toISOString(),
    blocks
  };
}

async function syncAcceptedPlanToGoogleCalendar(plan) {
  if (!config.googleAccessToken) {
    return {
      synced: false,
      message: "No Google access token configured."
    };
  }

  const acceptedBlocks = plan.blocks.filter((block) => block.status === "accepted" && block.source !== "calendar");
  const results = [];
  for (const block of acceptedBlocks) {
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.googleCalendarId)}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.googleAccessToken}`
      },
      body: JSON.stringify({
        summary: block.title,
        description: `Planned by Assistive Weekly Planner (${block.kind || block.source}).`,
        start: {
          dateTime: block.startTime,
          timeZone: config.timezone
        },
        end: {
          dateTime: block.endTime,
          timeZone: config.timezone
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      results.push({ id: block.id, ok: false, error: text });
      continue;
    }

    const data = await response.json();
    results.push({ id: block.id, ok: true, googleEventId: data.id });
  }

  return {
    synced: results.every((item) => item.ok),
    results
  };
}

async function fetchGoogleCalendarEvents(horizonDays) {
  if (!config.googleAccessToken) {
    return [];
  }

  const timeMin = new Date().toISOString();
  const timeMax = addDaysInTimeZone(new Date(), horizonDays || 7, config.timezone).toISOString();
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.googleCalendarId)}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.googleAccessToken}`
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Google Calendar import failed: ${message}`);
  }

  const data = await response.json();
  return (data.items || []).map((event) => ({
    id: event.id,
    summary: event.summary || "Busy",
    startTime: event.start?.dateTime || event.start?.date || null,
    endTime: event.end?.dateTime || event.end?.date || null
  }));
}

async function processTelegramUpdate(update, runtime = {}) {
  const usingInjectedDb = Object.prototype.hasOwnProperty.call(runtime, "db");
  const readDbFn = runtime.readDb || readDb;
  const writeDbFn = runtime.writeDb || (usingInjectedDb ? (() => {}) : writeDb);
  const router = runtime.routeNaturalLanguageMessage || routeNaturalLanguageMessage;
  const sendTelegramMessageFn = runtime.sendTelegramMessage || sendTelegramMessage;
  const activeConfig = runtime.config || config;
  const now = runtime.now;
  const messageText = update?.message?.text || update?.text || "";
  const incomingChatId = update?.message?.chat?.id || null;
  const db = usingInjectedDb ? runtime.db : readDbFn();

  let reply = "Command not recognized.";
  if (incomingChatId) {
    db.user.telegramChatId = String(incomingChatId);
  }

  if (!messageText.startsWith("/")) {
    try {
      const result = await router({
        messageText,
        db,
        config: activeConfig,
        helpers: {
          addTask: (currentDb, payload) => {
            const task = createTaskFromInput({ ...payload, now, timezone: currentDb.user.timezone || activeConfig.timezone });
            currentDb.tasks.push(task);
            return task;
          },
          addEvent: (currentDb, payload) => {
            const event = createEventFromInput({ ...payload, now, timezone: currentDb.user.timezone || activeConfig.timezone });
            currentDb.events.push(event);
            return event;
          },
          generatePlan: async (currentDb, payload) => {
            currentDb.plan = await generatePlan({
              db: currentDb,
              reason: payload.reason || "agent_plan_request",
              preserveAccepted: true,
              now
            });
            return currentDb.plan;
          },
          replan: async (currentDb, payload) => {
            shiftPendingBlocks(currentDb, Math.max(0, Number(payload.delayMinutes || 0)));
            currentDb.plan = await generatePlan({
              db: currentDb,
              reason: "agent_replan_request",
              preserveAccepted: true,
              now
            });
            return currentDb.plan;
          },
          splitTask: (currentDb, payload) => splitTask(currentDb, payload.taskId, payload.parts),
          updatePreferences: (currentDb, payload) => {
            currentDb.user = {
              ...currentDb.user,
              ...sanitizeUser({
                ...currentDb.user,
                ...payload
              })
            };
            return currentDb.user;
          }
        },
        dependencies: runtime.routerDependencies || {}
      });
      recordConversationTurn(db, "user", messageText, now);
      writeDbFn(db);
      reply = result.reply;
    } catch (error) {
      console.error(`Agent processing failed: ${error.message}`);
      reply = "I couldn't process that natural-language request right now. Please try again or use a slash command like /plan or /add.";
    }
  } else if (messageText.startsWith("/start")) {
    reply = "Planner bot is connected. Try /add Finish deck in 120m by tomorrow 5pm priority high, then /plan.";
  } else if (messageText.startsWith("/setup")) {
    reply = "Setup is handled in the web app right now. Open the planner and fill the profile form.";
  } else if (messageText.startsWith("/add ")) {
    const task = createTaskFromInput({ text: messageText.replace("/add ", ""), source: "telegram", now, timezone: db.user.timezone || activeConfig.timezone });
    db.tasks.push(task);
    writeDbFn(db);
    reply = `Added task: ${task.title} (${task.estimatedDuration}m, ${task.priority}).`;
  } else if (messageText.startsWith("/plan")) {
    db.plan = await generatePlan({ db, reason: "telegram_plan", preserveAccepted: true, now });
    writeDbFn(db);
    reply = summarizePlan(db.plan);
  } else if (messageText.startsWith("/accept")) {
    db.plan = markPlanAccepted(db);
    writeDbFn(db);
    reply = "Plan accepted. Web UI will reflect accepted blocks, and Google sync will run when configured.";
  } else if (messageText.startsWith("/reject")) {
    db.plan.status = "rejected";
    db.plan.blocks = db.plan.blocks.map((block) => ({ ...block, status: "skipped" }));
    writeDbFn(db);
    reply = "Plan rejected.";
  } else if (messageText.startsWith("/replan")) {
    const minutes = Number(messageText.match(/(\d+)/)?.[1] || 30);
    shiftPendingBlocks(db, minutes);
    db.plan = await generatePlan({ db, reason: "telegram_replan", preserveAccepted: true, now });
    writeDbFn(db);
    reply = `Replanned the remaining schedule with a ${minutes} minute delay.\n\n${summarizePlan(db.plan)}`;
  } else if (messageText.startsWith("/split")) {
    const [, taskId, parts] = messageText.split(/\s+/);
    const result = splitTask(db, taskId, Number(parts || 2));
    writeDbFn(db);
    reply = result.ok ? `Split task into ${result.tasks.length} parts.` : result.error;
  }

  const replyChatId = incomingChatId || db.user.telegramChatId || null;
  recordConversationTurn(db, "assistant", reply, now);
  refreshConversationReferences(db, messageText, reply);
  writeDbFn(db);
  if (replyChatId && activeConfig.telegramBotToken) {
    try {
      await sendTelegramMessageFn(replyChatId, reply);
    } catch (error) {
      console.error(`Telegram delivery failed: ${error.message}`);
    }
  }

  return { reply, db };
}

async function sendTelegramMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Telegram send failed: ${message}`);
  }
}

function summarizePlan(plan) {
  const firstBlocks = sortBlocks(plan.blocks).slice(0, 5);
  if (firstBlocks.length === 0) {
    return "No plan blocks generated yet.";
  }
  return firstBlocks
    .map((block) => `${formatShortDate(block.startTime)} ${formatShortTime(block.startTime)}-${formatShortTime(block.endTime)} ${block.title}`)
    .join("\n");
}

function splitTask(db, taskId, parts) {
  const taskIndex = db.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex === -1) {
    return { ok: false, error: "Task not found." };
  }

  const task = db.tasks[taskIndex];
  const splitParts = Math.max(2, Number(parts || 2));
  const durationPerPart = Math.max(15, Math.round(task.estimatedDuration / splitParts));

  const newTasks = Array.from({ length: splitParts }, (_, index) => ({
    ...task,
    id: randomId("task"),
    title: `${task.title} (Part ${index + 1}/${splitParts})`,
    estimatedDuration: durationPerPart,
    splittable: false,
    status: "pending",
    createdAt: new Date().toISOString()
  }));

  db.tasks.splice(taskIndex, 1, ...newTasks);
  return { ok: true, tasks: newTasks };
}

function removeTask(db, taskId) {
  const taskIndex = db.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex === -1) {
    return { ok: false, error: "Task not found." };
  }

  db.tasks.splice(taskIndex, 1);
  if (db.plan?.blocks) {
    db.plan.blocks = db.plan.blocks.filter((block) => block.taskId !== taskId);
  }

  return { ok: true, removedTaskId: taskId };
}

function removeEvent(db, eventId) {
  const eventIndex = db.events.findIndex((event) => event.id === eventId);
  if (eventIndex === -1) {
    return { ok: false, error: "Event not found." };
  }

  db.events.splice(eventIndex, 1);
  if (db.plan?.blocks) {
    db.plan.blocks = db.plan.blocks.filter((block) => block.eventId !== eventId);
  }

  return { ok: true, removedEventId: eventId };
}

function shiftPendingBlocks(db, delayMinutes) {
  if (!db.plan?.blocks?.length || !delayMinutes) {
    return;
  }
  db.plan.blocks = db.plan.blocks.map((block) => {
    if (block.status === "accepted" || block.kind === "event" || block.kind === "calendar") {
      return block;
    }
    return {
      ...block,
      startTime: addMinutes(block.startTime, delayMinutes).toISOString(),
      endTime: addMinutes(block.endTime, delayMinutes).toISOString()
    };
  });
}

function findFreeSlots(dayStart, dayEnd, occupied) {
  const relevant = occupied
    .map((block) => ({
      startTime: new Date(block.startTime),
      endTime: new Date(block.endTime)
    }))
    .filter((block) => block.endTime > dayStart && block.startTime < dayEnd)
    .sort((a, b) => a.startTime - b.startTime);

  const freeSlots = [];
  let cursor = new Date(dayStart);

  for (const block of relevant) {
    if (block.startTime > cursor) {
      freeSlots.push({ startTime: new Date(cursor), endTime: new Date(block.startTime) });
    }
    if (block.endTime > cursor) {
      cursor = new Date(block.endTime);
    }
  }

  if (cursor < dayEnd) {
    freeSlots.push({ startTime: cursor, endTime: dayEnd });
  }

  return freeSlots;
}

function sortBlocks(blocks) {
  return [...blocks].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

function parseTaskText(text, options = {}) {
  const normalized = text.trim();
  const durationMatch = normalized.match(/(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i);
  const priorityPhraseMatch = normalized.match(/\bpriority\s+(high|medium|low)\b/i);
  const priorityMatch = priorityPhraseMatch || normalized.match(/\b(high|medium|low)\b/i);
  const deadlineMatch = normalized.match(/\bby\s+(.+?)(?=\s+\bpriority\s+(?:high|medium|low)\b|\s+\b(?:high|medium|low)\b|$)/i);
  const splittable = /\b(split|break down|parts?)\b/i.test(normalized);

  let estimatedDuration = 60;
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    estimatedDuration = unit.startsWith("h") ? value * 60 : value;
  }

  const title = normalized
    .replace(durationMatch?.[0] || "", "")
    .replace(priorityPhraseMatch?.[0] || "", "")
    .replace(!priorityPhraseMatch ? priorityMatch?.[0] || "" : "", "")
    .replace(deadlineMatch?.[0] || "", "")
    .replace(/\bpriority\b/gi, "")
    .replace(/\b(split|break down into parts|parts?)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\b(in|on|at|for)\s*$/i, "")
    .trim() || "Untitled task";

  return {
    title,
    estimatedDuration,
    priority: priorityMatch ? priorityMatch[1].toLowerCase() : "medium",
    deadline: deadlineMatch ? parseLooseDate(deadlineMatch[1], options.now, options.timezone) : null,
    splittable,
    preferredTimeWindow: "any"
  };
}

function parseLooseDate(value, nowOverride, timeZone = DEFAULT_TIMEZONE) {
  const normalizedValue = normalizeLooseDateInput(value);
  const lower = normalizedValue.trim().toLowerCase();
  const now = resolveNow(nowOverride);
  const activeTimeZone = resolveTimeZone(timeZone);
  const tomorrowMatch = lower.match(/^tomorrow(?:\s+at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (lower === "tomorrow") {
    return addDaysInTimeZone(now, 1, activeTimeZone).toISOString();
  }
  if (tomorrowMatch) {
    const target = addDaysInTimeZone(now, 1, activeTimeZone);
    const hhmm = `${String(normalizeHour(tomorrowMatch[1], tomorrowMatch[3])).padStart(2, "0")}:${String(Number(tomorrowMatch[2] || 0)).padStart(2, "0")}`;
    return combineDateAndTimeInTimeZone(target, hhmm, activeTimeZone).toISOString();
  }
  const weekdayMatch = lower.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at)?\s*(\d{1,2})?(?::(\d{2}))?\s*(am|pm)?$/);
  if (weekdayMatch) {
    const target = nextWeekdayInTimeZone(now, weekdayMatch[1], false, activeTimeZone);
    if (weekdayMatch[2]) {
      const hhmm = `${String(normalizeHour(weekdayMatch[2], weekdayMatch[4])).padStart(2, "0")}:${String(Number(weekdayMatch[3] || 0)).padStart(2, "0")}`;
      return combineDateAndTimeInTimeZone(target, hhmm, activeTimeZone).toISOString();
    } else {
      return combineDateAndTimeInTimeZone(target, "17:00", activeTimeZone).toISOString();
    }
  }
  const parsed = new Date(normalizedValue);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return null;
}

function normalizeLooseDateInput(value) {
  return String(value || "")
    .trim()
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
}

function normalizeHour(rawHour, meridiem) {
  let hour = Number(rawHour);
  const suffix = String(meridiem || "").toLowerCase();
  if (suffix === "pm" && hour < 12) {
    hour += 12;
  }
  if (suffix === "am" && hour === 12) {
    hour = 0;
  }
  return hour;
}

function formatShortDate(value) {
  return formatInTimeZone(value, { month: "short", day: "numeric" }, config.timezone);
}

function formatShortTime(value) {
  return formatInTimeZone(value, { hour: "numeric", minute: "2-digit" }, config.timezone);
}

function minutesBetween(start, end) {
  return Math.round((new Date(end) - new Date(start)) / 60000);
}

function addMinutes(value, minutes) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function readDb() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  if (!Array.isArray(db.events)) {
    db.events = [];
  }
  if (!db.plan || !Array.isArray(db.plan.blocks)) {
    db.plan = {
      id: randomId("plan"),
      reason: "recovered",
      status: "draft",
      generatedAt: null,
      blocks: [],
      notes: []
    };
  }
  if (!db.meta || typeof db.meta !== "object") {
    db.meta = {};
  }
  if (!Array.isArray(db.meta.conversationHistory)) {
    db.meta.conversationHistory = [];
  }
  if (!db.meta.lastReferences || typeof db.meta.lastReferences !== "object") {
    db.meta.lastReferences = {};
  }
  if (!("pendingClarification" in db.meta)) {
    db.meta.pendingClarification = null;
  }
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  fs.writeFileSync(EVENTS_CSV_FILE, buildEventsCsv(db.events || []));
}

function initializeDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      user: {
        name: "Hackathon User",
        workdayStart: "09:00",
        workdayEnd: "18:00",
        planHorizonDays: 7,
        breakCadenceMinutes: 120,
        activeWindow: "17:00-20:00",
        timezone: config.timezone,
        wellnessMode: "off",
        gymName: "",
        healthyTaskTypes: []
      },
      tasks: [],
      events: [],
      externalEvents: [],
      plan: {
        id: randomId("plan"),
        reason: "initial",
        status: "draft",
        generatedAt: null,
        blocks: [],
        notes: []
      },
      meta: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        conversationHistory: [],
        lastReferences: {},
        pendingClarification: null
      }
    };
    writeDb(initial);
    return;
  }

  const existing = readDb();
  fs.writeFileSync(EVENTS_CSV_FILE, buildEventsCsv(existing.events || []));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = fs.readFileSync(filePath, "utf8");
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      return;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

function recordConversationTurn(db, role, text, nowOverride) {
  if (!db.meta) {
    db.meta = {};
  }
  if (!Array.isArray(db.meta.conversationHistory)) {
    db.meta.conversationHistory = [];
  }
  db.meta.conversationHistory.push({
    role,
    text: String(text || ""),
    createdAt: resolveNow(nowOverride).toISOString()
  });
  db.meta.conversationHistory = db.meta.conversationHistory.slice(-12);
  db.meta.updatedAt = resolveNow(nowOverride).toISOString();
}

function refreshConversationReferences(db, latestUserMessage, latestReply) {
  if (!db.meta) {
    db.meta = {};
  }
  const latestEvent = [...(db.events || [])].reverse()[0] || null;
  const latestPlanBlock = [...(db.plan?.blocks || [])].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))[0] || null;
  db.meta.lastReferences = {
    lastUserMessage: String(latestUserMessage || ""),
    lastReply: String(latestReply || ""),
    latestEventId: latestEvent?.id || null,
    latestPlanKind: latestPlanBlock?.kind || null,
    latestPlanDate: latestPlanBlock?.startTime || null
  };
  db.meta.updatedAt = new Date().toISOString();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendCsv(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function buildEventsCsv(events) {
  const header = [
    "id",
    "title",
    "startTime",
    "endTime",
    "location",
    "address",
    "status",
    "source",
    "createdAt"
  ];
  const rows = [header, ...(events || []).map((event) => ([
    event.id,
    event.title,
    event.startTime,
    event.endTime,
    event.location,
    event.address,
    event.status,
    event.source,
    event.createdAt
  ]))];

  return `${rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n")}\n`;
}

function escapeCsvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

module.exports = {
  config,
  createServer,
  buildEventsCsv,
  createTaskFromInput,
  createEventFromInput,
  generatePlan,
  removeEvent,
  removeTask,
  sanitizeUser,
  parseTaskText,
  parseLooseDate,
  processTelegramUpdate,
  splitTask,
  initializeDb,
  readDb,
  writeDb
};
