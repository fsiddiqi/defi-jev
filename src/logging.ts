import pino from 'pino';
import fs from 'fs';
import path from 'path';

const isDev = process.env.NODE_ENV !== 'production';
const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';

const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const transports: pino.TransportTargetOptions[] = [];

if (isDev && !isTest) {
  try {
    transports.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
      level: process.env.LOG_LEVEL || 'debug',
    });
  } catch (_e) {
    // pino-pretty not available
  }
}

// Always add file transport (JSON for aggregation)
transports.push({
  target: 'pino/file',
  options: {
    destination: path.join(logDir, 'bot.log'),
    mkdir: true,
  },
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || (isDev && !isTest ? 'debug' : 'info'),
  },
  pino.transport({ targets: transports })
);
