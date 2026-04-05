const initialHabits = [
  {
    name: 'Ademhalingsoefeningen',
    description: '10 minuten ademhalingsoefeningen',
    frequency: 'daily',
    timesPerDay: 3,
    preferredPeriods: ['morning', 'afternoon', 'evening'],
    earliestTime: '08:00',
    latestTime: '23:00',
    retryAfterMinutes: 30
  },
  {
    name: '10.000 stappen',
    description: 'Minstens 10.000 stappen zetten',
    frequency: 'daily',
    timesPerDay: 1,
    preferredPeriods: ['evening'],
    earliestTime: '18:00',
    latestTime: '23:00',
    retryAfterMinutes: 30
  }
];

// Period definitions with start/end times
const periodDefinitions = {
  morning:   { start: '08:00', end: '12:00', label: 'Voormiddag' },
  afternoon: { start: '12:00', end: '18:00', label: 'Namiddag' },
  evening:   { start: '18:00', end: '23:00', label: 'Avond' }
};

const periodLabels = {
  morning:   'voormiddag',
  afternoon: 'namiddag',
  evening:   'avond'
};

module.exports = { initialHabits, periodDefinitions, periodLabels };
