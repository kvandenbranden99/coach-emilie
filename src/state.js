// In-memory state — survives within a process, seeded from DB on restart

const { getDb } = require('./database/db');

// How long a user_chat may stay open without any activity before it is
// auto-closed. Configurable via env var, defaults to 60 minutes.
const USER_CHAT_TIMEOUT_MS =
  Number(process.env.USER_CHAT_TIMEOUT_MINUTES || 60) * 60 * 1000;

// Active conversation state
// Types: 'idle' | 'friday_session' | 'user_chat'
let conversationState = { type: 'idle' };

// Timestamp (ms) of the last activity in the current conversationState.
// Updated whenever the state is set; consulted by isConversationStale().
let conversationStateUpdatedAt = Date.now();

// Pending reminder responses, keyed by habitId
// { [habitId]: { reminderId, habitId, period, sentAt, attemptNumber } }
const pendingReminders = {};

// Track whether we've already loaded from DB on this boot
let pendingRemindersLoaded = false;

// In-progress habit-addition conversation state
let habitConversationState = null;

// ---------------------------------------------------------------------------
// DB persistence helpers for pendingReminders
// ---------------------------------------------------------------------------

function _persistPendingReminders() {
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO system_state (key, value, updated_at)
      VALUES ('pending_reminders', ?, CURRENT_TIMESTAMP)
    `).run(JSON.stringify(pendingReminders));
  } catch (_) { /* non-fatal */ }
}

/**
 * Load pendingReminders from the DB once per process lifetime.
 * Called lazily on first read so the DB is guaranteed to be initialised.
 */
function _ensurePendingRemindersLoaded() {
  if (pendingRemindersLoaded) return;
  pendingRemindersLoaded = true;
  try {
    const row = getDb()
      .prepare(`SELECT value FROM system_state WHERE key = 'pending_reminders'`)
      .get();
    if (row) {
      const saved = JSON.parse(row.value);
      Object.assign(pendingReminders, saved);
    }
  } catch (_) { /* non-fatal */ }
}

// --- Conversation state ---

function getConversationState() {
  return conversationState;
}

function setConversationState(state) {
  conversationState = state;
  conversationStateUpdatedAt = Date.now();
}

function clearConversationState() {
  conversationState = { type: 'idle' };
  conversationStateUpdatedAt = Date.now();
}

/**
 * Returns true if the current conversationState is a user_chat that has been
 * inactive longer than USER_CHAT_TIMEOUT_MS. Other states (friday_session,
 * idle) never go stale via this mechanism.
 */
function isConversationStale() {
  if (conversationState.type !== 'user_chat') return false;
  return (Date.now() - conversationStateUpdatedAt) > USER_CHAT_TIMEOUT_MS;
}

// --- Pending reminders ---

function getPendingReminder(habitId) {
  _ensurePendingRemindersLoaded();
  return pendingReminders[String(habitId)];
}

function getPendingReminders() {
  _ensurePendingRemindersLoaded();
  return pendingReminders;
}

function setPendingReminder(habitId, reminder) {
  _ensurePendingRemindersLoaded();
  pendingReminders[String(habitId)] = reminder;
  _persistPendingReminders();
}

function clearPendingReminder(habitId) {
  _ensurePendingRemindersLoaded();
  delete pendingReminders[String(habitId)];
  _persistPendingReminders();
}

function hasPendingReminders() {
  _ensurePendingRemindersLoaded();
  return Object.keys(pendingReminders).length > 0;
}

// --- Habit conversation state ---

function getHabitConversationState() {
  return habitConversationState;
}

function setHabitConversationState(state) {
  habitConversationState = state;
}

function clearHabitConversationState() {
  habitConversationState = null;
}

module.exports = {
  getConversationState,
  setConversationState,
  clearConversationState,
  isConversationStale,
  getPendingReminder,
  getPendingReminders,
  setPendingReminder,
  clearPendingReminder,
  hasPendingReminders,
  getHabitConversationState,
  setHabitConversationState,
  clearHabitConversationState
};
