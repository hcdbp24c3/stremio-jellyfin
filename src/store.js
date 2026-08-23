'use strict';

// Setup storage with two interchangeable backends:
//  - sqlite: node:sqlite (Node >= 22.5), the preferred database mode
//  - json:   the legacy config.json file (fallback for older runtimes)
// Both expose the same small surface so index.js never branches on mode.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function randomId() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz023456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function sqliteStore(configPath) {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = process.env.DB_PATH || path.join(path.dirname(configPath), 'setups.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL keeps readers and the (rare) writer from blocking each other;
  // busy_timeout guards against external processes holding the file.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS setups (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      name TEXT,
      hosts_json TEXT NOT NULL,
      catalogs_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
  `);
  return {
    mode: 'sqlite',
    listSetups() {
      return db.prepare('SELECT id, token, name, hosts_json, catalogs_json FROM setups ORDER BY created_at').all()
        .map((r) => ({ id: r.id, token: r.token, name: r.name, hosts: JSON.parse(r.hosts_json), catalogs: JSON.parse(r.catalogs_json || 'null') }));
    },
    getSetup(id) {
      const r = db.prepare('SELECT id, token, name, hosts_json, catalogs_json FROM setups WHERE id = ?').get(id);
      return r && { id: r.id, token: r.token, name: r.name, hosts: JSON.parse(r.hosts_json), catalogs: JSON.parse(r.catalogs_json || 'null') };
    },
    getByToken(token) {
      const r = db.prepare('SELECT id FROM setups WHERE token = ?').get(token);
      return r ? r.id : null;
    },
    saveSetup({ token, name, hosts, catalogs }) {
      const existing = this.getByToken(token);
      if (existing) return { id: existing, created: false };
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = randomId();
        try {
          db.prepare('INSERT INTO setups (id, token, name, hosts_json, catalogs_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, token, name || null, JSON.stringify(hosts), catalogs ? JSON.stringify(catalogs) : null, Date.now());
          return { id, created: true };
        } catch (e) {
          if (!String(e.message).includes('UNIQUE')) throw e;
        }
      }
      throw new Error('could not allocate setup id');
    },
    deleteSetup(id) {
      db.prepare('DELETE FROM setups WHERE id = ?').run(id);
    },
    getSecret() {
      const r = db.prepare('SELECT value FROM kv WHERE key = ?').get('serverSecret');
      return r ? r.value : null;
    },
    setSecret(value) {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('serverSecret', value);
    },
    getSetting(key) {
      const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(`setting:${key}`);
      return r ? JSON.parse(r.value) : null;
    },
    setSetting(key, value) {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(`setting:${key}`, JSON.stringify(value));
    },
    deleteSetting(key) {
      db.prepare('DELETE FROM kv WHERE key = ?').run(`setting:${key}`);
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM setups').get().n;
    },
  };
}

function jsonStore(configPath) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
  };
  const write = (obj) => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(obj, null, 2) + '\n');
  };
  return {
    mode: 'json',
    listSetups() {
      return (read().setups || []).map((s) => ({ ...s }));
    },
    getSetup(id) {
      return (read().setups || []).find((s) => s.id === id) || null;
    },
    getByToken(token) {
      const hit = (read().setups || []).find((s) => s.token === token);
      return hit ? hit.id : null;
    },
    saveSetup({ token, name, hosts, catalogs }) {
      const cfg = read();
      cfg.setups = cfg.setups || [];
      const existing = cfg.setups.find((s) => s.token === token);
      if (existing) return { id: existing.id, created: false };
      const id = randomId();
      cfg.setups.push({ id, token, name: name || null, hosts, catalogs: catalogs || null });
      write(cfg);
      return { id, created: true };
    },
    deleteSetup(id) {
      const cfg = read();
      cfg.setups = (cfg.setups || []).filter((s) => s.id !== id);
      write(cfg);
    },
    getSecret() {
      return read().serverSecret || null;
    },
    setSecret(value) {
      const cfg = read();
      cfg.serverSecret = value;
      write(cfg);
    },
    getSetting(key) {
      const cfg = read();
      return cfg.settings && cfg.settings[key] !== undefined ? cfg.settings[key] : null;
    },
    setSetting(key, value) {
      const cfg = read();
      cfg.settings = { ...(cfg.settings || {}), [key]: value };
      write(cfg);
    },
    deleteSetting(key) {
      const cfg = read();
      if (cfg.settings) delete cfg.settings[key];
      write(cfg);
    },
    count() {
      return (read().setups || []).length;
    },
  };
}

function createStore(configPath) {
  try {
    const store = sqliteStore(configPath);
    console.log(`[store] sqlite at ${process.env.DB_PATH || path.join(path.dirname(configPath), 'setups.db')}`);
    return store;
  } catch (err) {
    console.log(`[store] sqlite unavailable (${err.message.split('\n')[0]}); using config.json`);
    return jsonStore(configPath);
  }
}

module.exports = { createStore, randomId };
