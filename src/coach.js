const Anthropic = require('@anthropic-ai/sdk');
const { DateTime } = require('luxon');
const { getDb } = require('./database/db');
const { periodLabels } = require('./config/habits');
const logger = require('./utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL   = 'claude-sonnet-4-6';
const TIMEZONE = process.env.TIMEZONE || 'Europe/Brussels';

// ---------------------------------------------------------------------------
// System prompt helpers
// ---------------------------------------------------------------------------

function getActiveHabitsText() {
  const db     = getDb();
  const habits = db.prepare('SELECT * FROM habits WHERE active = 1').all();
  if (habits.length === 0) return 'Geen actieve gewoonten.';

  return habits.map(h => {
    const periods = JSON.parse(h.preferred_periods || '[]');
    const periodText = periods.map(p => periodLabels[p] || p).join(', ');
    return `- ${h.name}: ${h.description} (${h.times_per_day}× per dag, ${periodText})`;
  }).join('\n');
}

function buildSystemPrompt() {
  const now      = DateTime.now().setZone(TIMEZONE);
  const userName = process.env.USER_NAME || 'gebruiker';

  return `Je bent een persoonlijke coach voor ${userName}.
Je communiceert in het Nederlands, op een warme maar directe toon.
Je bent motiverend maar realistisch.
Je houdt bij wat de gebruiker belooft en vraagt er de volgende keer naar.
Je bent bondig in je berichten — maximaal 3 à 4 zinnen per bericht, tenzij het een uitgebreide sessie betreft.
Je gebruikt af en toe een emoji om de toon luchtig te houden.
Je detecteert automatisch of een reactie positief of negatief is.

De actieve gewoonten van de gebruiker:
${getActiveHabitsText()}

Huidige datum en tijd: ${now.setLocale('nl').toFormat("cccc d MMMM yyyy 'om' HH:mm")}
Tijdzone: ${TIMEZONE}`;
}

// ---------------------------------------------------------------------------
// Habit reminders
// ---------------------------------------------------------------------------

/**
 * Generate a reminder message for a habit in a given period.
 */
async function generateHabitReminder(habit, period, attemptNumber) {
  const periodLabel = periodLabels[period] || period;

  const prompt = attemptNumber === 1
    ? `Stuur een vriendelijke, motiverende herinnering aan de gebruiker om "${habit.name}" te doen (${habit.description}). Het is nu de ${periodLabel}. Houd het kort en energiek.`
    : `Stuur een korte, directe herinnering (poging ${attemptNumber}) aan de gebruiker om "${habit.name}" te doen (${habit.description}). Ze reageerden eerder niet. Houd het heel bondig.`;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 120,
    system:     buildSystemPrompt(),
    messages:   [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

/**
 * Classify a user message as 'completed', 'declined', or 'unknown'.
 * Pass habitName to evaluate whether that specific habit was completed.
 */
async function detectResponse(userMessage, habitName = null) {
  const subject = habitName ? `"${habitName}"` : 'de gevraagde taak';
  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 10,
    system:     `Analyseer of het bericht aangeeft dat de gebruiker ${subject} gedaan heeft (positief) of niet kan/wil doen (negatief).
Als het bericht meerdere gewoonten bespreekt, beoordeel dan uitsluitend of ${subject} als gedaan wordt gemeld.
Antwoord enkel met één woord: "completed", "declined", of "unknown".
Voorbeelden positief: gedaan, klaar, ✓, 👍, ja, gelukt, oké, al gehaald.
Voorbeelden negatief: nee, geen tijd, kan niet, later, straks, nog niet, ❌, overgeslagen.`,
    messages:   [{ role: 'user', content: userMessage }]
  });

  const result = response.content[0].text.trim().toLowerCase();
  if (result.includes('completed')) return 'completed';
  if (result.includes('declined'))  return 'declined';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Friday session
// ---------------------------------------------------------------------------

// Ordered steps in the Friday session
const FRIDAY_STEPS = [
  'opening',
  'went_well',
  'was_difficult',
  'todo_review',
  'todo_discussion',
  'new_todos',
  'gratitude',
  'closing'
];

const STEP_PROMPTS = {
  opening:         'Start de sessie met een warme begroeting en kondig aan dat je het weekoverzicht al hebt gestuurd. Vraag wat er goed is gegaan deze week.',
  went_well:       'De gebruiker heeft geantwoord op "wat ging goed". Reageer kort en positief en vraag daarna: "Wat was er moeilijk deze week?"',
  was_difficult:   'De gebruiker heeft geantwoord op "wat was moeilijk". Reageer empathisch en vraag of ze de openstaande to-do\'s van vorige week willen bespreken.',
  todo_review:     'Begeleid het gesprek over de openstaande to-do\'s. Vraag hoe het gegaan is met elk item.',
  todo_discussion: 'Bespreek de to-do\'s verder. Vraag door bij niet-voltooide taken. Wanneer de gebruiker klaar is, vraag welke to-do\'s ze de komende week willen oppikken of toevoegen.',
  new_todos:       'Help de gebruiker nieuwe to-do\'s formuleren. Zorg dat elke to-do specifiek en controleerbaar is. Vraag: hoe vaak en wanneer? Als de gebruiker klaar is, stel dan de dankbaarheidsvraag.',
  gratitude:       'De gebruiker heeft de nieuwe to-do\'s opgegeven. Vraag nu: "Waar ben je dankbaar voor deze week?"',
  closing:         'De gebruiker heeft de dankbaarheidsvraag beantwoord. Sluit de sessie warm af en laat hen weten dat je zo de samenvatting stuurt.'
};

/**
 * Process a single turn in the Friday session.
 * Returns { responseText, nextStep, isComplete, extractedData }
 */
async function processFridaySession(userMessage, sessionState) {
  const db = getDb();
  const { sessionId, step, history } = sessionState;

  // Detect explicit close request
  const closeWords = ['klaar', 'stop', 'afsluiten', 'einde', 'done', 'finish'];
  const wantsToClose = userMessage
    && closeWords.some(w => userMessage.toLowerCase().includes(w));

  const currentStep = wantsToClose ? 'closing' : step;
  const stepPrompt  = STEP_PROMPTS[currentStep] || STEP_PROMPTS.closing;

  // Build conversation history for Claude
  const messages = [
    ...(history || []).map(h => ({ role: h.role, content: h.content }))
  ];
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  const systemPrompt = `${buildSystemPrompt()}

Je leidt momenteel een vrijdagsessie (stap: "${currentStep}").
Instructie voor deze stap: ${stepPrompt}
Reageer passend op het bericht van de gebruiker en leid het gesprek verder.`;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 400,
    system:     systemPrompt,
    messages:   messages.length > 0
      ? messages
      : [{ role: 'user', content: 'Start de sessie.' }]
  });

  const responseText = response.content[0].text;

  // Persist to conversation_history
  if (userMessage) {
    db.prepare(`
      INSERT INTO conversation_history (session_type, session_id, role, content)
      VALUES ('friday_session', ?, 'user', ?)
    `).run(sessionId, userMessage);

    // Save step-specific data
    if (step === 'went_well') {
      db.prepare('UPDATE friday_sessions SET went_well = ? WHERE id = ?').run(userMessage, sessionId);
    } else if (step === 'was_difficult') {
      db.prepare('UPDATE friday_sessions SET was_difficult = ? WHERE id = ?').run(userMessage, sessionId);
    } else if (step === 'gratitude') {
      db.prepare('UPDATE friday_sessions SET grateful_for = ? WHERE id = ?').run(userMessage, sessionId);
    }
  }

  db.prepare(`
    INSERT INTO conversation_history (session_type, session_id, role, content)
    VALUES ('friday_session', ?, 'assistant', ?)
  `).run(sessionId, responseText);

  // Determine next step
  const isComplete = currentStep === 'closing';
  let nextStep = currentStep;
  if (!isComplete) {
    const idx = FRIDAY_STEPS.indexOf(currentStep);
    nextStep = idx >= 0 && idx < FRIDAY_STEPS.length - 1
      ? FRIDAY_STEPS[idx + 1]
      : 'closing';
  }

  return { responseText, nextStep, isComplete };
}

// ---------------------------------------------------------------------------
// Week report
// ---------------------------------------------------------------------------

/**
 * Build the formatted habit week report string.
 */
async function generateWeekReport(weekNumber, year) {
  const db     = getDb();
  const habits = db.prepare('SELECT * FROM habits WHERE active = 1').all();
  const now    = DateTime.now().setZone(TIMEZONE);
  const weekStart = now.startOf('week'); // Monday

  const dayNames = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag'];

  let report = '📊 Jouw gewoonterapport van deze week:\n\n';

  for (const habit of habits) {
    const periods      = JSON.parse(habit.preferred_periods || '[]');
    const habitEmoji   = habit.name.toLowerCase().includes('stap') ? '🚶' : '🌬️';
    let totalExpected  = 0;
    let totalCompleted = 0;

    report += `${habitEmoji} ${habit.name}\n`;

    for (let i = 0; i < 5; i++) {
      const day     = weekStart.plus({ days: i });
      const dateStr = day.toFormat('yyyy-MM-dd');
      const isToday  = day.hasSame(now, 'day');
      const isFuture = day > now;

      if (isFuture) break;

      const dayReminders = db.prepare(`
        SELECT period, completed FROM reminders
        WHERE habit_id = ? AND date = ?
      `).all(habit.id, dateStr);

      const checks = periods.map(p => {
        if (isToday) {
          const r = dayReminders.find(x => x.period === p);
          if (!r) return '⏳';
          return r.completed ? '✅' : '❌';
        }
        const r = dayReminders.find(x => x.period === p);
        if (!r) { totalExpected++; return '❌'; }
        totalExpected++;
        if (r.completed) { totalCompleted++; return '✅'; }
        return '❌';
      });

      if (isToday) {
        const done = dayReminders.filter(r => r.completed).length;
        totalCompleted += done;
        totalExpected  += habit.times_per_day;
      }

      const completedToday = dayReminders.filter(r => r.completed).length;
      const totalForDay    = habit.times_per_day;
      report += `- ${dayNames[i]}: ${checks.join(' ')} (${completedToday}/${totalForDay})\n`;
    }

    const score        = totalExpected > 0 ? Math.round((totalCompleted / totalExpected) * 100) : 0;
    const scoreEmoji   = score >= 80 ? '🔥' : score >= 60 ? '💪' : '📈';
    report += `Weekscore: ${totalCompleted}/${totalExpected} — ${score}% ${scoreEmoji}\n\n`;
  }

  return report;
}

// ---------------------------------------------------------------------------
// Session summary
// ---------------------------------------------------------------------------

async function generateSessionSummary(sessionId) {
  const db      = getDb();
  const session = db.prepare('SELECT * FROM friday_sessions WHERE id = ?').get(sessionId);
  if (!session) return 'Geen sessie gevonden.';

  const todos = db.prepare(`
    SELECT description FROM todos WHERE week_number = ? AND year = ? AND completed = 0
  `).all(session.week_number, session.year);

  const prompt = `Genereer een bondige, warme samenvatting van de vrijdagsessie op basis van:
- Wat ging goed: ${session.went_well || '(niet ingevuld)'}
- Wat was moeilijk: ${session.was_difficult || '(niet ingevuld)'}
- Dankbaar voor: ${session.grateful_for || '(niet ingevuld)'}
- Nieuwe to-do's komende week: ${todos.length > 0 ? todos.map(t => t.description).join(', ') : 'geen'}

Sluit af met een motiverende zin voor de komende week.`;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 350,
    system:     buildSystemPrompt(),
    messages:   [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// ---------------------------------------------------------------------------
// Generic fallback response
// ---------------------------------------------------------------------------

async function generateGenericResponse(userMessage, recentHistory = []) {
  const messages = [
    ...recentHistory.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 200,
    system:     buildSystemPrompt(),
    messages
  });

  return response.content[0].text;
}

module.exports = {
  generateHabitReminder,
  detectResponse,
  processFridaySession,
  generateWeekReport,
  generateSessionSummary,
  generateGenericResponse,
  FRIDAY_STEPS
};
