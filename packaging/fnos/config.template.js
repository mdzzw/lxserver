// Default configuration seeded into the fnOS app data directory on first start.
// Everything not listed here falls back to src/defaultConfig.ts.
module.exports = {
  // Overridden by the install wizard on first start.
  'admin.password': '123456',

  // No built-in demo accounts: create sync users from the admin console.
  users: [],
}
