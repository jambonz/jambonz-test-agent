import * as http from 'node:http';
import pino from 'pino';
import { createEndpoint, Session } from '@jambonz/sdk/websocket';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const envVars = {
  OPENAI_MODEL: {
    type: 'string' as const,
    description: 'OpenAI model to use',
    default: 'gpt-4.1-mini',
  },
  CARTESIA_VOICE: {
    type: 'string' as const,
    description: 'Cartesia voice ID',
    default: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
  },
  ELEVENLABS_VOICE: {
    type: 'string' as const,
    description: 'ElevenLabs voice id',
    default: 'hpp4J3VqNfWAUOO0d1Us',
  },
  TOOL_DELAY_SHORT_MS: {
    type: 'string' as const,
    description: 'Simulated delay for the lookup_weather tool (ms)',
    default: '4000',
  },
  TOOL_DELAY_LONG_MS: {
    type: 'string' as const,
    description: 'Simulated delay for the book_flight tool (ms) — set above escalationSecs to test long phrases',
    default: '15000',
  },
  TOOL_FILLER_AUDIO_URL: {
    type: 'string' as const,
    description: 'Audio URL for toolFiller audio mode (should be loopable)',
    default: 'https://download.samplelib.com/mp3/sample-9s.mp3',
  },
  SYSTEM_PROMPT: {
    type: 'string' as const,
    description: 'System prompt for the voice agent',
    uiHint: 'textarea' as const,
    default: [
      'You are a helpful voice AI assistant.',
      'The user is interacting with you via voice,',
      'even if you perceive the conversation as text.',
      'You eagerly assist users with their questions',
      'by providing information from your extensive knowledge.',
      'Your responses are concise, to the point,',
      'and use natural spoken English with proper punctuation.',
      'Never use markdown, bullet points, numbered lists,',
      'emojis, asterisks, or any special formatting.',
      'You are curious, friendly, and have a sense of humor.',
      'When the conversation begins,',
      'greet the user in a helpful and friendly manner.',
    ].join(' '),
  },
};

interface SttConfig {
  vendor: string;
  language?: string;
  deepgramOptions?: Record<string, unknown>;
  assemblyAiOptions?: Record<string, unknown>;
  speechmaticsOptions?: Record<string, unknown>;
}

interface TtsConfig {
  vendor: string;
  voiceEnvVar: string;
  options?: Record<string, unknown>;
}

interface AgentOptions {
  stt: SttConfig;
  tts: TtsConfig;
  turnDetection: 'krisp' | 'stt';
  noiseIsolation?: 'krisp' | 'rnnoise';
  /** When set, attaches tools + toolHook so feature-server's toolFiller path runs. */
  toolFiller?: Record<string, unknown>;
}

/* Tool defs that exercise the toolFiller variants. The `filler` field is
 * stripped server-side and used to override the global toolFiller per tool. */
const TOOLS_WITH_FILLER = [
  {
    name: 'lookup_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
    /* Inherits global filler. */
  },
  {
    name: 'book_flight',
    description: 'Book a flight between two airports',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['from', 'to'],
    },
    /* Per-tool override — exercises tool-aware phrase generation + escalation. */
    filler: { type: 'backchannel', style: 'apologetic and reassuring', escalationSecs: 6 },
  },
  {
    name: 'check_balance',
    description: 'Check the account balance',
    parameters: { type: 'object', properties: {} },
    /* Disabled — exercises the filler:false path. */
    filler: false,
  },
];

function handleSession(session: Session, opts: AgentOptions) {
  const log = logger.child({ call_sid: session.callSid });
  const model = session.data.env_vars?.OPENAI_MODEL || 'gpt-4.1-mini';
  const voice = session.data.env_vars?.[opts.tts.voiceEnvVar]
    || envVars[opts.tts.voiceEnvVar as keyof typeof envVars]?.default;
  let systemPrompt = session.data.env_vars?.SYSTEM_PROMPT || envVars.SYSTEM_PROMPT.default;
  /* Nudge the model toward calling tools when we want to test filler audio.
   * Without this, GPT-4.1-mini happily fabricates weather and flight info from
   * its own knowledge and never invokes the tools — so no filler ever plays. */
  if (opts.toolFiller) {
    systemPrompt += ' You have tools available: lookup_weather (for weather questions), ' +
      'book_flight (for flight bookings), and check_balance (for account balance). ' +
      'Always call the appropriate tool — never answer from your own knowledge for these topics.';
  }
  const delayShortMs = parseInt(
    session.data.env_vars?.TOOL_DELAY_SHORT_MS || envVars.TOOL_DELAY_SHORT_MS.default, 10);
  const delayLongMs = parseInt(
    session.data.env_vars?.TOOL_DELAY_LONG_MS || envVars.TOOL_DELAY_LONG_MS.default, 10);

  session.on('/agent-event', (evt: Record<string, unknown>) => {
    log.info({payload: evt}, `agent event: ${evt.type}`);
  });

  session.on('/agent-complete', (evt: Record<string, unknown>) => {
    log.info({payload: evt}, 'agent completed');
    session.hangup().reply();
  });

  /* Simulated tool handler — sleeps for the configured delay then sends canned
   * results so the filler audio has time to play. */
  if (opts.toolFiller) {
    session.on('agent:tool-call', (evt: Record<string, unknown>) => {
      const id = evt.tool_call_id as string;
      const name = evt.name as string;
      const args = evt.arguments as Record<string, unknown>;
      log.info({id, name, args}, '[tool-call] received');

      const delay =
        name === 'lookup_weather' ? delayShortMs :
          name === 'book_flight' ? delayLongMs :
            500;

      setTimeout(() => {
        let result: unknown;
        if (name === 'lookup_weather') {
          result = { city: args.city, temp_f: 58, condition: 'cloudy' };
        } else if (name === 'book_flight') {
          result = { confirmation: 'ABC123', from: args.from, to: args.to, departure: '3pm' };
        } else if (name === 'check_balance') {
          result = { balance_usd: 1234.56 };
        } else {
          result = { error: `unknown tool ${name}` };
        }
        log.info({id, name, delay}, '[tool-call] returning result');
        session.sendToolOutput(id, result);
      }, delay);
    });
  }

  /* SDK types don't yet know about toolFiller — cast on the verb config. */
  const agentConfig: Record<string, unknown> = {
    stt: opts.stt,
    tts: {
      vendor: opts.tts.vendor,
      voice,
      ...opts.tts.options && { options: opts.tts.options },
    },
    llm: {
      vendor: 'openai',
      model,
      llmOptions: {
        messages: [
          { role: 'system', content: systemPrompt },
        ],
        ...opts.toolFiller && { tools: TOOLS_WITH_FILLER },
      },
    },
    turnDetection: opts.turnDetection,
    ...opts.noiseIsolation && { noiseIsolation: opts.noiseIsolation },
    earlyGeneration: true,
    bargeIn: { enable: true },
    eventHook: '/agent-event',
    actionHook: '/agent-complete',
    ...opts.toolFiller && {
      toolFiller: opts.toolFiller,
      toolHook: '/tool-call',
    },
  };

  session.agent(agentConfig as Parameters<Session['agent']>[0]).send();
}

const port = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer();
const makeService = createEndpoint({ server, port, envVars });

/* Deepgram nova-3 + Krisp turn detection */
const svc = makeService({ path: '/' });
svc.on('session:new', (session) => {
  handleSession(session, {
    stt: {
      vendor: 'deepgram',
      language: 'multi',
      deepgramOptions: { model: 'nova-3-general' },
    },
    tts: { vendor: 'cartesia', voiceEnvVar: 'CARTESIA_VOICE' },
    turnDetection: 'krisp',
  });
});

/* Deepgram Flux + native turn detection */
const fluxSvc = makeService({ path: '/flux' });
fluxSvc.on('session:new', (session) => {
  handleSession(session, {
    stt: { vendor: 'deepgramflux' },
    tts: { vendor: 'cartesia', voiceEnvVar: 'CARTESIA_VOICE' },
    turnDetection: 'stt',
  });
});

/* AssemblyAI u3-rt-pro + native turn detection */
const aaiSvc = makeService({ path: '/aai' });
aaiSvc.on('session:new', (session) => {
  handleSession(session, {
    stt: {
      vendor: 'assemblyai',
      assemblyAiOptions: {
        languageDetection: true,
      },
    },
    tts: { vendor: 'cartesia', voiceEnvVar: 'CARTESIA_VOICE' },
    turnDetection: 'stt',
  });
});

/* Deepgram nova-3 + Krisp turn detection + ElevenLabs TTS */
const elSvc = makeService({ path: '/elevenlabs' });
elSvc.on('session:new', (session) => {
  handleSession(session, {
    stt: {
      vendor: 'deepgram',
      language: 'multi',
      deepgramOptions: { model: 'nova-3-general' },
    },
    tts: {
      vendor: 'elevenlabs',
      voiceEnvVar: 'ELEVENLABS_VOICE',
      options: { model_id: 'eleven_flash_v2_5' },
    },
    turnDetection: 'krisp',
  });
});

/* Speechmatics preview + native turn detection */
const smSvc = makeService({ path: '/speechmatics' });
smSvc.on('session:new', (session) => {
  handleSession(session, {
    stt: {
      vendor: 'speechmaticspreview',
      language: 'en',
    },
    tts: { vendor: 'cartesia', voiceEnvVar: 'CARTESIA_VOICE' },
    turnDetection: 'stt',
  });
});

/* toolFiller: backchannel mode + per-tool overrides.
 *   lookup_weather → inherits global ('friendly and casual')
 *   book_flight    → per-tool override ('apologetic and reassuring', escalationSecs:6)
 *   check_balance  → filler:false → no audio at all */
const tfBackchannelSvc = makeService({ path: '/toolfiller-backchannel' });
tfBackchannelSvc.on('session:new', (session) => {
  handleSession(session, {
    stt: {
      vendor: 'deepgram',
      language: 'multi',
      deepgramOptions: { model: 'nova-3-general' },
    },
    tts: { vendor: 'cartesia', voiceEnvVar: 'CARTESIA_VOICE' },
    turnDetection: 'krisp',
    toolFiller: {
      type: 'backchannel',
      startDelaySecs: 1.5,
      escalationSecs: 8,
      style: 'friendly and casual',
    },
  });
});

/* toolFiller: audio mode — loops a URL until the tool returns. */
const tfAudioSvc = makeService({ path: '/toolfiller-audio' });
tfAudioSvc.on('session:new', (session) => {
  const audioUrl = session.data.env_vars?.TOOL_FILLER_AUDIO_URL
    || envVars.TOOL_FILLER_AUDIO_URL.default;
  handleSession(session, {
    stt: {
      vendor: 'deepgram',
      language: 'multi',
      deepgramOptions: { model: 'nova-3-general' },
    },
    tts: { vendor: 'cartesia', voiceEnvVar: 'CARTESIA_VOICE' },
    turnDetection: 'krisp',
    toolFiller: {
      type: 'audio',
      startDelaySecs: 1.5,
      url: audioUrl,
    },
  });
});

logger.info({ port }, 'jambonz voice agent listening');
