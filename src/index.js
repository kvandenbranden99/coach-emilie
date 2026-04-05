require('dotenv').config();

const express = require('express');

const { initDatabase }                         = require('./database/migrations');
const { initTelegram, sendTelegramMessage }    = require('./telegram');
const { initSlack, sendSlackMessage }          = require('./slack');
const { initScheduler, setMessageSender: setSchedulerSender } = require('./scheduler');
const { handleIncomingMessage, setMessageSender: setHandlerSender } = require('./messageHandler');
const { determineChannel }                     = require('./channelRouter');
const logger                                   = require('./utils/logger');

// ---------------------------------------------------------------------------
// Unified send function — auto-selects Telegram or Slack, with fallback
// ---------------------------------------------------------------------------

async function sendMessage(text, forceChannel = null) {
  const channel = determineChannel(forceChannel);

  try {
    if (channel === 'slack') {
      await sendSlackMessage(text);
    } else {
      await sendTelegramMessage(text);
    }
  } catch (primaryErr) {
    logger.error(`Fout bij sturen via ${channel}:`, primaryErr.message);

    // Fallback to Telegram when Slack fails
    if (channel !== 'telegram') {
      try {
        await sendTelegramMessage(text);
        logger.info('Bericht alsnog via Telegram verzonden (fallback)');
      } catch (fallbackErr) {
        logger.error('Telegram fallback ook mislukt:', fallbackErr.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  logger.info('Coach Agent wordt opgestart…');

  // Validate required environment variables
  const required = ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`Ontbrekende omgevingsvariabelen: ${missing.join(', ')}`);
    logger.error('Kopieer .env.example naar .env en vul de waarden in.');
    process.exit(1);
  }

  // Database
  initDatabase();

  // Wire up the send function
  setHandlerSender(sendMessage);
  setSchedulerSender(sendMessage);

  // Message handler (shared by Telegram and Slack)
  const onMessage = async (text, channel) => {
    try {
      await handleIncomingMessage(text, channel);
    } catch (err) {
      logger.error('Onverwerkte fout in berichtverwerking:', err);
    }
  };

  // Telegram (always required)
  initTelegram(onMessage);

  // Slack (optional — only when all three env vars are present)
  const slackConfigured =
    process.env.SLACK_BOT_TOKEN &&
    process.env.SLACK_APP_TOKEN &&
    process.env.SLACK_SIGNING_SECRET;

  if (slackConfigured) {
    try {
      await initSlack(onMessage);
    } catch (err) {
      logger.warn('Slack kon niet worden opgestart:', err.message);
      logger.warn('De agent draait verder zonder Slack.');
    }
  } else {
    logger.warn('Slack niet geconfigureerd — alleen Telegram actief');
  }

  // Scheduler
  initScheduler();

  // Express health-check (required for Railway / Render)
  const app  = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'coach-emilie', timestamp: new Date().toISOString() });
  });

  app.get('/', (_req, res) => {
    res.json({ message: 'Coach Emilie draait! 🚀' });
  });

  app.listen(PORT, () => {
    logger.info(`HTTP server luistert op poort ${PORT}`);
  });

  logger.info('Coach Agent succesvol opgestart! 🚀');
}

main().catch((err) => {
  // Use console.error here in case the logger itself hasn't initialised yet
  console.error('Kritieke fout bij opstarten:', err);
  process.exit(1);
});
