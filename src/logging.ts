import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

let transport: ReturnType<typeof pino.transport> | undefined;

if (isDev && !isTest) {
  try {
    transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    });
  } catch (_e) {
    // pino-pretty not available, fall back to basic logging
    transport = undefined;
  }
}

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || (isDev && !isTest ? 'debug' : 'info'),
  },
  transport
);
