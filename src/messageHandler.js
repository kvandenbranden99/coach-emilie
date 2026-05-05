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

  // 2b. Late habit update — gebruiker meldt achteraf dat een eerder
  //     declined of niet-beantwoorde habit van vandaag tóch nog gedaan is.
  //     Pas alleen aan als het bericht plausibel over een habit gaat.
  if (_messageMentionsHabits(text)) {
    const handled = await _handleLateHabitUpdate(text, channel);
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

// ---------------------------------------------------------------------------
// Late habit update — handle "ah ja ik heb het tóch nog gedaan" boodschappen
// die binnenkomen NA de pending reminder gewist is (bv. door eerdere decline).
// ---------------------------------------------------------------------------

/**
 * Goedkope keyword-check vooraf: alleen als het bericht plausibel over
 * een habit gaat, gaan we Claude lastigvallen met een AI-call.
 */
function _messageMentionsHabits(text) {
  if (!text) return false;
  const db = getDb();
  const habits = db.prepare('SELECT name, description FROM habits WHERE active = 1').all();

  const habitWords = [];
  for (const h of habits) {
    // Splits habit-naam in losse betekenisvolle woorden (>3 letters)
    const words = `${h.name} ${h.description || ''}`
      .toLowerCase()
      .split(/[\s,.\-/]+/)
      .filter(w => w.length > 3);
    habitWords.push(...words);
  }

  // Generieke status-woorden die op een habit-update kunnen wijzen
  const statusWords = [
    'gedaan', 'voltooid', 'gehaald', 'gelukt', 'afgevinkt', 'gehaald',
    'overgeslagen', 'niet gelukt', 'mis', 'gemist', 'vergeten'
  ];

  const lower = text.toLowerCase();
  const hasHabitWord = habitWords.some(w => lower.includes(w));
  const hasStatusWord = statusWords.some(w => lower.includes(w));

  // Beide nodig: bericht moet over een specifieke habit gaan EN status melden
  return hasHabitWord && hasStatusWord;
}

/**
 * Probeer het bericht te interpreteren als een late update voor een habit
 * van vandaag (bijv. "ziezo, mijn 10000 stappen heb ik nu toch gedaan").
 * Zoekt voor elke vandaag-habit de meest recente reminder van vandaag op
 * en past die aan als het bericht ondubbelzinnig completed/declined zegt.
 *
 * Returns true als er minstens één DB-update is gebeurd (caller stopt dan
 * de routing). Returns false als er niets aangepast werd, zodat de gewone
 * chat-flow wordt voortgezet.
 */
async function _handleLateHabitUpdate(text, channel) {
  const db = getDb();
  const today = DateTime.now().setZone(TIMEZONE).toFormat('yyyy-MM-dd');

  // Zoek alle habits van vandaag die ALLEEN een reminder kregen — niet alleen
  // de actieve, maar gefilterd op "heeft een reminder vandaag".
  const habitsToday = db.prepare(`
    SELECT DISTINCT h.id, h.name
    FROM habits h
    JOIN reminders r ON r.habit_id = h.id
    WHERE h.active = 1 AND r.date = ?
  `).all(today);

  if (habitsToday.length === 0) return false;

  // Vraag Claude welke van deze habits het bericht expliciet noemt
  const responses = await detectMultiHabitResponses(text, habitsToday);

  let updatedCount  = 0;
  const completedNames = [];
  const declinedNames  = [];

  for (const habit of habitsToday) {
    const status = responses[habit.name];
    if (status !== 'completed' && status !== 'declined') continue;

    // Pak de meest recente reminder van vandaag voor deze habit
    const latest = db.prepare(`
      SELECT id, response, completed FROM reminders
      WHERE habit_id = ? AND date = ?
      ORDER BY sent_at DESC LIMIT 1
    `).get(habit.id, today);
    if (!latest) continue;

    const newCompleted = status === 'completed' ? 1 : 0;

    // Als de status al hetzelfde is, niets doen — anders raken we door de
    // pending-flow en deze flow dezelfde reminder twee keer aan.
    if (latest.response === status && latest.completed === newCompleted) continue;

    db.prepare('UPDATE reminders SET response = ?, completed = ? WHERE id = ?')
      .run(status, newCompleted, latest.id);

    logger.info(`Late update: herinnering #${latest.id} (${habit.name}) → ${status}`);
    updatedCount++;
    if (status === 'completed') completedNames.push(habit.name);
    else                        declinedNames.push(habit.name);
  }

  if (updatedCount === 0) return false;

  let reply;
  if (completedNames.length > 0 && declinedNames.length === 0) {
    if (completedNames.length === 1) {
      reply = `Top dat je "${completedNames[0]}" toch nog gedaan hebt! 💪 Aangepast.`;
    } else {
      reply = `Top! 💪 Ik heb ${completedNames.map(n => `"${n}"`).join(' en ')} alsnog op gedaan gezet.`;
    }
  } else if (declinedNames.length > 0 && completedNames.length === 0) {
    reply = `Oké, ${declinedNames.map(n => `"${n}"`).join(' en ')} laten we voor vandaag staan. 👍`;
  } else {
    reply = `Aangepast — ${completedNames.map(n => `"${n}"`).join(' en ')} op gedaan, ${declinedNames.map(n => `"${n}"`).join(' en ')} blijft staan. 👍`;
  }

  await _sendMessage(reply, channel);
  return true;
}

// ---------------------------------------------------------------------------
// User-initiated chat handlers
// ---------------------------------------------------------------------------

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
