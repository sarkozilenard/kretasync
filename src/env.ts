export const env = {
  get databaseUrl() { return process.env.DATABASE_URL || ''; },
  get encryptionKey() { return process.env.ENCRYPTION_KEY || ''; },
  get cronSecret() { return process.env.CRON_SECRET || ''; },
  get appUrl() { return (process.env.APP_URL || '').replace(/\/$/, ''); },
  get syncIntervalHours() { return Math.max(1, Number(process.env.SYNC_INTERVAL_HOURS) || 24); },
  get syncDays() { return Math.min(60, Math.max(1, Number(process.env.SYNC_DAYS) || 14)); },
  get resendApiKey() { return process.env.RESEND_API_KEY || ''; },
  get emailFrom() { return process.env.EMAIL_FROM || ''; },
  get emailEnabled() { return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM); },
  get kretaTimesAreUtc() { return process.env.KRETA_TIMES_ARE_UTC === 'true'; },
};
