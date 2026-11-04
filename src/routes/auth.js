const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { signToken } = require('../auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;

router.post('/register', async (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 8 to 72 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email.trim(), hash]
    );
    const user = rows[0];
    return res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    // 23505 = unique_violation (our lower(email) unique index)
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)',
      [email.trim()]
    );
    const user = rows[0];

    // Same message for "no such user" and "wrong password" so attackers
    // can't discover which emails are registered.
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    return res.json({
      user: { id: user.id, email: user.email },
      token: signToken(user),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;