// Fixed settings for the plugin. SUPABASE_URL and SUPABASE_ANON_KEY are the
// extension's values (src/content/data-client.js); a test pins them equal.
// The anon key is the publishable key, not a secret.

export const SUPABASE_URL = 'https://gwqmihcbainmuaqkpdyq.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3cW1paGNiYWlubXVhcWtwZHlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI5MzkyMDQsImV4cCI6MjA3ODUxNTIwNH0.MKtG7Zf5VRDLXW7wL3I3d788Os9ryuCTZ0vsH-sXFQ0';

export const COLLECT_URL = `${SUPABASE_URL}/functions/v1/collect`;

// Sign-in redirects to http://127.0.0.1:<port>/callback. These three exact
// URLs are what the owner adds to the Supabase redirect allow list (R2), so
// the ports are fixed and tried in this order.
export const LOOPBACK_HOST = '127.0.0.1';
export const LOOPBACK_PORTS = Object.freeze([53682, 53683, 53684]);
export const LOOPBACK_PATH = '/callback';
