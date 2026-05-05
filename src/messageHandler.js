const {
  getConversationState,
  setConversationState,
  clearConversationState,
  isConversationStale,
  getPendingReminders,
  clearPendingReminder,
  getHabitConversationState
} = require('./state');

const {
  processFridaySession,
  detectMultiHabitResponses,
  detectFridaySessionIntent,
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

const { triggerFridaySessionFromUser } = require('./scheduler');
const { getDb } = require('./database/db');
const { DateTime } = require('luxon');
const logger = require('./utils/logger');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Brussels';

let _sendMessage = null;

function setMessageSender(fn) {
  _sendMessage = fn;
}

function _matchesAnyWord(message, keywords) {
  if (!message) return false;
  return keywords.some(kw => {
    if (/\s/.test(kw)) {
      return message.toLowerCase().includes(kw.toLowerCase());
    }
    return new RegExp(`\\b${kw}\\b`, 'i').test(message);
  });
}

async function handleIncomingMessage(text, channel) {
  if (isConversationStale()) {
    logger.info('user_chat verlopen door inactiviteit — automatisch afgesloten');
    clearConversationState();
  }

  const state = getConversationState();
  logger.info(`Inkomend bericht [${channel}]: "${text}" | staat: ${state.type}`);

  // 1. Active Friday session
  if (state.type === 'friday_session') {
    return await _handleFridayMessage(text, state);
  }

  // 2. Response to pending habit reminders (multi-habit aware)
  const pending = getPendingReminders();
  const habitIds = Object.keys(pending);
  if (habitIds.length > 0) {
    const handled = await _handlePendingRemindersResponse(text, pending, habitIds, channel);
    if (handled) return;
  }

  // 3. Friday-session intent
  if (await detectFridaySessionIntent(text)) {
    if (state.type === 'user_chat') {
      clearConversationState();
    }
    await triggerFridaySessionFromUser(channel);
    return;
  }

  // 4. Active user-initiated chat
  if (state.type === 'user_chat') {
    return await _handleUserChatMessage(text, state, channel);
  }

  // 5. In-progress habit-addition conversation
  if (getHabitConversationState()) {
    const reply = await processAddHabitStep(text);
    if (reply) await _sendMessage(reply, channel);
    return;
  }

  // 6. Habit management intent
  const intent = await detectHabitManagementIntent(text);
  if (intent) {
    return await _handleHabitIntent(intent, text, channel);
  }

  // 7. No active session — start a new user chat
  return await _startUserChat(text, channel);
}

async function _handlePendingRemindersResponse(text, pending, habitIds, channel) {
  const db = getDb();

  const habitsForDetection = [];
  const pendingByName = {};
  for (const habitId of habitIds) {
    const habit = db.prepare('SELECT name FROM habits WHERE id = ?').get(habitId);
    if (!habit) continue;
    const reminder = pending[habitId];
    habitsForDetection.push({
      id:     habitId,
      name:   habit.name,
      period: reminder ? reminder.period : null
    });
    pendingByName[habit.name] = reminder;
  }
  if (habitsForDetection.length === 0) return false;

  const responses = await detectMultiHabitResponses(text, habitsForDetection);

  let completedCount = 0;
  let declinedCount  = 0;
  const completedNames = [];
  const declinedNames  = [];

  for (const habit of habitsForDetection) {
    const status = responses[habit.name];
    if (status === 'completed') {
      await _recordReminderResponse(pendingByName[habit.name], 'completed');
      completedCount++;
      completedNames.push(habit.name);
    } else if (status === 'declined') {
      await _recordReminderResponse(pendingByName[habit.name], 'declined');
      declinedCount++;
      declinedNames.push(habit.name);
    }
  }

  if (completedCount === 0 && declinedCount === 0) {
    return false;
  }

  let reply;
  if (completedCount > 0 && declinedCount === 0) {
    if (completedNames.length === 1) {
      reply = `Super gedaan met "${completedNames[0]}"! 💪 Geregistreerd.`;
    } else {
      reply = `Super gedaan! 💪 Ik heb ${completedNames.map(n => `"${n}"`).join(' en ')} geregistreerd.`;
    }
  } else if (declinedCount > 0 && completedCount === 0) {
    reply = 'Geen probleem, ik probeer het later opnieuw. 👍';
  } else {
    reply = `Top dat je ${completedNames.map(n => `"${n}"`).join(' en ')} hebt gedaan! 💪 Voor ${declinedNames.map(n => `"${n}"`).join(' en ')} probeer ik het later opnieuw. 👍`;
  }

  await _sendMessage(reply, channel);
  return true;
}

const STOP_WORDS = ['klaar', 'stop', 'afsluiten', 'einde', 'bye', 'doei', 'tot later', 'done'];
const MAX_HISTORY = 20;

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
  const wantsToStop = _matchesAnyWord(text, STOP_WORDS);

  if (wantsToStop) {
    clearConversationState();
    await _sendMessage('Tot later! 👋 Laat het me weten als je me nodig hebt.', channel);
    logger.info('Gebruikersgesprek afgesloten op verzoek');
    return;
  }

  const history = state.history || [];
  const reply   = await generateGenericResponse(text, history);

  const updatedHistory = [
    ...history,
    { role: 'user',      content: text  },
    { role: 'assistant', content: reply }
  ].slice(-MAX_HISTORY);

  setConversationState({ ...state, history: updatedHistory });
  await _sendMessage(reply, channel);
}

async function _handleFridayMessage(text, state) {
  const db = getDb();

  const result = await processFridaySession(text, state);

  if (Array.isArray(result.sideEffects)) {
    for (const note of result.sideEffects) {
      logger.info(`Vrijdagsessie ${state.sessionId}: ${note}`);
    }
  }

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

async function _recordReminderResponse(pendingReminder, response) {
  if (!pendingReminder) return;
  const db        = getDb();
  const habitId   = pendingReminder.habitId;
  const completed = response === 'completed' ? 1 : 0;

  db.prepare('UPDATE reminders SET response = ?, completed = ? WHERE id = ?')
    .run(response, completed, pendingReminder.reminderId);

  logger.info(`Herinnering #${pendingReminder.reminderId} bijgewerkt → ${response}`);
  clearPendingReminder(habitId);
}

module.exports = { handleIncomingMessage, setMessageSender };