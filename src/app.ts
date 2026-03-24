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

interface PipelineOptions {
  stt: SttConfig;
  turnDetection: 'krisp' | 'stt';
}

function handleSession(session: Session, opts: PipelineOptions) {
  const model = session.data.env_vars?.OPENAI_MODEL || 'gpt-4.1-mini';
  const voice = session.data.env_vars?.CARTESIA_VOICE || '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';
  const systemPrompt = session.data.env_vars?.SYSTEM_PROMPT || envVars.SYSTEM_PROMPT.default;

  session.on('/pipeline-complete', (evt: Record<string, unknown>) => {
    console.log('pipeline completed', evt);
    session.hangup().reply();
  });

  session
    .pipeline({
      stt: opts.stt,
      tts: {
        vendor: 'cartesia',
        voice,
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
        minSpeechDuration: 0.5,
      },
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
    turnDetection: 'krisp',
  });
});

/* Deepgram Flux + native turn detection */
const fluxSvc = makeService({ path: '/flux' });
fluxSvc.on('session:new', (session) => {
  handleSession(session, {
    stt: { vendor: 'deepgramflux' },
    turnDetection: 'stt',
  });
});

/* AssemblyAI universal-3 pro + native turn detection */
const aaiSvc = makeService({ path: '/aai' });
aaiSvc.on('session:new', (session) => {
  handleSession(session, {
    stt: {
      vendor: 'assemblyai',
      assemblyAiOptions: {
        speechModel: 'universal-3-pro',
        serviceVersion: 'v3',
        endOfTurnConfidenceThreshold: 0.5,
        languageDetection: true,
      },
    },
    turnDetection: 'stt',
  });
});

console.log(`jambonz voice agent listening on port ${port}`);
