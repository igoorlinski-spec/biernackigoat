const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
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

// Database setup
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to SQLite database.');
    
    // Check if table users exists and has 'email' column, drop if old to reset
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", (err, row) => {
      if (!err && row) {
        db.run("SELECT email FROM users LIMIT 1", (err) => {
          if (err && (err.message.includes("no such column") || err.message.includes("no such table"))) {
            console.log("Old database schema detected. Dropping tables to reset database...");
            db.serialize(() => {
              db.run("DROP TABLE IF EXISTS users");
              db.run("DROP TABLE IF EXISTS matches");
              initializeDatabase();
            });
          } else {
            initializeDatabase();
          }
        });
      } else {
        initializeDatabase();
      }
    });
  }
});

function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        last_daily_claim INTEGER DEFAULT 0
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player1 TEXT NOT NULL,
        player2 TEXT NOT NULL,
        winner TEXT NOT NULL,
        mode TEXT NOT NULL,
        score TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
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

  // Master, Grandmaster, Challenger logic (simply based on absolute LP thresholds once Master is reached)
  const isApexTier = (rank) => ['Master', 'Grandmaster', 'Challenger'].includes(rank);

  if (isApexTier(currentRank)) {
    if (newLp < 0) {
      // Demote back to Diamond 1
      return { rank: 'Diamond 1', lp: 75 };
    }
    // Progression between Master/GM/Challenger
    if (newLp >= 1000) {
      return { rank: 'Challenger', lp: newLp };
    } else if (newLp >= 500) {
      return { rank: 'Grandmaster', lp: newLp };
    } else {
      return { rank: 'Master', lp: newLp };
    }
  }

  // standard divisions (Iron 4 to Diamond 1)
  if (newLp >= 100) {
    if (rankIndex < RANKS.indexOf('Diamond 1')) {
      // Promote
      rankIndex += 1;
      newLp = newLp - 100;
    } else {
      // Diamond 1 -> Master
      return { rank: 'Master', lp: newLp - 100 };
    }
  } else if (newLp < 0) {
    if (rankIndex > 0) {
      // Demote
      rankIndex -= 1;
      newLp = 100 + newLp; // e.g. 100 - 15 = 85 LP in lower tier
    } else {
      // Iron 4 0 LP floor
      newLp = 0;
    }
  }

  return { rank: RANKS[rankIndex], lp: newLp };
}

// REST Endpoints
app.post('/api/register', (req, res) => {
  const { nick, email, password } = req.body;
  if (!nick || !email || !password) {
    return res.status(400).json({ error: 'Nick, e-mail i hasło są wymagane' });
  }

  if (nick.length > 10) {
    return res.status(400).json({ error: 'Nick może mieć maksymalnie 10 znaków' });
  }

  db.get('SELECT nick, email FROM users WHERE nick = ? OR email = ?', [nick, email.toLowerCase()], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) {
      if (row.nick === nick) {
        return res.status(400).json({ error: 'Ten nick jest już zajęty' });
      } else {
        return res.status(400).json({ error: 'Ten e-mail jest już zarejestrowany' });
      }
    }

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        'INSERT INTO users (email, nick, password, unlocked_icons) VALUES (?, ?, ?, ?)',
        [email.toLowerCase(), nick, hash, 'dalton,tusk'],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true });
        }
      );
    });
  });
});

app.post('/api/login', (req, res) => {
  const { nickOrEmail, password } = req.body;
  if (!nickOrEmail || !password) {
    return res.status(400).json({ error: 'Nick/E-mail i hasło są wymagane' });
  }

  db.get('SELECT * FROM users WHERE nick = ? OR email = ?', [nickOrEmail, nickOrEmail.toLowerCase()], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: 'Nie znaleziono użytkownika' });

    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!isMatch) return res.status(400).json({ error: 'Błędne hasło' });

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
        unlocked_characters: user.unlocked_characters.split(','),
        unlocked_skills: user.unlocked_skills ? user.unlocked_skills.split(',') : [],
        activeChampion: user.active_champion || 'Zygzak',
        unlocked_icons: icons,
        activeIcon: user.active_icon || 'default',
        lastDailyClaim: user.last_daily_claim || 0
      });
    });
  });
});

app.get('/api/profile/:nick', (req, res) => {
  const { nick } = req.params;
  db.get('SELECT nick, coins, lp, rank, stars, unlocked_characters, unlocked_skills, active_champion, unlocked_icons, active_icon, last_daily_claim FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'Player not found' });

    // Calculate ranked winrate
    db.all(
      'SELECT winner, mode FROM matches WHERE (player1 = ? OR player2 = ?) AND mode = \'ranked\'',
      [nick, nick],
      (err, rankedMatches) => {
        if (err) return res.status(500).json({ error: err.message });

        let rankedWins = 0;
        let rankedTotal = rankedMatches.length;
        rankedMatches.forEach(m => {
          if (m.winner === nick) rankedWins++;
        });

        db.all(
          'SELECT * FROM matches WHERE player1 = ? OR player2 = ? ORDER BY timestamp DESC LIMIT 10',
          [nick, nick],
          (err, matches) => {
            if (err) return res.status(500).json({ error: err.message });

            let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
            if (!icons.includes('dalton')) icons.push('dalton');
            if (!icons.includes('tusk')) icons.push('tusk');

            res.json({
              nick: user.nick,
              coins: user.coins,
              lp: user.lp,
              rank: user.rank,
              stars: user.stars || 0,
              unlocked_characters: user.unlocked_characters.split(','),
              unlocked_skills: user.unlocked_skills ? user.unlocked_skills.split(',') : [],
              activeChampion: user.active_champion || 'Zygzak',
              unlocked_icons: icons,
              activeIcon: user.active_icon || 'default',
              lastDailyClaim: user.last_daily_claim || 0,
              rankedWins,
              rankedTotal,
              history: matches
            });
          }
        );
      }
    );
  });
});

app.get('/api/leaderboard', (req, res) => {
  db.all('SELECT nick, lp, rank, coins, stars, active_champion, active_icon FROM users WHERE length(nick) <= 10 ORDER BY lp DESC, coins DESC LIMIT 100', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/buy-icon', (req, res) => {
  const { nick, iconName, cost } = req.body;
  db.get('SELECT coins, unlocked_icons FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    if (icons.includes(iconName)) {
      return res.status(400).json({ error: 'Already unlocked' });
    }
    if (user.coins < cost) {
      return res.status(400).json({ error: 'Not enough coins' });
    }

    icons.push(iconName);
    const newCoins = user.coins - cost;
    const newIconsStr = icons.join(',');

    db.run(
      'UPDATE users SET coins = ?, unlocked_icons = ? WHERE nick = ?',
      [newCoins, newIconsStr, nick],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ coins: newCoins, unlocked_icons: icons });
      }
    );
  });
});

app.post('/api/select-icon', (req, res) => {
  const { nick, iconName } = req.body;
  if (!nick || !iconName) return res.status(400).json({ error: 'Nick and iconName are required' });

  db.get('SELECT unlocked_icons FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let icons = user.unlocked_icons ? user.unlocked_icons.split(',') : [];
    if (iconName !== 'default' && !icons.includes(iconName)) {
      return res.status(400).json({ error: 'Icon not unlocked' });
    }

    db.run('UPDATE users SET active_icon = ? WHERE nick = ?', [iconName, nick], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, activeIcon: iconName });
    });
  });
});

app.post('/api/claim-daily-chest', (req, res) => {
  const { nick } = req.body;
  if (!nick) return res.status(400).json({ error: 'Nick is required' });

  db.get('SELECT coins, last_daily_claim FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = Date.now();
    const lastClaim = user.last_daily_claim || 0;
    const cooldown = 24 * 60 * 60 * 1000; // 24 hours in ms

    if (now - lastClaim < cooldown) {
      const timeLeft = cooldown - (now - lastClaim);
      return res.status(400).json({ error: 'Cooldown active', timeLeft });
    }

    // Generate random reward (increments of 5 from 5 to 100)
    const rewards = [];
    for (let i = 5; i <= 100; i += 5) {
      rewards.push(i);
    }
    const rewardIndex = Math.floor(Math.random() * rewards.length);
    const rewardCoins = rewards[rewardIndex];

    const newCoins = (user.coins || 0) + rewardCoins;

    db.run(
      'UPDATE users SET coins = ?, last_daily_claim = ? WHERE nick = ?',
      [newCoins, now, nick],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          success: true,
          rewardCoins,
          newCoins,
          lastDailyClaim: now
        });
      }
    );
  });
});

app.post('/api/blackjack', (req, res) => {
  const { nick, bet } = req.body;
  if (!nick || !bet) return res.status(400).json({ error: 'Nick and bet are required' });

  const betAmount = parseInt(bet, 10);
  if (isNaN(betAmount) || betAmount < 10 || betAmount > 500) {
    return res.status(400).json({ error: 'Bet must be between 10 and 500' });
  }

  db.get('SELECT coins FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.coins < betAmount) return res.status(400).json({ error: 'Not enough coins' });

    // Dealer wins 70% of the time, player wins 30%
    const playerWins = Math.random() < 0.3;
    let playerTarget, dealerTarget;

    if (playerWins) {
      playerTarget = 19 + Math.floor(Math.random() * 3); // 19, 20, 21
      if (Math.random() < 0.5) {
        dealerTarget = 22 + Math.floor(Math.random() * 5); // 22 to 26 (bust)
      } else {
        dealerTarget = 17 + Math.floor(Math.random() * (playerTarget - 17)); // 17 to playerTarget - 1
      }
    } else {
      if (Math.random() < 0.4) {
        playerTarget = 22 + Math.floor(Math.random() * 5); // Player busts (22 to 26)
        dealerTarget = 17 + Math.floor(Math.random() * 4); // Dealer stands (17 to 20)
      } else {
        playerTarget = 16 + Math.floor(Math.random() * 4); // Player stands (16 to 19)
        dealerTarget = playerTarget + 1 + Math.floor(Math.random() * (21 - playerTarget)); // Dealer beats player
      }
    }

    const generateHand = (targetScore) => {
      const suits = ['♠', '♥', '♦', '♣'];
      const hand = [];
      let currentScore = 0;
      while (currentScore < targetScore) {
        let needed = targetScore - currentScore;
        let cardVal;
        let cardScore;
        if (needed > 11) {
          cardScore = Math.floor(Math.random() * 10) + 2;
          if (cardScore === 10) {
            cardVal = ['10', 'J', 'Q', 'K'][Math.floor(Math.random() * 4)];
          } else if (cardScore === 11) {
            cardVal = 'A';
          } else {
            cardVal = String(cardScore);
          }
        } else {
          cardScore = needed;
          if (cardScore === 10) {
            cardVal = ['10', 'J', 'Q', 'K'][Math.floor(Math.random() * 4)];
          } else if (cardScore === 11) {
            cardVal = 'A';
          } else {
            cardVal = String(cardScore);
          }
        }
        const suit = suits[Math.floor(Math.random() * suits.length)];
        hand.push({ suit, value: cardVal, score: cardScore });
        currentScore += cardScore;
      }
      return hand;
    };

    const playerHand = generateHand(playerTarget);
    const dealerHand = generateHand(dealerTarget);

    let coinDiff = -betAmount;
    if (playerWins) {
      coinDiff = betAmount; // +2x bet in total, so net gain is +betAmount
    }
    const newCoins = user.coins + coinDiff;

    db.run('UPDATE users SET coins = ? WHERE nick = ?', [newCoins, nick], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        success: true,
        win: playerWins,
        playerHand,
        dealerHand,
        playerScore: playerTarget,
        dealerScore: dealerTarget,
        newCoins,
        rewardCoins: playerWins ? betAmount * 2 : 0
      });
    });
  });
});

app.post('/api/buy', (req, res) => {
  const { nick, character, cost } = req.body;
  db.get('SELECT coins, unlocked_characters FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let characters = user.unlocked_characters.split(',');
    if (characters.includes(character)) {
      return res.status(400).json({ error: 'Already unlocked' });
    }
    if (user.coins < cost) {
      return res.status(400).json({ error: 'Not enough coins' });
    }

    characters.push(character);
    const newCoins = user.coins - cost;
    const newCharsStr = characters.join(',');

    db.run(
      'UPDATE users SET coins = ?, unlocked_characters = ? WHERE nick = ?',
      [newCoins, newCharsStr, nick],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ coins: newCoins, unlocked_characters: characters });
      }
    );
  });
});

app.post('/api/select-champion', (req, res) => {
  const { nick, champion } = req.body;
  if (!nick || !champion) return res.status(400).json({ error: 'Nick and champion are required' });

  db.run('UPDATE users SET active_champion = ? WHERE nick = ?', [champion, nick], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/buy-skill', (req, res) => {
  const { nick, skillName, cost } = req.body;
  db.get('SELECT stars, unlocked_skills FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let skills = user.unlocked_skills ? user.unlocked_skills.split(',') : [];
    if (skills.includes(skillName)) {
      return res.status(400).json({ error: 'Already unlocked' });
    }
    if ((user.stars || 0) < cost) {
      return res.status(400).json({ error: 'Not enough stars' });
    }

    skills.push(skillName);
    const newStars = user.stars - cost;
    const newSkillsStr = skills.join(',');

    db.run(
      'UPDATE users SET stars = ?, unlocked_skills = ? WHERE nick = ?',
      [newStars, newSkillsStr, nick],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ stars: newStars, unlocked_skills: skills });
      }
    );
  });
});

app.post('/api/claim-pharaoh-star', (req, res) => {
  const { nick } = req.body;
  if (!nick) return res.status(400).json({ error: 'Nick is required' });

  db.get('SELECT stars FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newStars = (user.stars || 0) + 1;
    db.run('UPDATE users SET stars = ? WHERE nick = ?', [newStars, nick], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, stars: newStars });
    });
  });
});

// Real-time Game State
const queues = {
  draft: [],
  ranked: []
};

const onlineUsers = {}; // Map nick -> socket.id
const userChampions = {}; // Map nick -> active champion name
const userIcons = {}; // Map nick -> active icon name
const activeGames = {};

io.on('connection', (socket) => {
  let playerNick = null;

  socket.on('register_connection', ({ nick, activeIcon }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userIcons[nick] = activeIcon || 'default';
    socket.join(nick);
    console.log(`Player ${nick} connected via WebSocket. Socket ID: ${socket.id}`);
  });

  socket.on('join_queue', ({ mode, nick, champion, activeIcon }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userChampions[nick] = champion || 'Zygzak';
    userIcons[nick] = activeIcon || 'default';

    if (!queues[mode].includes(nick)) {
      queues[mode].push(nick);
      console.log(`${nick} joined ${mode} queue with champ ${champion}.`);
    }

    // Try matchmaking
    matchmake(mode);
  });

  socket.on('leave_queue', ({ mode, nick }) => {
    queues[mode] = queues[mode].filter(n => n !== nick);
    console.log(`${nick} left ${mode} queue.`);
  });

  // Practice Mode (Tryb Treningowy)
  socket.on('start_practice', ({ nick, champion, difficulty, activeIcon }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userChampions[nick] = champion || 'Zygzak';
    userIcons[nick] = activeIcon || 'default';

    const gameId = `practice_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    let botNick = 'Bot Ezreal';
    let botChamp = 'Zygzak';
    
    if (difficulty === 'medium') {
      botNick = 'Bot Dushane';
      botChamp = 'Dushane';
    } else if (difficulty === 'hard') {
      botNick = 'Bot Soprano';
      botChamp = 'Tony Soprano';
    }
    
    userChampions[botNick] = botChamp;
    
    const game = {
      id: gameId,
      mode: 'practice',
      difficulty: difficulty || 'easy',
      player1: nick,
      player2: botNick,
      scores: { [nick]: 0, [botNick]: 0 },
      round: 1,
      targetTime: 0,
      roundInputs: {},
      skillsUsed: { [nick]: false, [botNick]: false },
      activeEffects: { [nick]: {}, [botNick]: {} }
    };

    activeGames[gameId] = game;

    // Notify client match found with champ info
    socket.emit('match_found', { 
      gameId, 
      opponent: botNick, 
      opponentChamp: botChamp, 
      mode: 'practice', 
      role: 'player1' 
    });
    
    startNewRound(gameId);
  });

  // Gameplay
  socket.on('submit_time', ({ gameId, nick, timeDiff }) => {
    const game = activeGames[gameId];
    if (!game) return;

    game.roundInputs[nick] = timeDiff;

    // Generate Bot's time instantly when player submits
    if (game.player2.startsWith('Bot')) {
      const bot = game.player2;
      const botChamp = userChampions[bot] || 'Zygzak';
      
      // Bot decides to use skill (30% chance per round if not used yet)
      if (!game.skillsUsed[bot] && Math.random() < 0.3) {
        game.skillsUsed[bot] = true;
        if (botChamp === 'Zygzak') {
          game.activeEffects[game.player1].shake = true;
          socket.emit('skill_triggered', { type: 'shake' });
        } else if (botChamp === 'Dushane') {
          game.activeEffects[bot].dushane = true;
        } else if (botChamp === 'Tony Soprano') {
          game.activeEffects[game.player1].tony = true;
          socket.emit('skill_triggered', { type: 'tony_opp' });
        }
      }

      // Generate bot's error (signed difference) based on difficulty
      let botError = 0;
      if (game.difficulty === 'easy') {
        // Easy McQueen Bot: timing error -1.2s to +1.2s
        botError = (Math.random() * 2.4 - 1.2);
        if (Math.random() < 0.35) {
          botError += (Math.random() * 2.0 - 1.0);
        }
      } else if (game.difficulty === 'medium') {
        // Medium Dushane Bot: timing error -0.5s to +0.5s
        botError = (Math.random() * 1.0 - 0.5);
        if (Math.random() < 0.2) {
          botError += (Math.random() * 0.8 - 0.4);
        }
      } else if (game.difficulty === 'hard') {
        // Hard Soprano Bot: timing error -0.2s to +0.2s
        botError = (Math.random() * 0.4 - 0.2);
        if (Math.random() < 0.1) {
          botError += (Math.random() * 0.3 - 0.15);
        }
      }

      // Apply effects
      if (game.activeEffects[bot].tony) {
        botError += (botError >= 0 ? 1.00 : -1.00);
      }
      if (game.activeEffects[bot].shake) {
        botError += (botError >= 0 ? 0.30 : -0.30);
      }
      if (game.activeEffects[bot].speedup) {
        botError = botError * 2.0;
      }

      game.roundInputs[bot] = parseFloat(botError.toFixed(4));
    }

    // Check if both submitted
    if (Object.keys(game.roundInputs).length === 2) {
      evaluateRound(gameId);
    }
  });

  // Use Skill
  socket.on('use_skill', ({ gameId, nick, skill }) => {
    const game = activeGames[gameId];
    if (!game) return;

    if (game.skillsUsed[nick]) return; // limit exactly 1 per match
    game.skillsUsed[nick] = true;

    const opponent = game.player1 === nick ? game.player2 : game.player1;

    // If opponent is bot, we don't emit socket, we just apply effect to bot
    if (opponent.startsWith('Bot')) {
      if (skill === 'Zygzak') {
        game.activeEffects[opponent].shake = true;
      } else if (skill === 'Dushane') {
        game.activeEffects[nick].dushane = true;
        socket.emit('skill_triggered', { type: 'dushane_self' });
      } else if (skill === 'Tony Soprano') {
        game.activeEffects[opponent].tony = true;
        socket.emit('skill_triggered', { type: 'tony_self' });
      } else if (skill === 'WhiteToes') {
        game.activeEffects[opponent].speedup = true;
      }
      return;
    }

    // Normal multiplayer skill propagation
    const oppSocketId = onlineUsers[opponent];
    if (oppSocketId) {
      if (skill === 'Zygzak') {
        io.to(oppSocketId).emit('skill_triggered', { type: 'shake' });
      } else if (skill === 'Dushane') {
        game.activeEffects[nick].dushane = true;
        io.to(onlineUsers[nick]).emit('skill_triggered', { type: 'dushane_self' });
        io.to(oppSocketId).emit('skill_triggered', { type: 'dushane_opp' });
      } else if (skill === 'Tony Soprano') {
        game.activeEffects[opponent].tony = true;
        io.to(oppSocketId).emit('skill_triggered', { type: 'tony_opp' });
        io.to(onlineUsers[nick]).emit('skill_triggered', { type: 'tony_self' });
      } else if (skill === 'WhiteToes') {
        game.activeEffects[opponent].speedup = true;
        io.to(oppSocketId).emit('skill_triggered', { type: 'speedup' });
      }
    }
  });

  socket.on('disconnect', () => {
    if (playerNick) {
      delete onlineUsers[playerNick];
      delete userChampions[playerNick];
      queues.draft = queues.draft.filter(n => n !== playerNick);
      queues.ranked = queues.ranked.filter(n => n !== playerNick);

      // Handle disconnect inside active games
      for (const gameId in activeGames) {
        const game = activeGames[gameId];
        if (game.player1 === playerNick || game.player2 === playerNick) {
          const opponent = game.player1 === playerNick ? game.player2 : game.player1;
          if (!opponent.startsWith('Bot')) {
            const oppSocketId = onlineUsers[opponent];
            if (oppSocketId) {
              io.to(oppSocketId).emit('opponent_disconnected');
            }
          }
          finishGame(gameId, opponent, true);
        }
      }
    }
  });
});

function matchmake(mode) {
  // Filter queue for users who are actually online
  queues[mode] = queues[mode].filter(nick => onlineUsers[nick] !== undefined);

  if (queues[mode].length >= 2) {
    const p1 = queues[mode].shift();
    const p2 = queues[mode].shift();

    const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const game = {
      id: gameId,
      mode,
      player1: p1,
      player2: p2,
      scores: { [p1]: 0, [p2]: 0 },
      round: 1,
      targetTime: 0,
      roundInputs: {},
      skillsUsed: { [p1]: false, [p2]: false },
      activeEffects: { [p1]: {}, [p2]: {} }
    };

    activeGames[gameId] = game;

    // Send events to both players with their active champions
    const s1 = onlineUsers[p1];
    const s2 = onlineUsers[p2];

    if (s1 && s2) {
      io.to(s1).emit('match_found', { 
        gameId, 
        opponent: p2, 
        opponentChamp: userChampions[p2] || 'Zygzak',
        opponentIcon: userIcons[p2] || 'default',
        yourIcon: userIcons[p1] || 'default',
        mode, 
        role: 'player1' 
      });
      io.to(s2).emit('match_found', { 
        gameId, 
        opponent: p1, 
        opponentChamp: userChampions[p1] || 'Zygzak',
        opponentIcon: userIcons[p1] || 'default',
        yourIcon: userIcons[p2] || 'default',
        mode, 
        role: 'player2' 
      });
      startNewRound(gameId);
    } else {
      // Re-queue whoever is still online
      if (s1) queues[mode].unshift(p1);
      if (s2) queues[mode].unshift(p2);
    }
  }
}

function startNewRound(gameId) {
  const game = activeGames[gameId];
  if (!game) return;

  // Random target time between 0.01 and 10.00 seconds
  game.targetTime = parseFloat((Math.random() * 9.99 + 0.01).toFixed(2));
  game.roundInputs = {};

  // Reset round-specific effects
  game.activeEffects[game.player1] = {};
  game.activeEffects[game.player2] = {};

  // Notify Player 1
  const s1 = onlineUsers[game.player1];
  if (s1) {
    io.to(s1).emit('new_round', {
      round: game.round,
      targetTime: game.targetTime,
      scores: game.scores
    });
  }

  // Notify Player 2 (if human)
  if (game.player2 !== 'Bot Ezreal') {
    const s2 = onlineUsers[game.player2];
    if (s2) {
      io.to(s2).emit('new_round', {
        round: game.round,
        targetTime: game.targetTime,
        scores: game.scores
      });
    }
  }
}

function evaluateRound(gameId) {
  const game = activeGames[gameId];
  if (!game) return;

  const p1 = game.player1;
  const p2 = game.player2;

  let diff1 = game.roundInputs[p1]; // signed difference
  let diff2 = game.roundInputs[p2]; // signed difference

  // Calculate absolute values for victory checking
  let val1 = Math.abs(diff1);
  let val2 = Math.abs(diff2);

  // Apply skill modifiers
  if (game.activeEffects[p1].dushane) {
    val1 = Math.max(0, val1 - 0.15);
  }
  if (game.activeEffects[p2].dushane) {
    val2 = Math.max(0, val2 - 0.15);
  }
  if (game.activeEffects[p1].tony) {
    // tony adds 1.00s penalty for humans too if not already calculated
    val1 += 1.00;
  }
  if (game.activeEffects[p2].tony) {
    val2 += 1.00;
  }

  // Closer to target wins (i.e. smaller absolute diff)
  let roundWinner = null;
  if (val1 === val2) {
    roundWinner = 'draw';
  } else if (val1 < val2) {
    roundWinner = p1;
    game.scores[p1]++;
  } else {
    roundWinner = p2;
    game.scores[p2]++;
  }

  // Send results to p1
  const s1 = onlineUsers[p1];
  if (s1) {
    io.to(s1).emit('round_result', {
      winner: roundWinner,
      scores: game.scores,
      yourDiff: diff1,
      oppDiff: diff2,
      target: game.targetTime
    });
  }

  // Send results to p2 (if human)
  if (!p2.startsWith('Bot')) {
    const s2 = onlineUsers[p2];
    if (s2) {
      io.to(s2).emit('round_result', {
        winner: roundWinner,
        scores: game.scores,
        yourDiff: diff2,
        oppDiff: diff1,
        target: game.targetTime
      });
    }
  }

  // Check game over
  const pointsToWin = (game.mode === 'ranked' || game.mode === 'practice') ? 3 : 5;
  if (game.scores[p1] >= pointsToWin) {
    finishGame(gameId, p1);
  } else if (game.scores[p2] >= pointsToWin) {
    finishGame(gameId, p2);
  } else {
    game.round++;
    setTimeout(() => {
      startNewRound(gameId);
    }, 1500); // Fast round transition: 1.5-second delay
  }
}

function rewardPlayer(nick, coinsToAdd, starsToAdd, gameOverPayload) {
  db.get('SELECT coins, stars FROM users WHERE nick = ?', [nick], (err, row) => {
    if (err) {
      console.error(`Error fetching stats for rewarding ${nick}:`, err);
      return;
    }
    if (!row) {
      console.error(`Player ${nick} not found for rewarding.`);
      return;
    }

    const newCoins = Math.max(0, (row.coins || 0) + coinsToAdd);
    const newStars = Math.max(0, (row.stars || 0) + starsToAdd);

    db.run(
      'UPDATE users SET coins = ?, stars = ? WHERE nick = ?',
      [newCoins, newStars, nick],
      function(err) {
        if (err) {
          console.error(`Error updating stats for rewarding ${nick}:`, err);
          return;
        }
        console.log(`Successfully rewarded ${nick}: +${coinsToAdd} coins, +${starsToAdd} stars. New totals: ${newCoins} coins, ${newStars} stars.`);
        
        // Emit game_over directly to the player's socket room (more reliable than onlineUsers[nick])
        io.to(nick).emit('game_over', gameOverPayload);
      }
    );
  });
}

function finishGame(gameId, winnerNick, isDisconnect = false) {
  const game = activeGames[gameId];
  if (!game) return;

  const loserNick = game.player1 === winnerNick ? game.player2 : game.player1;
  const scoreStr = `${game.scores[game.player1]}-${game.scores[game.player2]}`;

  // Save all matches to history (including practice mode)
  db.run(
    'INSERT INTO matches (player1, player2, winner, mode, score) VALUES (?, ?, ?, ?, ?)',
    [game.player1, game.player2, winnerNick, game.mode, scoreStr],
    function(err) {
      if (err) {
        console.error('Error inserting match history:', err);
      }

      if (game.mode === 'draft') {
        const rewardW = 100;
        const rewardL = 0;

        // Reward Winner (+100 coins, 0 stars)
        rewardPlayer(winnerNick, rewardW, 0, { winner: winnerNick, reward: `+${rewardW} Coins` });
        
        // Reward Loser (if human)
        if (!loserNick.startsWith('Bot')) {
          rewardPlayer(loserNick, rewardL, 0, { winner: winnerNick, reward: `+${rewardL} Coins` });
        }

      } else if (game.mode === 'ranked') {
        const lpGain = Math.floor(Math.random() * 11) + 20; // 20-30
        const lpLoss = -(Math.floor(Math.random() * 6) + 15); // -15 to -20

        // Reward Winner (+200 coins, 0 stars, +LP)
        db.get('SELECT rank, lp FROM users WHERE nick = ?', [winnerNick], (err, winUser) => {
          if (err) console.error('Error fetching ranked winner details:', err);
          if (winUser) {
            const nextW = calculateNewRank(winUser.rank, winUser.lp, lpGain);
            db.run('UPDATE users SET rank = ?, lp = ? WHERE nick = ?', [nextW.rank, nextW.lp, winnerNick], (err) => {
              if (err) console.error('Error updating ranked winner rank/lp:', err);
              
              rewardPlayer(winnerNick, 200, 0, {
                winner: winnerNick,
                reward: '+200 Coins',
                lpChange: lpGain,
                newRank: nextW.rank,
                newLp: nextW.lp,
                prevRank: winUser.rank,
                prevLp: winUser.lp
              });
            });
          }
        });

        // Reward Loser (if human)
        if (!loserNick.startsWith('Bot')) {
          db.get('SELECT rank, lp FROM users WHERE nick = ?', [loserNick], (err, loseUser) => {
            if (err) console.error('Error fetching ranked loser details:', err);
            if (loseUser) {
              const nextL = calculateNewRank(loseUser.rank, loseUser.lp, lpLoss);
              db.run('UPDATE users SET rank = ?, lp = ? WHERE nick = ?', [nextL.rank, nextL.lp, loserNick], (err) => {
                if (err) console.error('Error updating ranked loser rank/lp:', err);
                
                rewardPlayer(loserNick, 0, 0, {
                  winner: winnerNick,
                  reward: '+0 Coins',
                  lpChange: lpLoss,
                  newRank: nextL.rank,
                  newLp: nextL.lp,
                  prevRank: loseUser.rank,
                  prevLp: loseUser.lp
                });
              });
            }
          });
        }

      } else if (game.mode === 'practice') {
        // Practice Mode rewards (+50/70/100 coins for win based on bot difficulty, +10 for loss, 0 stars)
        const humanPlayer = game.player1;
        const isHumanWinner = winnerNick === humanPlayer;
        let coinsReward = 10;
        
        if (isHumanWinner) {
          if (game.difficulty === 'medium') {
            coinsReward = 70;
          } else if (game.difficulty === 'hard') {
            coinsReward = 100;
          } else {
            coinsReward = 50;
          }
        }

        rewardPlayer(humanPlayer, coinsReward, 0, {
          winner: winnerNick,
          reward: `+${coinsReward} Coins (Trening)`
        });
      }
    }
  );

  delete activeGames[gameId];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
