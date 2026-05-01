const winston = require('winston');
const path = require('path');
const fs = require('fs');
const util = require('util');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Winston puts extra args after the message under Symbol.for('splat')
const SPLAT = Symbol.for('splat');

function formatSplat(splat) {
  if (!splat || splat.length === 0) return '';
  return ' ' + splat.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack || `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'object' && arg !== null) {
      return util.inspect(arg, { depth: 3, colors: false });
    }
    return String(arg);
  }).join(' ');
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
      const { level, message, timestamp, stack } = info;
      const extra = formatSplat(info[SPLAT]);
      const base  = stack || message;
      return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${base}${extra}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error'
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log')
    })
  ]
});

module.exports = logger;
