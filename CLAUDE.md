# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram bot for the game "Encounter" that allows users to send answers even when offline. The bot queues answers and sends them automatically when connection is restored.

**Core functionality:**
- Telegram bot interface for Encounter game integration
- Offline mode with answer queuing (auto-sends with 1.2s delay)
- User session management with persistent storage in `user_data.json`
- Direct integration with Encounter API endpoints

## Development Commands

```bash
# Start the bot (production)
npm start

# Start the bot (development)
npm run dev

# Install dependencies
npm install
```

## Architecture

### Main Components

**index.js** (main bot logic)
- Bot initialization and message handling
- User state management (WAITING_FOR_LOGIN, WAITING_FOR_PASSWORD, WAITING_FOR_GAME_URL, READY)
- Answer queue processing with retry logic
- Telegram keyboard interface with buttons: "Задание", "Сектора", status, settings

**encounter-api.js** (Encounter API wrapper)
- `authenticate(login, password)` - Handles login via `/login/signin?json=1`
- `getGameState(gameId, authCookies)` - Fetches current game state from `/GameEngines/Encounter/Play/{gameId}?json=1`
- `sendAnswer(gameId, answer, authCookies)` - Submits answers to the game
- `getGameInfo(gameId, authCookies)` - Gets game metadata
- `checkConnection()` - Verifies domain connectivity

### Data Flow

1. User authenticates with login/password → cookies stored in `user.authCookies`
2. User provides game URL → parsed to extract `domain` and `gameId`
3. User sends answers → bot checks online/offline status:
   - Online: sends immediately via `sendAnswer()`
   - Offline: adds to `user.answerQueue[]`
4. Queue processing: auto-sends queued answers with 1.2s delays when online

### State Management

User data persisted in `user_data.json`:
```javascript
{
  login: string,
  password: string,
  domain: string,
  gameId: string,
  authCookies: { GUID, stoken, atoken },
  answerQueue: [{ answer, timestamp }],
  isOnline: boolean
}
```

## Important Implementation Details

### Cookie Management
- Auth cookies (`GUID`, `stoken`, `atoken`) are extracted from `/login/signin?json=1`
- Cookies reset on domain/auth changes
- Automatic re-authentication on 401/session expiry errors

### Error Handling
- Network errors (`ECONNREFUSED`, `ETIMEDOUT`) trigger offline queue mode
- Auth errors trigger automatic re-login attempts
- Event codes 1-22 from Encounter API map to specific error messages (see encounter-api.js:222-240)
- Ignorable errors in queue (stale data) are skipped automatically

### Game State Events
Key `Event` values from Encounter API:
- `0` - Game is active and ready
- `4` - Player not authenticated
- `16` - Level changed (triggers state refresh)
- Other codes indicate various game/player states (see encounter-api.js:222-240)

### URL Parsing
Supports two game URL formats:
1. `https://domain.en.cx/GameDetails.aspx?gid=XXXXX`
2. `https://domain.en.cx/gameengines/encounter/play/XXXXX/`

### Queue Processing
- Processes answers sequentially with 1.2s delays between each
- Skips stale answers (level changed, unknown game errors)
- Retries on auth errors (one automatic re-auth attempt)
- Updates single progress message throughout processing

## Configuration

Environment variables (`.env`):
- `BOT_TOKEN` - Telegram bot token from @BotFather (required)
- `DATA_FILE` - Path for user data storage (default: `user_data.json`)

## Testing

Use `/test` command to verify:
- Domain connectivity
- Authentication status
- Game info retrieval
- Current level/sector status

## Encounter API

Docs: https://world.en.cx/Addons.aspx?aid=18832

## User Project rules

You are a Senior Telegram Developer and an Expert in JavaScript, Node.js, Telegram BOT API, with a deep understanding of best practices and performance optimization techniques in these technologies.

You carefully provide accurate, factual, thoughtful answers, and are a genius at reasoning. At the same time, you are strict, laconic and critical.

### General

- Concise Code: Be concise and minimize any other prose.
- No Guessing: If you think there might not be a correct answer, you say so. If you do not know the answer, say so, instead of guessing and don't lie.
- Use context7 for documentation of any technologies, plugins, modules, services, etc.
- При ответах всегда используй русский язык.

### Code Style and Structure

- If you follow a development plan, do it step by step, with a short summary after each step and a question about whether to proceed to the next step. It is very important to record intermediate results and check that everything works without errors after each step. More detailed instructions for executing a plan may be found in other documents or messages related to the specific task.
- Write clear, modular code.
- Use functional and declarative programming patterns; avoid classes.
- Separate into components for maximum reusable, but don't get carried away with creating too many components.
- Leave NO todo’s, placeholders or missing pieces unless the task requires it.
- Document code with JSDoc comments.
- Check for linter errors as often as possible.

### **IMPORTANT!** Basic principles of implementation

The implementation must strictly adhere to these non-negotiable principles:
- YAGNI (You Aren't Gonna Need It)
- KISS (Keep It Simple, Stupid)
- DRY (Don't Repeat Yourself)
- SOLID Principles (Single-responsibility principle, Open–closed principle, Liskov substitution principle, Interface segregation principle, Dependency inversion principle)

Always follow the YAGNI + KISS + DRY + SOLID principles when designing or adding new code.

## How to ensure Always Works™ implementation

Please ensure your implementation Always Works™ for this project tasks.

Follow this systematic approach:

### Core Philosophy

- "Should work" ≠ "does work" - Pattern matching isn't enough
- I'm not paid to write code, I'm paid to solve problems
- Untested code is just a guess, not a solution

### The 30-Second Reality Check - Must answer YES to ALL:

- Did I run/build the code?
- Did I trigger the exact feature I changed?
- Did I see the expected result with my own observation (including GUI)?
- Did I check for error messages?
- Would I bet $100 this works?

### Phrases to Avoid:

- "This should work now"
- "I've fixed the issue" (especially 2nd+ time)
- "Try it now" (without trying it myself)
- "The logic is correct so..."

### Specific Test Requirements:

- UI Changes: Actually click the button/link/form
- API Changes: Make the actual API call
- Data Changes: Query the database
- Logic Changes: Run the specific scenario
- Config Changes: Restart and verify it loads

### The Embarrassment Test:

"If the user records trying this and it fails, will I feel embarrassed to see his face?"

### Time Reality:

- Time saved skipping tests: 30 seconds
- Time wasted when it doesn't work: 30 minutes
- User trust lost: Immeasurable

A user describing a bug for the third time isn't thinking "this AI is trying hard" - they're thinking "why am I wasting time with this incompetent tool?"