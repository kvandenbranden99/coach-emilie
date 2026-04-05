// In-memory state — survives within a process, seeded from DB on restart

// Active conversation state
// Types: 'idle' | 'friday_session' | 'habit_management'
let conversationState = { type: 'idle' };

// Pending reminder responses, keyed by habitId
// { [habitId]: { reminderId, habitId, period, sentAt, attemptNumber } }
const pendingReminders = {};

// In-progress habit-addition conversation state
let habitConversationState = null;

// --- Conversation state ---

function getConversationState() {
  return conversationState;
}

function setConversationState(state) {
  conversationState = state;
}

function clearConversationState() {
  conversationState = { type: 'idle' };
}

// --- Pending reminders ---

function getPendingReminder(habitId) {
  return pendingReminders[String(habitId)];
}

function getPendingReminders() {
  return pendingReminders;
}

function setPendingReminder(habitId, reminder) {
  pendingReminders[String(habitId)] = reminder;
}

function clearPendingReminder(habitId) {
  delete pendingReminders[String(habitId)];
}

function hasPendingReminders() {
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
  getPendingReminder,
  getPendingReminders,
  setPendingReminder,
  clearPendingReminder,
  hasPendingReminders,
  getHabitConversationState,
  setHabitConversationState,
  clearHabitConversationState
};
