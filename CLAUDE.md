# jambonz-agent

## What this is

A research/test application for comparing voice AI pipeline configurations on jambonz. Single-file TypeScript WebSocket app using `@jambonz/sdk`. Runs on an EC2 server under pm2.

## Stack

- TypeScript (ESM, `"type": "module"`)
- `@jambonz/sdk` WebSocket transport (`createEndpoint` / `makeService`)
- `pipeline` verb (requires jambonz commercial v10.1.0+)

## Architecture

All code is in `src/app.ts`. A shared `handleSession` function builds the pipeline, parameterized by STT config and turn detection mode. Three services are registered on different WebSocket paths (`/`, `/flux`, `/aai`).

Application-configurable values (model, voice, system prompt) use jambonz env vars (`envVars` schema + `session.data.env_vars`), not `process.env`. The only `process.env` usage is `PORT` for the listening port.

## Build & Run

- `npm run build` compiles to `dist/`
- `npm start` runs `dist/app.js`
- Deployed at `/home/jambonz/apps/jambonz-agent` on EC2, managed by pm2 on port 3105

## Working with this code

- Always use the jambonz MCP server tools (`mcp__jambonz__jambonz_developer_toolkit` and `mcp__jambonz__get_jambonz_schema`) to look up verb schemas and SDK patterns before writing jambonz code.
- `deepgramflux` is a distinct STT vendor string (not `deepgram` with a model option).
- STT vendors with native turn detection (deepgramflux, assemblyai, speechmatics) use `turnDetection: 'stt'`. The `earlyGeneration` flag is still relevant for these vendors — their preflighting events trigger early LLM generation.
