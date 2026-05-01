const { google } = require('googleapis');
const { DateTime } = require('luxon');
const logger = require('../utils/logger');

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

/**
 * Returns the list of calendar IDs to query.
 * Priority:
 *   1. GOOGLE_CALENDAR_IDS  (comma-separated, multi-calendar support)
 *   2. GOOGLE_CALENDAR_ID   (single calendar, legacy)
 *   3. 'primary'            (default)
 */
function getCalendarIds() {
  const multi = process.env.GOOGLE_CALENDAR_IDS;
  if (multi && multi.trim()) {
    return multi.split(',').map(id => id.trim()).filter(Boolean);
  }
  return [process.env.GOOGLE_CALENDAR_ID || 'primary'];
}

/**
 * Returns events from all configured Google Calendars between startTime and endTime.
 * @param {DateTime} startTime
 * @param {DateTime} endTime
 * @returns {Promise<Array<{start: DateTime, end: DateTime, summary: string}>>}
 */
async function getGoogleCalendarEvents(startTime, endTime) {
  if (!process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_CLIENT_ID) {
    logger.debug('Google Calendar niet geconfigureerd, overslaan');
    return [];
  }

  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });
  const tz = process.env.TIMEZONE || 'Europe/Brussels';
  const calendarIds = getCalendarIds();

  // Fetch all calendars in parallel; one failing calendar should not block the others.
  const results = await Promise.all(calendarIds.map(async (calendarId) => {
    try {
      const response = await calendar.events.list({
        calendarId,
        timeMin: startTime.toISO(),
        timeMax: endTime.toISO(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      return (response.data.items || [])
        .filter(e => e.status !== 'cancelled' && e.start.dateTime)
        .map(e => ({
          start:   DateTime.fromISO(e.start.dateTime, { zone: tz }),
          end:     DateTime.fromISO(e.end.dateTime,   { zone: tz }),
          summary: e.summary || 'Bezet'
        }));
    } catch (error) {
      logger.error(`Fout bij ophalen Google Calendar events (${calendarId}):`, error.message);
      return [];
    }
  }));

  // Flatten and sort by start time
  return results.flat().sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

/**
 * Returns true if there is at least one all-day event in any configured calendar
 * on the given date.
 * @param {DateTime} date
 * @returns {Promise<boolean>}
 */
async function hasGoogleAllDayEvent(date) {
  if (!process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_CLIENT_ID) return false;

  const auth     = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarIds = getCalendarIds();

  const dayStart = date.startOf('day');
  const dayEnd   = dayStart.plus({ days: 1 });

  // Check all calendars in parallel; return true on the first match.
  const results = await Promise.all(calendarIds.map(async (calendarId) => {
    try {
      const response = await calendar.events.list({
        calendarId,
        timeMin:      dayStart.toISO(),
        timeMax:      dayEnd.toISO(),
        singleEvents: true,
      });

      return (response.data.items || []).some(
        e => e.status !== 'cancelled' && e.start.date && !e.start.dateTime
      );
    } catch (error) {
      logger.error(`Fout bij ophalen heel-dag events (${calendarId}):`, error.message);
      return false;
    }
  }));

  return results.some(Boolean);
}

module.exports = { getGoogleCalendarEvents, hasGoogleAllDayEvent };
