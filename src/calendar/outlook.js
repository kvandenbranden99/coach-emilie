const fetch = require('node-fetch');
const { DateTime } = require('luxon');
const logger = require('../utils/logger');

let cachedToken = null;
let tokenExpiry  = null;

async function getAccessToken() {
  if (cachedToken && tokenExpiry && DateTime.now() < tokenExpiry) {
    return cachedToken;
  }

  if (!process.env.MICROSOFT_REFRESH_TOKEN || !process.env.MICROSOFT_CLIENT_ID) {
    return null;
  }

  try {
    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
    const params = new URLSearchParams({
      client_id:     process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: process.env.MICROSOFT_REFRESH_TOKEN,
      grant_type:    'refresh_token',
      scope:         'https://graph.microsoft.com/Calendars.Read offline_access'
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params
      }
    );

    if (!response.ok) {
      throw new Error(`Token refresh mislukt: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    cachedToken  = data.access_token;
    tokenExpiry  = DateTime.now().plus({ seconds: (data.expires_in || 3600) - 60 });
    return cachedToken;
  } catch (error) {
    logger.error('Fout bij ophalen Outlook access token:', error.message);
    return null;
  }
}

/**
 * Returns events from Outlook between startTime and endTime.
 * @param {DateTime} startTime
 * @param {DateTime} endTime
 * @returns {Promise<Array<{start: DateTime, end: DateTime, summary: string}>>}
 */
async function getOutlookCalendarEvents(startTime, endTime) {
  if (!process.env.MICROSOFT_REFRESH_TOKEN || !process.env.MICROSOFT_CLIENT_ID) {
    logger.debug('Outlook Calendar niet geconfigureerd, overslaan');
    return [];
  }

  try {
    const token = await getAccessToken();
    if (!token) return [];

    const tz  = process.env.TIMEZONE || 'Europe/Brussels';
    const url = `https://graph.microsoft.com/v1.0/me/calendarView`
      + `?startDateTime=${startTime.toISO()}`
      + `&endDateTime=${endTime.toISO()}`
      + `&$select=subject,start,end`
      + `&$orderby=start/dateTime`
      + `&$top=50`;

    const response = await fetch(url, {
      headers: {
        Authorization:              `Bearer ${token}`,
        'Content-Type':             'application/json',
        'Prefer':                   `outlook.timezone="${tz}"`
      }
    });

    if (!response.ok) {
      throw new Error(`Graph API fout: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return (data.value || []).map(e => ({
      start:   DateTime.fromISO(e.start.dateTime, { zone: tz }),
      end:     DateTime.fromISO(e.end.dateTime,   { zone: tz }),
      summary: e.subject || 'Bezet'
    }));
  } catch (error) {
    logger.error('Fout bij ophalen Outlook events:', error.message);
    return [];
  }
}

module.exports = { getOutlookCalendarEvents };
