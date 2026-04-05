const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('./database/db');
const {
  setHabitConversationState,
  clearHabitConversationState,
  getHabitConversationState
} = require('./state');
const logger = require('./utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

const INTENT = {
  ADD:    'add',
  REMOVE: 'remove',
  PAUSE:  'pause',
  RESUME: 'resume',
  LIST:   'list'
};

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

async function detectHabitManagementIntent(userMessage) {
  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 10,
    system:     `Analyseer of het bericht van de gebruiker betrekking heeft op gewoontenbeheer.
Antwoord enkel met één van deze opties: "add", "remove", "pause", "resume", "list", of "none".
- add:    gebruiker wil een nieuwe gewoonte toevoegen
- remove: gebruiker wil een gewoonte verwijderen
- pause:  gebruiker wil een gewoonte tijdelijk pauzeren
- resume: gebruiker wil een gepauzeerde gewoonte hervatten
- list:   gebruiker wil een overzicht van zijn gewoonten zien
- none:   het bericht gaat niet over gewoontenbeheer`,
    messages: [{ role: 'user', content: userMessage }]
  });

  const raw = response.content[0].text.trim().toLowerCase();
  return Object.values(INTENT).includes(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// Add-habit conversation flow
// ---------------------------------------------------------------------------

const ADD_QUESTIONS = [
  { field: 'name',       question: 'Wat is de naam van de gewoonte?' },
  { field: 'description',question: 'Wat houdt de gewoonte precies in?' },
  { field: 'timesPerDay',question: 'Hoe vaak per dag wil je dit doen? (bijv. 1, 2 of 3)' },
  { field: 'periods',    question: 'Op welk moment van de dag? (voormiddag / namiddag / avond — meerdere zijn mogelijk)' },
  { field: 'timeRange',  question: 'Is er een vroegste of laatste tijdstip? (bijv. "08:00 tot 22:00", of typ "geen")' }
];

async function startAddHabitConversation() {
  setHabitConversationState({ step: 0, data: {} });
  return ADD_QUESTIONS[0].question;
}

/**
 * Process the next answer in the add-habit flow.
 * Returns the next question, a confirmation message, or null when done.
 */
async function processAddHabitStep(userMessage) {
  const state = getHabitConversationState();
  if (!state) return null;

  const q = ADD_QUESTIONS[state.step];
  state.data[q.field] = userMessage.trim();
  state.step += 1;

  if (state.step < ADD_QUESTIONS.length) {
    setHabitConversationState(state);
    return ADD_QUESTIONS[state.step].question;
  }

  // All questions answered — save and confirm
  clearHabitConversationState();
  return await _saveNewHabit(state.data);
}

async function _saveNewHabit(data) {
  const db = getDb();

  // Parse periods from Dutch natural language
  const periodMap = {
    voormiddag: 'morning',
    ochtend:    'morning',
    namiddag:   'afternoon',
    middag:     'afternoon',
    avond:      'evening',
    nacht:      'evening'
  };
  const input   = data.periods.toLowerCase();
  const periods = Object.entries(periodMap)
    .filter(([key]) => input.includes(key))
    .map(([, val]) => val)
    .filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate
  if (periods.length === 0) periods.push('morning');

  // Parse time range
  let earliestTime = '08:00';
  let latestTime   = '23:00';
  if (data.timeRange && data.timeRange.toLowerCase() !== 'geen') {
    const matches = data.timeRange.match(/\d{1,2}:\d{2}/g);
    if (matches && matches[0]) earliestTime = matches[0];
    if (matches && matches[1]) latestTime   = matches[1];
  }

  const timesPerDay = Math.max(1, parseInt(data.timesPerDay, 10) || 1);

  db.prepare(`
    INSERT INTO habits (name, description, frequency, times_per_day, preferred_periods, earliest_time, latest_time)
    VALUES (?, ?, 'daily', ?, ?, ?, ?)
  `).run(data.name, data.description, timesPerDay, JSON.stringify(periods), earliestTime, latestTime);

  logger.info(`Nieuwe gewoonte aangemaakt: ${data.name}`);

  const periodLabels = { morning: 'voormiddag', afternoon: 'namiddag', evening: 'avond' };
  const periodText   = periods.map(p => periodLabels[p] || p).join(', ');
  return `✅ Gewoonte "${data.name}" is toegevoegd! Ik stuur je voortaan ${timesPerDay}× per dag een herinnering (${periodText}).`;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

async function removeHabit(habitName) {
  const db    = getDb();
  const habit = db.prepare('SELECT * FROM habits WHERE name LIKE ? AND active = 1').get(`%${habitName}%`);
  if (!habit) return `Ik vond geen actieve gewoonte met de naam "${habitName}".`;

  db.prepare('UPDATE habits SET active = 0 WHERE id = ?').run(habit.id);
  logger.info(`Gewoonte verwijderd: ${habit.name}`);
  return `🗑️ Gewoonte "${habit.name}" is verwijderd.`;
}

async function pauseHabit(habitName) {
  const db    = getDb();
  const habit = db.prepare('SELECT * FROM habits WHERE name LIKE ? AND active = 1').get(`%${habitName}%`);
  if (!habit) return `Ik vond geen actieve gewoonte met de naam "${habitName}".`;

  db.prepare('UPDATE habits SET active = 0 WHERE id = ?').run(habit.id);
  logger.info(`Gewoonte gepauzeerd: ${habit.name}`);
  return `⏸️ Gewoonte "${habit.name}" is gepauzeerd.`;
}

async function resumeHabit(habitName) {
  const db    = getDb();
  const habit = db.prepare('SELECT * FROM habits WHERE name LIKE ? AND active = 0').get(`%${habitName}%`);
  if (!habit) return `Ik vond geen gepauzeerde gewoonte met de naam "${habitName}".`;

  db.prepare('UPDATE habits SET active = 1 WHERE id = ?').run(habit.id);
  logger.info(`Gewoonte hervat: ${habit.name}`);
  return `▶️ Gewoonte "${habit.name}" is hervat! Fijn dat je het weer oppikt. 💪`;
}

async function listHabits() {
  const db     = getDb();
  const habits = db.prepare('SELECT * FROM habits WHERE active = 1').all();
  if (habits.length === 0) return 'Je hebt momenteel geen actieve gewoonten.';

  const periodLabels = { morning: 'voormiddag', afternoon: 'namiddag', evening: 'avond' };
  const lines = habits.map(h => {
    const periods    = JSON.parse(h.preferred_periods || '[]');
    const periodText = periods.map(p => periodLabels[p] || p).join(', ');
    return `• ${h.name}: ${h.times_per_day}× per dag (${periodText})`;
  });

  return `📋 Jouw actieve gewoonten:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Helper: extract habit name from free-text message
// ---------------------------------------------------------------------------

async function extractHabitNameFromMessage(message) {
  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 30,
    system:     'Extraheer de naam van de gewoonte uit het bericht. Antwoord enkel met de naam, of "onbekend" als je het niet kan bepalen.',
    messages:   [{ role: 'user', content: message }]
  });

  const name = response.content[0].text.trim();
  return name.toLowerCase() === 'onbekend' ? null : name;
}

module.exports = {
  detectHabitManagementIntent,
  startAddHabitConversation,
  processAddHabitStep,
  removeHabit,
  pauseHabit,
  resumeHabit,
  listHabits,
  extractHabitNameFromMessage,
  INTENT
};
