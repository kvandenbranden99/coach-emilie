/**
 * Test script: probeer Google Calendar events op te halen voor vandaag.
 * Gebruik: node scripts/test-google.js
 *
 * Dit script gebruikt dezelfde credentials én multi-calendar logica
 * als de bot, en toont de échte foutmelding zonder via winston te gaan.
 */

require('dotenv').config();
const { google } = require('googleapis');
const { DateTime } = require('luxon');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Brussels';

function getCalendarIds() {
  const multi = process.env.GOOGLE_CALENDAR_IDS;
  if (multi && multi.trim()) {
    return multi.split(',').map(id => id.trim()).filter(Boolean);
  }
  return [process.env.GOOGLE_CALENDAR_ID || 'primary'];
}

async function main() {
  console.log('=== Google Calendar Test ===\n');

  // Check env vars
  console.log('GOOGLE_CLIENT_ID:    ', process.env.GOOGLE_CLIENT_ID ? '✓ gezet' : '✗ ONTBREEKT');
  console.log('GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? '✓ gezet' : '✗ ONTBREEKT');
  console.log('GOOGLE_REFRESH_TOKEN:', process.env.GOOGLE_REFRESH_TOKEN ? `✓ gezet (begint met ${process.env.GOOGLE_REFRESH_TOKEN.substring(0, 10)}...)` : '✗ ONTBREEKT');

  const calendarIds = getCalendarIds();
  console.log('Kalenders te checken:', calendarIds.length);
  calendarIds.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
  console.log();

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.error('FOUT: ontbrekende credentials in .env');
    process.exit(1);
  }

  // Build OAuth client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  // Test 1: refresh access token
  console.log('Test 1: access token verversen...');
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    console.log('✓ Access token verkregen');
    console.log('  Verloopt op:', new Date(credentials.expiry_date).toLocaleString('nl-BE'));
    console.log();
  } catch (err) {
    console.error('✗ FOUT bij access token verversen:');
    console.error('  Code:', err.code || err.response?.status);
    console.error('  Message:', err.message);
    if (err.response?.data) {
      console.error('  Details:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const now = DateTime.now().setZone(TIMEZONE);
  const dayStart = now.startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });

  // Test 2: fetch events for today (per kalender)
  console.log(`Test 2: events van vandaag (${now.toFormat('yyyy-MM-dd')}) ophalen per kalender...`);
  for (const calendarId of calendarIds) {
    try {
      const response = await calendar.events.list({
        calendarId,
        timeMin: dayStart.toISO(),
        timeMax: dayEnd.toISO(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];
      console.log(`  📅 [${calendarId}] → ${events.length} events`);
      events.forEach((e, i) => {
        const isAllDay = !!e.start.date && !e.start.dateTime;
        const time = isAllDay ? '[hele dag]' : `${e.start.dateTime} - ${e.end.dateTime}`;
        console.log(`     ${i + 1}. ${e.summary || '(geen titel)'} ${isAllDay ? '🗓️' : '⏰'} ${time}`);
      });
    } catch (err) {
      console.error(`  ✗ FOUT bij [${calendarId}]:`, err.message);
      if (err.response?.data?.error) {
        console.error(`     ${JSON.stringify(err.response.data.error)}`);
      }
    }
  }
  console.log();

  // Test 3: detect all-day events across all calendars
  console.log('Test 3: heel-dag events detecteren (alle kalenders)...');
  let allDayCount = 0;
  for (const calendarId of calendarIds) {
    try {
      const response = await calendar.events.list({
        calendarId,
        timeMin: dayStart.toISO(),
        timeMax: dayEnd.toISO(),
        singleEvents: true,
      });

      const allDay = (response.data.items || []).filter(
        e => e.status !== 'cancelled' && e.start.date && !e.start.dateTime
      );
      if (allDay.length > 0) {
        console.log(`  📅 [${calendarId}] → ${allDay.length} heel-dag events:`);
        allDay.forEach(e => console.log(`     - ${e.summary}`));
        allDayCount += allDay.length;
      } else {
        console.log(`  📅 [${calendarId}] → geen heel-dag events`);
      }
    } catch (err) {
      console.error(`  ✗ FOUT bij [${calendarId}]:`, err.message);
    }
  }
  console.log(`\n  → totaal ${allDayCount} heel-dag events vandaag`);
  console.log();

  console.log('=== Alles getest ===');
}

main().catch(err => {
  console.error('Onverwachte fout:', err);
  process.exit(1);
});
