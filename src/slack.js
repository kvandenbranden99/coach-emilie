const { App } = require('@slack/bolt');
const logger = require('./utils/logger');

let slackApp = null;

/**
 * Initialize the Slack app in Socket Mode.
 * Requires SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.
 * @param {(text: string, channel: string) => Promise<void>} onMessage
 */
async function initSlack(onMessage) {
  const botToken      = process.env.SLACK_BOT_TOKEN;
  const appToken      = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken || !appToken || !signingSecret) {
    throw new Error('Slack vereist SLACK_BOT_TOKEN, SLACK_APP_TOKEN en SLACK_SIGNING_SECRET');
  }

  slackApp = new App({
    token:         botToken,
    signingSecret,
    socketMode:    true,
    appToken
  });

  // Listen to direct messages and channel messages
  slackApp.message(async ({ message }) => {
    // Filter: only handle messages from the configured channel and from humans
    if (message.channel !== process.env.SLACK_CHANNEL_ID) return;
    if (message.bot_id || message.subtype)               return;
    if (!message.text)                                   return;

    logger.info(`Slack bericht ontvangen: "${message.text}"`);

    try {
      await onMessage(message.text, 'slack');
    } catch (err) {
      logger.error('Fout bij verwerken Slack bericht:', err);
    }
  });

  await slackApp.start();
  logger.info('Slack bot geïnitialiseerd (Socket Mode)');
}

/**
 * Send a message to the configured Slack channel.
 * Splits messages longer than 3000 characters (Slack block limit).
 */
async function sendSlackMessage(text) {
  if (!slackApp) throw new Error('Slack app is niet geïnitialiseerd');

  const channelId = process.env.SLACK_CHANNEL_ID;
  const MAX_LEN   = 3000;

  for (let i = 0; i < text.length; i += MAX_LEN) {
    const chunk = text.slice(i, i + MAX_LEN);
    await slackApp.client.chat.postMessage({ channel: channelId, text: chunk });
  }

  logger.info(`Slack → "${text.substring(0, 60).replace(/\n/g, ' ')}${text.length > 60 ? '…' : ''}"`);
}

module.exports = { initSlack, sendSlackMessage };
