const pino = require('pino');
const { format } = require('util');

const buildTransport = () => {
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }

  return {
    targets: [
      {
        target: 'pino-pretty',
        level: process.env.LOG_LEVEL || 'info',
        options: {
          translateTime: 'SYS:standard',
          singleLine: false,
          ignore: 'pid,hostname'
        }
      }
    ]
  };
};

const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: buildTransport()
});

const emit = (level, args) => {
  if (args.length === 0) {
    baseLogger[level]('');
    return;
  }

  const errorArg = args.find(arg => arg instanceof Error);
  const remainingArgs = errorArg ? args.filter(arg => arg !== errorArg) : [...args];

  let context = {};
  let messageArgs = remainingArgs;

  if (
    remainingArgs.length > 0 &&
    typeof remainingArgs[0] === 'object' &&
    remainingArgs[0] !== null &&
    !Array.isArray(remainingArgs[0])
  ) {
    context = remainingArgs.shift();
    messageArgs = remainingArgs;
  }

  const message =
    messageArgs.length > 0 ? format(...messageArgs) : errorArg ? errorArg.message : '';

  if (errorArg) {
    context = { ...context, err: errorArg };
  }

  baseLogger[level](context, message);
};

const logger = {
  fatal: (...args) => emit('fatal', args),
  error: (...args) => emit('error', args),
  warn: (...args) => emit('warn', args),
  info: (...args) => emit('info', args),
  debug: (...args) => emit('debug', args),
  trace: (...args) => emit('trace', args)
};

module.exports = { logger };
