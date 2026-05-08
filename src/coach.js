const Anthropic = require('@anthropic-ai/sdk');
const { DateTime } = require('luxon');
const { getDb } = require('./database/db');
const { periodLabels } = require('./config/habits');
const logger = require('./utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL   = 'claude-sonnet-4-6';
const TIMEZONE = process.env.TIMEZONE || 'Europe/Brussels';

// ---------------------------------------------------------------------------
// Word-boundary helpers
// ---------------------------------------------------------------------------

function _matchesAnyWord(message, keywords) {
  if (!message) return false;
  return keywords.some(kw => {
    if (/\s/.test(kw)) {
      return message.toLowerCase().includes(kw.toLowerCase());
    }
    return new RegExp(`\\b${kw}\\b`, 'i').test(message);
  });
}

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
 * (Legacy) classify a user message as 'completed', 'declined', or 'unknown'
 * for a single habit. Kept for backwards compatibility — for multi-habit
 * scenarios use detectMultiHabitResponses below.
 */
async function detectResponse(userMessage, habitName = null) {
  const subject = habitName ? `"${habitName}"` : 'de gevraagde taak';
  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 10,
    system:     `Analyseer of het bericht aangeeft dat de gebruiker ${subject} gedaan heeft (positief) of niet kan/wil doen (negatief).
Als het bericht meerdere gewoonten bespreekt, beoordeel dan uitsluitend of ${subject} als gedaan wordt gemeld.
Als het bericht ${subject} niet noemt, antwoord dan "unknown".
Antwoord enkel met één woord: "completed", "declined", of "unknown".`,
    messages:   [{ role: 'user', content: userMessage }]
  });

  const result = response.content[0].text.trim().toLowerCase();
  if (result.includes('completed')) return 'completed';
  if (result.includes('declined'))  return 'declined';
  return 'unknown';
}

/**
 * Classify a user message against MULTIPLE pending habits in a single call.
 */
async function detectMultiHabitResponses(userMessage, habits) {
  if (!userMessage || !habits || habits.length === 0) return {};

  const habitList = habits
    .map((h, i) => {
      const periodHint = h.period ? ` (${periodLabels[h.period] || h.period})` : '';
      return `${i + 1}. "${h.name}"${periodHint}`;
    })
    .join('\n');

  const result = {};
  habits.forEach(h => { result[h.name] = 'not_mentioned'; });

  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 200,
      system: `Je analyseert een bericht van een gebruiker tegen een lijst van openstaande
gewoonten. Voor ELKE gewoonte beoordeel je:
- "completed" → de gebruiker meldt SPECIFIEK dat deze gewoonte gedaan is.
- "declined"  → de gebruiker meldt SPECIFIEK dat deze gewoonte (nu) niet kan/wil.
- "not_mentioned" → de gewoonte wordt niet expliciet besproken in het bericht.

Wees STRIKT. Bij twijfel kies "not_mentioned". Een algemeen "ja" of "gedaan"
zonder verwijzing naar een specifieke gewoonte → markeer ALLEEN de gewoonte
die in de allerlaatste herinnering aan bod kwam, of "not_mentioned" als dat
onduidelijk is. Het is veel erger om een gewoonte ten onrechte als "completed"
te markeren dan om hem als "not_mentioned" over te slaan.

Antwoord uitsluitend met geldige JSON in dit formaat (zonder markdown):
{
  "1": "completed",
  "2": "not_mentioned"
}

De keys zijn de nummers uit de lijst, de values zijn "completed", "declined" of "not_mentioned".`,
      messages: [{
        role: 'user',
        content: `Lijst van openstaande gewoonten:
${habitList}

Bericht van de gebruiker:
"${userMessage}"`
      }]
    });

    const text  = response.content[0].text.trim();
    const clean = text.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(clean);

    habits.forEach((h, i) => {
      const value = parsed[String(i + 1)];
      if (value === 'completed' || value === 'declined' || value === 'not_mentioned') {
        result[h.name] = value;
      }
    });
  } catch (err) {
    logger.error('Fout bij detectMultiHabitResponses:', err.message);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Friday session intent detection
// ---------------------------------------------------------------------------

const FRIDAY_KEYWORDS = [
  'vrijdagsessie',
  'vrijdag sessie',
  'weekreflectie',
  'week reflectie',
  'wekelijkse check-in',
  'wekelijkse checkin',
  'weekoverzicht',
  'week overzicht',
  'inhaalsessie',
  'inhaal sessie',
  'check-in nu',
  'checkin nu',
  'reflectie nu'
];

async function detectFridaySessionIntent(userMessage) {
  if (!userMessage) return false;
  const lower = userMessage.toLowerCase();

  if (FRIDAY_KEYWORDS.some(kw => lower.includes(kw))) {
    return true;
  }

  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 5,
      system:     `Beoordeel of het bericht van de gebruiker uitdrukkelijk vraagt om een wekelijkse reflectie- of evaluatiesessie te starten.
Voorbeelden die "ja" zijn:
- "laten we de week overlopen"
- "kunnen we nu reflecteren over deze week?"
- "doe maar een check-in"
- "ik wil de week eens bespreken"
- "tijd voor een evaluatie"
- "weekgesprek graag"

Voorbeelden die "nee" zijn:
- gewone antwoorden op herinneringen ("gedaan", "nee", "later")
- algemene vragen of small talk
- vragen over een specifieke gewoonte
- "hoi", "hallo", "hoe gaat het"

Antwoord enkel met één woord: "ja" of "nee".`,
      messages:   [{ role: 'user', content: userMessage }]
    });

    const result = response.content[0].text.trim().toLowerCase();
    return result.startsWith('ja');
  } catch (err) {
    logger.error('Fout bij detectFridaySessionIntent:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Friday session — state machine
// ---------------------------------------------------------------------------

const FRIDAY_STEPS = [
  'opening',
  'went_well',
  'was_difficult',
  'todo_review',
  'new_todos',
  'gratitude',
  'closing'
];

const MULTI_TURN_STEPS = new Set(['todo_review', 'new_todos']);

/**
 * Detect whether the user signals they are done with the current multi-turn step.
 * Strategy: only match VERY specific multi-word phrases. Single words like
 * "klaar", "door", "verder", "volgende" are too generic — they appear in normal
 * Dutch sentences (e.g. "ik wil DOOR mijn lijst gaan", "VOLGENDE week", "KLAAR
 * met de tafel"). Any single-word interpretation we delegate to the AI.
 */
async function _detectStepDone(userMessage, stepContext) {
  if (!userMessage) return false;

  // Specific multi-word phrases that unambiguously mean "I'm done with this step"
  const doneKeywords = [
    'dat is alles', 'dat was het', 'meer niet', 'geen meer',
    'ga door', 'ga maar door', 'we kunnen door', 'we kunnen verder',
    'volgende vraag', 'volgende stap',
    'oké volgende', 'ok volgende',
    'ik ben klaar', 'ben klaar',
    'verder niets', 'niks meer', 'niets meer'
  ];
  if (_matchesAnyWord(userMessage, doneKeywords)) return true;

  // AI fallback for everything else. The prompt is now strict — the default
  // is "nee" unless the user UNAMBIGUOUSLY signals they're done.
  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 5,
      system:     `Beoordeel of de gebruiker UITDRUKKELIJK aangeeft klaar te zijn met de huidige stap van een coaching gesprek.

Context van de stap: ${stepContext}

KIES "ja" ALLEEN als de gebruiker DUIDELIJK signaleert dat hij/zij geen
nieuwe inhoud meer wil delen voor deze stap. Bij twijfel of als het bericht
nog inhoud bevat die bij deze stap hoort: kies "nee".

Voorbeelden die "ja" zijn:
- "dat zijn alle to-do's"
- "verder niets"
- "we kunnen door"
- "geen meer"
- "ik ben klaar"

Voorbeelden die "nee" zijn:
- gebruiker noemt nog een nieuwe taak/to-do (zelfs als hij "door" of "verder" gebruikt in de zin, bv. "ik wil DOOR mijn lijst gaan")
- gebruiker bespreekt details of timing van een to-do (bv. "ik wil dat zondag doen")
- gebruiker stelt een wedervraag
- gebruiker beschrijft iets dat hij/zij wil gaan doen

Antwoord enkel met "ja" of "nee".`,
      messages:   [{ role: 'user', content: userMessage }]
    });
    return response.content[0].text.trim().toLowerCase().startsWith('ja');
  } catch (err) {
    logger.error('Fout bij _detectStepDone:', err.message);
    return false;
  }
}

async function _extractTodosFromHistory(history) {
  if (!history || history.length === 0) return [];

  const transcript = history
    .map(h => `${h.role === 'user' ? 'Gebruiker' : 'Coach'}: ${h.content}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 600,
      system: `Je bent een data-extractor. Lees het transcript van een coaching gesprek en
extraheer ALLEEN de concrete to-do's die de gebruiker zichzelf voor de komende week
heeft opgelegd. Negeer to-do's van vorige week, gewoonten, en algemene goede voornemens.

Formuleer elke to-do bondig en specifiek. Als de gebruiker een frequentie noemt
(bv. "drie keer", "elke dag"), gebruik die.

Antwoord uitsluitend met geldige JSON in dit formaat:
{
  "todos": [
    { "description": "...", "frequency": "once|weekly|daily", "timesPerWeek": null }
  ]
}

Zonder markdown, zonder commentaar, alleen de JSON. Als er geen to-do's zijn:
{ "todos": [] }`,
      messages:   [{ role: 'user', content: transcript }]
    });

    const text  = response.content[0].text.trim();
    const clean = text.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!Array.isArray(parsed.todos)) return [];
    return parsed.todos.filter(t => t && typeof t.description === 'string' && t.description.length > 0);
  } catch (err) {
    logger.error('Fout bij _extractTodosFromHistory:', err.message);
    return [];
  }
}

function _persistTodos(session, todos) {
  if (!todos || todos.length === 0) return 0;
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO todos (description, frequency, times_per_week, week_number, year)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    for (const t of rows) {
      insert.run(
        t.description,
        t.frequency || 'weekly',
        t.timesPerWeek || null,
        session.week_number,
        session.year
      );
    }
  });
  insertMany(todos);
  return todos.length;
}

function _getOpenTodosFromPreviousWeeks(currentSession) {
  const db = getDb();
  return db.prepare(`
    SELECT id, description, frequency, times_per_week, week_number, year
    FROM todos
    WHERE completed = 0
      AND (year < ? OR (year = ? AND week_number < ?))
    ORDER BY year ASC, week_number ASC, id ASC
  `).all(currentSession.year, currentSession.year, currentSession.week_number);
}

function formatOpenTodosList(todos) {
  if (!todos || todos.length === 0) return null;
  return todos.map((t, i) => `${i + 1}. ${t.description}`).join('\n');
}

const STEP_PROMPTS = {
  opening:       'Start de sessie met een warme begroeting en kondig aan dat je het weekoverzicht al hebt gestuurd. Vraag wat er goed is gegaan deze week.',
  went_well:     'De gebruiker heeft geantwoord op "wat ging goed". Reageer kort en positief. Stel daarna de volgende vraag: "Wat was er moeilijk deze week?"',
  was_difficult: 'De gebruiker heeft geantwoord op "wat was moeilijk". Reageer empathisch.',
  todo_review:   `Je bespreekt nu de openstaande to-do's van vorige week, één voor één.
Vraag bij elk niet-voltooid item: hoe is het gegaan, is het gelukt, of moet het verschoven worden?
Wanneer alle items besproken zijn, vraag of de gebruiker wil doorgaan naar nieuwe to-do's voor deze week.`,
  new_todos:     `Je begeleidt nu het opstellen van nieuwe to-do's voor de komende week.
Vraag de gebruiker naar concrete, specifieke en controleerbare to-do's voor de komende week.
Vraag voor elk item: hoe vaak en wanneer? Help bij het bondig formuleren.
Wanneer de gebruiker meerdere to-do's heeft genoemd of aangeeft klaar te zijn, vat ze kort op en bevestig.
Vraag dan: "Heb je nog meer to-do's of zijn dit ze?"`,
  gratitude:     'De gebruiker heeft de nieuwe to-do\'s opgegeven. Stel nu de volgende vraag: "Waar ben je dankbaar voor deze week?"',
  closing:       'De gebruiker heeft de dankbaarheidsvraag beantwoord. Sluit de sessie warm af en laat hen weten dat je zo de samenvatting stuurt.'
};

async function processFridaySession(userMessage, sessionState) {
  const db = getDb();
  const { sessionId, step, history } = sessionState;

  const closeWords = ['einde', 'afsluiten', 'finish', 'beëindig'];
  const wantsToClose = _matchesAnyWord(userMessage, closeWords);

  let currentStep = wantsToClose ? 'closing' : step;
  let nextStep    = currentStep;
  let stayOnStep  = false;
  const sideEffects = [];

  if (!wantsToClose && MULTI_TURN_STEPS.has(currentStep)) {
    const done = await _detectStepDone(userMessage, STEP_PROMPTS[currentStep]);
    stayOnStep = !done;
    logger.info(`Vrijdagsessie ${sessionId} stap "${currentStep}": _detectStepDone=${done} → ${stayOnStep ? 'blijven' : 'doorgaan'}`);
  }

  if (currentStep === 'new_todos' && !stayOnStep) {
    try {
      const fullHistory = [
        ...(history || []),
        { role: 'user', content: userMessage || '' }
      ];
      const todos = await _extractTodosFromHistory(fullHistory);
      const session = db.prepare('SELECT * FROM friday_sessions WHERE id = ?').get(sessionId);
      const count = _persistTodos(session, todos);
      if (count > 0) {
        sideEffects.push(`${count} to-do(s) opgeslagen voor week ${session.week_number}/${session.year}`);
      }
    } catch (err) {
      logger.error('Fout bij to-do extractie:', err.message);
    }
  }

  const stepPrompt = STEP_PROMPTS[currentStep] || STEP_PROMPTS.closing;

  const messages = [
    ...(history || []).map(h => ({ role: h.role, content: h.content }))
  ];
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  let extraContext = '';
  if (currentStep === 'todo_review') {
    const session  = db.prepare('SELECT * FROM friday_sessions WHERE id = ?').get(sessionId);
    const openTodos = _getOpenTodosFromPreviousWeeks(session);
    if (openTodos.length > 0) {
      extraContext = `\n\nOpenstaande to-do's van vorige weken:\n${formatOpenTodosList(openTodos)}`;
    } else {
      extraContext = `\n\nEr zijn geen openstaande to-do's van vorige weken.`;
    }
  }

  const stayHint = stayOnStep
    ? `\n\nBELANGRIJK: De gebruiker is NOG niet klaar met deze stap. Blijf op deze stap, vraag door of help verder. Stel NIET de volgende vraag.`
    : '';

  const systemPrompt = `${buildSystemPrompt()}

Je leidt momenteel een vrijdagsessie (stap: "${currentStep}").
Instructie voor deze stap: ${stepPrompt}${extraContext}${stayHint}
Reageer passend op het bericht van de gebruiker en leid het gesprek verder.`;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 500,
    system:     systemPrompt,
    messages:   messages.length > 0
      ? messages
      : [{ role: 'user', content: 'Start de sessie.' }]
  });

  const responseText = response.content[0].text;

  if (userMessage) {
    db.prepare(`
      INSERT INTO conversation_history (session_type, session_id, role, content)
      VALUES ('friday_session', ?, 'user', ?)
    `).run(sessionId, userMessage);

    if (currentStep === 'went_well') {
      db.prepare('UPDATE friday_sessions SET went_well = ? WHERE id = ?').run(userMessage, sessionId);
    } else if (currentStep === 'was_difficult') {
      db.prepare('UPDATE friday_sessions SET was_difficult = ? WHERE id = ?').run(userMessage, sessionId);
    } else if (currentStep === 'gratitude') {
      db.prepare('UPDATE friday_sessions SET grateful_for = ? WHERE id = ?').run(userMessage, sessionId);
    }
  }

  db.prepare(`
    INSERT INTO conversation_history (session_type, session_id, role, content)
    VALUES ('friday_session', ?, 'assistant', ?)
  `).run(sessionId, responseText);

  const isComplete = currentStep === 'closing';
  if (!isComplete) {
    if (stayOnStep) {
      nextStep = currentStep;
    } else {
      const idx = FRIDAY_STEPS.indexOf(currentStep);
      nextStep = idx >= 0 && idx < FRIDAY_STEPS.length - 1
        ? FRIDAY_STEPS[idx + 1]
        : 'closing';
    }
  }

  return { responseText, nextStep, isComplete, sideEffects };
}

// ---------------------------------------------------------------------------
// Week report
// ---------------------------------------------------------------------------

async function generateWeekReport(weekNumber, year) {
  const db     = getDb();
  const habits = db.prepare('SELECT * FROM habits WHERE active = 1').all();
  const now    = DateTime.now().setZone(TIMEZONE);
  const weekStart = now.startOf('week');

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

  const openTodos = db.prepare(`
    SELECT description FROM todos
    WHERE completed = 0
      AND (year < ? OR (year = ? AND week_number < ?))
    ORDER BY year ASC, week_number ASC, id ASC
  `).all(year, year, weekNumber);

  if (openTodos.length > 0) {
    report += `📌 Openstaande to-do's van vorige week(en):\n`;
    openTodos.forEach((t, i) => {
      report += `${i + 1}. ${t.description}\n`;
    });
    report += '\n';
  }

  return report;
}

async function generateSessionSummary(sessionId) {
  const db      = getDb();
  const session = db.prepare('SELECT * FROM friday_sessions WHERE id = ?').get(sessionId);
  if (!session) return 'Geen sessie gevonden.';

  const newTodos = db.prepare(`
    SELECT description FROM todos WHERE week_number = ? AND year = ?
  `).all(session.week_number, session.year);

  const prompt = `Genereer een bondige, warme samenvatting van de vrijdagsessie op basis van:
- Wat ging goed: ${session.went_well || '(niet ingevuld)'}
- Wat was moeilijk: ${session.was_difficult || '(niet ingevuld)'}
- Dankbaar voor: ${session.grateful_for || '(niet ingevuld)'}
- To-do's voor komende week: ${newTodos.length > 0 ? newTodos.map(t => `"${t.description}"`).join(', ') : 'geen vastgelegd'}

Som de to-do's expliciet op zodat de gebruiker ze ziet.
Sluit af met een motiverende zin voor de komende week.`;

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 400,
    system:     buildSystemPrompt(),
    messages:   [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

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
  detectMultiHabitResponses,
  detectFridaySessionIntent,
  processFridaySession,
  generateWeekReport,
  generateSessionSummary,
  generateGenericResponse,
  FRIDAY_STEPS
};
