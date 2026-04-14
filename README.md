# jambonz-agent

A jambonz voice AI agent using the `agent` verb with multiple STT backends for comparing turn detection strategies.

## Callflows

| Path | STT Vendor | Turn Detection | Notes |
|------|-----------|----------------|-------|
| `/` | Deepgram nova-3-general | Krisp | Multilingual, acoustic end-of-turn via Krisp |
| `/flux` | Deepgram Flux | Native (STT) | Acoustic + semantic turn detection built into Deepgram Flux |
| `/aai` | AssemblyAI universal-3 pro | Native (STT) | v3 streaming API with native turn detection, language detection enabled |

All callflows share the same TTS (Cartesia), LLM (OpenAI), barge-in settings, and system prompt.

## Application Environment Variables

These are configurable from the jambonz portal:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI model for the LLM |
| `CARTESIA_VOICE` | `9626c31c-bec5-4cca-baa8-f8ba9e84c8bc` | Cartesia voice ID |
| `SYSTEM_PROMPT` | *(see source)* | System prompt for the voice agent |

## Setup

```bash
npm install
npm run build
```

## Running

```bash
# development
npm run dev

# production
PORT=3105 npm start
```

The `PORT` environment variable controls the listening port (default: 3000).

### pm2

Add to your existing `ecosystem.config.js`:

```js
{
  name: 'jambonz-agent',
  script: 'dist/app.js',
  cwd: '/home/jambonz/apps/jambonz-agent',
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '512M',
  env: {
    NODE_ENV: 'production',
    PORT: 3105
  }
}
```

## jambonz Configuration

Create a jambonz application with the WebSocket URL pointing to the desired callflow path:

- `ws://<host>:3105/` for Deepgram + Krisp
- `ws://<host>:3105/flux` for Deepgram Flux
- `ws://<host>:3105/aai` for AssemblyAI

Requires jambonz server version 10.1.1+ (the `agent` verb is commercial-only).
