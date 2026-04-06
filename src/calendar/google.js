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
 * Returns events from Google Calendar between startTime and endTime.
 * @param {DateTime} startTime
 * @param {DateTime} endTime
 * @returns {Promise<Array<{start: DateTime, end: DateTime, summary: string}>>}
 */
async function getGoogleCalendarEvents(startTime, endTime) {
  if (!process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_CLIENT_ID) {
    logger.debug('Google Calendar niet geconfigureerd, overslaan');
    return [];
  }

  try {
    const auth = getOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth });
    const tz = process.env.TIMEZONE || 'Europe/Brussels';

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: startTime.toISO(),
      timeMax: endTime.toISO(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    return (response.data.items || [])
      .filter(e => e.status !== 'cancelled' && e.start.dateTime)
      .map(e => ({
        start: DateTime.fromISO(e.start.dateTime, { zone: tz }),
        end:   DateTime.fromISO(e.end.dateTime,   { zone: tz }),
        summary: e.summary || 'Bezet'
      }));
  } catch (error) {
    logger.error('Fout bij ophalen Google Calendar events:', error.message);
    return [];
  }
}

/**
 * Returns true if there is at least one all-day event on the given date.
 * @param {DateTime} date
 * @returns {Promise<boolean>}
 */
async function hasGoogleAllDayEvent(date) {
  if (!process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_CLIENT_ID) return false;

  try {
    const auth     = getOAuth2Client();
    const calendar = google.calendar({ version: 'v3', auth });

    const dayStart = date.startOf('day');
    const dayEnd   = dayStart.plus({ days: 1 });

    const response = await calendar.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin:      dayStart.toISO(),
      timeMax:      dayEnd.toISO(),
      singleEvents: true,
    });

    return (response.data.items || []).some(
      e => e.status !== 'cancelled' && e.start.date && !e.start.dateTime
    );
  } catch (error) {
    logger.error('Fout bij ophalen heel-dag events:', error.message);
    return false;
  }
}

module.exports = { getGoogleCalendarEvents, hasGoogleAllDayEvent };
