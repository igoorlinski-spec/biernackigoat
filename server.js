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
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        nick TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        coins INTEGER DEFAULT 0,
        lp INTEGER DEFAULT 0,
        rank TEXT DEFAULT 'Iron 4',
        unlocked_characters TEXT DEFAULT 'Zygzak',
        stars INTEGER DEFAULT 0,
        unlocked_skills TEXT DEFAULT '',
        active_champion TEXT DEFAULT 'Zygzak'
      )
    `);

    // Ensure stars column exists for older database files
    db.run(`ALTER TABLE users ADD COLUMN stars INTEGER DEFAULT 0`, (err) => {
      // Ignore if column already exists
    });

    // Ensure unlocked_skills column exists for older database files
    db.run(`ALTER TABLE users ADD COLUMN unlocked_skills TEXT DEFAULT ''`, (err) => {
      // Ignore if column already exists
    });

    // Ensure active_champion column exists for older database files
    db.run(`ALTER TABLE users ADD COLUMN active_champion TEXT DEFAULT 'Zygzak'`, (err) => {
      // Ignore if column already exists
    });

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

    // Reset all users' coins and stars to 0 to clean up older testing accounts
    db.run(`UPDATE users SET coins = 0, stars = 0`, (err) => {
      if (err) console.error('Error resetting user coins/stars to 0:', err);
    });
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
  const { nick, password } = req.body;
  if (!nick || !password) {
    return res.status(400).json({ error: 'Nick and password are required' });
  }

  db.get('SELECT nick FROM users WHERE nick = ?', [nick], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) return res.status(400).json({ error: 'Nick already taken' });

    bcrypt.hash(password, 10, (err, hash) => {
      if (err) return res.status(500).json({ error: err.message });

      db.run(
        'INSERT INTO users (nick, password) VALUES (?, ?)',
        [nick, hash],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true });
        }
      );
    });
  });
});

app.post('/api/login', (req, res) => {
  const { nick, password } = req.body;
  db.get('SELECT * FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: 'User not found' });

    bcrypt.compare(password, user.password, (err, isMatch) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!isMatch) return res.status(400).json({ error: 'Incorrect password' });

      res.json({
        nick: user.nick,
        coins: user.coins,
        lp: user.lp,
        rank: user.rank,
        stars: user.stars || 0,
        unlocked_characters: user.unlocked_characters.split(','),
        unlocked_skills: user.unlocked_skills ? user.unlocked_skills.split(',') : [],
        activeChampion: user.active_champion || 'Zygzak'
      });
    });
  });
});

app.get('/api/profile/:nick', (req, res) => {
  const { nick } = req.params;
  db.get('SELECT nick, coins, lp, rank, stars, unlocked_characters, unlocked_skills, active_champion FROM users WHERE nick = ?', [nick], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'Player not found' });

    db.all(
      'SELECT * FROM matches WHERE player1 = ? OR player2 = ? ORDER BY timestamp DESC LIMIT 10',
      [nick, nick],
      (err, matches) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          nick: user.nick,
          coins: user.coins,
          lp: user.lp,
          rank: user.rank,
          stars: user.stars || 0,
          unlocked_characters: user.unlocked_characters.split(','),
          unlocked_skills: user.unlocked_skills ? user.unlocked_skills.split(',') : [],
          activeChampion: user.active_champion || 'Zygzak',
          history: matches
        });
      }
    );
  });
});

app.get('/api/leaderboard', (req, res) => {
  db.all('SELECT nick, lp, rank, coins, stars, active_champion FROM users WHERE length(nick) <= 10 ORDER BY lp DESC, coins DESC LIMIT 100', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
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
const activeGames = {};

io.on('connection', (socket) => {
  let playerNick = null;

  socket.on('register_connection', (nick) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    socket.join(nick);
    console.log(`Player ${nick} connected via WebSocket. Socket ID: ${socket.id}`);
  });

  socket.on('join_queue', ({ mode, nick, champion }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userChampions[nick] = champion || 'Zygzak';

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
  socket.on('start_practice', ({ nick, champion }) => {
    playerNick = nick;
    onlineUsers[nick] = socket.id;
    userChampions[nick] = champion || 'Zygzak';

    const gameId = `practice_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const botNick = 'Bot Ezreal';
    userChampions[botNick] = 'Zygzak'; // Bot uses Zygzak
    
    const game = {
      id: gameId,
      mode: 'practice',
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
      opponentChamp: 'Zygzak', 
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

    // Generate Bot Ezreal's time instantly when player submits
    if (game.player2 === 'Bot Ezreal') {
      const bot = 'Bot Ezreal';
      
      // Bot decides to use skill (30% chance per round if not used yet)
      if (!game.skillsUsed[bot] && Math.random() < 0.3) {
        game.skillsUsed[bot] = true;
        game.activeEffects[game.player1].shake = true;
        socket.emit('skill_triggered', { type: 'shake' });
      }

      // Generate bot's error (signed difference, between -0.9s and +0.9s)
      let botError = (Math.random() * 1.8 - 0.9);
      // 25% chance of a larger mistake
      if (Math.random() < 0.25) {
        botError += (Math.random() * 2.0 - 1.0);
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
    if (opponent === 'Bot Ezreal') {
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
          if (opponent !== 'Bot Ezreal') {
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
        mode, 
        role: 'player1' 
      });
      io.to(s2).emit('match_found', { 
        gameId, 
        opponent: p1, 
        opponentChamp: userChampions[p1] || 'Zygzak',
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
  if (p2 !== 'Bot Ezreal') {
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

        // Reward Winner
        rewardPlayer(winnerNick, rewardW, 3, { winner: winnerNick, reward: `+${rewardW} Coins, +3 Gwiazdy` });
        
        // Reward Loser (if human)
        if (loserNick !== 'Bot Ezreal') {
          rewardPlayer(loserNick, rewardL, 0, { winner: winnerNick, reward: `+${rewardL} Coins` });
        }

      } else if (game.mode === 'ranked') {
        const lpGain = Math.floor(Math.random() * 11) + 20; // 20-30
        const lpLoss = -(Math.floor(Math.random() * 6) + 15); // -15 to -20

        // Reward Winner
        db.get('SELECT rank, lp FROM users WHERE nick = ?', [winnerNick], (err, winUser) => {
          if (err) console.error('Error fetching ranked winner details:', err);
          if (winUser) {
            const nextW = calculateNewRank(winUser.rank, winUser.lp, lpGain);
            db.run('UPDATE users SET rank = ?, lp = ? WHERE nick = ?', [nextW.rank, nextW.lp, winnerNick], (err) => {
              if (err) console.error('Error updating ranked winner rank/lp:', err);
              
              rewardPlayer(winnerNick, 200, 5, {
                winner: winnerNick,
                reward: '+200 Coins, +5 Gwiazdy',
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
        if (loserNick !== 'Bot Ezreal') {
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
        // Practice Mode rewards (+50 coins for win, +10 for loss, 0 stars)
        const humanPlayer = game.player1;
        const isHumanWinner = winnerNick === humanPlayer;
        const coinsReward = isHumanWinner ? 50 : 10;

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
