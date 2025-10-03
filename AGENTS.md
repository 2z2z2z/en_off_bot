# Repository Guidelines

## Project Structure & Module Organization
The Telegram bot runs from `index.js`, wiring polling, state tracking, and filesystem persistence. Shared Encounter API calls sit in `encounter-api.js`; adjust this module when request flows change. Runtime snapshots live in `user_data.json` (override via `DATA_FILE`), while secrets belong in `.env` copied from `config.env.example`. Deployment helpers (`deploy.sh`, `docker-compose.yml`, `.github/workflows/deploy.yml`) mirror each other—keep URLs, ports, and environment variables in sync across them.

## Build, Test, and Development Commands
- `npm install`: install/update dependencies for local development.
- `npm start` (alias `npm run dev`): boot the polling bot in the current shell.
- `npm ci`: clean install used by CI; run before committing lockfile updates.
- `node -c index.js && node -c encounter-api.js`: quick syntax gate identical to the workflow lint stage.
- `docker-compose up -d`: spin up the bot with the provided image and `.env` on a server.

## Coding Style & Naming Conventions
Use Node 18+ and stick to two-space indentation, single quotes, and `const`/`let` as in the existing files. Export modules via `module.exports` and keep filenames lowercase-hyphenated. Favour camelCase for functions and variables, UPPER_SNAKE_CASE for shared constants, and async/await over promise chains. Run `npm start` once locally to confirm dotenv and file paths resolve before submitting changes.

## Testing Guidelines
No automated tests ship yet, but CI expects `npm test`. Add Jest-based suites under `tests/` or `__tests__/`, naming files `*.spec.js`. Cover command handlers, Encounter API adapters, and state transitions; mock Telegram updates to avoid live traffic. Always run `npm test` (or supply a placeholder script) so the workflow’s matrix job passes. Supplement with `node -c` syntax checks before pushing.

## Commit & Pull Request Guidelines
Existing history uses short, lower-case summaries (e.g., `add task + add sectors`). Follow that tone with imperative, ≤72-character subjects, optionally adding a blank-line body for context. Reference issues using `Fixes #<id>` when applicable. Pull requests should include: purpose-focused summary, configuration changes, manual test notes, and relevant screenshots or logs. Confirm CI passes and Docker assets remain buildable before requesting review.

## Configuration & Deployment Tips
Never commit real tokens; keep `.env` local and rotate keys if exposed. Update `config.env.example` alongside any new variables. When touching deployment files, document the change in `VPS_DEPLOYMENT.md` or inline comments so operators can mirror it. For server rollouts, prefer the `deploy.sh` script for PM2 setups and document any manual post-steps in the PR description.
