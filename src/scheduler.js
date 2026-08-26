const cron = require('node-cron');
const { getSettings } = require('./db');
const { zonedParts, defaultTimezone } = require('./utils');
const { processDueAutomations } = require('./service');

let lastRunAt = 0;

// Intervalo entre ciclos vem do .env: são poucas notas por mês, não faz sentido
// martelar o portal de minuto em minuto.
function intervalMinutes() {
  const value = Number(process.env.WORKER_INTERVAL_MINUTES || 240);
  return Number.isFinite(value) && value > 0 ? value : 240;
}

function insideWindow(now, scheduler) {
  const minutes = now.hour * 60 + now.minute;
  const start = Number(scheduler.startHour) * 60 + Number(scheduler.startMinute);
  const end = Number(scheduler.endHour) * 60 + Number(scheduler.endMinute);
  // Janela que atravessa a meia-noite (fim menor que início) também funciona.
  return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
}

function startScheduler() {
  const task = cron.schedule('* * * * *', async () => {
    const settings = getSettings();
    if (!settings.scheduler.enabled) return;
    const now = zonedParts(new Date(), defaultTimezone());
    if (!insideWindow(now, settings.scheduler)) return;
    if (Date.now() - lastRunAt < intervalMinutes() * 60000) return;
    lastRunAt = Date.now();
    try {
      const result = await processDueAutomations({ manual: false, limit: 1 });
      if (result?.issued) console.log(`[scheduler] 1 nota processada, ${result.pending} na fila para o próximo ciclo.`);
    } catch (err) {
      console.error('[scheduler]', err);
    }
  });
  return task;
}

module.exports = { startScheduler, insideWindow, intervalMinutes };
