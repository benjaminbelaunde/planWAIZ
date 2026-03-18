const fs = require("fs");
const path = require("path");
const {
  DEFAULT_TIMEZONE,
  addDaysInTimeZone,
  combineDateAndTimeInTimeZone,
  formatInTimeZone,
  getTimeZoneParts,
  nextWeekdayInTimeZone,
  resolveNow,
  resolveTimeZone,
  startOfDayInTimeZone,
  zonedDateTimeToUtc
} = require("./time-utils");

const AGENT_PROMPT_PATH = path.join(__dirname, "prompts", "agent.md");
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const DEFAULT_ITEM_DURATION_MINUTES = 60;
const INTENTS = [
  "task_request",
  "event_request",
  "plan_request",
  "replan_request",
  "split_task",
  "setup_update",
  "online_lookup",
  "clarification_needed",
  "unsupported"
];
const MONTH_INDEX = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

function getAgentPrompt() {
  return fs.readFileSync(AGENT_PROMPT_PATH, "utf8");
}

function isAiConfigured(config) {
  return Boolean(config.openaiApiKey);
}

function buildAgentResultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "requestType",
      "messageForUser",
      "confidence",
      "needsConfirmation",
      "plannerAction",
      "onlineLookup",
      "clarificationQuestion",
      "missingFields",
      "assumptions",
      "estimatedDuration",
      "eventPayload"
    ],
    properties: {
      intent: { type: "string", enum: INTENTS },
      requestType: {
        anyOf: [
          { type: "null" },
          { type: "string", enum: ["task", "event"] }
        ]
      },
      messageForUser: { type: "string" },
      confidence: { type: "number" },
      needsConfirmation: { type: "boolean" },
      plannerAction: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "payload"],
            properties: {
              type: { type: "string" },
              payload: { type: "object", additionalProperties: true }
            }
          }
        ]
      },
      onlineLookup: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["query", "reason"],
            properties: {
              query: { type: "string" },
              reason: { type: "string" }
            }
          }
        ]
      },
      clarificationQuestion: {
        anyOf: [{ type: "null" }, { type: "string" }]
      },
      missingFields: {
        type: "array",
        items: { type: "string" }
      },
      assumptions: {
        type: "array",
        items: { type: "string" }
      },
      estimatedDuration: {
        anyOf: [{ type: "null" }, { type: "number" }]
      },
      eventPayload: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: true
          }
        ]
      }
    }
  };
}

function buildLookupSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["answer", "sources", "selectedVenue"],
    properties: {
      answer: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url"],
          properties: {
            title: { type: "string" },
            url: { type: "string" }
          }
        }
      },
      selectedVenue: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["name", "address"],
            properties: {
              name: { type: "string" },
              address: { type: "string" },
              url: {
                anyOf: [{ type: "null" }, { type: "string" }]
              }
            }
          }
        ]
      }
    }
  };
}

async function understandPlannerMessage({ messageText, contextSummary, config }) {
  if (!isAiConfigured(config)) {
    return finalizePlannerResult(heuristicUnderstand(messageText, contextSummary), messageText);
  }

  try {
    const response = await callOpenAI({
      config,
      schemaName: "agent_result",
      schema: buildAgentResultSchema(),
      instructions: getAgentPrompt(),
      input: [
        "User message:",
        messageText,
        "",
        "Planner context:",
        JSON.stringify(contextSummary, null, 2),
        "",
        "Return only structured JSON."
      ].join("\n")
    });

    return finalizePlannerResult(response, messageText, config);
  } catch (error) {
    console.error(`OpenAI understanding failed, falling back to heuristics: ${error.message}`);
    return finalizePlannerResult(heuristicUnderstand(messageText, contextSummary, config), messageText, config);
  }
}

async function finalizeAgentWithLookup({ messageText, contextSummary, initialResult, lookupResult, config }) {
  if (!isAiConfigured(config)) {
    if (initialResult.intent === "event_request" && initialResult.eventPayload && lookupResult.selectedVenue) {
      return finalizePlannerResult({
        ...initialResult,
        messageForUser: `I found a place and added it as a proposed event.`,
        plannerAction: {
          type: "ADD_EVENT_AND_PLAN",
          payload: {
            ...initialResult.eventPayload,
            location: lookupResult.selectedVenue.name,
            address: lookupResult.selectedVenue.address,
            lookupSources: lookupResult.sources || []
          }
        }
      }, messageText, config);
    }
    return finalizePlannerResult({
      ...initialResult,
      plannerAction: null,
      onlineLookup: null,
      eventPayload: initialResult.eventPayload
        ? {
            ...initialResult.eventPayload,
            location: ""
          }
        : null,
      messageForUser: lookupResult.answer || initialResult.messageForUser
    }, messageText, config);
  }

  try {
    const response = await callOpenAI({
      config,
      schemaName: "agent_result_with_lookup",
      schema: buildAgentResultSchema(),
      instructions: getAgentPrompt(),
      input: [
        "Original user message:",
        messageText,
        "",
        "Planner context:",
        JSON.stringify(contextSummary, null, 2),
        "",
        "Initial agent result:",
        JSON.stringify(initialResult, null, 2),
        "",
        "Online lookup findings:",
        JSON.stringify(lookupResult, null, 2),
        "",
        "If this is an event request, incorporate the selected venue into eventPayload and plannerAction.",
        "Return the final structured action and user-facing answer."
      ].join("\n")
    });

    return finalizePlannerResult(response, messageText, config);
  } catch (error) {
    console.error(`OpenAI finalization failed, preserving initial planner action: ${error.message}`);
    if (initialResult.intent === "event_request" && initialResult.eventPayload && lookupResult.selectedVenue) {
      return finalizePlannerResult({
        ...initialResult,
        messageForUser: "I found a place and added it as a proposed event.",
        plannerAction: {
          type: "ADD_EVENT_AND_PLAN",
          payload: {
            ...initialResult.eventPayload,
            location: lookupResult.selectedVenue.name,
            address: lookupResult.selectedVenue.address,
            lookupSources: lookupResult.sources || []
          }
        }
      }, messageText, config);
    }
    return finalizePlannerResult({
      ...initialResult,
      plannerAction: null,
      onlineLookup: null,
      eventPayload: initialResult.eventPayload
        ? {
            ...initialResult.eventPayload,
            location: ""
          }
        : null,
      messageForUser: lookupResult.answer || initialResult.messageForUser
    }, messageText, config);
  }
}

async function performOnlineLookup({ query, reason, contextSummary, config }) {
  if (!isAiConfigured(config)) {
    return {
      answer: "Online lookup is unavailable until OPENAI_API_KEY is configured.",
      sources: [],
      selectedVenue: null
    };
  }

  return callOpenAI({
    config,
    schemaName: "lookup_result",
    schema: buildLookupSchema(),
    instructions: [
      "You answer explicit factual questions for a planner assistant.",
      "When the query is a generic venue search, pick one best venue that fits the request and is likely open.",
      "Answer concisely and include source title/url pairs.",
      `Reason for lookup: ${reason}`
    ].join("\n"),
    input: [
      "Lookup query:",
      query,
      "",
      "Planner context:",
      JSON.stringify(contextSummary, null, 2),
      "",
      "Return only structured JSON."
    ].join("\n"),
    tools: [
      {
        type: "web_search_preview",
        search_context_size: "medium"
      }
    ]
  });
}

async function callOpenAI({ config, schemaName, schema, instructions, input, tools }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.openaiModel || DEFAULT_OPENAI_MODEL,
      instructions,
      input,
      tools: tools || [],
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          schema,
          strict: false
        }
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`OpenAI request failed: ${message}`);
  }

  const data = await response.json();
  const outputText = extractResponseText(data);
  return JSON.parse(outputText);
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  for (const item of data.output || []) {
    if (item.type !== "message") {
      continue;
    }
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        return content.text;
      }
    }
  }

  throw new Error("OpenAI response did not contain structured output text.");
}

function validateAgentResult(result) {
  const normalizedPlannerAction = normalizePlannerAction(result?.plannerAction, result?.eventPayload);
  const normalizedEventPayload = normalizeEventPayload(
    result?.eventPayload && typeof result.eventPayload === "object" ? result.eventPayload : null,
    normalizedPlannerAction?.payload || {}
  );
  const safe = {
    intent: INTENTS.includes(result?.intent) ? result.intent : "unsupported",
    requestType: result?.requestType === "task" || result?.requestType === "event" ? result.requestType : null,
    messageForUser: typeof result?.messageForUser === "string" ? result.messageForUser : "I could not understand that request.",
    confidence: Number.isFinite(result?.confidence) ? Number(result.confidence) : 0,
    needsConfirmation: Boolean(result?.needsConfirmation),
    plannerAction: normalizedPlannerAction,
    onlineLookup: result?.onlineLookup && typeof result.onlineLookup === "object"
      ? {
          query: String(result.onlineLookup.query || ""),
          reason: String(result.onlineLookup.reason || "")
        }
      : null,
    clarificationQuestion: typeof result?.clarificationQuestion === "string" ? result.clarificationQuestion : null,
    missingFields: Array.isArray(result?.missingFields) ? result.missingFields.map((item) => String(item)) : [],
    assumptions: Array.isArray(result?.assumptions) ? result.assumptions.map((item) => String(item)) : [],
    estimatedDuration: Number.isFinite(result?.estimatedDuration) ? Number(result.estimatedDuration) : null,
    eventPayload: normalizedEventPayload
  };

  if (safe.intent === "clarification_needed" && !safe.clarificationQuestion) {
    safe.clarificationQuestion = "What would you like me to change exactly?";
  }

  return safe;
}

function normalizePlannerAction(plannerAction, eventPayload) {
  if (!plannerAction || typeof plannerAction !== "object") {
    return null;
  }

  const rawType = String(plannerAction.type || "").trim();
  const rawPayload = plannerAction.payload && typeof plannerAction.payload === "object"
    ? plannerAction.payload
    : {};
  const typeMap = {
    create_event: "ADD_EVENT_AND_PLAN",
    add_event: "ADD_EVENT_AND_PLAN",
    create_task: "ADD_TASK",
    add_task: "ADD_TASK",
    generate_plan: "GENERATE_PLAN",
    replan_schedule: "REPLAN",
    update_setup: "UPDATE_PREFERENCES"
  };
  const normalizedType = typeMap[rawType.toLowerCase()] || rawType;

  return {
    type: normalizedType,
    payload: normalizeActionPayload(normalizedType, rawPayload, eventPayload)
  };
}

function normalizeActionPayload(type, payload, eventPayload) {
  if (type !== "ADD_EVENT_AND_PLAN" && type !== "ADD_EVENT") {
    return payload;
  }

  const source = eventPayload && typeof eventPayload === "object" ? eventPayload : {};
  return {
    ...payload,
    title: payload.title || source.title || "",
    startTime: payload.startTime || payload.start || source.startTime || source.start || null,
    endTime: payload.endTime || payload.end || source.endTime || source.end || null,
    location: payload.location || source.location || "",
    source: payload.source || source.source || "agent_event",
    status: payload.status || source.status || "proposed",
    assumptions: Array.isArray(payload.assumptions) ? payload.assumptions : (Array.isArray(source.assumptions) ? source.assumptions : []),
    lookupSources: Array.isArray(payload.lookupSources) ? payload.lookupSources : (Array.isArray(source.lookupSources) ? source.lookupSources : []),
    locked: payload.locked !== undefined ? Boolean(payload.locked) : (source.locked !== undefined ? Boolean(source.locked) : true)
  };
}

function normalizeEventPayload(eventPayload, plannerPayload) {
  if (!eventPayload && !plannerPayload) {
    return null;
  }

  const source = eventPayload && typeof eventPayload === "object" ? eventPayload : {};
  const payload = plannerPayload && typeof plannerPayload === "object" ? plannerPayload : {};
  if (!Object.keys(source).length && !Object.keys(payload).length) {
    return null;
  }

  return {
    ...source,
    title: source.title || payload.title || "",
    startTime: source.startTime || source.start || payload.startTime || payload.start || null,
    endTime: source.endTime || source.end || payload.endTime || payload.end || null,
    location: source.location || payload.location || "",
    source: source.source || payload.source || "agent_event",
    status: source.status || payload.status || "proposed",
    assumptions: Array.isArray(source.assumptions) ? source.assumptions : (Array.isArray(payload.assumptions) ? payload.assumptions : []),
    lookupSources: Array.isArray(source.lookupSources) ? source.lookupSources : (Array.isArray(payload.lookupSources) ? payload.lookupSources : []),
    locked: source.locked !== undefined ? Boolean(source.locked) : (payload.locked !== undefined ? Boolean(payload.locked) : true)
  };
}

function finalizePlannerResult(result, originalText, config = {}) {
  return applyCaptureRequirements(validateAgentResult(result), originalText, config);
}

function applyCaptureRequirements(result, originalText, config = {}) {
  if (result.intent === "task_request" && result.plannerAction?.type === "ADD_TASK") {
    return enforceTaskCaptureRequirements(result, originalText, config);
  }
  if (result.intent === "event_request" && result.plannerAction?.type === "ADD_EVENT_AND_PLAN") {
    return enforceEventCaptureRequirements(result, originalText, config);
  }
  return result;
}

function enforceTaskCaptureRequirements(result, originalText, config = {}) {
  const lower = String(originalText || "").toLowerCase();
  const title = String(result.plannerAction?.payload?.title || normalizeTaskTitle(originalText)).trim();
  const deadline = normalizeIsoString(result.plannerAction?.payload?.deadline) || parseDeadlinePhrase(extractDeadlinePhrase(originalText), config);
  const explicitDuration = detectDuration(lower);
  const estimatedDuration = Number(result.plannerAction?.payload?.estimatedDuration || explicitDuration || DEFAULT_ITEM_DURATION_MINUTES);
  const assumptions = Array.isArray(result.assumptions) ? [...result.assumptions] : [];

  if (!title || title.split(" ").length < 2) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: "task",
      messageForUser: "I need a bit more detail about that task.",
      confidence: 0.4,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: "What exactly is the task, and when is this due?",
      missingFields: ["title", "deadline"],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (!deadline) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: "task",
      messageForUser: "I need a deadline before I can add that task.",
      confidence: 0.7,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: "When is this due?",
      missingFields: ["deadline"],
      assumptions,
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (!explicitDuration && !assumptions.some((item) => item.includes("Defaulted task duration"))) {
    assumptions.push("Defaulted task duration to 60 minutes.");
  }

  return validateAgentResult({
    ...result,
    assumptions,
    estimatedDuration,
    plannerAction: {
      ...result.plannerAction,
      payload: {
        ...result.plannerAction.payload,
        text: `${title} in ${estimatedDuration}m by ${extractDeadlinePhrase(originalText) || deadline} priority ${detectPriority(lower)}`,
        title,
        estimatedDuration,
        deadline,
        source: result.plannerAction.payload?.source || "agent",
        assumptions,
        inferredEstimate: !explicitDuration
      }
    }
  });
}

function enforceEventCaptureRequirements(result, originalText, config = {}) {
  const lower = String(originalText || "").toLowerCase();
  const parsedSchedule = extractScheduleDetails(originalText, config);
  const explicitStartTime = parsedSchedule.startTime;
  const modeledStartTime = normalizeIsoString(result.eventPayload?.startTime || result.plannerAction?.payload?.startTime);
  const startTime = explicitStartTime || modeledStartTime;
  const specificLocation = String(result.eventPayload?.location || result.plannerAction?.payload?.location || "").trim();
  const durationMinutes = (!parsedSchedule.inferredDuration ? parsedSchedule.durationMinutes : null)
    || result.estimatedDuration
    || durationBetweenIsoStrings(result.eventPayload?.startTime || result.plannerAction?.payload?.startTime, result.eventPayload?.endTime || result.plannerAction?.payload?.endTime)
    || parsedSchedule.durationMinutes
    || ((specificLocation || result.onlineLookup) ? DEFAULT_ITEM_DURATION_MINUTES : null);
  const endTime = startTime ? addMinutes(startTime, durationMinutes).toISOString() : null;
  const title = String(result.eventPayload?.title || result.plannerAction?.payload?.title || parsedSchedule.title || inferEventTitle(lower)).trim() || "Event";
  const location = specificLocation;
  const assumptions = Array.isArray(result.assumptions) ? [...result.assumptions] : [];

  if (!startTime) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: "event",
      messageForUser: "I need a clear start time before I can add that event.",
      confidence: 0.8,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: parsedSchedule.clarificationQuestion || "What time does this start?",
      missingFields: parsedSchedule.missingFields.length ? parsedSchedule.missingFields : ["startTime"],
      assumptions,
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (!durationMinutes) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: "event",
      messageForUser: "I need the duration before I can add that event.",
      confidence: 0.82,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: parsedSchedule.clarificationQuestion || buildDurationClarificationQuestion(title),
      missingFields: ["duration"],
      assumptions,
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (parsedSchedule.inferredDuration && durationMinutes === DEFAULT_ITEM_DURATION_MINUTES && (location || result.onlineLookup) && !assumptions.some((item) => item.includes("Defaulted event duration"))) {
    assumptions.push("Defaulted event duration to 60 minutes.");
  }

  return validateAgentResult({
    ...result,
    assumptions,
    eventPayload: result.eventPayload
      ? {
          ...result.eventPayload,
          title,
          startTime,
          endTime,
          location,
          assumptions
        }
      : null,
    plannerAction: {
      ...result.plannerAction,
      payload: {
        ...result.plannerAction.payload,
        title,
        startTime,
        endTime,
        location,
        assumptions
      }
    }
  });
}

function heuristicUnderstand(messageText, contextSummary, config = {}) {
  const text = String(messageText || "").trim();
  const lower = text.toLowerCase();

  if (!text) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: null,
      messageForUser: "I need a little more detail to help.",
      confidence: 0.2,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: "What would you like me to plan or change?",
      missingFields: ["message"],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (looksLikeStandaloneLookup(lower)) {
    return validateAgentResult({
      intent: "online_lookup",
      requestType: null,
      messageForUser: "I can check that online.",
      confidence: 0.72,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: {
        query: text,
        reason: "Explicit factual request from the user."
      },
      clarificationQuestion: null,
      missingFields: [],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (looksLikeEventRequest(lower)) {
    return buildEventRequest(text, config, contextSummary);
  }

  if (/\b(plan|organize|schedule)\b/.test(lower)) {
    return validateAgentResult({
      intent: "plan_request",
      requestType: null,
      messageForUser: "I’ll generate a plan from your current tasks, events, and calendar context.",
      confidence: 0.78,
      needsConfirmation: false,
      plannerAction: {
        type: "GENERATE_PLAN",
        payload: {
          reason: "agent_plan_request"
        }
      },
      onlineLookup: null,
      clarificationQuestion: null,
      missingFields: [],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (/\b(late|delay|delayed|running behind)\b/.test(lower)) {
    const delayMinutes = Number(text.match(/(\d+)/)?.[1] || 30);
    return validateAgentResult({
      intent: "replan_request",
      requestType: null,
      messageForUser: `I’ll replan the remaining schedule with a ${delayMinutes} minute delay.`,
      confidence: 0.8,
      needsConfirmation: false,
      plannerAction: {
        type: "REPLAN",
        payload: {
          delayMinutes
        }
      },
      onlineLookup: null,
      clarificationQuestion: null,
      missingFields: [],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (/\b(split|break down|break that|parts?)\b/.test(lower)) {
    const parts = Number(text.match(/(\d+)/)?.[1] || 3);
    const matchedTask = findTaskByTitle(text, contextSummary.tasks);
    if (!matchedTask) {
      return validateAgentResult({
        intent: "clarification_needed",
        requestType: "task",
        messageForUser: "I’m not sure which task you want to split.",
        confidence: 0.45,
        needsConfirmation: false,
        plannerAction: null,
        onlineLookup: null,
        clarificationQuestion: "Which task should I split?",
        missingFields: ["task_reference"],
        assumptions: [],
        estimatedDuration: null,
        eventPayload: null
      });
    }
    return validateAgentResult({
      intent: "split_task",
      requestType: "task",
      messageForUser: `I’ll split ${matchedTask.title} into ${parts} parts.`,
      confidence: 0.74,
      needsConfirmation: false,
      plannerAction: {
        type: "SPLIT_TASK",
        payload: {
          taskId: matchedTask.id,
          parts
        }
      },
      onlineLookup: null,
      clarificationQuestion: null,
      missingFields: [],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  if (/\b(my gym is|workday|work day|active window|break cadence)\b/.test(lower)) {
    const payload = {};
    const gymMatch = text.match(/my gym is\s+(.+)$/i);
    const workdayStartMatch = text.match(/workday starts? at\s+(\d{1,2}:\d{2})/i);
    const workdayEndMatch = text.match(/workday ends? at\s+(\d{1,2}:\d{2})/i);
    if (gymMatch) {
      payload.gymName = gymMatch[1].trim();
    }
    if (workdayStartMatch) {
      payload.workdayStart = workdayStartMatch[1];
    }
    if (workdayEndMatch) {
      payload.workdayEnd = workdayEndMatch[1];
    }
    return validateAgentResult({
      intent: "setup_update",
      requestType: null,
      messageForUser: "I’ll update your planner preferences.",
      confidence: 0.65,
      needsConfirmation: false,
      plannerAction: {
        type: "UPDATE_PREFERENCES",
        payload
      },
      onlineLookup: null,
      clarificationQuestion: null,
      missingFields: Object.keys(payload).length ? [] : ["preferences"],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  return buildTaskRequest(text, config);
}

function buildTaskRequest(text, config = {}) {
  const lower = text.toLowerCase();
  const normalizedTitle = normalizeTaskTitle(text);
  if (!normalizedTitle || normalizedTitle.split(" ").length < 2) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: "task",
      messageForUser: "I need a bit more detail about that task.",
      confidence: 0.4,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: "What exactly is the task, and when do you need it done?",
      missingFields: ["title", "deadline"],
      assumptions: [],
      estimatedDuration: null,
      eventPayload: null
    });
  }

  const estimatedDuration = detectDuration(lower) || DEFAULT_ITEM_DURATION_MINUTES;
  const assumptions = [];
  if (!detectDuration(lower)) {
    assumptions.push("Defaulted task duration to 60 minutes.");
  }

  const deadlinePhrase = extractDeadlinePhrase(text);
  if (!deadlinePhrase) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: "task",
      messageForUser: "I need a deadline before I can add that task.",
      confidence: 0.7,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: "When is this due?",
      missingFields: ["deadline"],
      assumptions,
      estimatedDuration: null,
      eventPayload: null
    });
  }

  return validateAgentResult({
    intent: "task_request",
    requestType: "task",
    messageForUser: "I’ll add that task and estimate the time needed.",
    confidence: 0.74,
    needsConfirmation: false,
    plannerAction: {
      type: "ADD_TASK",
      payload: {
        text: `${normalizedTitle} in ${estimatedDuration}m${deadlinePhrase ? ` by ${deadlinePhrase}` : ""} priority ${detectPriority(lower)}`,
        title: normalizedTitle,
        estimatedDuration,
        deadline: parseDeadlinePhrase(deadlinePhrase, config),
        source: "agent",
        assumptions,
        inferredEstimate: !detectDuration(lower)
      }
    },
    onlineLookup: null,
    clarificationQuestion: null,
    missingFields: [],
    assumptions,
    estimatedDuration,
    eventPayload: null
  });
}

function buildEventRequest(text, config = {}, contextSummary = {}) {
  const lower = text.toLowerCase();
  const parsedSchedule = extractScheduleDetails(text, config);
  if (!parsedSchedule.startTime) {
    return validateAgentResult({
      intent: "clarification_needed",
      requestType: "event",
      messageForUser: "I need a clear start time before I can add that event.",
      confidence: 0.8,
      needsConfirmation: false,
      plannerAction: null,
      onlineLookup: null,
      clarificationQuestion: parsedSchedule.clarificationQuestion || "What time does this start?",
      missingFields: parsedSchedule.missingFields.length ? parsedSchedule.missingFields : ["startTime"],
      assumptions: parsedSchedule.assumptions,
      estimatedDuration: null,
      eventPayload: null
    });
  }
  const specificLocation = extractSpecificLocation(text);
  const contextualLocation = inferContextualLocation(lower, contextSummary);
  const resolvedLocation = specificLocation || contextualLocation;
  const mealAreaContext = extractMealAreaContext(text, parsedSchedule.title || inferEventTitle(lower));
  const genericVenue = extractGenericVenuePhrase(text) || mealAreaContext;
  const title = chooseEventTitle({
    lower,
    parsedTitle: parsedSchedule.title,
    genericVenue,
    resolvedLocation
  });
  const duration = parsedSchedule.durationMinutes;
  const assumptions = [...parsedSchedule.assumptions];
  if (parsedSchedule.inferredDuration) {
    assumptions.push("Defaulted event duration to 60 minutes.");
  }
  if (contextualLocation && !specificLocation) {
    assumptions.push(`Used the user's regular gym location: ${contextualLocation}.`);
  }
  const eventPayload = {
    title,
    startTime: parsedSchedule.startTime,
    endTime: new Date(new Date(parsedSchedule.startTime).getTime() + duration * 60000).toISOString(),
    location: resolvedLocation,
    source: "agent_event",
    status: "proposed",
    assumptions,
    lookupSources: [],
    locked: true
  };

  if (genericVenue) {
    assumptions.push(`Assumed ${formatShortAssumptionTime(parsedSchedule.startTime)} for this event while searching for a venue.`);
    return validateAgentResult({
      intent: "event_request",
      requestType: "event",
      messageForUser: `I’ll find one good option and add it as a proposed event.`,
      confidence: 0.78,
      needsConfirmation: false,
      plannerAction: {
        type: "ADD_EVENT_AND_PLAN",
        payload: eventPayload
      },
      onlineLookup: {
        query: `${genericVenue} open ${formatLookupTime(parsedSchedule.startTime)}`,
        reason: "The user asked for a generic venue-based event and needs a specific place."
      },
      clarificationQuestion: null,
      missingFields: [],
      assumptions,
      estimatedDuration: null,
      eventPayload
    });
  }

  return validateAgentResult({
    intent: "event_request",
    requestType: "event",
    messageForUser: "I’ll add that as a fixed event in your plan.",
    confidence: 0.8,
    needsConfirmation: false,
    plannerAction: {
      type: "ADD_EVENT_AND_PLAN",
      payload: eventPayload
    },
    onlineLookup: null,
    clarificationQuestion: null,
    missingFields: [],
    assumptions,
    estimatedDuration: null,
    eventPayload
  });
}

function findTaskByTitle(messageText, tasks) {
  const lower = messageText.toLowerCase();
  return (tasks || []).find((task) => {
    const title = String(task.title || "").toLowerCase();
    return title && lower.includes(title);
  }) || null;
}

function looksLikeEventRequest(lower) {
  const eventNouns = /\b(dinner|lunch|breakfast|brunch|meeting|call|appointment|reservation|party|concert|movie|flight|doctor|dentist|coffee|date|gym|yoga|session|workout|deep work|quick call|coworking)\b/;
  const errandSignal = /\b(pick up|pickup|drop off|dropoff)\b/;
  const fixedTimeSignal = /\b(at\s+\d|today|tomorrow|tonight|this evening|morning|afternoon|evening|night|on\s+\w+day|next\s+\w+day|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}:\d{2}|\d{1,2}\s*(am|pm))\b/;
  const taskLikeVerb = /\b(finish|prep|prepare|draft|write|build|create|review|analyze|research|send|fix|complete)\b/;
  if (!eventNouns.test(lower) && !errandSignal.test(lower) && taskLikeVerb.test(lower)) {
    return false;
  }
  return eventNouns.test(lower) || errandSignal.test(lower) || fixedTimeSignal.test(lower) && /\b(with|at|in|on|today|tomorrow|tonight|evening|night|morning)\b/.test(lower);
}

function looksLikeStandaloneLookup(lower) {
  return /\b(weather|open|opening hours|hours|close|closing time|traffic|commute|distance|venue|restaurant|cafe|gym hours|forecast|rain|temperature)\b/.test(lower)
    && /(\?|what|when|where|is|are|does|do|how)/.test(lower);
}

function normalizeTaskTitle(text) {
  return String(text || "")
    .replace(/^(i need to|please|can you|could you|add)\s+/i, "")
    .replace(/\bby\s+.+$/i, "")
    .replace(/\bin\s+\d+\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i, "")
    .trim();
}

function extractDeadlinePhrase(text) {
  const explicitBy = String(text || "").match(/\bby\s+(.+)$/i);
  return explicitBy ? explicitBy[1].trim() : "";
}

function detectDuration(lower) {
  const match = lower.match(/(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return match[2].startsWith("h") ? value * 60 : value;
}

function estimateTaskDurationFromComplexity(lower) {
  return DEFAULT_ITEM_DURATION_MINUTES;
}

function detectPriority(lower) {
  if (/\b(high|urgent|asap|important)\b/.test(lower)) {
    return "high";
  }
  if (/\b(low|later|someday)\b/.test(lower)) {
    return "low";
  }
  return "medium";
}

function inferEventTitle(lower) {
  if (/\bdinner\b/.test(lower)) {
    return "Dinner";
  }
  if (/\blunch\b/.test(lower)) {
    return "Lunch";
  }
  if (/\bmeeting\b/.test(lower)) {
    return "Meeting";
  }
  if (/\bcoffee\b/.test(lower)) {
    return "Coffee";
  }
  if (/\bcoworking\b/.test(lower)) {
    return "Coworking";
  }
  if (/\bgym\b/.test(lower)) {
    return "Gym";
  }
  if (/\byoga\b/.test(lower)) {
    return "Yoga session";
  }
  if (/\bappointment\b/.test(lower)) {
    return "Appointment";
  }
  if (/\bflight\b/.test(lower)) {
    return "Flight";
  }
  return "Event";
}

function inferEventDuration(lower) {
  return DEFAULT_ITEM_DURATION_MINUTES;
}

function extractScheduleDetails(text, config = {}) {
  const original = String(text || "").trim();
  const lower = original.toLowerCase();
  const timeZone = resolveTimeZone(config.timezone || DEFAULT_TIMEZONE);
  const now = resolveNow(config.now);
  const assumptions = [];
  const dateInfo = extractScheduleDate(lower, now, timeZone);
  const rangeInfo = extractTimeRange(lower);
  const singleTime = rangeInfo ? null : extractSingleTime(lower);
  const timeOfDay = rangeInfo || singleTime ? null : extractTimeOfDay(lower);
  const hasTimeSignal = Boolean(rangeInfo || singleTime || timeOfDay);
  const hasTemporalSignal = Boolean(dateInfo.hasSignal || hasTimeSignal);

  let targetDate = dateInfo.date;
  if (!targetDate && hasTimeSignal) {
    targetDate = startOfDayInTimeZone(now, timeZone);
  }

  if (dateInfo.assumption) {
    assumptions.push(dateInfo.assumption);
  }

  let startTime = null;
  let durationMinutes = null;
  if (targetDate && rangeInfo) {
    startTime = combineDateAndTimeInTimeZone(targetDate, rangeInfo.startLabel, timeZone).toISOString();
    const endTime = combineDateAndTimeInTimeZone(targetDate, rangeInfo.endLabel, timeZone);
    durationMinutes = Math.max(0, Math.round((endTime - new Date(startTime)) / 60000));
  } else if (targetDate && singleTime) {
    startTime = combineDateAndTimeInTimeZone(targetDate, singleTime.label, timeZone).toISOString();
  } else if (targetDate && timeOfDay) {
    startTime = combineDateAndTimeInTimeZone(targetDate, timeOfDay.label, timeZone).toISOString();
  }

  const explicitDuration = durationMinutes || detectDuration(lower);
  const inferredDuration = !explicitDuration;
  durationMinutes = explicitDuration || DEFAULT_ITEM_DURATION_MINUTES;

  const title = normalizeScheduleTitle(original) || inferEventTitle(lower);
  const clarificationQuestion = !startTime
    ? buildStartClarificationQuestion({ hasDateSignal: dateInfo.hasSignal, hasTimeSignal, hasExplicitDuration: Boolean(explicitDuration) })
    : null;
  const missingFields = !startTime
    ? ["startTime"]
    : [];

  return {
    title,
    startTime,
    endTime: startTime && durationMinutes ? addMinutes(startTime, durationMinutes).toISOString() : null,
    durationMinutes,
    inferredDuration,
    missingFields,
    clarificationQuestion,
    assumptions,
    hasDateSignal: dateInfo.hasSignal,
    hasTimeSignal,
    hasTemporalSignal
  };
}

function inferEventTiming(text, config = {}) {
  const lower = String(text || "").toLowerCase();
  const timeZone = resolveTimeZone(config.timezone || DEFAULT_TIMEZONE);
  const now = resolveNow(config.now);
  const base = startOfDayInTimeZone(now, timeZone);
  const assumptions = [];
  const weekdayTime = extractWeekdayTime(lower, now, timeZone);
  if (weekdayTime) {
    assumptions.push(weekdayTime.assumption);
    return {
      startTime: weekdayTime.startTime,
      assumptions
    };
  }

  const tomorrowTime = lower.match(/\btomorrow(?:\s+(?:at|before))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (tomorrowTime) {
    const target = addDaysInTimeZone(base, 1, timeZone);
    const hhmm = `${String(normalizeHour(tomorrowTime[1], tomorrowTime[3])).padStart(2, "0")}:${String(Number(tomorrowTime[2] || 0)).padStart(2, "0")}`;
    return { startTime: combineDateAndTimeInTimeZone(target, hhmm, timeZone).toISOString(), assumptions };
  }

  const explicitTime = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (explicitTime) {
    const target = /\btomorrow\b/.test(lower) ? addDaysInTimeZone(base, 1, timeZone) : base;
    const hhmm = `${String(normalizeHour(explicitTime[1], explicitTime[3])).padStart(2, "0")}:${String(Number(explicitTime[2] || 0)).padStart(2, "0")}`;
    return { startTime: combineDateAndTimeInTimeZone(target, hhmm, timeZone).toISOString(), assumptions };
  }

  return { startTime: null, assumptions };
}

function extractGenericVenuePhrase(text) {
  const lower = String(text || "").toLowerCase();
  const normalized = lower
    .replace(/^(find|save|schedule|add)\s+/i, "")
    .replace(/\bon\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, "")
    .replace(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, "")
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, "")
    .replace(/\btomorrow\b.*$/i, "")
    .replace(/\btoday\b.*$/i, "")
    .replace(/\btonight\b.*$/i, "")
    .replace(/\bthis evening\b.*$/i, "")
    .replace(/\bfor\s+\d+\s*(m|min|mins|minutes|h|hr|hrs|hours)\b.*$/i, "")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b.*$/i, "")
    .replace(/\b\d{1,2}:\d{2}\b.*$/i, "")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)\b.*$/i, "")
    .replace(/\bat\s*$/i, "")
    .trim();
  const match = normalized.match(/\b(?:at\s+)?(a|an)\s+([a-z\s]+?)\s+in\s+([a-z\s]+)$/);
  if (match && isGenericVenueDescriptor(match[2].trim())) {
    return `${match[2].trim()} in ${match[3].trim()}`;
  }
  if (/\bpizza place in berkeley\b/.test(lower)) {
    return "pizza place in Berkeley";
  }
  return "";
}

function extractMealAreaContext(text, title) {
  const mealMatch = String(title || "").match(/\b(Lunch|Dinner|Breakfast|Brunch)\b/i);
  if (!mealMatch) {
    return "";
  }
  const original = String(text || "").trim();
  const match = original.match(/\bin\s+([A-Za-z][A-Za-z\s]+?)(?=\s+\b(on|next|tomorrow|tonight|this|at|with)\b|$)/i);
  if (!match) {
    return "";
  }
  const area = match[1].trim();
  return `${mealMatch[1].toLowerCase()} spot in ${area}`;
}

function extractSpecificLocation(text) {
  const matches = [...String(text || "").matchAll(/\bat\s+([^,.!?]+?)(?=\s+\bat\b|$)/gi)];
  const explicit = matches.at(-1);
  if (explicit && !/\d/.test(explicit[1]) && !/^(a|an)\s+/i.test(explicit[1].trim())) {
    return explicit[1].trim();
  }
  return "";
}

function inferContextualLocation(lower, contextSummary = {}) {
  if (/\bgym\b/.test(lower)) {
    const gymName = String(contextSummary?.user?.gymName || "").trim();
    if (gymName) {
      return gymName;
    }
  }
  return "";
}

function chooseEventTitle({ lower, parsedTitle, genericVenue, resolvedLocation }) {
  const inferredTitle = inferEventTitle(lower);
  if (!parsedTitle) {
    return inferredTitle;
  }
  if (resolvedLocation && /\bgym\b/.test(lower)) {
    return "Gym";
  }
  if (genericVenue && /\bcoworking\b/.test(lower)) {
    return "Coworking";
  }
  if (genericVenue && inferredTitle !== "Event" && /\b(lunch|dinner|coffee|breakfast|brunch)\b/.test(lower)) {
    return inferredTitle;
  }
  return parsedTitle;
}

function isGenericVenueDescriptor(value) {
  return /\b(place|restaurant|cafe|bar|spot|deli|coffee shop|coworking(?: space)?|workspace|thai place|pizza place)\b/.test(String(value || "").toLowerCase());
}

function normalizeScheduleTitle(text) {
  const cleaned = String(text || "")
    .replace(/^(add|save|schedule)\s+/i, "")
    .replace(/\(\s*\d+\s*(m|min|mins|minutes|h|hr|hrs|hours)\s*\)/gi, " ")
    .replace(/\bfor\s+\d+\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/gi, " ")
    .replace(/\b\d+\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/gi, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(am|pm)?\s*(to|-)\s*\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, " ")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, " ")
    .replace(/\b\d{1,2}(?::\d{2})\b/gi, " ")
    .replace(/\b\d{1,2}\s*(am|pm)\b/gi, " ")
    .replace(/\b(today|tomorrow|tonight|morning|afternoon|evening|night)\b/gi, " ")
    .replace(/\b(?:on\s+|next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, " ")
    .replace(/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi, " ")
    .replace(/\b(?:at|in)\s+[A-Za-z][A-Za-z0-9'&.\-\s]+$/i, " ")
    .replace(/\b(on|at|for|to)\b/gi, " ")
    .replace(/[(),]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(a|an)\s+/i, "")
    .trim();
  return cleaned ? `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}` : "";
}

function buildStartClarificationQuestion({ hasDateSignal, hasTimeSignal, hasExplicitDuration }) {
  if (hasExplicitDuration) {
    return "When should I schedule this?";
  }
  if (hasDateSignal && !hasTimeSignal) {
    return "What time does this start?";
  }
  return "When is this happening?";
}

function buildDurationClarificationQuestion(title) {
  const lower = String(title || "").toLowerCase();
  if (/\bappointment\b/.test(lower)) {
    return "How long is the appointment?";
  }
  if (/\b(lunch|meeting|session)\b/.test(lower)) {
    return "How long will this last?";
  }
  return "What is the duration?";
}

function extractScheduleDate(lower, now, timeZone) {
  if (/\btoday\b/.test(lower)) {
    return {
      date: startOfDayInTimeZone(now, timeZone),
      hasSignal: true,
      assumption: null
    };
  }

  if (/\btomorrow\b/.test(lower)) {
    return {
      date: startOfDayInTimeZone(addDaysInTimeZone(now, 1, timeZone), timeZone),
      hasSignal: true,
      assumption: null
    };
  }

  const weekdayMatch = lower.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekdayMatch) {
    const weekday = weekdayMatch[2];
    return {
      date: startOfDayInTimeZone(nextWeekdayInTimeZone(now, weekday, Boolean(weekdayMatch[1]), timeZone), timeZone),
      hasSignal: true,
      assumption: `Assumed ${capitalizeWeekday(weekday)} means the next upcoming ${capitalizeWeekday(weekday)} in the user's timezone.`
    };
  }

  const monthMatch = lower.match(/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/);
  if (monthMatch) {
    const localNow = getTimeZoneParts(now, timeZone);
    let year = Number(monthMatch[3] || localNow.year);
    const month = MONTH_INDEX[monthMatch[1]];
    const day = Number(monthMatch[2]);
    let candidate = zonedDateTimeToUtc({
      year,
      month,
      day,
      hour: 0,
      minute: 0,
      second: 0
    }, timeZone);

    if (!monthMatch[3]) {
      const localToday = zonedDateTimeToUtc({
        year: localNow.year,
        month: localNow.month,
        day: localNow.day,
        hour: 0,
        minute: 0,
        second: 0
      }, timeZone);
      if (candidate < localToday) {
        year += 1;
        candidate = zonedDateTimeToUtc({
          year,
          month,
          day,
          hour: 0,
          minute: 0,
          second: 0
        }, timeZone);
      }
    }

    return {
      date: candidate,
      hasSignal: true,
      assumption: null
    };
  }

  return {
    date: null,
    hasSignal: false,
    assumption: null
  };
}

function extractTimeRange(lower) {
  const rangeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!rangeMatch) {
    return null;
  }

  const startLabel = buildTimeLabel(rangeMatch[1], rangeMatch[2], rangeMatch[3], rangeMatch[6]);
  const endLabel = buildTimeLabel(rangeMatch[4], rangeMatch[5], rangeMatch[6], null);
  if (!startLabel || !endLabel) {
    return null;
  }

  return {
    startLabel,
    endLabel
  };
}

function extractSingleTime(lower) {
  const meridiemMatch = lower.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (meridiemMatch) {
    return {
      label: buildTimeLabel(meridiemMatch[1], meridiemMatch[2], meridiemMatch[3], null)
    };
  }

  const militaryMatch = lower.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (militaryMatch) {
    return {
      label: `${String(Number(militaryMatch[1])).padStart(2, "0")}:${militaryMatch[2]}`
    };
  }

  return null;
}

function extractTimeOfDay(lower) {
  if (/\bmorning\b/.test(lower)) {
    return { label: "09:00" };
  }
  if (/\bafternoon\b/.test(lower)) {
    return { label: "15:00" };
  }
  if (/\b(evening|night|tonight)\b/.test(lower)) {
    return { label: "19:00" };
  }
  return null;
}

function buildTimeLabel(hour, minute, meridiem, fallbackMeridiem) {
  const resolvedHour = normalizeHour(hour, meridiem || fallbackMeridiem || "");
  if (!Number.isFinite(resolvedHour)) {
    return null;
  }
  return `${String(resolvedHour).padStart(2, "0")}:${String(Number(minute || 0)).padStart(2, "0")}`;
}

function formatLookupTime(isoString) {
  return formatInTimeZone(isoString, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }, DEFAULT_TIMEZONE);
}

function formatShortAssumptionTime(isoString) {
  return formatInTimeZone(isoString, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit"
  }, DEFAULT_TIMEZONE);
}

function addMinutes(value, minutes) {
  return new Date(new Date(value).getTime() + Number(minutes || 0) * 60000);
}

function normalizeIsoString(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function durationBetweenIsoStrings(startTime, endTime) {
  const start = normalizeIsoString(startTime);
  const end = normalizeIsoString(endTime);
  if (!start || !end) {
    return null;
  }
  const minutes = Math.round((new Date(end) - new Date(start)) / 60000);
  return minutes > 0 ? minutes : null;
}

function parseDeadlinePhrase(value, config = {}) {
  const normalizedValue = normalizeLooseDateInput(value);
  const lower = String(normalizedValue || "").trim().toLowerCase();
  if (!lower) {
    return null;
  }
  const timeZone = resolveTimeZone(config.timezone || DEFAULT_TIMEZONE);
  const now = resolveNow(config.now);
  const tomorrowMatch = lower.match(/^tomorrow(?:\s+at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (lower === "tomorrow") {
    return addDaysInTimeZone(now, 1, timeZone).toISOString();
  }
  if (tomorrowMatch) {
    const target = addDaysInTimeZone(now, 1, timeZone);
    const hhmm = `${String(normalizeHour(tomorrowMatch[1], tomorrowMatch[3])).padStart(2, "0")}:${String(Number(tomorrowMatch[2] || 0)).padStart(2, "0")}`;
    return combineDateAndTimeInTimeZone(target, hhmm, timeZone).toISOString();
  }
  const weekdayMatch = lower.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at)?\s*(\d{1,2})?(?::(\d{2}))?\s*(am|pm)?$/);
  if (weekdayMatch) {
    const target = nextWeekdayInTimeZone(now, weekdayMatch[1], false, timeZone);
    if (weekdayMatch[2]) {
      const hhmm = `${String(normalizeHour(weekdayMatch[2], weekdayMatch[4])).padStart(2, "0")}:${String(Number(weekdayMatch[3] || 0)).padStart(2, "0")}`;
      return combineDateAndTimeInTimeZone(target, hhmm, timeZone).toISOString();
    } else {
      return combineDateAndTimeInTimeZone(target, "17:00", timeZone).toISOString();
    }
  }
  const parsed = new Date(normalizedValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

function formatHourLabel(date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function extractWeekdayTime(lower, now, timeZone) {
  const weekdayMatch = lower.match(/\b(?:on\s+|next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s+(?:at\s+)?)?(\d{1,2})?(?::(\d{2}))?\s*(am|pm)?/);
  if (!weekdayMatch || !weekdayMatch[2]) {
    return null;
  }

  const weekday = weekdayMatch[1];
  const hour = weekdayMatch[2];
  const minute = weekdayMatch[3];
  const meridiem = weekdayMatch[4];
  const target = nextWeekdayInTimeZone(now, weekday, /\bnext\s+/.test(lower), timeZone);
  if (hour) {
    const hhmm = `${String(normalizeHour(hour, meridiem)).padStart(2, "0")}:${String(Number(minute || 0)).padStart(2, "0")}`;
    const zonedTarget = combineDateAndTimeInTimeZone(target, hhmm, timeZone);
    return {
      startTime: zonedTarget.toISOString(),
      assumption: `Assumed ${capitalizeWeekday(weekday)} means the next upcoming ${capitalizeWeekday(weekday)} in the user's timezone.`
    };
  }

}

function capitalizeWeekday(value) {
  const str = String(value || "");
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

module.exports = {
  understandPlannerMessage,
  performOnlineLookup,
  finalizeAgentWithLookup,
  parseDeadlinePhrase,
  extractScheduleDetails,
  validateAgentResult,
  isAiConfigured
};
