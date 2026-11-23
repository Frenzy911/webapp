import 'server-only';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local (see README).`);
  return value;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** Server-side settings. Read lazily so a missing value fails the request that needs it, not the build. */
export const env = {
  get supabaseUrl() {
    return required('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabasePublishableKey() {
    return required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  },
  get supabaseSecretKey() {
    return required('SUPABASE_SECRET_KEY');
  },
  get ticketSecret() {
    return required('TICKET_SECRET');
  },
  /** Public URL used in email links. On Vercel it falls back to the production domain. */
  get baseUrl() {
    const fromVercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
    return (process.env.APP_BASE_URL || fromVercel || 'http://localhost:3000').replace(/\/+$/, '');
  },
  get production() {
    return process.env.NODE_ENV === 'production';
  },
  get smtp() {
    return {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: bool(process.env.SMTP_SECURE),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    };
  },
  get mailFrom() {
    return process.env.MAIL_FROM || 'Cebu Events <no-reply@example.com>';
  },
};
