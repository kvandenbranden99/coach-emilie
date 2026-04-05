const TelegramBot = require('node-telegram-bot-api');
const logger = require('./utils/logger');

let bot = null;

/**
 * Initialize the Telegram bot in polling mode.
 * @param {(text: string, channel: string) => Promise<void>} onMessage
 */
function initTelegram(onMessage) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is niet ingesteld');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is niet ingesteld');

  bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (msg) => {
    // Only respond to the authorized user
    if (String(msg.chat.id) !== String(chatId)) {
      logger.warn(`Bericht geweigerd van onbekende chat ID: ${msg.chat.id}`);
      return;
    }
    if (!msg.text) return;

    try {
      await onMessage(msg.text, 'telegram');
    } catch (err) {
      logger.error('Fout bij verwerken Telegram bericht:', err);
    }
  });

  bot.on('polling_error', (err) => {
    logger.error('Telegram polling fout:', err.message);
  });

  logger.info('Telegram bot geïnitialiseerd (polling)');
}

/**
 * Send a message to the configured Telegram chat.
 * Splits long messages automatically (Telegram limit: 4096 chars).
 */
async function sendTelegramMessage(text) {
  if (!bot) throw new Error('Telegram bot is niet geïnitialiseerd');

  const chatId   = process.env.TELEGRAM_CHAT_ID;
  const MAX_LEN  = 4096;

  for (let i = 0; i < text.length; i += MAX_LEN) {
    const chunk = text.slice(i, i + MAX_LEN);
    await bot.sendMessage(chatId, chunk);
  }

  logger.info(`Telegram → "${text.substring(0, 60).replace(/\n/g, ' ')}${text.length > 60 ? '…' : ''}"`);
}

module.exports = { initTelegram, sendTelegramMessage };
