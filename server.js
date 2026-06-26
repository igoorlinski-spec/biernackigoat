const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL connection pool - Neon requires SSL always
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let isPostgres = true;
let sqliteDb = null;

// Helper: run a query
let query = (text, params) => pool.query(text, params);

// Test DB connection on startup and setup fallback if it fails
pool.connect((err, client, release) => {
  if (err) {
    console.error('!!! DATABASE CONNECTION FAILED:', err.message);
    console.log('Falling back to local SQLite...');
    isPostgres = false;
    
    // Setup SQLite
    const { Database } = require('./db_adapter');
    sqliteDb = new Database(path.join(__dirname, 'database.sqlite'));
    
    // Override the query helper
    query = (text, params) => {
      let sql = text;
      const values = params || [];
      // Translate $1, $2, ... to ?
      sql = sql.replace(/\$(\d+)/g, '?');
      
      // Map SERIAL to INTEGER PRIMARY KEY AUTOINCREMENT
      sql = sql.replace(/\bSERIAL PRIMARY KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
      
      return new Promise((resolve, reject) => {
        const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
        if (isSelect) {
          sqliteDb.all(sql, values, (err, rows) => {
            if (err) reject(err);
            else resolve({ rows: rows || [] });
          });
        } else {
          sqliteDb.run(sql, values, function(err) {
            if (err) {
              if (sql.toUpperCase().includes('ADD COLUMN') && (err.message.includes('duplicate column name') || err.message.includes('already exists'))) {
                // Column already exists, ignore
                resolve({ rows: [], changes: 0 });
              } else {
                reject(err);
              }
            } else {
              resolve({ rows: [], lastID: this?.lastID, changes: this?.changes });
            }
          });
        }
      });
    };
    
    // Run initialization
    initializeDatabase();
  } else {
    console.log('Database connected successfully.');
    release();
    initializeDatabase();
  }
});

// Initialize database tables
async function initializeDatabase() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        nick TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        coins INTEGER DEFAULT 0,
        lp INTEGER DEFAULT 0,
        rank TEXT DEFAULT 'Iron 4',
        unlocked_characters TEXT DEFAULT 'Zygzak',
        stars INTEGER DEFAULT 0,
        unlocked_skills TEXT DEFAULT '',
        active_champion TEXT DEFAULT 'Zygzak',
        unlocked_icons TEXT DEFAULT 'dalton,tusk',
        active_icon TEXT DEFAULT 'default',
        last_daily_claim BIGINT DEFAULT 0,
        casino_xp INTEGER DEFAULT 0,
        blackjack_wins INTEGER DEFAULT 0,
        perfect_timings INTEGER DEFAULT 0
      )
    `);

    // Add new columns to existing tables if they don't exist
    try {
      await query(`ALTER TABLE users ADD COLUMN casino_xp INTEGER DEFAULT 0`);
    } catch(e) {}
    try {
      await query(`ALTER TABLE users ADD COLUMN blackjack_wins INTEGER DEFAULT 0`);
    } catch(e) {}
    try {
      await query(`ALTER TABLE users ADD COLUMN perfect_timings INTEGER DEFAULT 0`);
    } catch(e) {}
    try {
      await query(`ALTER TABLE users ADD COLUMN pending_chest_icon TEXT`);
    } catch(e) {}
    try {
      await query(`ALTER TABLE users ADD COLUMN pending_chest_refund INTEGER DEFAULT 0`);
    } catch(e) {}

    await query(`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        player1 TEXT NOT NULL,
        player2 TEXT NOT NULL,
        winner TEXT NOT NULL,
        mode TEXT NOT NULL,
        score TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        creator TEXT NOT NULL,
        offered_icon TEXT NOT NULL,
        requested_icon TEXT DEFAULT '',
        requested_coins INTEGER DEFAULT 0,
        status TEXT DEFAULT 'open',
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

// Ranks hierarchy
const RANKS = [
  'Iron 4', 'Iron 3', 'Iron 2', 'Iron 1',
  'Bronze 4', 'Bronze 3', 'Bronze 2', 'Bronze 1',
  'Silver 4', 'Silver 3', 'Silver 2', 'Silver 1',
  'Gold 4', 'Gold 3', 'Gold 2', 'Gold 1',
  'Platinum 4', 'Platinum 3', 'Platinum 2', 'Platinum 1',
  'Emerald 4', 'Emerald 3', 'Emerald 2', 'Emerald 1',
  'Diamond 4', 'Diamond 3', 'Diamond 2', 'Diamond 1',
  'Master', 'Grandmaster', 'Challenger'
];

function calculateNewRank(currentRank, currentLp, lpChange) {
  let newLp = currentLp + lpChange;
  let rankIndex = RANKS.indexOf(currentRank);
  if (rankIndex === -1) rankIndex = 0;

  const isApexTier = (rank) => ['Master', 'Grandmaster', 'Challenger'].includes(rank);

  if (isApexTier(currentRank)) {
    if (newLp < 0) return { rank: 'Diamond 1', lp: 75 };
    if (newLp >= 1000) return { rank: 'Challenger', lp: newLp };
    else if (newLp >= 500) return { rank: 'Grandmaster', lp: newLp };
    else return { rank: 'Master', lp: newLp };
  }

  if (newLp >= 100) {
    if (rankIndex < RANKS.indexOf('Diamond 1')) {
      rankIndex += 1;
      newLp = newLp - 100;
    } else {
      return { rank: 'Master', lp: newLp - 100 };
    }
  } else if (newLp < 0) {
    if (rankIndex > 0) {
      rankIndex -= 1;
      newLp = 100 + newLp;
    } else {
      newLp = 0;
    }
  }

  return { rank: RANKS[rankIndex], lp: newLp };
}

// ─── REST Endpoints ───────────────────────────────────────────────────────────

// Health check / diagnostics endpoint
app.get('/api/health', async (req, res) => {
  const dbUrl = process.env.DATABASE_URL;
  try {
    await query('SELECT 1');
    res.json({
      status: 'OK',
      db: 'connected',
      hasDbUrl: !!dbUrl,
      dbUrlPreview: dbUrl ? dbUrl.substring(0, 30) + '...' : 'MISSING'
    });
  } catch (err) {
    res.status(500).json({
      status: 'ERROR',
      db: 'disconnected',
      hasDbUrl: !!dbUrl,
      error: err.message
    });
  }
});

app.post('/api/admin/give', async (req, res) => {
  const { secret, nick, coins, stars } = req.body;
  if (secret !== 'biernacki2024admin') return res.status(403).json({ error: 'Forbidden' });
  try {
    const result = await query('SELECT nick, coins, stars FROM users WHERE LOWER(nick) = LOWER($1)', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const actualNick = result.rows[0].nick;
    const newCoins = (result.rows[0].coins || 0) + (parseInt(coins) || 0);
    const newStars = (result.rows[0].stars || 0) + (parseInt(stars) || 0);
    await query('UPDATE users SET coins = $1, stars = $2 WHERE nick = $3', [newCoins, newStars, actualNick]);
    res.json({ success: true, nick: actualNick, newCoins, newStars });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { nick, email, password } = req.body;
  if (!nick || !email || !password)
    return res.status(400).json({ error: 'Nick, e-mail i hasło są wymagane' });
  if (nick.length > 10)
    return res.status(400).json({ error: 'Nick może mieć maksymalnie 10 znaków' });

  try {
    const existing = await query(
      'SELECT nick, email FROM users WHERE nick = $1 OR email = $2',
      [nick, email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.nick === nick) return res.status(400).json({ error: 'Ten nick jest już zajęty' });
      return res.status(400).json({ error: 'Ten e-mail jest już zarejestrowany' });
    }

    const hash = await bcrypt.hash(password, 10);
    await query(
      'INSERT INTO users (email, nick, password, unlocked_icons) VALUES ($1, $2, $3, $4)',
      [email.toLowerCase(), nick, hash, 'dalton,tusk']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { nickOrEmail, password } = req.body;
  if (!nickOrEmail || !password)
    return res.status(400).json({ error: 'Nick/E-mail i hasło są wymagane' });

  try {
    const result = await query(
      'SELECT * FROM users WHERE nick = $1 OR email = $2',
      [nickOrEmail, nickOrEmail.toLowerCase()]
    );
    if (result.rows.length === 0)
      return res.status(400).json({ error: 'Nie znaleziono użytkownika. Sprawdź nick/e-mail.' });

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Błędne hasło.' });

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    if (!icons.includes('dalton')) icons.push('dalton');
    if (!icons.includes('tusk')) icons.push('tusk');

    res.json({
      nick: user.nick,
      email: user.email,
      coins: user.coins,
      lp: user.lp,
      rank: user.rank,
      stars: user.stars || 0,
      unlocked_characters: user.unlocked_characters ? user.unlocked_characters.split(',') : ['Zygzak'],
      unlocked_skills: user.unlocked_skills ? user.unlocked_skills.split(',') : [],
      activeChampion: user.active_champion || 'Zygzak',
      unlocked_icons: icons,
      activeIcon: user.active_icon || 'default',
      lastDailyClaim: parseInt(user.last_daily_claim) || 0
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Błąd serwera: ' + err.message });
  }
});

app.get('/api/profile/:nick', async (req, res) => {
  const { nick } = req.params;
  try {
    const result = await query(
      'SELECT nick, coins, lp, rank, stars, unlocked_characters, unlocked_skills, active_champion, unlocked_icons, active_icon, last_daily_claim, casino_xp, blackjack_wins, perfect_timings FROM users WHERE nick = $1',
      [nick]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Player not found' });

    const user = result.rows[0];

    const rankedResult = await query(
      "SELECT winner, mode FROM matches WHERE (player1 = $1 OR player2 = $1) AND mode = 'ranked'",
      [nick]
    );
    let rankedWins = 0;
    let rankedTotal = rankedResult.rows.length;
    rankedResult.rows.forEach(m => { if (m.winner === nick) rankedWins++; });

    const historyResult = await query(
      'SELECT * FROM matches WHERE player1 = $1 OR player2 = $1 ORDER BY timestamp DESC LIMIT 10',
      [nick]
    );

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    if (!icons.includes('dalton')) icons.push('dalton');
    if (!icons.includes('tusk')) icons.push('tusk');

    const casinoXp = user.casino_xp || 0;
    const bjWins = user.blackjack_wins || 0;
    const perfectTimings = user.perfect_timings || 0;

    res.json({
      nick: user.nick,
      coins: user.coins,
      lp: user.lp,
      rank: user.rank,
      stars: user.stars || 0,
      unlocked_characters: user.unlocked_characters ? user.unlocked_characters.split(',') : ['Zygzak'],
      unlocked_skills: user.unlocked_skills ? user.unlocked_skills.split(',') : [],
      activeChampion: user.active_champion || 'Zygzak',
      unlocked_icons: icons,
      activeIcon: user.active_icon || 'default',
      lastDailyClaim: parseInt(user.last_daily_claim) || 0,
      rankedWins,
      rankedTotal,
      history: historyResult.rows,
      casino_xp: casinoXp,
      blackjack_wins: bjWins,
      perfect_timings: perfectTimings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await query(
      'SELECT nick, lp, rank, coins, stars, active_champion, active_icon, casino_xp, blackjack_wins, perfect_timings FROM users WHERE length(nick) <= 10 ORDER BY lp DESC, coins DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/buy-icon', async (req, res) => {
  const { nick, iconName, cost } = req.body;
  try {
    const result = await query('SELECT coins, unlocked_icons FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    if (icons.includes(iconName)) return res.status(400).json({ error: 'Already unlocked' });
    if (user.coins < cost) return res.status(400).json({ error: 'Not enough coins' });

    icons.push(iconName);
    const newCoins = user.coins - cost;
    await query('UPDATE users SET coins = $1, unlocked_icons = $2 WHERE nick = $3', [newCoins, icons.join(','), nick]);
    res.json({ coins: newCoins, unlocked_icons: icons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/select-icon', async (req, res) => {
  const { nick, iconName } = req.body;
  if (!nick || !iconName) return res.status(400).json({ error: 'Nick and iconName are required' });
  try {
    const result = await query('SELECT unlocked_icons FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    if (iconName !== 'default' && !icons.includes(iconName))
      return res.status(400).json({ error: 'Icon not unlocked' });

    await query('UPDATE users SET active_icon = $1 WHERE nick = $2', [iconName, nick]);
    res.json({ success: true, activeIcon: iconName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-daily-chest', async (req, res) => {
  const { nick } = req.body;
  if (!nick) return res.status(400).json({ error: 'Nick is required' });
  try {
    const result = await query('SELECT coins, last_daily_claim FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    const now = Date.now();
    const lastClaim = parseInt(user.last_daily_claim) || 0;
    const cooldown = 24 * 60 * 60 * 1000;

    if (now - lastClaim < cooldown) {
      return res.status(400).json({ error: 'Cooldown active', timeLeft: cooldown - (now - lastClaim) });
    }

    const rewards = [];
    for (let i = 5; i <= 100; i += 5) rewards.push(i);
    const rewardCoins = rewards[Math.floor(Math.random() * rewards.length)];
    const newCoins = (user.coins || 0) + rewardCoins;

    await query('UPDATE users SET coins = $1, last_daily_claim = $2 WHERE nick = $3', [newCoins, now, nick]);
    res.json({ success: true, rewardCoins, newCoins, lastDailyClaim: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-paid-chest', async (req, res) => {
  const { nick } = req.body;
  if (!nick) return res.status(400).json({ error: 'Nick jest wymagany' });
  try {
    const result = await query('SELECT coins, unlocked_icons FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    const cost = 30;
    if ((user.coins || 0) < cost) {
      return res.status(400).json({ error: 'Brak monet (wymagane 30 monet)' });
    }

    let rewardIcon = '';
    let isLegendary = false;

    const roll = Math.random() * 100;
    if (roll <= 1.0) {
      rewardIcon = 'irys'; // Stary Irys
      isLegendary = true;
    } else if (roll <= 2.0) {
      rewardIcon = 'starka';
      isLegendary = true;
    } else {
      const pool = ['dalton', 'tusk', 'okekel', 'disco_adamus', 'popek', 'milosz_kulesza', 'mr_krycha'];
      rewardIcon = pool[Math.floor(Math.random() * pool.length)];
    }

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    const isDuplicate = icons.includes(rewardIcon);
    const refundAmount = 15;

    let finalCoins = user.coins - cost;

    // Save as pending instead of updating inventory immediately
    await query(
      'UPDATE users SET coins = $1, pending_chest_icon = $2, pending_chest_refund = $3 WHERE nick = $4',
      [finalCoins, rewardIcon, refundAmount, nick]
    );

    res.json({
      success: true,
      rewardIcon,
      isLegendary,
      isDuplicate,
      refundAmount,
      newCoins: finalCoins
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-fame-chest', async (req, res) => {
  const { nick } = req.body;
  if (!nick) return res.status(400).json({ error: 'Nick jest wymagany' });
  try {
    const result = await query('SELECT coins, unlocked_icons FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    const cost = 80;
    if ((user.coins || 0) < cost) {
      return res.status(400).json({ error: 'Brak monet (wymagane 80 monet)' });
    }

    let rewardIcon = '';
    let isLegendary = false;

    const roll = Math.random() * 100;
    if (roll <= 1.0) {
      rewardIcon = 'young_maga';
      isLegendary = true;
    } else if (roll <= 2.0) {
      rewardIcon = 'irys'; // Stary Irys
      isLegendary = true;
    } else if (roll <= 3.0) {
      rewardIcon = 'starka';
      isLegendary = true;
    } else {
      const pool = ['ishowspeed', 'lewandowski', 'trzaskowski', 'kaczynski'];
      rewardIcon = pool[Math.floor(Math.random() * pool.length)];
    }

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    const isDuplicate = icons.includes(rewardIcon);
    const refundAmount = 40;

    let finalCoins = user.coins - cost;

    // Save as pending instead of updating inventory immediately
    await query(
      'UPDATE users SET coins = $1, pending_chest_icon = $2, pending_chest_refund = $3 WHERE nick = $4',
      [finalCoins, rewardIcon, refundAmount, nick]
    );

    res.json({
      success: true,
      rewardIcon,
      isLegendary,
      isDuplicate,
      refundAmount,
      newCoins: finalCoins
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-chest-choice', async (req, res) => {
  const { nick, choice } = req.body;
  if (!nick || !choice) return res.status(400).json({ error: 'Brak wymaganych pól' });
  try {
    const result = await query('SELECT coins, unlocked_icons, pending_chest_icon, pending_chest_refund FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    const icon = user.pending_chest_icon;
    const refund = user.pending_chest_refund || 0;

    if (!icon) {
      return res.status(400).json({ error: 'Brak oczekującej nagrody' });
    }

    let finalCoins = user.coins;
    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];

    if (choice === 'keep') {
      icons.push(icon);
    } else if (choice === 'sell') {
      finalCoins += refund;
    } else {
      return res.status(400).json({ error: 'Nieprawidłowy wybór' });
    }

    // Clear pending columns
    await query(
      'UPDATE users SET coins = $1, unlocked_icons = $2, pending_chest_icon = NULL, pending_chest_refund = 0 WHERE nick = $3',
      [finalCoins, icons.join(','), nick]
    );

    res.json({
      success: true,
      newCoins: finalCoins,
      unlocked_icons: icons
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    const result = await query("SELECT * FROM trades WHERE status = 'open' ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades/create', async (req, res) => {
  const { creator, offeredIcon, requestedIcon, requestedCoins } = req.body;
  if (!creator || !offeredIcon) {
    return res.status(400).json({ error: 'Brak wymaganych pól' });
  }
  try {
    const userRes = await query('SELECT unlocked_icons, active_icon FROM users WHERE nick = $1', [creator]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];
    
    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    if (!icons.includes(offeredIcon)) {
      return res.status(400).json({ error: 'Nie posiadasz tej ikony' });
    }
    
    // Remove one copy of the icon from user's inventory
    const index = icons.indexOf(offeredIcon);
    if (index > -1) {
      icons.splice(index, 1);
    }
    let activeIcon = user.active_icon;
    if (activeIcon === offeredIcon && !icons.includes(offeredIcon)) {
      activeIcon = 'default';
    }
    
    await query('UPDATE users SET unlocked_icons = $1, active_icon = $2 WHERE nick = $3', [icons.join(','), activeIcon, creator]);
    
    // Save trade offer
    const coinsReq = parseInt(requestedCoins) || 0;
    const iconReq = requestedIcon || '';
    
    await query(
      "INSERT INTO trades (creator, offered_icon, requested_icon, requested_coins, status) VALUES ($1, $2, $3, $4, 'open')",
      [creator, offeredIcon, iconReq, coinsReq]
    );
    
    io.emit('trades_updated');
    res.json({ success: true, unlocked_icons: icons, active_icon: activeIcon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades/cancel', async (req, res) => {
  const { nick, tradeId } = req.body;
  try {
    const tradeRes = await query('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (tradeRes.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    const trade = tradeRes.rows[0];
    
    if (trade.creator !== nick) {
      return res.status(403).json({ error: 'Nie jesteś właścicielem tej oferty' });
    }
    
    if (trade.status !== 'open') {
      return res.status(400).json({ error: 'Oferta nie jest już aktywna' });
    }
    
    // Mark as cancelled
    await query("UPDATE trades SET status = 'cancelled' WHERE id = $1", [tradeId]);
    
    // Give the offered icon back
    const userRes = await query('SELECT unlocked_icons FROM users WHERE nick = $1', [nick]);
    if (userRes.rows.length > 0) {
      const user = userRes.rows[0];
      let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
      icons.push(trade.offered_icon);
      await query('UPDATE users SET unlocked_icons = $1 WHERE nick = $2', [icons.join(','), nick]);
    }
    
    io.emit('trades_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades/accept', async (req, res) => {
  const { buyer, tradeId } = req.body;
  try {
    const tradeRes = await query('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (tradeRes.rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
    const trade = tradeRes.rows[0];
    
    if (trade.creator === buyer) {
      return res.status(400).json({ error: 'Nie możesz zaakceptować własnej oferty' });
    }
    
    if (trade.status !== 'open') {
      return res.status(400).json({ error: 'Oferta nie jest już aktywna' });
    }
    
    const buyerRes = await query('SELECT coins, unlocked_icons FROM users WHERE nick = $1', [buyer]);
    if (buyerRes.rows.length === 0) return res.status(404).json({ error: 'Kupujący nie istnieje' });
    const buyerUser = buyerRes.rows[0];
    
    const creatorRes = await query('SELECT coins, unlocked_icons FROM users WHERE nick = $1', [trade.creator]);
    if (creatorRes.rows.length === 0) return res.status(404).json({ error: 'Sprzedający nie istnieje' });
    const creatorUser = creatorRes.rows[0];
    
    let buyerIcons = buyerUser.unlocked_icons ? buyerUser.unlocked_icons.split(',') : [];
    let creatorIcons = creatorUser.unlocked_icons ? creatorUser.unlocked_icons.split(',') : [];
    
    // Check constraints
    if (trade.requested_coins > 0) {
      if (buyerUser.coins < trade.requested_coins) {
        return res.status(400).json({ error: 'Nie masz wystarczającej ilości monet' });
      }
      // Process coins transaction
      const newBuyerCoins = buyerUser.coins - trade.requested_coins;
      const newCreatorCoins = creatorUser.coins + trade.requested_coins;
      
      // Add offered icon to buyer (unconditionally, support duplicates)
      buyerIcons.push(trade.offered_icon);
      
      await query('UPDATE users SET coins = $1, unlocked_icons = $2 WHERE nick = $3', [newBuyerCoins, buyerIcons.join(','), buyer]);
      await query('UPDATE users SET coins = $1 WHERE nick = $2', [newCreatorCoins, trade.creator]);
      
    } else if (trade.requested_icon) {
      if (!buyerIcons.includes(trade.requested_icon)) {
        return res.status(400).json({ error: 'Nie posiadasz wymaganej ikony do wymiany' });
      }
      
      // Process icons exchange
      // Remove only ONE copy of requested icon from buyer
      const idx = buyerIcons.indexOf(trade.requested_icon);
      if (idx > -1) {
        buyerIcons.splice(idx, 1);
      }
      
      // Give offered icon to buyer (unconditionally, support duplicates)
      buyerIcons.push(trade.offered_icon);
      
      // Give requested icon to creator (unconditionally, support duplicates)
      creatorIcons.push(trade.requested_icon);
      
      // If buyer's active icon was the requested one and they have no copies left, reset it to default
      const buyerActiveRes = await query('SELECT active_icon FROM users WHERE nick = $1', [buyer]);
      let buyerActive = buyerActiveRes.rows[0]?.active_icon || 'default';
      if (buyerActive === trade.requested_icon && !buyerIcons.includes(trade.requested_icon)) {
        buyerActive = 'default';
      }
      
      await query('UPDATE users SET unlocked_icons = $1, active_icon = $2 WHERE nick = $3', [buyerIcons.join(','), buyerActive, buyer]);
      await query('UPDATE users SET unlocked_icons = $1 WHERE nick = $2', [creatorIcons.join(','), trade.creator]);
    }
    
    // Complete trade
    await query("UPDATE trades SET status = 'completed' WHERE id = $1", [tradeId]);
    
    io.emit('trades_updated');
    io.to(trade.creator).emit('trade_accepted');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades/recycle', async (req, res) => {
  const { nick, selectedIcons } = req.body;
  if (!nick || !selectedIcons || !Array.isArray(selectedIcons) || selectedIcons.length !== 10) {
    return res.status(400).json({ error: 'Musisz wybrać dokładnie 10 ikon do recyklingu.' });
  }

  try {
    const userRes = await query('SELECT coins, unlocked_icons, active_icon, unlocked_characters FROM users WHERE nick = $1', [nick]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Użytkownik nie istnieje.' });
    const user = userRes.rows[0];

    let ownedIcons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    
    // Validate owned icons
    let tempOwned = [...ownedIcons];
    for (const icon of selectedIcons) {
      const idx = tempOwned.indexOf(icon);
      if (idx === -1) {
        return res.status(400).json({ error: `Nie posiadasz wystarczającej liczby kopii ikony: ${icon}` });
      }
      tempOwned.splice(idx, 1);
    }

    // Deduct the icons
    ownedIcons = tempOwned;

    // Check active icon
    let activeIcon = user.active_icon || 'default';
    if (activeIcon !== 'default' && !ownedIcons.includes(activeIcon)) {
      activeIcon = 'default';
    }

    // Roll reward
    const rand = Math.random();
    let rewardType = ''; // 'dushane' or 'coin'
    let newCoins = user.coins;
    let characters = user.unlocked_characters ? user.unlocked_characters.split(',') : ['Zygzak'];

    if (rand < 0.04) {
      rewardType = 'dushane';
      if (!characters.includes('Dushane')) {
        characters.push('Dushane');
      }
    } else {
      rewardType = 'coin';
      newCoins += 1;
    }

    await query(
      'UPDATE users SET coins = $1, unlocked_icons = $2, active_icon = $3, unlocked_characters = $4 WHERE nick = $5',
      [newCoins, ownedIcons.join(','), activeIcon, characters.join(','), nick]
    );

    res.json({
      success: true,
      reward: rewardType,
      newCoins,
      unlocked_icons: ownedIcons,
      unlocked_characters: characters,
      active_icon: activeIcon
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Casino ────────────────────────────────────────────────────────────────────

const activeBJGames = {};

const generateDeck = () => {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = [
    { val: '2', score: 2 }, { val: '3', score: 3 }, { val: '4', score: 4 },
    { val: '5', score: 5 }, { val: '6', score: 6 }, { val: '7', score: 7 },
    { val: '8', score: 8 }, { val: '9', score: 9 }, { val: '10', score: 10 },
    { val: 'J', score: 10 }, { val: 'Q', score: 10 }, { val: 'K', score: 10 },
    { val: 'A', score: 11 }
  ];
  const deck = [];
  for (const suit of suits) {
    for (const v of values) {
      deck.push({ suit, value: v.val, score: v.score });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

const calculateBJScore = (hand) => {
  let score = hand.reduce((acc, card) => acc + card.score, 0);
  let aces = hand.filter(card => card.value === 'A').length;
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
};

app.post('/api/casino/blackjack/start', async (req, res) => {
  const { nick, bet } = req.body;
  if (!nick || !bet) return res.status(400).json({ error: 'Nick and bet are required' });
  const betAmount = parseInt(bet, 10);
  if (isNaN(betAmount) || betAmount < 10 || betAmount > 500)
    return res.status(400).json({ error: 'Bet must be between 10 and 500' });

  try {
    const result = await query('SELECT coins FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    if (user.coins < betAmount) return res.status(400).json({ error: 'Not enough coins' });

    await query('UPDATE users SET coins = $1 WHERE nick = $2', [user.coins - betAmount, nick]);

    const deck = generateDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    activeBJGames[nick] = { deck, playerHand, dealerHand, bet: betAmount };

    res.json({
      success: true,
      playerHand,
      dealerHand: [dealerHand[0], { suit: '?', value: '?', score: 0 }],
      playerScore: calculateBJScore(playerHand),
      dealerScore: dealerHand[0].score,
      newCoins: user.coins - betAmount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/casino/blackjack/hit', (req, res) => {
  const { nick } = req.body;
  const game = activeBJGames[nick];
  if (!game) return res.status(400).json({ error: 'No active game found' });

  const newCard = game.deck.pop();
  game.playerHand.push(newCard);
  const playerScore = calculateBJScore(game.playerHand);

  if (playerScore > 21) {
    delete activeBJGames[nick];
    res.json({
      success: true, status: 'bust',
      playerHand: game.playerHand, dealerHand: game.dealerHand,
      playerScore, dealerScore: calculateBJScore(game.dealerHand), message: 'Bust!'
    });
  } else {
    res.json({
      success: true, status: 'playing',
      playerHand: game.playerHand,
      dealerHand: [game.dealerHand[0], { suit: '?', value: '?', score: 0 }],
      playerScore, dealerScore: game.dealerHand[0].score
    });
  }
});

app.post('/api/casino/blackjack/stand', async (req, res) => {
  const { nick } = req.body;
  const game = activeBJGames[nick];
  if (!game) return res.status(400).json({ error: 'No active game found' });

  let playerScore = calculateBJScore(game.playerHand);
  let dealerScore = calculateBJScore(game.dealerHand);
  while (dealerScore < 17) {
    game.dealerHand.push(game.deck.pop());
    dealerScore = calculateBJScore(game.dealerHand);
  }

  let result = 'lose';
  let payout = 0;
  if (dealerScore > 21 || playerScore > dealerScore) { result = 'win'; payout = game.bet * 2; }
  else if (playerScore === dealerScore) { result = 'push'; payout = game.bet; }

  try {
    const userResult = await query('SELECT coins, casino_xp, blackjack_wins FROM users WHERE nick = $1', [nick]);
    if (userResult.rows.length === 0) { delete activeBJGames[nick]; return res.status(500).json({ error: 'User not found' }); }
    const u = userResult.rows[0];
    const newCoins = u.coins + payout;

    let newXp = u.casino_xp || 0;
    let newBjWins = u.blackjack_wins || 0;
    if (result === 'win') {
      newXp += 1;
      newBjWins += 1;
    }

    await query('UPDATE users SET coins = $1, casino_xp = $2, blackjack_wins = $3 WHERE nick = $4',
      [newCoins, newXp, newBjWins, nick]);
    delete activeBJGames[nick];
    res.json({ success: true, status: result, playerHand: game.playerHand, dealerHand: game.dealerHand,
      playerScore, dealerScore, payout, newCoins, newXp, newBjWins });
  } catch (err) {
    delete activeBJGames[nick];
    res.status(500).json({ error: err.message });
  }
});

const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

app.post('/api/casino/roulette', async (req, res) => {
  const { nick, bets } = req.body;
  if (!nick || !bets) return res.status(400).json({ error: 'Nick and bets are required' });

  let totalBet = 0;
  for (const key in bets) {
    const val = parseInt(bets[key], 10);
    if (isNaN(val) || val < 0) return res.status(400).json({ error: 'Invalid bet' });
    totalBet += val;
  }
  if (totalBet < 10 || totalBet > 1000)
    return res.status(400).json({ error: 'Zakład musi wynosić od 10 do 1000 monet' });

  try {
    const result = await query('SELECT coins, casino_xp FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (result.rows[0].coins < totalBet) return res.status(400).json({ error: 'Za mało monet' });

    const winNumber = Math.floor(Math.random() * 37);
    let winColor = 'green';
    if (winNumber > 0) winColor = RED_NUMBERS.includes(winNumber) ? 'red' : 'black';

    let payout = 0;
    for (const key in bets) {
      const betVal = parseInt(bets[key], 10);
      if (!betVal || betVal <= 0) continue;
      if (key === 'red' && winColor === 'red') payout += betVal * 2;
      else if (key === 'black' && winColor === 'black') payout += betVal * 2;
      else if (key.startsWith('num_')) {
        const num = parseInt(key.split('_')[1], 10);
        if (num === winNumber) payout += betVal * 36;
      }
    }

    const newCoins = result.rows[0].coins - totalBet + payout;
    let newXp = result.rows[0].casino_xp || 0;
    if (payout > 0) newXp += 1;
    await query('UPDATE users SET coins = $1, casino_xp = $2 WHERE nick = $3', [newCoins, newXp, nick]);
    res.json({ success: true, number: winNumber, color: winColor, payout, totalBet, newCoins, newXp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const SPORTS_MATCHES = {
  match_1: { id: 'match_1', home: 'Polska', away: 'Niemcy', odds: { '1': 3.20, 'X': 3.40, '2': 2.10 }, probs: [0.28, 0.55] },
  match_2: { id: 'match_2', home: 'Brazylia', away: 'Argentyna', odds: { '1': 2.20, 'X': 3.10, '2': 2.45 }, probs: [0.42, 0.70] },
  match_3: { id: 'match_3', home: 'Francja', away: 'Hiszpania', odds: { '1': 2.05, 'X': 3.20, '2': 2.70 }, probs: [0.45, 0.73] },
  match_4: { id: 'match_4', home: 'Portugalia', away: 'Włochy', odds: { '1': 2.30, 'X': 3.00, '2': 2.50 }, probs: [0.40, 0.70] }
};

app.post('/api/casino/sports/bet', async (req, res) => {
  const { nick, matchId, prediction, bet } = req.body;
  if (!nick || !matchId || !prediction || !bet) return res.status(400).json({ error: 'Missing parameters' });
  const betAmount = parseInt(bet, 10);
  if (isNaN(betAmount) || betAmount < 10 || betAmount > 500)
    return res.status(400).json({ error: 'Zakład musi wynosić od 10 do 500 monet' });

  const match = SPORTS_MATCHES[matchId];
  if (!match) return res.status(400).json({ error: 'Invalid match ID' });
  const oddsVal = match.odds[prediction];
  if (!oddsVal) return res.status(400).json({ error: 'Invalid prediction' });

  try {
    const result = await query('SELECT coins FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (result.rows[0].coins < betAmount) return res.status(400).json({ error: 'Za mało monet' });

    const rand = Math.random();
    let outcome = '2';
    if (rand < match.probs[0]) outcome = '1';
    else if (rand < match.probs[1]) outcome = 'X';

    let homeGoals = 0, awayGoals = 0;
    if (outcome === '1') { homeGoals = Math.floor(Math.random() * 3) + 1; awayGoals = Math.floor(Math.random() * homeGoals); }
    else if (outcome === 'X') { homeGoals = Math.floor(Math.random() * 3); awayGoals = homeGoals; }
    else { awayGoals = Math.floor(Math.random() * 3) + 1; homeGoals = Math.floor(Math.random() * awayGoals); }

    const won = outcome === prediction;
    const payout = won ? Math.floor(betAmount * oddsVal) : 0;
    const newCoins = result.rows[0].coins - betAmount + payout;
    await query('UPDATE users SET coins = $1 WHERE nick = $2', [newCoins, nick]);
    res.json({ success: true, won, score: `${homeGoals}-${awayGoals}`, outcome, payout, newCoins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/casino/slots', async (req, res) => {
  const { nick, bet } = req.body;
  if (!nick || !bet) return res.status(400).json({ error: 'Missing parameters' });
  const betAmount = parseInt(bet, 10);
  if (isNaN(betAmount) || betAmount < 10 || betAmount > 500)
    return res.status(400).json({ error: 'Zakład musi wynosić od 10 do 500 monet' });

  try {
    const result = await query('SELECT coins, casino_xp FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (result.rows[0].coins < betAmount) return res.status(400).json({ error: 'Za mało monet' });

    const symbols = ['Zygzak', 'Faraon', 'Moneta', 'Gwiazda', 'Korona'];
    const isWin = Math.random() < 0.3;
    let reels = [], payoutMultiplier = 0;

    if (isWin) {
      const isJackpot = Math.random() < 0.25;
      const winningSymbol = symbols[Math.floor(Math.random() * symbols.length)];
      if (isJackpot) {
        reels = [winningSymbol, winningSymbol, winningSymbol];
        payoutMultiplier = 8;
      } else {
        const otherSymbols = symbols.filter(s => s !== winningSymbol);
        const diffSymbol = otherSymbols[Math.floor(Math.random() * otherSymbols.length)];
        reels = [winningSymbol, winningSymbol, diffSymbol];
        for (let i = reels.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [reels[i], reels[j]] = [reels[j], reels[i]];
        }
        payoutMultiplier = 2;
      }
    } else {
      const shuffled = [...symbols].sort(() => Math.random() - 0.5);
      reels = [shuffled[0], shuffled[1], shuffled[2]];
      payoutMultiplier = 0;
    }

    const payout = betAmount * payoutMultiplier;
    const newCoins = result.rows[0].coins - betAmount + payout;
    let newXp = result.rows[0].casino_xp || 0;
    if (isWin) newXp += 1;
    await query('UPDATE users SET coins = $1, casino_xp = $2 WHERE nick = $3', [newCoins, newXp, nick]);
    res.json({ success: true, reels, win: isWin, payout, newCoins, newXp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/buy', async (req, res) => {
  const { nick, character, cost } = req.body;
  try {
    const result = await query('SELECT coins, unlocked_characters FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    let characters = user.unlocked_characters.split(',');
    if (characters.includes(character)) return res.status(400).json({ error: 'Already unlocked' });
    if (user.coins < cost) return res.status(400).json({ error: 'Not enough coins' });

    characters.push(character);
    const newCoins = user.coins - cost;
    await query('UPDATE users SET coins = $1, unlocked_characters = $2 WHERE nick = $3', [newCoins, characters.join(','), nick]);
    res.json({ coins: newCoins, unlocked_characters: characters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/select-champion', async (req, res) => {
  const { nick, champion } = req.body;
  if (!nick || !champion) return res.status(400).json({ error: 'Nick and champion are required' });
  try {
    await query('UPDATE users SET active_champion = $1 WHERE nick = $2', [champion, nick]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/buy-skill', async (req, res) => {
  const { nick, skillName, cost } = req.body;
  try {
    const result = await query('SELECT stars, unlocked_skills FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];

    let skills = user.unlocked_skills ? user.unlocked_skills.split(',') : [];
    if (skills.includes(skillName)) return res.status(400).json({ error: 'Already unlocked' });
    if ((user.stars || 0) < cost) return res.status(400).json({ error: 'Not enough stars' });

    skills.push(skillName);
    const newStars = user.stars - cost;
    await query('UPDATE users SET stars = $1, unlocked_skills = $2 WHERE nick = $3', [newStars, skills.join(','), nick]);
    res.json({ stars: newStars, unlocked_skills: skills });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-pharaoh-star', async (req, res) => {
  const { nick } = req.body;
  if (!nick) return res.status(400).json({ error: 'Nick is required' });
  try {
    const result = await query('SELECT stars FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const newStars = (result.rows[0].stars || 0) + 1;
    await query('UPDATE users SET stars = $1 WHERE nick = $2', [newStars, nick]);
    res.json({ success: true, stars: newStars });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kanapa mode - reward coins per won round
app.post('/api/kanapa/reward', async (req, res) => {
  const { nick, coins } = req.body;
  if (!nick || !coins) return res.status(400).json({ error: 'Nick and coins are required' });
  try {
    const result = await query('SELECT coins FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const newCoins = (result.rows[0].coins || 0) + parseInt(coins);
    await query('UPDATE users SET coins = $1 WHERE nick = $2', [newCoins, nick]);
    res.json({ success: true, newCoins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Perfect timing tracker (for TIMI badge)
app.post('/api/perfect-timing', async (req, res) => {
  const { nick } = req.body;
  if (!nick) return res.status(400).json({ error: 'Nick required' });
  try {
    const result = await query('SELECT perfect_timings FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const newPT = (result.rows[0].perfect_timings || 0) + 1;
    await query('UPDATE users SET perfect_timings = $1 WHERE nick = $2', [newPT, nick]);
    res.json({ success: true, perfect_timings: newPT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get casino XP bonus for current user (every 10 XP = +2% win bonus)
app.get('/api/casino/xp-bonus/:nick', async (req, res) => {
  const { nick } = req.params;
  try {
    const result = await query('SELECT casino_xp FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const xp = result.rows[0].casino_xp || 0;
    const bonusTiers = Math.floor(xp / 10);
    const bonusPercent = bonusTiers * 2;
    res.json({ casino_xp: xp, bonus_percent: bonusPercent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



const queues = { draft: [], ranked: [] };
const onlineUsers = {};
const userChampions = {};
const userIcons = {};
const activeGames = {};

io.on('connection', (socket) => {
  let playerNick = null;

  socket.on('register_connection', ({ nick, activeIcon }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userIcons[nick] = activeIcon || 'default';
    socket.join(nick);
    console.log(`Player ${nick} connected via WebSocket.`);
  });

  socket.on('join_queue', ({ mode, nick, champion, activeIcon }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userChampions[nick] = champion || 'Zygzak';
    userIcons[nick] = activeIcon || 'default';
    if (!queues[mode].includes(nick)) queues[mode].push(nick);
    matchmake(mode);
  });

  socket.on('force_bot_match', async ({ mode, nick, champion, activeIcon }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userChampions[nick] = champion || 'Zygzak';
    userIcons[nick] = activeIcon || 'default';

    // Remove from queue
    queues[mode] = queues[mode].filter(n => n !== nick);

    const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    let botNick = 'Bot Ezreal', botChamp = 'Zygzak', botDiff = 'easy';
    if (mode === 'ranked') {
      const rand = Math.random();
      if (rand < 0.33) {
        botNick = 'Bot Ezreal'; botChamp = 'Zygzak'; botDiff = 'easy';
      } else if (rand < 0.66) {
        botNick = 'Bot Dushane'; botChamp = 'Dushane'; botDiff = 'medium';
      } else {
        botNick = 'Bot Soprano'; botChamp = 'Tony Soprano'; botDiff = 'hard';
      }
    } else {
      // Draft mode
      const rand = Math.random();
      if (rand < 0.5) {
        botNick = 'Bot Ezreal'; botChamp = 'Zygzak'; botDiff = 'easy';
      } else {
        botNick = 'Bot Dushane'; botChamp = 'Dushane'; botDiff = 'medium';
      }
    }
    userChampions[botNick] = botChamp;

    const game = {
      id: gameId, mode, player1: nick, player2: botNick, difficulty: botDiff,
      scores: { [nick]: 0, [botNick]: 0 }, round: 1, targetTime: 0,
      roundInputs: {}, skillsUsed: { [nick]: false, [botNick]: false },
      activeEffects: { [nick]: {}, [botNick]: {} }
    };
    activeGames[gameId] = game;

    const s1 = onlineUsers[nick];
    if (s1) {
      const stats1 = await getMatchmakingStats(nick);
      const stats2 = await getMatchmakingStats(botNick);

      let botIcon = 'default';
      if (botNick === 'Bot Soprano') botIcon = 'young_maga';
      else if (botNick === 'Bot Dushane') botIcon = 'irys';
      else if (botNick === 'Bot Ezreal') botIcon = 'dalton';

      io.to(s1).emit('match_found', { 
        gameId, 
        opponent: botNick, 
        opponentChamp: botChamp, 
        opponentIcon: botIcon, 
        yourIcon: userIcons[nick] || 'default', 
        mode, 
        role: 'player1',
        yourStats: stats1,
        opponentStats: stats2
      });
      startNewRound(gameId);
    }
  });

  socket.on('leave_queue', ({ mode, nick }) => {
    queues[mode] = queues[mode].filter(n => n !== nick);
  });

  socket.on('start_practice', async ({ nick, champion, difficulty, activeIcon }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userChampions[nick] = champion || 'Zygzak';
    userIcons[nick] = activeIcon || 'default';

    const gameId = `practice_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    let botNick = 'Bot Ezreal', botChamp = 'Zygzak';
    if (difficulty === 'medium') { botNick = 'Bot Dushane'; botChamp = 'Dushane'; }
    else if (difficulty === 'hard') { botNick = 'Bot Soprano'; botChamp = 'Tony Soprano'; }
    userChampions[botNick] = botChamp;

    const game = {
      id: gameId, mode: 'practice', difficulty: difficulty || 'easy',
      player1: nick, player2: botNick,
      scores: { [nick]: 0, [botNick]: 0 }, round: 1, targetTime: 0,
      roundInputs: {}, skillsUsed: { [nick]: false, [botNick]: false },
      activeEffects: { [nick]: {}, [botNick]: {} }
    };
    activeGames[gameId] = game;

    const stats1 = await getMatchmakingStats(nick);
    const stats2 = await getMatchmakingStats(botNick);

    let botIcon = 'default';
    if (botNick === 'Bot Soprano') botIcon = 'young_maga';
    else if (botNick === 'Bot Dushane') botIcon = 'irys';
    else if (botNick === 'Bot Ezreal') botIcon = 'dalton';

    socket.emit('match_found', { 
      gameId, 
      opponent: botNick, 
      opponentChamp: botChamp, 
      opponentIcon: botIcon, 
      yourIcon: userIcons[nick] || 'default', 
      mode: 'practice', 
      role: 'player1',
      yourStats: stats1,
      opponentStats: stats2
    });
    startNewRound(gameId);
  });

  socket.on('submit_time', ({ gameId, nick, timeDiff }) => {
    const game = activeGames[gameId];
    if (!game) return;
    game.roundInputs[nick] = timeDiff;

    if (game.player2.startsWith('Bot')) {
      const bot = game.player2;
      const botChamp = userChampions[bot] || 'Zygzak';
      if (!game.skillsUsed[bot] && Math.random() < 0.3) {
        game.skillsUsed[bot] = true;
        if (botChamp === 'Zygzak') { game.activeEffects[game.player1].shake = true; socket.emit('skill_triggered', { type: 'shake' }); }
        else if (botChamp === 'Dushane') { game.activeEffects[bot].dushane = true; }
        else if (botChamp === 'Tony Soprano') { game.activeEffects[game.player1].tony = true; socket.emit('skill_triggered', { type: 'tony_opp' }); }
      }

      let botError = 0;
      if (game.difficulty === 'easy') { botError = (Math.random() * 2.4 - 1.2); if (Math.random() < 0.35) botError += (Math.random() * 2.0 - 1.0); }
      else if (game.difficulty === 'medium') { botError = (Math.random() * 1.0 - 0.5); if (Math.random() < 0.2) botError += (Math.random() * 0.8 - 0.4); }
      else if (game.difficulty === 'hard') { botError = (Math.random() * 0.30 - 0.15); }

      if (game.activeEffects[bot].tony) botError += (botError >= 0 ? 1.00 : -1.00);
      if (game.activeEffects[bot].shake) botError += (botError >= 0 ? 0.30 : -0.30);
      if (game.activeEffects[bot].speedup) botError = botError * 2.0;

      game.roundInputs[bot] = parseFloat(botError.toFixed(4));
    }

    if (Object.keys(game.roundInputs).length === 2) evaluateRound(gameId);
  });

  socket.on('use_skill', ({ gameId, nick, skill }) => {
    const game = activeGames[gameId];
    if (!game || game.skillsUsed[nick]) return;
    game.skillsUsed[nick] = true;
    const opponent = game.player1 === nick ? game.player2 : game.player1;

    if (opponent.startsWith('Bot')) {
      if (skill === 'Zygzak') game.activeEffects[opponent].shake = true;
      else if (skill === 'Dushane') { game.activeEffects[nick].dushane = true; socket.emit('skill_triggered', { type: 'dushane_self' }); }
      else if (skill === 'Tony Soprano') { game.activeEffects[opponent].tony = true; socket.emit('skill_triggered', { type: 'tony_self' }); }
      else if (skill === 'WhiteToes') game.activeEffects[opponent].speedup = true;
      return;
    }

    const oppSocketId = onlineUsers[opponent];
    if (oppSocketId) {
      if (skill === 'Zygzak') io.to(oppSocketId).emit('skill_triggered', { type: 'shake' });
      else if (skill === 'Dushane') { game.activeEffects[nick].dushane = true; io.to(onlineUsers[nick]).emit('skill_triggered', { type: 'dushane_self' }); io.to(oppSocketId).emit('skill_triggered', { type: 'dushane_opp' }); }
      else if (skill === 'Tony Soprano') { game.activeEffects[opponent].tony = true; io.to(oppSocketId).emit('skill_triggered', { type: 'tony_opp' }); io.to(onlineUsers[nick]).emit('skill_triggered', { type: 'tony_self' }); }
      else if (skill === 'WhiteToes') { game.activeEffects[opponent].speedup = true; io.to(oppSocketId).emit('skill_triggered', { type: 'speedup' }); }
    }
  });

  socket.on('disconnect', () => {
    if (playerNick) {
      delete onlineUsers[playerNick];
      delete userChampions[playerNick];
      queues.draft = queues.draft.filter(n => n !== playerNick);
      queues.ranked = queues.ranked.filter(n => n !== playerNick);

      for (const gameId in activeGames) {
        const game = activeGames[gameId];
        if (game.player1 === playerNick || game.player2 === playerNick) {
          const opponent = game.player1 === playerNick ? game.player2 : game.player1;
          if (!opponent.startsWith('Bot')) {
            const oppSocketId = onlineUsers[opponent];
            if (oppSocketId) io.to(oppSocketId).emit('opponent_disconnected');
          }
          finishGame(gameId, opponent, true);
        }
      }
    }
  });
});

async function getMatchmakingStats(nick) {
  if (!nick) return { rank: 'Iron 4', winratio: '0%', badge: 'Brak' };
  if (nick.startsWith('Bot')) {
    let botRank = 'Bronze 1';
    let botBadge = 'Brak';
    if (nick === 'Bot Ezreal') { botRank = 'Bronze 3'; }
    else if (nick === 'Bot Dushane') { botRank = 'Silver 1'; botBadge = 'Nowicjusz Blackjack 🎗️'; }
    else if (nick === 'Bot Soprano') { botRank = 'Gold 1'; botBadge = 'Boss Blackjack 🏆'; }
    return {
      rank: botRank,
      winratio: '50%',
      badge: botBadge
    };
  }

  try {
    const result = await query(
      'SELECT rank, blackjack_wins, perfect_timings FROM users WHERE nick = $1',
      [nick]
    );
    if (result.rows.length === 0) return { rank: 'Iron 4', winratio: '0%', badge: 'Brak' };
    const user = result.rows[0];

    const rankedResult = await query(
      "SELECT winner FROM matches WHERE (player1 = $1 OR player2 = $1) AND mode = 'ranked'",
      [nick]
    );
    let rankedWins = 0;
    let rankedTotal = rankedResult.rows.length;
    rankedResult.rows.forEach(m => { if (m.winner === nick) rankedWins++; });

    const winratio = rankedTotal > 0 ? `${Math.round((rankedWins / rankedTotal) * 100)}%` : '0%';

    let badge = 'Brak';
    const bjWins = user.blackjack_wins || 0;
    const pt = user.perfect_timings || 0;

    if (pt >= 40) {
      badge = 'TIMI ⚡';
    } else if (bjWins >= 100) {
      badge = 'GOAT Blackjack 🐐';
    } else if (bjWins >= 30) {
      badge = 'Boss Blackjack 🏆';
    } else if (bjWins >= 10) {
      badge = 'Nowicjusz Blackjack 🎗️';
    }

    return {
      rank: user.rank || 'Iron 4',
      winratio,
      badge
    };
  } catch (err) {
    console.error('Error fetching stats for matchmaking:', err);
    return { rank: 'Iron 4', winratio: '0%', badge: 'Brak' };
  }
}

async function matchmake(mode) {
  queues[mode] = queues[mode].filter(nick => onlineUsers[nick] !== undefined);
  if (queues[mode].length >= 2) {
    const p1 = queues[mode].shift();
    const p2 = queues[mode].shift();
    const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const game = {
      id: gameId, mode, player1: p1, player2: p2,
      scores: { [p1]: 0, [p2]: 0 }, round: 1, targetTime: 0,
      roundInputs: {}, skillsUsed: { [p1]: false, [p2]: false },
      activeEffects: { [p1]: {}, [p2]: {} }
    };
    activeGames[gameId] = game;

    const s1 = onlineUsers[p1], s2 = onlineUsers[p2];
    if (s1 && s2) {
      const stats1 = await getMatchmakingStats(p1);
      const stats2 = await getMatchmakingStats(p2);

      io.to(s1).emit('match_found', { 
        gameId, 
        opponent: p2, 
        opponentChamp: userChampions[p2] || 'Zygzak', 
        opponentIcon: userIcons[p2] || 'default', 
        yourIcon: userIcons[p1] || 'default', 
        mode, 
        role: 'player1',
        yourStats: stats1,
        opponentStats: stats2
      });
      io.to(s2).emit('match_found', { 
        gameId, 
        opponent: p1, 
        opponentChamp: userChampions[p1] || 'Zygzak', 
        opponentIcon: userIcons[p1] || 'default', 
        yourIcon: userIcons[p2] || 'default', 
        mode, 
        role: 'player2',
        yourStats: stats2,
        opponentStats: stats1
      });
      startNewRound(gameId);
    } else {
      if (s1) queues[mode].unshift(p1);
      if (s2) queues[mode].unshift(p2);
    }
  }
}

function startNewRound(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  game.targetTime = parseFloat((Math.random() * 9.99 + 0.01).toFixed(2));
  game.roundInputs = {};
  game.activeEffects[game.player1] = {};
  game.activeEffects[game.player2] = {};

  const s1 = onlineUsers[game.player1];
  if (s1) io.to(s1).emit('new_round', { round: game.round, targetTime: game.targetTime, scores: game.scores });

  if (!game.player2.startsWith('Bot')) {
    const s2 = onlineUsers[game.player2];
    if (s2) io.to(s2).emit('new_round', { round: game.round, targetTime: game.targetTime, scores: game.scores });
  }
}

function evaluateRound(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  const p1 = game.player1, p2 = game.player2;
  let diff1 = game.roundInputs[p1], diff2 = game.roundInputs[p2];
  let val1 = Math.abs(diff1), val2 = Math.abs(diff2);

  let dushaneImprovement1 = 0;
  let dushaneImprovement2 = 0;

  if (game.activeEffects[p1].dushane) {
    const newVal1 = Math.max(0, val1 - 0.25);
    dushaneImprovement1 = val1 - newVal1;
    val1 = newVal1;
  }
  if (game.activeEffects[p2].dushane) {
    const newVal2 = Math.max(0, val2 - 0.25);
    dushaneImprovement2 = val2 - newVal2;
    val2 = newVal2;
  }

  if (game.activeEffects[p1].tony) val1 += 1.00;
  if (game.activeEffects[p2].tony) val2 += 1.00;

  let roundWinner = null;
  const isP1Perfect = Math.abs(diff1) === 0;
  const isP2Perfect = Math.abs(diff2) === 0;

  if (val1 === val2) {
    roundWinner = 'draw';
    game.scores[p1] += isP1Perfect ? 2 : 1;
    game.scores[p2] += isP2Perfect ? 2 : 1;
  } else if (val1 < val2) {
    roundWinner = p1;
    game.scores[p1] += isP1Perfect ? 2 : 1;
  } else {
    roundWinner = p2;
    game.scores[p2] += isP2Perfect ? 2 : 1;
  }

  const s1 = onlineUsers[p1];
  if (s1) {
    io.to(s1).emit('round_result', {
      winner: roundWinner,
      scores: game.scores,
      yourDiff: diff1,
      oppDiff: diff2,
      target: game.targetTime,
      yourDushaneImprovement: dushaneImprovement1,
      oppDushaneImprovement: dushaneImprovement2
    });
  }
  if (!p2.startsWith('Bot')) {
    const s2 = onlineUsers[p2];
    if (s2) {
      io.to(s2).emit('round_result', {
        winner: roundWinner,
        scores: game.scores,
        yourDiff: diff2,
        oppDiff: diff1,
        target: game.targetTime,
        yourDushaneImprovement: dushaneImprovement2,
        oppDushaneImprovement: dushaneImprovement1
      });
    }
  }

  const pointsToWin = (game.mode === 'ranked' || game.mode === 'practice') ? 3 : 5;
  if (game.scores[p1] >= pointsToWin) finishGame(gameId, p1);
  else if (game.scores[p2] >= pointsToWin) finishGame(gameId, p2);
  else { game.round++; setTimeout(() => startNewRound(gameId), 1500); }
}

async function rewardPlayer(nick, coinsToAdd, starsToAdd, gameOverPayload) {
  try {
    const result = await query('SELECT coins, stars FROM users WHERE nick = $1', [nick]);
    if (result.rows.length === 0) return;
    const row = result.rows[0];
    const newCoins = Math.max(0, (row.coins || 0) + coinsToAdd);
    const newStars = Math.max(0, (row.stars || 0) + starsToAdd);
    await query('UPDATE users SET coins = $1, stars = $2 WHERE nick = $3', [newCoins, newStars, nick]);
    io.to(nick).emit('game_over', gameOverPayload);
  } catch (err) {
    console.error(`Error rewarding ${nick}:`, err.message);
  }
}

async function finishGame(gameId, winnerNick, isDisconnect = false) {
  const game = activeGames[gameId];
  if (!game) return;
  const loserNick = game.player1 === winnerNick ? game.player2 : game.player1;
  const scoreStr = `${game.scores[game.player1]}-${game.scores[game.player2]}`;

  delete activeGames[gameId];

  try {
    await query(
      'INSERT INTO matches (player1, player2, winner, mode, score) VALUES ($1, $2, $3, $4, $5)',
      [game.player1, game.player2, winnerNick, game.mode, scoreStr]
    );
  } catch (err) {
    console.error('Error inserting match history:', err.message);
  }

  if (game.mode === 'draft') {
    await rewardPlayer(winnerNick, 100, 0, { winner: winnerNick, reward: '+100 Coins' });
    if (!loserNick.startsWith('Bot')) await rewardPlayer(loserNick, 0, 0, { winner: winnerNick, reward: '+0 Coins' });

  } else if (game.mode === 'ranked') {
    const lpGain = Math.floor(Math.random() * 11) + 20;
    const lpLoss = -(Math.floor(Math.random() * 6) + 15);

    if (!winnerNick.startsWith('Bot')) {
      try {
        const winResult = await query('SELECT rank, lp FROM users WHERE nick = $1', [winnerNick]);
        if (winResult.rows.length > 0) {
          const winUser = winResult.rows[0];
          const nextW = calculateNewRank(winUser.rank, winUser.lp, lpGain);
          await query('UPDATE users SET rank = $1, lp = $2 WHERE nick = $3', [nextW.rank, nextW.lp, winnerNick]);
          await rewardPlayer(winnerNick, 200, 0, { winner: winnerNick, reward: '+200 Coins', lpChange: lpGain, newRank: nextW.rank, newLp: nextW.lp, prevRank: winUser.rank, prevLp: winUser.lp });
        }
      } catch (err) { console.error('Error updating ranked winner:', err.message); }
    }

    if (!loserNick.startsWith('Bot')) {
      try {
        const loseResult = await query('SELECT rank, lp FROM users WHERE nick = $1', [loserNick]);
        if (loseResult.rows.length > 0) {
          const loseUser = loseResult.rows[0];
          const nextL = calculateNewRank(loseUser.rank, loseUser.lp, lpLoss);
          await query('UPDATE users SET rank = $1, lp = $2 WHERE nick = $3', [nextL.rank, nextL.lp, loserNick]);
          await rewardPlayer(loserNick, 0, 0, { winner: winnerNick, reward: '+0 Coins', lpChange: lpLoss, newRank: nextL.rank, newLp: nextL.lp, prevRank: loseUser.rank, prevLp: loseUser.lp });
        }
      } catch (err) { console.error('Error updating ranked loser:', err.message); }
    }

  } else if (game.mode === 'practice') {
    const humanPlayer = game.player1;
    const isHumanWinner = winnerNick === humanPlayer;
    let coinsReward = 20;
    if (isHumanWinner) {
      if (game.difficulty === 'hard') coinsReward = 400;
      else coinsReward = 100;
    } else {
      coinsReward = 20;
    }
    await rewardPlayer(humanPlayer, coinsReward, 0, { winner: winnerNick, reward: `+${coinsReward} Coins (Trening)` });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
