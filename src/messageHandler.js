const {
  getConversationState,
  setConversationState,
  clearConversationState,
  getPendingReminders,
  clearPendingReminder,
  getHabitConversationState
} = require('./state');

const {
  processFridaySession,
  detectResponse,
  generateGenericResponse,
  generateSessionSummary
} = require('./coach');

const {
  detectHabitManagementIntent,
  startAddHabitConversation,
  processAddHabitStep,
  removeHabit,
  pauseHabit,
  resumeHabit,
  listHabits,
  extractHabitNameFromMessage,
  INTENT
} = require('./habitManager');

const { getDb } = require('./database/db');
const { DateTime } = require('luxon');
const logger = require('./utils/logger');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Brussels';

// Injected at startup by index.js
let _sendMessage = null;

function setMessageSender(fn) {
  _sendMessage = fn;
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

async function handleIncomingMessage(text, channel) {
  const state = getConversationState();
  logger.info(`Inkomend bericht [${channel}]: "${text}" | staat: ${state.type}`);

  // 1. Active Friday session
  if (state.type === 'friday_session') {
    return await _handleFridayMessage(text, state);
  }

  // 2. In-progress habit-addition conversation
  if (getHabitConversationState()) {
    const reply = await processAddHabitStep(text);
    if (reply) await _sendMessage(reply, channel);
    return;
  }

  // 3. Habit management intent
  const intent = await detectHabitManagementIntent(text);
  if (intent) {
    return await _handleHabitIntent(intent, text, channel);
  }

  // 4. Response to a pending habit reminder
  const pending = getPendingReminders();
  const habitIds = Object.keys(pending);
  if (habitIds.length > 0) {
    const response = await detectResponse(text);
    if (response !== 'unknown') {
      for (const habitId of habitIds) {
        await _recordReminderResponse(parseInt(habitId, 10), response);
      }
      const reply = response === 'completed'
        ? 'Super gedaan! 💪 Ik heb het geregistreerd.'
        : 'Geen probleem, ik probeer het later opnieuw. 👍';
      await _sendMessage(reply, channel);
      return;
    }
  }

  // 5. Generic conversation
  const reply = await generateGenericResponse(text);
  await _sendMessage(reply, channel);
}

// ---------------------------------------------------------------------------
// Friday session handler
// ---------------------------------------------------------------------------

async function _handleFridayMessage(text, state) {
  const db = getDb();

  const result = await processFridaySession(text, state);
  // Friday session always goes via Telegram
  await _sendMessage(result.responseText, 'telegram');

  if (result.isComplete) {
    const summary = await generateSessionSummary(state.sessionId);
    await _sendMessage(`\n📝 Samenvatting van onze sessie:\n\n${summary}`, 'telegram');

    db.prepare('UPDATE friday_sessions SET ended_at = CURRENT_TIMESTAMP, summary = ? WHERE id = ?')
      .run(summary, state.sessionId);

    clearConversationState();
    logger.info(`Vrijdagsessie ${state.sessionId} afgesloten`);
  } else {
    const newHistory = [
      ...(state.history || []),
      ...(text ? [{ role: 'user', content: text }] : []),
      { role: 'assistant', content: result.responseText }
    ];
    setConversationState({ ...state, step: result.nextStep, history: newHistory });
  }
}

// ---------------------------------------------------------------------------
// Habit management handler
// ---------------------------------------------------------------------------

async function _handleHabitIntent(intent, message, channel) {
  let reply;

  switch (intent) {
    case INTENT.ADD:
      reply = await startAddHabitConversation();
      break;

    case INTENT.REMOVE: {
      const name = await extractHabitNameFromMessage(message);
      reply = name ? await removeHabit(name) : 'Welke gewoonte wil je verwijderen?';
      break;
    }

    case INTENT.PAUSE: {
      const name = await extractHabitNameFromMessage(message);
      reply = name ? await pauseHabit(name) : 'Welke gewoonte wil je pauzeren?';
      break;
    }

    case INTENT.RESUME: {
      const name = await extractHabitNameFromMessage(message);
      reply = name ? await resumeHabit(name) : 'Welke gewoonte wil je hervatten?';
      break;
    }

    case INTENT.LIST:
      reply = await listHabits();
      break;

    default:
      reply = await generateGenericResponse(message);
  }

  await _sendMessage(reply, channel);
}

// ---------------------------------------------------------------------------
// Record reminder response in DB
// ---------------------------------------------------------------------------

async function _recordReminderResponse(habitId, response) {
  const db      = getDb();
  const now     = DateTime.now().setZone(TIMEZONE);
  const dateStr = now.toFormat('yyyy-MM-dd');

  const reminder = db.prepare(`
    SELECT * FROM reminders
    WHERE habit_id = ? AND date = ? AND response IS NULL
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(habitId, dateStr);

  if (reminder) {
    const completed = response === 'completed' ? 1 : 0;
    db.prepare('UPDATE reminders SET response = ?, completed = ? WHERE id = ?')
      .run(response, completed, reminder.id);
    logger.info(`Herinnering #${reminder.id} bijgewerkt → ${response}`);
  }

  clearPendingReminder(habitId);
}

module.exports = { handleIncomingMessage, setMessageSender };
