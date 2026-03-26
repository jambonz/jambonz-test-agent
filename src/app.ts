import * as http from 'node:http';
import { createEndpoint, Session } from '@jambonz/sdk/websocket';

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
      'and without any complex formatting or punctuation',
      'including emojis, asterisks, or other symbols.',
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
}

interface TtsConfig {
  vendor: string;
  voiceEnvVar: string;
  options?: Record<string, unknown>;
}

interface PipelineOptions {
  stt: SttConfig;
  tts: TtsConfig;
  turnDetection: 'krisp' | 'stt';
}

function handleSession(session: Session, opts: PipelineOptions) {
  const model = session.data.env_vars?.OPENAI_MODEL || 'gpt-4.1-mini';
  const voice = session.data.env_vars?.[opts.tts.voiceEnvVar]
    || envVars[opts.tts.voiceEnvVar as keyof typeof envVars]?.default;
  const systemPrompt = session.data.env_vars?.SYSTEM_PROMPT || envVars.SYSTEM_PROMPT.default;

  session.on('/pipeline-event', (evt: Record<string, unknown>) => {
    if (evt.type === 'turn_end') {
      const { transcript, response, interrupted, latency } = evt as Record<string, unknown>;
      console.log('turn_end', JSON.stringify({ transcript, response, interrupted, latency }, null, 2));
    } else {
      console.log(`pipeline event: ${evt.type}`);
    }
  });

  session.on('/pipeline-complete', (evt: Record<string, unknown>) => {
    console.log('pipeline completed', evt);
    session.hangup().reply();
  });

  session
    .pipeline({
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
        },
      },
      turnDetection: opts.turnDetection,
      earlyGeneration: true,
      bargeIn: {
        enable: true,
      },
      eventHook: '/pipeline-event',
      actionHook: '/pipeline-complete',
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

console.log(`jambonz voice agent listening on port ${port}`);
