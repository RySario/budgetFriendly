'use strict';
/* Create or reset the single user.
 *
 *   npm run create-user -- you@example.com 'your-password'
 *   dokku run budgetfriendly npm run create-user -- you@example.com 'your-password'
 *
 * Running it for an email that already exists resets that password.
 */

const bcrypt = require('bcryptjs');
const db = require('../src/db');

async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error("Usage: npm run create-user -- <email> '<password>'");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const user = await db.one(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, email`,
    [email.trim().toLowerCase(), hash]
  );

  const count = await db.one('SELECT COUNT(*)::int AS n FROM users');
  console.log(`User ready: ${user.email} (id ${user.id}).`);
  if (count.n > 1) {
    console.log(`Note: ${count.n} users exist. This app is built for one; remove the extras if that was unintended.`);
  }
}

main()
  .then(() => db.pool.end())
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
