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

  // 2. Response to a pending habit reminder — checked BEFORE user_chat so that
  //    a reply to a reminder is never swallowed by an ongoing conversation.
  const pending = getPendingReminders();
  const habitIds = Object.keys(pending);
  if (habitIds.length > 0) {
    const db = getDb();
    let completedCount = 0;
    let declinedCount  = 0;

    for (const habitId of habitIds) {
      const habit    = db.prepare('SELECT name FROM habits WHERE id = ?').get(habitId);
      const response = await detectResponse(text, habit ? habit.name : null);
      if (response !== 'unknown') {
        await _recordReminderResponse(pending[habitId], response);
        if (response === 'completed') completedCount++;
        else declinedCount++;
      }
    }

    if (completedCount > 0 || declinedCount > 0) {
      let reply;
      if (completedCount > 0 && declinedCount === 0) {
        reply = 'Super gedaan! 💪 Ik heb het geregistreerd.';
      } else if (declinedCount > 0 && completedCount === 0) {
        reply = 'Geen probleem, ik probeer het later opnieuw. 👍';
      } else {
        reply = 'Super gedaan met wat je al hebt gedaan! 💪 Voor de rest probeer ik het later opnieuw. 👍';
      }
      await _sendMessage(reply, channel);
      return;
    }
  }

  // 3. Active user-initiated chat — continue with history, don't restart
  if (state.type === 'user_chat') {
    return await _handleUserChatMessage(text, state, channel);
  }

  // 4. In-progress habit-addition conversation
  if (getHabitConversationState()) {
    const reply = await processAddHabitStep(text);
    if (reply) await _sendMessage(reply, channel);
    return;
  }

  // 5. Habit management intent
  const intent = await detectHabitManagementIntent(text);
  if (intent) {
    return await _handleHabitIntent(intent, text, channel);
  }

  // 6. No active session — start a new user chat and track history
  return await _startUserChat(text, channel);
}

// ---------------------------------------------------------------------------
// User-initiated chat handlers
// ---------------------------------------------------------------------------

const STOP_WORDS = ['klaar', 'stop', 'afsluiten', 'einde', 'bye', 'doei', 'tot later', 'done'];
const MAX_HISTORY = 20; // max berichten bewaard in geheugen

async function _startUserChat(text, channel) {
  const reply = await generateGenericResponse(text, []);

  setConversationState({
    type: 'user_chat',
    history: [
      { role: 'user',      content: text  },
      { role: 'assistant', content: reply }
    ]
  });

  await _sendMessage(reply, channel);
  logger.info('Nieuw gebruikersgesprek gestart');
}

async function _handleUserChatMessage(text, state, channel) {
  const wantsToStop = STOP_WORDS.some(w => text.toLowerCase().includes(w));

  if (wantsToStop) {
    clearConversationState();
    await _sendMessage('Tot later! 👋 Laat het me weten als je me nodig hebt.', channel);
    logger.info('Gebruikersgesprek afgesloten op verzoek');
    return;
  }

  const history = state.history || [];
  const reply   = await generateGenericResponse(text, history);

  // Append new exchange and cap history to avoid unbounded growth
  const updatedHistory = [
    ...history,
    { role: 'user',      content: text  },
    { role: 'assistant', content: reply }
  ].slice(-MAX_HISTORY);

  setConversationState({ ...state, history: updatedHistory });
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

async function _recordReminderResponse(pendingReminder, response) {
  const db        = getDb();
  const habitId   = pendingReminder.habitId;
  const completed = response === 'completed' ? 1 : 0;

  // Update the exact reminder we sent, identified by its primary key
  db.prepare('UPDATE reminders SET response = ?, completed = ? WHERE id = ?')
    .run(response, completed, pendingReminder.reminderId);

  logger.info(`Herinnering #${pendingReminder.reminderId} bijgewerkt → ${response}`);
  clearPendingReminder(habitId);
}

module.exports = { handleIncomingMessage, setMessageSender };
