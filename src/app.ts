import * as http from 'node:http';
import pino from 'pino';
import { createEndpoint, Session } from '@jambonz/sdk/websocket';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const envVars = {
  BEDROCK_MODEL: {
    type: 'string' as const,
    description: 'Bedrock model to use',
    default: 'us.meta.llama4-scout-17b-instruct-v1:0',
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
  TOOLS_LLM_VENDOR: {
    type: 'string' as const,
    description: '/flux-tools: LLM vendor (an LLM credential for it must exist in the account)',
    default: 'bedrock',
  },
  TOOLS_LLM_MODEL: {
    type: 'string' as const,
    description: '/flux-tools: LLM model (e.g. anthropic/claude-haiku-4.5 for vendor openai via OpenRouter)',
    default: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  },
  BARGE_IN_STRATEGY: {
    type: 'string' as const,
    description: '/flux-tools: barge-in strategy, interruptPrediction (needs a Krisp key) or vad',
    default: 'interruptPrediction',
  },
  FLUX_EAGER_EOT_THRESHOLD: {
    type: 'string' as const,
    description: '/flux-tools: Deepgram Flux eagerEotThreshold (early end-of-turn signal that starts the LLM)',
    default: '0.5',
  },
  FLUX_EOT_THRESHOLD: {
    type: 'string' as const,
    description: '/flux-tools: Deepgram Flux eotThreshold (confirmed end of turn)',
    default: '0.7',
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
}

function handleSession(session: Session, opts: AgentOptions) {
  const log = logger.child({ call_sid: session.callSid });
  const model = session.data.env_vars?.BEDROCK_MODEL || 'us.meta.llama4-scout-17b-instruct-v1:0';
  const voice = session.data.env_vars?.[opts.tts.voiceEnvVar]
    || envVars[opts.tts.voiceEnvVar as keyof typeof envVars]?.default;
  const systemPrompt = session.data.env_vars?.SYSTEM_PROMPT || envVars.SYSTEM_PROMPT.default;

  session.on('/agent-event', (evt: Record<string, unknown>) => {
    log.info({payload: evt}, `agent event: ${evt.type}`);
  });

  session.on('/agent-complete', (evt: Record<string, unknown>) => {
    log.info({payload: evt}, 'agent completed');
    session.hangup().reply();
  });

  session
    .agent({
      noiseIsolation: 'krisp',
      stt: opts.stt,
      tts: {
        vendor: opts.tts.vendor,
        voice,
        ...opts.tts.options && { options: opts.tts.options },
      },
      llm: {
        vendor: 'bedrock',
        model,
        llmOptions: {
          messages: [
            { role: 'system', content: systemPrompt },
          ],
        },
      },
      turnDetection: opts.turnDetection,
      ...opts.noiseIsolation && { noiseIsolation: opts.noiseIsolation },
      earlyGeneration: true,
      bargeIn: {
        enable: true,
      },
      eventHook: '/agent-event',
      actionHook: '/agent-complete',
    })
    .send();
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
      speechmaticsOptions: { profile: 'smart'}
    },
    tts: { vendor: 'cartesia', voiceEnvVar: 'CARTESIA_VOICE' },
    turnDetection: 'stt',
  });
});

/* Early generation with tools (trial): Deepgram Flux EagerEndOfTurn starts the
   LLM before the turn is confirmed, and the agent has tools shaped like an
   outbound campaign's (record the outcome + act, often in one batch). The
   tools are simulated and every execution is logged and counted per call:
   each should run once, and only for a confirmed turn — never for a guess. */
const TRIAL_PROMPT = [
  'You are Maya, calling from Acme Solar about the free solar quote the person requested online.',
  'You are on a phone call: speak naturally, one or two short sentences at a time, no formatting.',
  'Greet them, confirm you are speaking with the person who asked for a quote, and ask if they',
  'have a minute to be connected with a specialist who can give them their quote.',
  'If they agree: in ONE response say a short line like "Great, one moment please" and call BOTH',
  'record_lead and transfer_to_specialist.',
  'If they want a call later: ask when, then call schedule_callback and say goodbye.',
  'If they are not interested: call mark_not_interested, thank them, and say goodbye.',
].join(' ');

const TRIAL_TOOLS = [
  {
    name: 'record_lead',
    description: 'Record that the caller agreed to talk to a specialist.',
    parameters: {type: 'object', properties: {}},
  },
  {
    name: 'transfer_to_specialist',
    description: 'Transfer the caller to a solar specialist.',
    parameters: {type: 'object', properties: {}},
  },
  {
    name: 'schedule_callback',
    description: 'Schedule a call back at the time the caller asked for.',
    parameters: {
      type: 'object',
      properties: {
        date: {type: 'string', description: 'YYYY-MM-DD'},
        time: {type: 'string', description: 'HH:MM, 24-hour'},
      },
      required: ['date', 'time'],
    },
  },
  {
    name: 'mark_not_interested',
    description: 'Record that the caller is not interested.',
    parameters: {type: 'object', properties: {}},
  },
];

const TRIAL_RESULTS: Record<string, unknown> = {
  record_lead: {ok: true},
  transfer_to_specialist: {ok: true, note: 'simulated: no real transfer; tell the caller they are being connected'},
  schedule_callback: {ok: true},
  mark_not_interested: {ok: true},
};

function handleToolTrialSession(session: Session) {
  const log = logger.child({ call_sid: session.callSid, flow: 'flux-tools' });
  /* portal app env vars win; the process environment is the fallback for a
     system whose portal doesn't show them */
  const env = {...process.env, ...(session.data.env_vars || {})} as Record<string, string | undefined>;
  const vendor = env.TOOLS_LLM_VENDOR || envVars.TOOLS_LLM_VENDOR.default;
  const model = env.TOOLS_LLM_MODEL || envVars.TOOLS_LLM_MODEL.default;
  const eagerEotThreshold = parseFloat(env.FLUX_EAGER_EOT_THRESHOLD || envVars.FLUX_EAGER_EOT_THRESHOLD.default);
  const eotThreshold = parseFloat(env.FLUX_EOT_THRESHOLD || envVars.FLUX_EOT_THRESHOLD.default);
  const executed: Record<string, number> = {};
  /* the schema allows `strategy`; this SDK's types predate it */
  const bargeIn = { enable: true, strategy: env.BARGE_IN_STRATEGY || envVars.BARGE_IN_STRATEGY.default };

  session.on('/tool-call', (evt: Record<string, unknown>) => {
    const name = String(evt.name);
    executed[name] = (executed[name] || 0) + 1;
    log.info({tool: name, args: evt.arguments, tool_call_id: evt.tool_call_id, count: executed[name]},
      'trial tool executed');
    session.sendToolOutput(String(evt.tool_call_id), TRIAL_RESULTS[name] ?? {ok: false, error: 'unknown tool'});
  });

  session.on('/agent-event', (evt: Record<string, unknown>) => {
    log.info({payload: evt}, `agent event: ${evt.type}`);
  });

  log.info({vendor, model, eagerEotThreshold, eotThreshold, bargeIn: bargeIn.strategy}, 'flux-tools trial call');

  session.on('/agent-complete', (evt: Record<string, unknown>) => {
    /* the trial's result per call: every count should be 0 or 1 */
    log.info({payload: evt, executed}, 'agent completed (flux-tools trial)');
    session.hangup().reply();
  });

  session
    .agent({
      stt: {
        vendor: 'deepgramflux',
        deepgramOptions: { eagerEotThreshold, eotThreshold },
      },
      tts: { vendor: 'deepgram', voice: 'aura-2-asteria-en' },   // as Voizer's English campaigns
      llm: {
        vendor,
        model,
        llmOptions: {
          messages: [{ role: 'system', content: TRIAL_PROMPT }],
          tools: TRIAL_TOOLS,
        },
      },
      turnDetection: 'stt',
      earlyGeneration: true,
      bargeIn,
      toolHook: '/tool-call',
      eventHook: '/agent-event',
      actionHook: '/agent-complete',
    })
    .send();
}

const fluxToolsSvc = makeService({ path: '/flux-tools' });
fluxToolsSvc.on('session:new', (session) => handleToolTrialSession(session));

logger.info({ port }, 'jambonz voice agent listening');

