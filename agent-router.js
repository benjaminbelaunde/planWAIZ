const {
  understandPlannerMessage,
  performOnlineLookup,
  finalizeAgentWithLookup,
  parseDeadlinePhrase
} = require("./ai");
const {
  DEFAULT_TIMEZONE,
  formatInTimeZone,
  toTimeZoneDateKey
} = require("./time-utils");

async function routeNaturalLanguageMessage({ messageText, db, helpers, config, dependencies = {} }) {
  const clarificationResult = await handlePendingClarification({
    messageText,
    db,
    helpers,
    config
  });
  if (clarificationResult) {
    return clarificationResult;
  }

  const contextualReply = handleContextualFollowUp(messageText, db, dependencies);
  if (contextualReply) {
    return {
      reply: contextualReply,
      agentResult: {
        intent: "context_follow_up",
        requestType: null
      },
      lookupResult: null,
      changed: false
    };
  }

  const eventFollowUp = handleEventDetailFollowUp(messageText, db);
  if (eventFollowUp) {
    return {
      reply: eventFollowUp,
      agentResult: {
        intent: "event_request",
        requestType: "event"
      },
      lookupResult: null,
      changed: false
    };
  }

  const contextSummary = buildPlannerContextSummary(db, dependencies);
  const resolveIntent = dependencies.resolveIntent || understandPlannerMessage;
  let agentResult = await resolveIntent({
    messageText,
    contextSummary,
    config
  });

  let lookupResult = null;
  if (agentResult.onlineLookup && shouldPerformLookup(agentResult, messageText)) {
    try {
      if (dependencies.lookupPlace) {
        const place = await dependencies.lookupPlace({
          query: agentResult.onlineLookup.query,
          reason: agentResult.onlineLookup.reason,
          contextSummary,
          config
        });
        lookupResult = buildLookupResultFromPlace(place);
        agentResult = finalizeAgentResultWithPlace(agentResult, lookupResult);
      } else {
        lookupResult = await performOnlineLookup({
          query: agentResult.onlineLookup.query,
          reason: agentResult.onlineLookup.reason,
          contextSummary,
          config
        });

        agentResult = await finalizeAgentWithLookup({
          messageText,
          contextSummary,
          initialResult: agentResult,
          lookupResult,
          config
        });
      }
    } catch (error) {
      console.error(`Event lookup failed: ${error.message}`);
      lookupResult = {
        answer: "Venue lookup is temporarily unavailable.",
        sources: [],
        selectedVenue: null
      };
      if (agentResult.intent === "event_request" && agentResult.eventPayload) {
        agentResult = {
          intent: "clarification_needed",
          requestType: "event",
          messageForUser: "I couldn’t look up a place right now, so I still need a specific location.",
          confidence: agentResult.confidence || 0.6,
          needsConfirmation: false,
          plannerAction: null,
          onlineLookup: null,
          clarificationQuestion: "Which specific place should I use?",
          missingFields: ["location"],
          assumptions: agentResult.assumptions || [],
          estimatedDuration: null,
          eventPayload: null
        };
      }
    }
  }

  const execution = await executePlannerAction(agentResult, db, helpers);
  const reply = buildUserReply(agentResult, lookupResult, execution);
  updatePendingClarification(db, agentResult, execution);

  return {
    reply,
    agentResult,
    lookupResult,
    changed: execution.changed
  };
}

async function handlePendingClarification({ messageText, db, helpers, config }) {
  const pending = db.meta?.pendingClarification;
  if (!pending || pending.kind !== "task" || !Array.isArray(pending.missingFields) || !pending.missingFields.includes("deadline")) {
    return null;
  }

  const deadline = parseDeadlinePhrase(messageText, config);
  if (!deadline) {
    return null;
  }

  const draft = pending.draft || {};
  const taskPayload = {
    ...draft,
    deadline,
    source: draft.source || "agent",
    assumptions: [
      ...(Array.isArray(draft.assumptions) ? draft.assumptions : []),
      `Captured deadline from follow-up reply: ${messageText.trim()}.`
    ]
  };
  const task = helpers.addTask(db, taskPayload);
  const plan = await helpers.generatePlan(db, {
    reason: "clarification_completed_task_added_and_planned"
  });
  db.meta.pendingClarification = null;

  return {
    reply: `Added task: ${task.title}.\n\n${summarizePlan(plan)}`,
    agentResult: {
      intent: "task_request",
      requestType: "task"
    },
    lookupResult: null,
    changed: true
  };
}

function buildPlannerContextSummary(db, dependencies = {}) {
  return {
    user: {
      name: db.user.name,
      workdayStart: db.user.workdayStart,
      workdayEnd: db.user.workdayEnd,
      activeWindow: db.user.activeWindow,
      gymName: db.user.gymName,
      healthyTaskTypes: db.user.healthyTaskTypes
    },
    tasks: (db.tasks || []).slice(-10).map((task) => ({
      id: task.id,
      title: task.title,
      estimatedDuration: task.estimatedDuration,
      priority: task.priority,
      deadline: task.deadline,
      status: task.status,
      assumptions: task.assumptions || []
    })),
    events: (db.events || []).slice(-10).map((event) => ({
      id: event.id,
      title: event.title,
      startTime: event.startTime,
      endTime: event.endTime,
      location: event.location,
      status: event.status,
      assumptions: event.assumptions || []
    })),
    plan: {
      status: db.plan.status,
      proposedBlocks: db.plan.blocks.filter((block) => block.status === "proposed").length,
      acceptedBlocks: db.plan.blocks.filter((block) => block.status === "accepted").length,
      tomorrowBlocks: summarizeBlocksForDay(db.plan.blocks || [], 1, dependencies),
      nextBlocks: db.plan.blocks.slice(0, 5).map((block) => ({
        title: block.title,
        startTime: block.startTime,
        endTime: block.endTime,
        status: block.status,
        kind: block.kind
      }))
    },
    conversation: {
      recentMessages: (db.meta?.conversationHistory || []).slice(-6),
      lastReferences: db.meta?.lastReferences || {}
    },
    externalCalendarSummary: (db.externalEvents || []).slice(0, 8).map((event) => ({
      title: event.summary || event.title || "Busy",
      startTime: event.startTime || event.start?.dateTime || event.start,
      endTime: event.endTime || event.end?.dateTime || event.end
    }))
  };
}

async function executePlannerAction(agentResult, db, helpers) {
  if (agentResult.intent === "clarification_needed" || agentResult.intent === "unsupported") {
    return { changed: false };
  }

  if (!agentResult.plannerAction) {
    return { changed: false };
  }

  switch (agentResult.plannerAction.type) {
    case "ADD_TASK": {
      const task = helpers.addTask(db, agentResult.plannerAction.payload);
      return { changed: true, task };
    }
    case "ADD_TASK_AND_PLAN": {
      const task = helpers.addTask(db, agentResult.plannerAction.payload);
      const plan = await helpers.generatePlan(db, {
        reason: "agent_task_added_and_planned"
      });
      return { changed: true, task, plan };
    }
    case "ADD_EVENT": {
      const event = helpers.addEvent(db, agentResult.plannerAction.payload);
      return { changed: true, event };
    }
    case "ADD_EVENT_AND_PLAN": {
      const event = helpers.addEvent(db, agentResult.plannerAction.payload);
      const plan = await helpers.generatePlan(db, {
        reason: "agent_event_added_and_planned"
      });
      return { changed: true, event, plan };
    }
    case "GENERATE_PLAN": {
      const plan = await helpers.generatePlan(db, agentResult.plannerAction.payload);
      return { changed: true, plan };
    }
    case "REPLAN": {
      const plan = await helpers.replan(db, agentResult.plannerAction.payload);
      return { changed: true, plan };
    }
    case "SPLIT_TASK": {
      const result = helpers.splitTask(db, agentResult.plannerAction.payload);
      return { changed: Boolean(result?.ok), splitResult: result };
    }
    case "UPDATE_PREFERENCES": {
      const user = helpers.updatePreferences(db, agentResult.plannerAction.payload);
      return { changed: true, user };
    }
    default:
      return { changed: false };
  }
}

function buildUserReply(agentResult, lookupResult, execution) {
  if (agentResult.intent === "clarification_needed") {
    return agentResult.clarificationQuestion || agentResult.messageForUser;
  }

  if (agentResult.intent === "unsupported") {
    return agentResult.messageForUser || "I understood the message, but I cannot act on it yet.";
  }

  let reply = agentResult.messageForUser;

  if (execution.event && execution.plan) {
    return formatCompactEventReply(execution.event, lookupResult, agentResult);
  } else if (execution.event) {
    reply = formatCompactEventReply(execution.event, lookupResult, agentResult);
  } else if (execution.task && execution.plan) {
    reply = `${reply}\n\nAdded task: ${execution.task.title}.\n\n${summarizePlan(execution.plan)}`;
  } else if (execution.task) {
    reply = `${reply}\n\nAdded task: ${execution.task.title}.`;
  } else if (execution.plan) {
    reply = `${reply}\n\n${summarizePlan(execution.plan)}`;
  } else if (execution.splitResult?.ok) {
    reply = `${reply}\n\nSplit task into ${execution.splitResult.tasks.length} parts.`;
  }

  if (lookupResult?.answer) {
    reply = `${reply}\n\n${lookupResult.answer}`;
  }

  const sourcesText = formatSources(
    lookupResult?.sources || execution.event?.lookupSources || []
  );
  if (sourcesText) {
    reply = `${reply}\n\nSources:\n${sourcesText}`;
  }

  return reply.trim();
}

function updatePendingClarification(db, agentResult, execution) {
  if (!db.meta) {
    db.meta = {};
  }

  if (execution?.changed) {
    db.meta.pendingClarification = null;
    return;
  }

  if (agentResult.intent === "clarification_needed" && agentResult.requestType === "task" && agentResult.missingFields?.includes("deadline")) {
    db.meta.pendingClarification = {
      kind: "task",
      missingFields: [...agentResult.missingFields],
      question: agentResult.clarificationQuestion || agentResult.messageForUser,
      draft: inferTaskDraftFromClarification(agentResult),
      createdAt: new Date().toISOString()
    };
    return;
  }

  if (agentResult.intent !== "clarification_needed") {
    db.meta.pendingClarification = null;
  }
}

function inferTaskDraftFromClarification(agentResult) {
  const payload = agentResult.plannerAction?.payload || {};
  return {
    title: payload.title || "",
    estimatedDuration: payload.estimatedDuration || agentResult.estimatedDuration || 60,
    priority: payload.priority || "medium",
    splittable: payload.splittable !== undefined ? Boolean(payload.splittable) : false,
    preferredTimeWindow: payload.preferredTimeWindow || "any",
    status: payload.status || "pending",
    source: payload.source || "agent",
    assumptions: Array.isArray(payload.assumptions) ? payload.assumptions : (Array.isArray(agentResult.assumptions) ? agentResult.assumptions : []),
    inferredEstimate: payload.inferredEstimate !== undefined ? Boolean(payload.inferredEstimate) : false
  };
}

function buildLookupResultFromPlace(place) {
  if (!place) {
    return {
      answer: "Venue lookup is temporarily unavailable.",
      sources: [],
      selectedVenue: null
    };
  }

  const venueName = place.name || place.displayLabel || "Selected venue";
  const venueAddress = place.address || "";
  return {
    answer: place.answer || `Selected place: ${place.displayLabel || venueName}.`,
    sources: Array.isArray(place.sources) ? place.sources : [],
    selectedVenue: {
      name: venueName,
      address: venueAddress,
      url: place.url || null
    }
  };
}

function finalizeAgentResultWithPlace(agentResult, lookupResult) {
  if (!(agentResult.intent === "event_request" && agentResult.eventPayload && lookupResult.selectedVenue)) {
    return {
      ...agentResult,
      messageForUser: lookupResult.answer || agentResult.messageForUser
    };
  }

  return {
    ...agentResult,
    messageForUser: agentResult.messageForUser || "I found a place and saved the event.",
    plannerAction: {
      type: "ADD_EVENT",
      payload: {
        ...agentResult.eventPayload,
        location: lookupResult.selectedVenue.name,
        address: lookupResult.selectedVenue.address,
        lookupSources: lookupResult.sources || []
      }
    }
  };
}

function formatCompactEventReply(event, lookupResult, agentResult) {
  const day = formatInTimeZone(event.startTime, { weekday: "short" }, DEFAULT_TIMEZONE);
  const startLabel = formatShortTime(event.startTime);
  const endLabel = formatShortTime(event.endTime);
  const venue = event.location ? ` at ${event.location}` : "";
  const lines = [
    `Saved ${humanizeEventTitle(event.title)}${venue}.`,
    `Proposed event: ${day} ${startLabel}-${endLabel}${venue}.`
  ];

  if (!event.location && lookupResult?.answer && agentResult?.intent === "event_request") {
    lines.push("Venue lookup is temporarily unavailable, so the event was saved without a place.");
  }

  return lines.join("\n");
}

function summarizePlan(plan) {
  return (plan.blocks || [])
    .slice(0, 5)
    .map((block) => `${formatShortDate(block.startTime)} ${formatShortTime(block.startTime)}-${formatShortTime(block.endTime)} ${block.title}`)
    .join("\n");
}

function formatShortDate(value) {
  return formatInTimeZone(value, { month: "short", day: "numeric" }, DEFAULT_TIMEZONE);
}

function formatShortTime(value) {
  return formatInTimeZone(value, { hour: "numeric", minute: "2-digit" }, DEFAULT_TIMEZONE);
}

function formatSources(sources) {
  return sources
    .filter((source) => source.url)
    .slice(0, 3)
    .map((source) => `- ${source.title}: ${source.url}`)
    .join("\n");
}

function handleEventDetailFollowUp(messageText, db) {
  const lower = String(messageText || "").trim().toLowerCase();
  if (!lower) {
    return null;
  }

  if (!/\b(why this place|show details|what assumptions did you make|assumptions|sources\??|why)\b/.test(lower)) {
    return null;
  }

  const latestEvent = [...(db.events || [])].reverse().find((event) => event.status === "proposed" || event.status === "accepted");
  if (!latestEvent) {
    return "I don’t have a recent event to explain yet.";
  }

  if (/\bsources\??\b/.test(lower)) {
    const sourcesText = formatSources(latestEvent.lookupSources || []);
    return sourcesText ? `Sources:\n${sourcesText}` : "I don’t have source links stored for that event.";
  }

  if (/\bassumptions|what assumptions did you make\b/.test(lower)) {
    const assumptions = latestEvent.assumptions || [];
    return assumptions.length
      ? `Assumptions:\n${assumptions.map((item) => `- ${item}`).join("\n")}`
      : "I didn’t have to make any notable assumptions for that event.";
  }

  if (/\bwhy this place|why\b/.test(lower)) {
    const source = (latestEvent.lookupSources || [])[0];
    if (latestEvent.location && source) {
      return `I picked ${latestEvent.location} as the best fit I found for your request. Source: ${source.url}`;
    }
    if (latestEvent.location) {
      return `I picked ${latestEvent.location} as the best fit I found for your request.`;
    }
    return "I don’t have venue-selection details stored for that event.";
  }

  if (/\bshow details\b/.test(lower)) {
    const details = [
      `${latestEvent.title}: ${formatShortDate(latestEvent.startTime)} ${formatShortTime(latestEvent.startTime)}-${formatShortTime(latestEvent.endTime)}${latestEvent.location ? ` at ${latestEvent.location}` : ""}.`
    ];
    if ((latestEvent.assumptions || []).length) {
      details.push(`Assumptions:\n${latestEvent.assumptions.map((item) => `- ${item}`).join("\n")}`);
    }
    const sourcesText = formatSources(latestEvent.lookupSources || []);
    if (sourcesText) {
      details.push(`Sources:\n${sourcesText}`);
    }
    return details.join("\n\n");
  }

  return null;
}

function handleContextualFollowUp(messageText, db, dependencies = {}) {
  const lower = String(messageText || "").trim().toLowerCase();
  if (!lower) {
    return null;
  }

  if (/\b(where is|where's)\b.*\b(dinner|event|reservation|date)\b.*\btomorrow\b/.test(lower)) {
    const event = findRelevantEvent(db, { keyword: "dinner", dayOffset: 1 }, dependencies);
    if (!event) {
      return "I don’t have a dinner event for tomorrow in the plan yet.";
    }
    const location = event.location || event.address || "the location is still unset";
    return `${event.title} tomorrow is ${location}. It’s scheduled for ${formatShortTime(event.startTime)}.`;
  }

  if (/\b(how('| i)?s|what('?s)?)( my)?\s+schedule\b.*\btomorrow\b/.test(lower) || /\bhow('?s)? my schdule\b.*\btomorrow\b/.test(lower)) {
    const summary = summarizeTomorrowSchedule(db, dependencies);
    return summary;
  }

  if (/\bwhere is it\b/.test(lower) || /\bwhere is that\b/.test(lower)) {
    const lastEvent = resolveLastReferencedEvent(db);
    if (!lastEvent) {
      return null;
    }
    const location = lastEvent.location || lastEvent.address || "the location is still unset";
    return `${lastEvent.title} is ${location}.`;
  }

  return null;
}

function summarizeTomorrowSchedule(db, dependencies = {}) {
  const blocks = summarizeBlocksForDay(db.plan?.blocks || [], 1, dependencies);
  if (!blocks.length) {
    return "Tomorrow looks mostly open right now.";
  }

  const lines = blocks.slice(0, 6).map((block) => {
    const location = block.location ? ` at ${block.location}` : "";
    return `- ${formatShortTime(block.startTime)}-${formatShortTime(block.endTime)} ${block.title}${location}`;
  });
  return `Tomorrow looks like:\n${lines.join("\n")}`;
}

function summarizeBlocksForDay(blocks, dayOffset, dependencies = {}) {
  const target = resolveNow(dependencies.now);
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() + dayOffset);
  const targetKey = toLocalDateKey(target);
  return [...blocks]
    .filter((block) => toLocalDateKey(block.startTime) === targetKey && block.status !== "skipped")
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

function findRelevantEvent(db, { keyword, dayOffset }, dependencies = {}) {
  const target = resolveNow(dependencies.now);
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() + dayOffset);
  const targetKey = toLocalDateKey(target);
  return [...(db.events || [])]
    .reverse()
    .find((event) => {
      const sameDay = toLocalDateKey(event.startTime) === targetKey;
      const matchesKeyword = !keyword || String(event.title || "").toLowerCase().includes(keyword);
      return sameDay && matchesKeyword;
    }) || null;
}

function resolveLastReferencedEvent(db) {
  const refId = db.meta?.lastReferences?.latestEventId;
  if (refId) {
    const exact = (db.events || []).find((event) => event.id === refId);
    if (exact) {
      return exact;
    }
  }
  return [...(db.events || [])].reverse()[0] || null;
}

function toLocalDateKey(value) {
  return toTimeZoneDateKey(value, DEFAULT_TIMEZONE);
}

function humanizeEventTitle(title) {
  if (!title) {
    return "your event";
  }
  const lower = String(title).toLowerCase();
  if (lower === "dinner") {
    return "your dinner";
  }
  if (lower === "lunch") {
    return "your lunch";
  }
  return title;
}

function shouldPerformLookup(agentResult, text) {
  if (agentResult.intent === "event_request") {
    return true;
  }
  const lower = String(text || "").toLowerCase();
  return /\b(weather|open|opening hours|hours|close|closing|traffic|commute|distance|venue|restaurant|cafe|forecast|rain|temperature)\b/.test(lower)
    && /(\?|what|when|where|is|are|does|do|how)/.test(lower);
}

function resolveNow(nowOverride) {
  if (typeof nowOverride === "function") {
    return new Date(nowOverride());
  }
  if (nowOverride) {
    return new Date(nowOverride);
  }
  return new Date();
}

module.exports = {
  routeNaturalLanguageMessage,
  buildPlannerContextSummary
};
