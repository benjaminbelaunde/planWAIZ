const {
  createTaskFromInput,
  processTelegramUpdate,
  config,
  readDb,
  writeDb
} = require("./server");

async function main() {
  const originalOpenAiKey = config.openaiApiKey;
  try {
    config.openaiApiKey = "";

    const db = {
      user: {
        name: "Demo User",
        workdayStart: "09:00",
        workdayEnd: "18:00",
        planHorizonDays: 7,
        breakCadenceMinutes: 120,
        activeWindow: "17:00-20:00",
        timezone: "America/Los_Angeles",
        wellnessMode: "suggestions",
        gymName: "Momentum Gym",
        healthyTaskTypes: ["walk", "gym"]
      },
      tasks: [
        createTaskFromInput({ text: "Finish investor deck in 180m by tomorrow 5pm priority high" }),
        createTaskFromInput({ text: "Draft onboarding copy in 90m priority medium" }),
        createTaskFromInput({ text: "Break down launch checklist in 120m by Friday 3pm priority high split" })
      ],
      events: [],
      externalEvents: [
        {
          id: "evt_1",
          summary: "Existing standup",
          startTime: new Date().setHours(10, 0, 0, 0),
          endTime: new Date().setHours(10, 30, 0, 0)
        }
      ],
      plan: {
        id: "plan_demo",
        status: "draft",
        blocks: [],
        notes: []
      },
      meta: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };
    writeDb(db);

    await processTelegramUpdate({ message: { text: "Plan my week around my meetings", chat: { id: 111 } } });
    await processTelegramUpdate({ message: { text: "I'm 45 minutes late", chat: { id: 111 } } });
    await processTelegramUpdate({ message: { text: "Break down launch checklist into 3 parts", chat: { id: 111 } } });
    await processTelegramUpdate({ message: { text: "I need to prep demo script in 45m by tomorrow 11am priority high", chat: { id: 111 } } });

    const finalDb = readDb();
    const plan = finalDb.plan;

    if (!plan.blocks.length) {
      throw new Error("Planner did not generate any blocks.");
    }

    const taskBlocks = plan.blocks.filter((block) => block.source === "task");
    const healthBlocks = plan.blocks.filter((block) => block.source === "health");
    const splitTasks = finalDb.tasks.filter((task) => task.title.includes("Break down launch checklist (Part"));
    const addedTask = finalDb.tasks.find((task) => task.title === "prep demo script");

    if (splitTasks.length !== 3) {
      throw new Error("Natural-language split flow failed.");
    }

    if (!addedTask) {
      throw new Error("Natural-language add-task flow failed.");
    }

    if (!taskBlocks.length) {
      throw new Error("Plan generation did not schedule any task blocks.");
    }

    console.log("Smoke test passed.");
    console.log(`Generated ${taskBlocks.length} task blocks and ${healthBlocks.length} healthy suggestion(s).`);
    console.log(plan.blocks.slice(0, 6));
  } finally {
    config.openaiApiKey = originalOpenAiKey;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
