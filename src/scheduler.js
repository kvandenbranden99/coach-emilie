const cron = require('node-cron');
const { DateTime } = require('luxon');

const { getDb } = require('./database/db');
const {
  generateHabitReminder,
  generateWeekReport,
  FRIDAY_STEPS
} = require('./coach');
const { determineChannel } = require('./channelRouter');
const { isCurrentlyFree } = require('./calendar');
const {
  setPendingReminder,
  setConversationState,
  clearConversationState,
  getConversationState,
  isConversationStale
} = require('./state');
const { periodDefinitions } = require('./config/habits');
const logger = require('./utils/logger');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Brussels';

let _sendMessage = null;

function setMessageSender(fn) {
  _sendMessage = fn;
}

// ---------------------------------------------------------------------------
// Public: start all cron jobs
// ---------------------------------------------------------------------------

function initScheduler() {
  // Every 30 min during 08:00–22:30 (fires at :00 and :30)
  cron.schedule('*/30 8-22 * * *', async () => {
    await checkAndSendHabitReminders();
  }, { timezone: TIMEZONE });

  // Extra tick at 23:00 to catch the last half-hour of the day
  cron.schedule('0 23 * * *', async () => {
    await checkAndSendHabitReminders();
  }, { timezone: TIMEZONE });

  // Friday at 13:00 → weekly session
  cron.schedule('0 13 * * 5', async () => {
    await startFridaySession();
  }, { timezone: TIMEZONE });

  // Daily at midnight → clean up unanswered reminders
  cron.schedule('0 0 * * *', async () => {
    await midnightCleanup();
  }, { timezone: TIMEZONE });

  logger.info('Scheduler geïnitialiseerd');
}

// ---------------------------------------------------------------------------
// Habit reminder logic
// ---------------------------------------------------------------------------

async function checkAndSendHabitReminders() {
  const now     = DateTime.now().setZone(TIMEZONE);
  const dateStr = now.toFormat('yyyy-MM-dd');

  // Auto-close stale user_chat so reminders aren't suppressed indefinitely.
  if (isConversationStale()) {
    logger.info('user_chat verlopen door inactiviteit — automatisch afgesloten door scheduler');
    clearConversationState();
  }

  // Skip reminder checks during Friday session or active user chat
  const convType = getConversationState().type;
  if (convType === 'friday_session' || convType === 'user_chat') {
    logger.debug(`Gesprek actief (${convType}) — herinneringen overgeslagen`);
    return;
  }

  const db     = getDb();
  const habits = db.prepare('SELECT * FROM habits WHERE active = 1').all();

  for (const habit of habits) {
    const periods = JSON.parse(habit.preferred_periods || '[]');
    for (const period of periods) {
      try {
        await _processHabitPeriod(habit, period, now, dateStr);
      } catch (err) {
        logger.error(`Fout bij verwerken ${habit.name}/${period}:`, err.message);
      }
    }
  }
}

function _parseTimeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

async function _processHabitPeriod(habit, period, now, dateStr) {
  const bounds = periodDefinitions[period];
  if (!bounds) return;

  const periodStartMin = _parseTimeToMinutes(bounds.start);
  const periodEndMin   = _parseTimeToMinutes(bounds.end);
  const nowMin         = now.hour * 60 + now.minute;

  // Outside this period → skip
  if (nowMin < periodStartMin || nowMin >= periodEndMin) return;

  const db = getDb();

  // Already completed this period today?
  const completed = db.prepare(`
    SELECT id FROM reminders
    WHERE habit_id = ? AND period = ? AND date = ? AND completed = 1
    LIMIT 1
  `).get(habit.id, period, dateStr);
  if (completed) return;

  // Most recent reminder for this habit+period today
  const latest = db.prepare(`
    SELECT * FROM reminders
    WHERE habit_id = ? AND period = ? AND date = ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(habit.id, period, dateStr);

  const retryMinutes = habit.retry_after_minutes || 30;

  if (!latest) {
    // No reminder sent yet in this period → try immediately
    await _sendReminderIfFree(habit, period, now, dateStr, bounds, 1);
    return;
  }

  const response       = latest.response;
  const sentAt         = DateTime.fromSQL(latest.sent_at, { zone: TIMEZONE });
  const minutesSinceSent = now.diff(sentAt, 'minutes').minutes;

  if (!response) {
    // No response received yet
    // Rule: if >30 min without response AND currently free → retry
    if (minutesSinceSent >= retryMinutes) {
      await _sendReminderIfFree(habit, period, now, dateStr, bounds, latest.attempt_number + 1);
    }
    return;
  }

  if (response === 'declined') {
    // Declined → wait retryMinutes then retry if free
    if (minutesSinceSent >= retryMinutes) {
      await _sendReminderIfFree(habit, period, now, dateStr, bounds, latest.attempt_number + 1);
    }
    return;
  }

  // response === 'completed' → nothing to do
}

async function _sendReminderIfFree(habit, period, now, dateStr, bounds, attemptNumber) {
  const [sh, sm] = bounds.start.split(':').map(Number);
  const [eh, em] = bounds.end.split(':').map(Number);

  const periodStart = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const periodEnd   = now.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

  const free = await isCurrentlyFree(periodStart, periodEnd);
  if (!free) {
    logger.debug(`${habit.name} (${period}): agenda bezet, herinnering overgeslagen`);
    return;
  }

  // Generate message
  const text = await generateHabitReminder(habit, period, attemptNumber);

  // Channel: Friday session always Telegram, others by time
  const channel = await determineChannel();
  await _sendMessage(text, channel);

  // Persist
  const db     = getDb();
  const result = db.prepare(`
    INSERT INTO reminders (habit_id, period, sent_at, attempt_number, date)
    VALUES (?, ?, ?, ?, ?)
  `).run(habit.id, period, now.toSQL(), attemptNumber, dateStr);

  setPendingReminder(habit.id, {
    reminderId:    result.lastInsertRowid,
    habitId:       habit.id,
    period,
    sentAt:        now,
    attemptNumber
  });

  logger.info(`Herinnering verstuurd: "${habit.name}" (${period}, poging ${attemptNumber}) via ${channel}`);
}

// ---------------------------------------------------------------------------
// Friday session — scheduled (cron) version
// ---------------------------------------------------------------------------

async function startFridaySession() {
  const now = DateTime.now().setZone(TIMEZONE);
  const db  = getDb();

  // Prevent duplicate sessions for the same week
  const existing = db.prepare(`
    SELECT id FROM friday_sessions
    WHERE week_number = ? AND year = ?
  `).get(now.weekNumber, now.year);

  if (existing) {
    logger.warn(`Vrijdagsessie week ${now.weekNumber}/${now.year} bestaat al, overgeslagen`);
    return;
  }

  logger.info('Vrijdagsessie starten…');

  const { lastInsertRowid: sessionId } = db.prepare(`
    INSERT INTO friday_sessions (week_number, year) VALUES (?, ?)
  `).run(now.weekNumber, now.year);

  // Set conversation state BEFORE sending, so incoming replies are routed correctly
  setConversationState({
    type:      'friday_session',
    sessionId,
    step:      'opening',
    history:   []
  });

  await _sendMessage('Goedemiddag! Tijd voor onze wekelijkse check-in. 😊', 'telegram');

  // Brief pause, then send the week report + first question
  setTimeout(async () => {
    try {
      const report = await generateWeekReport(now.weekNumber, now.year);
      await _sendMessage(report, 'telegram');

      // Advance to first question step
      setConversationState({
        type:      'friday_session',
        sessionId,
        step:      'went_well',
        history:   [
          { role: 'assistant', content: 'Goedemiddag! Tijd voor onze wekelijkse check-in. 😊' },
          { role: 'assistant', content: report }
        ]
      });

      await _sendMessage('Wat is er goed gegaan deze week? 🌟', 'telegram');
    } catch (err) {
      logger.error('Fout na opening vrijdagsessie:', err);
    }
  }, 2500);
}

// ---------------------------------------------------------------------------
// Friday session — user-triggered version (resume or start fresh)
// ---------------------------------------------------------------------------

/**
 * Determine the next step for an existing (open) Friday session
 * by inspecting which fields are already filled in the DB.
 */
function _inferNextStepForOpenSession(session) {
  // Map filled fields to the next logical question.
  // The session table only persists went_well, was_difficult and grateful_for,
  // so for the in-between steps we can only tell "we are past went_well",
  // "we are past was_difficult", etc. We always restart on the *next* unanswered
  // question.
  if (!session.went_well)     return 'went_well';
  if (!session.was_difficult) return 'was_difficult';
  if (!session.grateful_for)  return 'gratitude';
  return 'closing';
}

/**
 * Load the assistant/user history for a session from conversation_history,
 * trimmed to the most recent N turns to keep the context manageable.
 */
function _loadSessionHistory(sessionId, limit = 30) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT role, content
    FROM conversation_history
    WHERE session_type = 'friday_session' AND session_id = ?
    ORDER BY id ASC
  `).all(sessionId);

  // Keep only the last `limit` turns
  return rows.slice(-limit).map(r => ({ role: r.role, content: r.content }));
}

/**
 * User-triggered Friday session.
 *  - If an open session for this week exists → resume from the next unanswered step.
 *  - Otherwise → start a brand new session, including week report.
 *
 * @param {string} channel  channel the user triggered from ('telegram' | 'slack')
 */
async function triggerFridaySessionFromUser(channel = 'telegram') {
  const now = DateTime.now().setZone(TIMEZONE);
  const db  = getDb();

  // Look for an existing OPEN session this week
  const existing = db.prepare(`
    SELECT * FROM friday_sessions
    WHERE week_number = ? AND year = ? AND ended_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(now.weekNumber, now.year);

  if (existing) {
    return await _resumeFridaySession(existing, channel);
  }
  return await _startFridaySessionForUser(channel);
}

async function _resumeFridaySession(session, channel) {
  const nextStep = _inferNextStepForOpenSession(session);
  const history  = _loadSessionHistory(session.id);

  setConversationState({
    type:      'friday_session',
    sessionId: session.id,
    step:      nextStep,
    history
  });

  // Friday session always goes via Telegram, but we acknowledge
  // on the channel the user used so they know it has been picked up.
  if (channel !== 'telegram') {
    await _sendMessage('Ik pak de vrijdagsessie op in Telegram. 📲', channel);
  }
  await _sendMessage(
    'We pakken onze wekelijkse check-in weer op waar we gestopt zijn. 😊',
    'telegram'
  );

  // Re-ask the appropriate question for the step we land on
  const followUp = {
    went_well:     'Wat is er goed gegaan deze week? 🌟',
    was_difficult: 'Wat was er moeilijk deze week?',
    gratitude:     'Waar ben je dankbaar voor deze week?',
    closing:       'We hadden eigenlijk al alles besproken. Wil je nog iets toevoegen voor we afsluiten?'
  };
  await _sendMessage(followUp[nextStep] || followUp.went_well, 'telegram');

  logger.info(`Vrijdagsessie ${session.id} hervat op stap "${nextStep}"`);
}

async function _startFridaySessionForUser(channel) {
  const now = DateTime.now().setZone(TIMEZONE);
  const db  = getDb();

  logger.info('Vrijdagsessie gestart op vraag van gebruiker');

  const { lastInsertRowid: sessionId } = db.prepare(`
    INSERT INTO friday_sessions (week_number, year) VALUES (?, ?)
  `).run(now.weekNumber, now.year);

  setConversationState({
    type:      'friday_session',
    sessionId,
    step:      'opening',
    history:   []
  });

  if (channel !== 'telegram') {
    await _sendMessage('Ik start onze wekelijkse check-in op in Telegram. 📲', channel);
  }
  await _sendMessage('Tijd voor onze wekelijkse check-in. 😊', 'telegram');

  // Brief pause, then send the week report + first question
  setTimeout(async () => {
    try {
      const report = await generateWeekReport(now.weekNumber, now.year);
      await _sendMessage(report, 'telegram');

      setConversationState({
        type:      'friday_session',
        sessionId,
        step:      'went_well',
        history:   [
          { role: 'assistant', content: 'Tijd voor onze wekelijkse check-in. 😊' },
          { role: 'assistant', content: report }
        ]
      });

      await _sendMessage('Wat is er goed gegaan deze week? 🌟', 'telegram');
    } catch (err) {
      logger.error('Fout na opening (user-triggered) vrijdagsessie:', err.message);
    }
  }, 2500);
}

// ---------------------------------------------------------------------------
// Midnight cleanup
// ---------------------------------------------------------------------------

async function midnightCleanup() {
  const yesterday = DateTime.now().setZone(TIMEZONE).minus({ days: 1 });
  const dateStr   = yesterday.toFormat('yyyy-MM-dd');
  const db        = getDb();

  // Mark all unanswered reminders from yesterday as 'no_response'
  db.prepare(`
    UPDATE reminders SET response = 'no_response'
    WHERE date = ? AND response IS NULL
  `).run(dateStr);

  // Also clear any lingering user_chat at midnight (safety net)
  if (getConversationState().type === 'user_chat') {
    clearConversationState();
    logger.info('user_chat opgeruimd bij nachtelijke cleanup');
  }

  logger.info(`Nachtopruiming voltooid voor ${dateStr}`);
}

module.exports = {
  initScheduler,
  setMessageSender,
  startFridaySession,
  triggerFridaySessionFromUser
};
