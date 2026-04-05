const { DateTime } = require('luxon');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Brussels';

function parseTimeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Determine which channel to use based on current time and day.
 * @param {string|null} forceChannel - Override: 'telegram' or 'slack'
 * @returns {'telegram'|'slack'}
 */
function determineChannel(forceChannel = null) {
  if (forceChannel === 'telegram' || forceChannel === 'slack') return forceChannel;

  const now = DateTime.now().setZone(TIMEZONE);

  // weekday: 1=Monday … 7=Sunday
  const isWeekend   = now.weekday >= 6;
  const nowMinutes  = now.hour * 60 + now.minute;

  const slackStart = parseTimeToMinutes(process.env.SLACK_START_TIME || '09:00');
  const slackEnd   = parseTimeToMinutes(process.env.SLACK_END_TIME   || '17:00');

  if (!isWeekend && nowMinutes >= slackStart && nowMinutes < slackEnd) {
    return 'slack';
  }

  return 'telegram';
}

module.exports = { determineChannel };
