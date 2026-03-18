# Assistive Weekly Planner MVP

Hackathon-ready MVP for a Telegram-driven day and week planner with a lightweight web calendar UI, separate task and event planning, rule-based scheduling, task splitting, replanning, and optional healthy activity suggestions.

## What is included

- Zero-dependency Node.js server
- Telegram webhook and command parser
- LLM-backed natural language agent with prompt file and tool router
- Separate `Task` and immutable `Event` request handling
- Google Calendar read/write hooks using manual access tokens
- Rule-based scheduling engine
- Persistent local JSON storage
- Lightweight week-view web UI

## Quick start

1. Copy `.env.example` to `.env`.
2. Fill in any values you have available. The app still runs without Telegram or Google tokens.
3. Start the app:

```bash
npm start
```

4. Open `http://localhost:3000`.

## AI setup

To enable natural-language Telegram handling and explicit online factual lookups, add these to `.env`:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5.4
```

If `OPENAI_API_KEY` is missing, the app falls back to a local heuristic parser and disables real online lookup.

## Demo flow

1. Complete the setup form with work hours and wellness preferences.
2. Add tasks in the UI or send Telegram-style commands to the webhook.
3. Send plain-English messages like “I need to finish the deck tomorrow before 5” or “I’m 45 minutes late.”
4. Add fixed events like “Tomorrow night dinner” or “Tomorrow dinner at a pizza place in Berkeley.”
5. Generate a plan for the week.
6. Review the proposed plan in the web calendar.
7. Accept the plan to write to Google Calendar if a valid token is configured.
8. Replan when a task is delayed or split a large task into smaller blocks.

## Telegram commands

Send these to `POST /api/telegram/webhook` using a Telegram update payload, or mirror them in the UI:

- `/setup`
- `/add Finish deck in 120m by tomorrow 5pm priority high`
- `/plan`
- `/replan delayed 45`
- `/split <task-id> 3`
- `/accept`
- `/reject`

For real Telegram testing, `TELEGRAM_CHAT_ID` is not needed. The bot replies to whichever chat sent the command and stores the latest chat it saw.

Non-command natural language now also works. Examples:

- `I need to finish the investor deck tomorrow before 5`
- `Tomorrow night dinner`
- `Tomorrow dinner at a pizza place in Berkeley`
- `Plan my week around my meetings`
- `I'm 45 minutes late`
- `Break down the investor deck into 3 parts`
- `What are the opening hours for my gym tonight?`

## Google Calendar auth

For hackathon speed, the server expects a valid `GOOGLE_ACCESS_TOKEN` with Calendar scope in `.env`. It uses:

- `GET /calendar/v3/calendars/{calendarId}/events`
- `POST /calendar/v3/calendars/{calendarId}/events`

If the token is missing, the app stays fully usable in local-only mode and reports the sync limitation in the UI.
