/* Backend address. The publishable key is meant to be public: every table is closed,
   and each server function checks a PIN/password token itself. */
export var SUPABASE_URL = "https://opebjfttlucanxbvpwgs.supabase.co";
export var SUPABASE_KEY = "sb_publishable_qmbwK4pAX8XMcHEU4R-g1w_F5OP7cSq";

/* Local testing only: http://localhost:8787/?api=local points the app at tests/server.mjs */
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]api=local/.test(location.search)) {
  SUPABASE_URL = location.origin;
}

export var APP_VERSION = "2.11.0";
