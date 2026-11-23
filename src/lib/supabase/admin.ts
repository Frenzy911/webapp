import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';

let client: SupabaseClient | null = null;

/**
 * Supabase client with the secret (service_role) key. Server-only: it bypasses Row Level Security,
 * so every caller must have checked who is asking first (see lib/auth.ts).
 */
export function db(): SupabaseClient {
  client ??= createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}
