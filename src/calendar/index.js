const { DateTime } = require('luxon');
const { getGoogleCalendarEvents }  = require('./google');
const { getOutlookCalendarEvents } = require('./outlook');
const logger = require('../utils/logger');

const TIMEZONE              = process.env.TIMEZONE || 'Europe/Brussels';
const MIN_FREE_SLOT_MINUTES = parseInt(process.env.MIN_FREE_SLOT_MINUTES || '30', 10);

/**
 * Merge and sort events from both calendars.
 */
async function getCombinedBusySlots(startTime, endTime) {
  const [google, outlook] = await Promise.all([
    getGoogleCalendarEvents(startTime, endTime),
    getOutlookCalendarEvents(startTime, endTime)
  ]);

  return [...google, ...outlook].sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

/**
 * Find all free slots within [startTimeStr, endTimeStr] on the given date.
 * @param {DateTime} date         - The date to check (timezone-aware)
 * @param {string}   startTimeStr - 'HH:mm'
 * @param {string}   endTimeStr   - 'HH:mm'
 * @param {number}   minMinutes   - Minimum free-slot duration
 * @returns {Promise<Array<{start: DateTime, end: DateTime}>>}
 */
async function findFreeSlots(date, startTimeStr, endTimeStr, minMinutes = MIN_FREE_SLOT_MINUTES) {
  const [sh, sm] = startTimeStr.split(':').map(Number);
  const [eh, em] = endTimeStr.split(':').map(Number);

  const windowStart = date.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const windowEnd   = date.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

  const busy = await getCombinedBusySlots(windowStart, windowEnd);

  const freeSlots = [];
  let cursor = windowStart;

  for (const event of busy) {
    const evStart = event.start < windowStart ? windowStart : event.start;
    const evEnd   = event.end   > windowEnd   ? windowEnd   : event.end;

    if (cursor < evStart) {
      const durMins = evStart.diff(cursor, 'minutes').minutes;
      if (durMins >= minMinutes) {
        freeSlots.push({ start: cursor, end: evStart });
      }
    }

    if (evEnd > cursor) {
      cursor = evEnd;
    }
  }

  // Remaining time after the last event
  if (cursor < windowEnd) {
    const durMins = windowEnd.diff(cursor, 'minutes').minutes;
    if (durMins >= minMinutes) {
      freeSlots.push({ start: cursor, end: windowEnd });
    }
  }

  return freeSlots;
}

/**
 * Returns true if the current moment falls within a free calendar slot.
 * Falls back to true if calendar APIs are unavailable.
 */
async function isCurrentlyFree(periodStart, periodEnd) {
  const now = DateTime.now().setZone(TIMEZONE);
  if (now < periodStart || now >= periodEnd) return false;

  try {
    const checkEnd = now.plus({ minutes: MIN_FREE_SLOT_MINUTES });
    const busy = await getCombinedBusySlots(now, checkEnd);

    for (const event of busy) {
      if (event.start <= now && event.end > now) {
        logger.debug(`Bezet vanwege: ${event.summary}`);
        return false;
      }
    }
    return true;
  } catch (error) {
    logger.warn('Agenda check mislukt, beschouwen als vrij:', error.message);
    return true; // Fail-open: send reminder even without calendar data
  }
}

/**
 * Find the next free slot starting at or after `afterTime`, ending before `endTime`.
 * Returns the start of that slot, or null if none found.
 */
async function findNextFreeSlot(afterTime, endTime, minMinutes = MIN_FREE_SLOT_MINUTES) {
  try {
    const busy = await getCombinedBusySlots(afterTime, endTime);
    let cursor = afterTime;

    for (const event of busy) {
      if (event.start > cursor) {
        const durMins = event.start.diff(cursor, 'minutes').minutes;
        if (durMins >= minMinutes) return cursor;
      }
      if (event.end > cursor) {
        cursor = event.end;
      }
    }

    const remaining = endTime.diff(cursor, 'minutes').minutes;
    return remaining >= minMinutes ? cursor : null;
  } catch (error) {
    logger.warn('findNextFreeSlot mislukt:', error.message);
    return afterTime; // Fail-open
  }
}

module.exports = { getCombinedBusySlots, findFreeSlots, isCurrentlyFree, findNextFreeSlot };
