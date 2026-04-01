// ============================================================
// 金曲猜歌王 — script.js
// ============================================================
(function() {
"use strict";

// --------------- Configuration ---------------
var CONFIG = {
  SUPABASE_URL: 'https://hrulsakkhelwnsvpnakx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhydWxzYWtraGVsd25zdnBuYWt4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1OTE0NzAsImV4cCI6MjA5MDE2NzQ3MH0.WKeRkXy8CjtMw4kZvLzBUHZ7kF6KJI25NtgREbmb76U',
  GOOGLE_SHEET_ID: '13BKUVWdA3t-Zh8085EjhGODuD-5jZGZP5MoghM1crDY',
  PLAYBACK_SECONDS: 30,
  INITIAL_TOKENS: 2,
  MAX_TOKENS: 5,
};

// --------------- Global State ---------------
var isGoogleSheetLoaded = false;
var songDatabase = [];          // [{language, artist, title, year, youtubeId}]
var availableLanguages = [];

// Supabase
var supabaseClient = null;
var channel = null;

// YouTube
var ytPlayer = null;
var ytReady = false;
var playbackTimer = null;
var secondsLeft = CONFIG.PLAYBACK_SECONDS;

// Local player
var myName = '';
var myId = '';           // unique id per session
var isHost = false;

// Room / Game
var roomCode = '';
var players = [];        // [{id, name, isHost, score, tokens, timeline:[]}]
var winScore = 5;         // configurable win condition
var gameState = {
  phase: 'waiting',      // waiting | playing | placing | betting | reveal
  currentPlayerIndex: 0,
  round: 1,
  currentSong: null,     // {artist, title, year, youtubeId}
  heroPlacement: null,   // {gapIndex, guessArtist, guessTitle}
  bets: {},              // {playerId: {gapIndex, guessArtist, guessTitle, timestamp}}
  betOrder: [],          // ordered list of player ids who bet (first submitter wins ties)
  usedSongIds: [],
};

// UI selection state
var selectedGapIndex = null;
var betSelectedGapIndex = null;

// ============================================================
// A. DATA MODULE — Google Sheet loader
// ============================================================
function getSheetCSVUrl() {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.GOOGLE_SHEET_ID}/export?format=csv`;
}

function extractYouTubeId(raw) {
  if (!raw) return null;
  const s = raw.trim();
  // Direct 11-char ID
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  // Various URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

function parseCSV(text) {
  // Strip BOM
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Simple CSV parse (handles commas inside quotes)
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;
    const [language, artist, title, yearRaw, ytRaw] = cols.map(c => c.trim());
    if (!artist || !title || !yearRaw) continue;
    const year = parseInt(yearRaw, 10);
    if (isNaN(year)) continue;
    const youtubeId = extractYouTubeId(ytRaw);
    if (!youtubeId) continue;
    rows.push({ language: language || '未知', artist, title, year, youtubeId });
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

async function loadSongDatabase() {
  const statusEl = document.getElementById('loading-status');
  try {
    const resp = await fetch(getSheetCSVUrl());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    songDatabase = parseCSV(text);
    if (songDatabase.length === 0) throw new Error('題庫為空');

    // Extract unique languages
    const langSet = new Set(songDatabase.map(s => s.language));
    availableLanguages = [...langSet].sort();
    populateLanguageSelect();

    isGoogleSheetLoaded = true;
    statusEl.textContent = `題庫載入完成！共 ${songDatabase.length} 首歌`;
    statusEl.className = 'loading-status loaded';
    document.getElementById('btn-create-room').disabled = false;
    document.getElementById('btn-join-room').disabled = false;
  } catch (err) {
    statusEl.textContent = `題庫載入失敗：${err.message}`;
    statusEl.className = 'loading-status error';
    console.error('Sheet load error:', err);
  }
}

function populateLanguageSelect() {
  const sel = document.getElementById('lang-select');
  sel.innerHTML = '<option value="全部">全部</option>';
  availableLanguages.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    sel.appendChild(opt);
  });
}

function getFilteredSongs() {
  const lang = document.getElementById('lang-select').value;
  if (lang === '全部') return songDatabase;
  return songDatabase.filter(s => s.language === lang);
}

function drawRandomSong() {
  const pool = getFilteredSongs().filter(s => !gameState.usedSongIds.includes(s.youtubeId));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================================
// B. SUPABASE REALTIME MODULE
// ============================================================
function initSupabase() {
  supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
}

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function joinChannel(code) {
  roomCode = code;
  channel = supabaseClient.channel(`room-${code}`, {
    config: { broadcast: { self: true } },
  });

  channel.on('broadcast', { event: 'sync' }, ({ payload }) => {
    handleSyncMessage(payload);
  });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      // announce self
      broadcastSync({
        type: 'player_join',
        player: { id: myId, name: myName, isHost },
      });
    }
  });
}

function broadcastSync(data) {
  if (!channel) return;
  channel.send({
    type: 'broadcast',
    event: 'sync',
    payload: data,
  });
}

function handleSyncMessage(payload) {
  switch (payload.type) {
    case 'player_join':
      handlePlayerJoin(payload.player);
      break;
    case 'player_list':
      handlePlayerList(payload.players);
      break;
    case 'game_start':
      handleGameStart(payload);
      break;
    case 'new_turn':
      handleNewTurn(payload);
      break;
    case 'hero_submitted':
      handleHeroSubmitted(payload);
      break;
    case 'bet_placed':
      handleBetPlaced(payload);
      break;
    case 'reveal':
      handleReveal(payload);
      break;
    case 'next_round':
      handleNewTurn(payload);
      break;
    case 'swap_song':
      handleSwapSong(payload);
      break;
    case 'direct_score':
      handleDirectScore(payload);
      break;
    case 'game_over':
      handleGameOver(payload);
      break;
    case 'sudden_death':
      handleSuddenDeath(payload);
      break;
  }
}

// ============================================================
// C. YOUTUBE PLAYER MODULE
// ============================================================
function loadYouTubeAPI() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

// Called by YouTube API when ready (must be global)
window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  // If game screen is already visible, create player immediately
  if (document.getElementById('screen-game').classList.contains('active')) {
    createYTPlayer();
  }
};

function createYTPlayer(videoId) {
  if (ytPlayer) {
    if (videoId) ytPlayer.loadVideoById(videoId);
    return;
  }
  ytPlayer = new YT.Player('yt-player', {
    height: '100%',
    width: '100%',
    videoVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
    },
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
    },
    events: {
      onReady: () => {
        if (videoId) ytPlayer.cueVideoById(videoId);
      },
      onStateChange: onPlayerStateChange,
    },
  });
}

var hasSeekStarted = false;
var isRevealPlayback = false;
var currentRandomStart = 0;  // store the random start position for replay

function onPlayerStateChange(event) {
  // When video first starts playing, seek to random segment (but not during reveal)
  if (event.data === YT.PlayerState.PLAYING && !hasSeekStarted && !isRevealPlayback) {
    hasSeekStarted = true;
    try {
      var duration = ytPlayer.getDuration();
      if (duration > CONFIG.PLAYBACK_SECONDS + 10) {
        // Pick a random start between 10% and 70% of the song
        var minStart = Math.floor(duration * 0.1);
        var maxStart = Math.floor(duration * 0.7);
        currentRandomStart = minStart + Math.floor(Math.random() * (maxStart - minStart));
        ytPlayer.seekTo(currentRandomStart, true);
      } else {
        currentRandomStart = 0;
      }
    } catch (e) { /* ignore seek errors */ }
    startPlaybackTimer();
  } else if (event.data === YT.PlayerState.PLAYING && hasSeekStarted) {
    // After seek completes, timer is already running
  }
}

function startPlaybackTimer() {
  secondsLeft = CONFIG.PLAYBACK_SECONDS;
  updateTimerDisplay();
  clearInterval(playbackTimer);
  playbackTimer = setInterval(function() {
    secondsLeft--;
    updateTimerDisplay();
    if (secondsLeft <= 0) {
      clearInterval(playbackTimer);
      if (ytPlayer) ytPlayer.pauseVideo();
      // Show replay button
      var replayBtn = document.getElementById('btn-replay');
      if (replayBtn) replayBtn.style.display = '';
      // Unlock guess section
      unlockGuessSection();
    }
  }, 1000);
  // Also unlock guess section immediately when music plays
  unlockGuessSection();
}

function updateTimerDisplay() {
  document.getElementById('timer-display').textContent = `${secondsLeft}s`;
}

function unlockGuessSection() {
  const btn = document.getElementById('btn-submit-placement');
  if (selectedGapIndex !== null) btn.disabled = false;
}

function stopPlayback() {
  clearInterval(playbackTimer);
  if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
    try { ytPlayer.pauseVideo(); } catch (e) { /* ignore */ }
  }
}

// ============================================================
// D. GAME LOGIC
// ============================================================

// --- Player join / list ---
function handlePlayerJoin(player) {
  // Host responds with full player list
  if (isHost && player.id !== myId) {
    // Add to local list if new
    if (!players.find(p => p.id === player.id)) {
      players.push({
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        score: 0,
        tokens: CONFIG.INITIAL_TOKENS,
        timeline: [],
      });
    }
    // Broadcast full list
    broadcastSync({ type: 'player_list', players });
  }
  renderWaitingRoom();
}

function handlePlayerList(list) {
  players = list.map(p => ({
    ...p,
    timeline: p.timeline || [],
    score: p.score || 0,
    tokens: p.tokens ?? CONFIG.INITIAL_TOKENS,
  }));
  renderWaitingRoom();
}

// --- Game start ---
function startGame() {
  if (!isHost) return;
  var winEl = document.getElementById('win-score-input-waiting');
  winScore = parseInt(winEl ? winEl.value : '5', 10) || 5;
  if (winScore < 1) winScore = 1;
  gameState.phase = 'playing';
  gameState.currentPlayerIndex = 0;
  gameState.round = 1;
  gameState.usedSongIds = [];
  gameState.betOrder = [];

  // Give each player an initial year card from the song pool
  var pool = getFilteredSongs();
  players.forEach(function(p) {
    if (pool.length === 0) return;
    var idx = Math.floor(Math.random() * pool.length);
    var initSong = pool[idx];
    p.timeline = [{ artist: initSong.artist, title: initSong.title, year: initSong.year }];
    gameState.usedSongIds.push(initSong.youtubeId);
    // Remove from pool so each player gets a different card
    pool = pool.filter(function(s) { return s.youtubeId !== initSong.youtubeId; });
  });

  var song = drawRandomSong();
  if (!song) { alert('題庫中沒有可用歌曲！'); return; }
  gameState.currentSong = song;
  gameState.usedSongIds.push(song.youtubeId);
  gameState.heroPlacement = null;
  gameState.bets = {};

  broadcastSync({
    type: 'game_start',
    players: players,
    winScore: winScore,
    gameState: {
      ...gameState,
      // Only send youtubeId to all; artist/title/year hidden until reveal
      currentSong: { youtubeId: song.youtubeId },
    },
    fullSong: song,
  });
}

function handleGameStart(payload) {
  players = payload.players.map(p => ({
    ...p,
    timeline: p.timeline || [],
    score: p.score || 0,
    tokens: p.tokens ?? CONFIG.INITIAL_TOKENS,
  }));
  winScore = payload.winScore || 5;
  gameState = {
    ...payload.gameState,
    currentSong: payload.fullSong || payload.gameState.currentSong,
    betOrder: [],
  };
  showScreen('screen-game');
  setupTurnUI();
}

// --- New turn ---
function handleNewTurn(payload) {
  gameState.currentPlayerIndex = payload.currentPlayerIndex;
  gameState.round = payload.round;
  gameState.phase = 'playing';
  gameState.heroPlacement = null;
  gameState.bets = {};
  gameState.betOrder = [];
  gameState.currentSong = payload.fullSong || payload.currentSong;
  players = payload.players || players;
  selectedGapIndex = null;
  betSelectedGapIndex = null;

  // Restore YT mask and playback controls for new round
  var mask = document.getElementById('yt-mask');
  if (mask) mask.style.display = '';
  var controls = document.querySelector('.playback-controls');
  if (controls) controls.style.display = '';
  isRevealPlayback = false;

  // Stop any currently playing video
  stopPlayback();

  setupTurnUI();
}

function setupTurnUI() {
  const currentPlayer = players[gameState.currentPlayerIndex];
  const amHero = currentPlayer.id === myId;

  document.getElementById('current-turn-label').textContent = `輪到：${currentPlayer.name}`;
  document.getElementById('round-label').textContent = `第 ${gameState.round} 回合`;
  document.getElementById('win-score-label').textContent = `目標 ${winScore} 分`;

  renderScoreboard();

  // Reset sections visibility
  document.getElementById('music-section').style.display = amHero ? '' : 'none';
  document.getElementById('guess-section').style.display = amHero ? '' : 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = 'none';

  if (amHero) {
    // Hero view
    document.getElementById('timeline-owner-label').textContent = '我的時間軸';
    renderTimeline('timeline', currentPlayer.timeline, true);
    document.getElementById('btn-play').disabled = false;
    document.getElementById('btn-replay').style.display = 'none';
    document.getElementById('btn-submit-placement').disabled = true;
    document.getElementById('guess-artist').value = '';
    document.getElementById('guess-title').value = '';
    secondsLeft = CONFIG.PLAYBACK_SECONDS;
    updateTimerDisplay();

    // Swap button
    const swapBtn = document.getElementById('btn-swap');
    swapBtn.style.display = currentPlayer.tokens >= 1 ? '' : 'none';

    // Direct score button
    const directBtn = document.getElementById('btn-direct-score');
    if (directBtn) directBtn.style.display = currentPlayer.tokens >= 3 ? '' : 'none';

    // Load video
    hasSeekStarted = false;
    if (gameState.currentSong) {
      if (ytReady && !ytPlayer) {
        createYTPlayer(gameState.currentSong.youtubeId);
      } else if (ytPlayer) {
        ytPlayer.cueVideoById(gameState.currentSong.youtubeId);
      }
    }

    selectedGapIndex = null;
  } else {
    // Spectator: show hero's timeline (read-only) while waiting
    document.getElementById('timeline-owner-label').textContent = `${currentPlayer.name} 的時間軸`;
    renderTimeline('timeline', currentPlayer.timeline, false);
    // Show waiting message
    document.getElementById('guess-section').style.display = 'none';
  }
}

// --- Hero submits placement ---
function submitPlacement() {
  if (selectedGapIndex === null) return;
  const placement = {
    gapIndex: selectedGapIndex,
    guessArtist: document.getElementById('guess-artist').value.trim(),
    guessTitle: document.getElementById('guess-title').value.trim(),
  };
  gameState.heroPlacement = placement;
  gameState.phase = 'betting';
  stopPlayback();

  broadcastSync({
    type: 'hero_submitted',
    playerId: myId,
    placement,
    heroTimeline: players[gameState.currentPlayerIndex].timeline,
  });
}

function handleHeroSubmitted(payload) {
  gameState.heroPlacement = payload.placement;
  gameState.phase = 'betting';
  stopPlayback();

  const currentPlayer = players[gameState.currentPlayerIndex];
  const amHero = currentPlayer.id === myId;

  if (amHero) {
    // Hero waits for bets
    document.getElementById('music-section').style.display = 'none';
    document.getElementById('guess-section').style.display = 'none';
    document.getElementById('betting-section').style.display = 'none';
    // Show a waiting hint
    document.getElementById('reveal-section').style.display = '';
    document.getElementById('reveal-content').innerHTML = '<h3>等待其他玩家下注...</h3>';
    document.getElementById('btn-next-round').style.display = 'none';

    // If no other players, auto-reveal immediately
    if (isHost) {
      var nonHeroPlayers = players.filter(function(p, i) { return i !== gameState.currentPlayerIndex; });
      if (nonHeroPlayers.length === 0) {
        setTimeout(function() { triggerReveal(); }, 500);
      }
    }
  } else {
    // Spectator enters betting mode
    document.getElementById('music-section').style.display = 'none';
    document.getElementById('betting-section').style.display = '';
    document.getElementById('reveal-section').style.display = 'none';

    // Render betting timeline: hero's timeline with gaps EXCEPT the one hero chose
    const heroTimeline = currentPlayer.timeline;
    renderBettingTimeline(heroTimeline, payload.placement.gapIndex);

    betSelectedGapIndex = null;
    document.getElementById('btn-submit-bet').disabled = false; // allow skip (no gap selected = skip bet position)
    document.getElementById('bet-guess-artist').value = '';
    document.getElementById('bet-guess-title').value = '';

    const me = players.find(p => p.id === myId);
    if (me && me.tokens < 1) {
      document.querySelector('.bet-hint').textContent = '籌碼不足，無法下注位置（可猜歌手/歌名）';
    } else {
      document.querySelector('.bet-hint').textContent = '選擇年代位置下注 (-1 籌碼)，或直接提交猜歌手/歌名';
    }
  }
}

// --- Betting ---
function submitBet() {
  const me = players.find(p => p.id === myId);
  if (!me) return;

  var guessArtist = document.getElementById('bet-guess-artist').value.trim();
  var guessTitle = document.getElementById('bet-guess-title').value.trim();
  var hasBetPosition = betSelectedGapIndex !== null;

  // If betting on position, must have at least 1 token
  if (hasBetPosition && me.tokens < 1) {
    alert('籌碼不足，無法下注位置');
    return;
  }

  // Must have at least something (gap, artist guess, or title guess)
  if (!hasBetPosition && !guessArtist && !guessTitle) {
    // Pure skip — still send so host knows
  }

  broadcastSync({
    type: 'bet_placed',
    playerId: myId,
    playerName: myName,
    timestamp: Date.now(),
    bet: {
      gapIndex: hasBetPosition ? betSelectedGapIndex : null,
      guessArtist: guessArtist,
      guessTitle: guessTitle,
    },
  });

  document.getElementById('btn-submit-bet').disabled = true;
  document.querySelector('.bet-hint').textContent = '已提交，等待結算...';
}

function handleBetPlaced(payload) {
  gameState.bets[payload.playerId] = payload.bet;
  // Track submission order
  if (!gameState.betOrder) gameState.betOrder = [];
  if (!gameState.betOrder.includes(payload.playerId)) {
    gameState.betOrder.push(payload.playerId);
  }

  // Host: if all non-hero players have submitted, auto-reveal
  if (isHost) {
    const nonHeroPlayers = players.filter((p, i) => i !== gameState.currentPlayerIndex);
    const allSubmitted = nonHeroPlayers.every(p => gameState.bets[p.id] !== undefined);
    if (allSubmitted) {
      setTimeout(() => triggerReveal(), 500);
    }
  }
}

// --- Reveal ---
function triggerReveal() {
  if (!isHost) return;
  var song = gameState.currentSong;
  var currentPlayer = players[gameState.currentPlayerIndex];

  // Calculate correct gap indices for this song
  var correctGaps = getCorrectGapIndices(currentPlayer.timeline, song.year);

  // Score hero placement
  var heroCorrect = correctGaps.includes(gameState.heroPlacement.gapIndex);
  if (heroCorrect) currentPlayer.score += 1;

  // Hero artist/title guesses — must get BOTH correct to earn 1 token
  var heroArtistCorrect = normalizeGuess(gameState.heroPlacement.guessArtist) === normalizeGuess(song.artist);
  var heroTitleCorrect = normalizeGuess(gameState.heroPlacement.guessTitle) === normalizeGuess(song.title);
  var heroBothCorrect = heroArtistCorrect && heroTitleCorrect;
  if (heroBothCorrect) {
    currentPlayer.tokens += 1;
    capTokens(currentPlayer);
  }

  // Only add song to hero's timeline if year placement was correct
  if (heroCorrect) {
    insertIntoTimeline(currentPlayer.timeline, gameState.heroPlacement.gapIndex, song);
  }

  // Score bettors — use betOrder for first-submit priority
  var betResults = {};
  var guessTokenClaimed = heroBothCorrect;  // hero has priority for song guess
  var betOrder = gameState.betOrder || Object.keys(gameState.bets);

  for (var b = 0; b < betOrder.length; b++) {
    var pid = betOrder[b];
    var bet = gameState.bets[pid];
    if (!bet) continue;
    var bettor = players.find(function(p) { return p.id === pid; });
    if (!bettor) continue;

    var betPositionCorrect = false;
    var betBothCorrect = false;

    // Position bet: costs 1 token only if they chose a position
    if (bet.gapIndex !== null) {
      bettor.tokens -= 1;
      betPositionCorrect = correctGaps.includes(bet.gapIndex);
      if (betPositionCorrect) {
        bettor.score += 1;
        bettor.tokens += 2; // net +1 profit
        // Bettor who guessed correct position also gets the song on their timeline
        insertIntoTimeline(bettor.timeline, 0, song); // insertIntoTimeline re-sorts
      }
    }

    // Song guess: must get BOTH artist AND title correct; only first correct guesser gets 1 token
    var bArtist = normalizeGuess(bet.guessArtist) === normalizeGuess(song.artist);
    var bTitle = normalizeGuess(bet.guessTitle) === normalizeGuess(song.title);
    if (!guessTokenClaimed && bArtist && bTitle) {
      betBothCorrect = true;
      bettor.tokens += 1;
      capTokens(bettor);
      guessTokenClaimed = true;
    }

    betResults[pid] = {
      correct: betPositionCorrect,
      hasBetPosition: bet.gapIndex !== null,
      bothCorrect: betBothCorrect,
      artistMatch: bArtist,
      titleMatch: bTitle,
      blocked: bArtist && bTitle && !betBothCorrect,
    };

    capTokens(bettor);
  }

  // Win check deferred — only checked at end of full round in nextRound()
  broadcastSync({
    type: 'reveal',
    song: song,
    heroCorrect: heroCorrect,
    heroArtistCorrect: heroArtistCorrect,
    heroTitleCorrect: heroTitleCorrect,
    heroBothCorrect: heroBothCorrect,
    heroPlacement: gameState.heroPlacement,
    betResults: betResults,
    players: players,
    correctGaps: correctGaps,
  });
}

function handleReveal(payload) {
  gameState.phase = 'reveal';
  players = payload.players;

  // Update timeline display
  var currentPlayer = players[gameState.currentPlayerIndex];
  renderTimeline('timeline', currentPlayer.timeline, false);
  renderScoreboard();

  // Show reveal; YouTube only for the hero player
  var amHero = currentPlayer.id === myId;
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  if (amHero) {
    document.getElementById('music-section').style.display = '';
    var mask = document.getElementById('yt-mask');
    if (mask) mask.style.display = 'none';
    document.querySelector('.playback-controls').style.display = 'none';
    isRevealPlayback = true;
    if (ytPlayer && payload.song && payload.song.youtubeId) {
      try { ytPlayer.loadVideoById(payload.song.youtubeId); } catch (e) { /* ignore */ }
    }
  } else {
    document.getElementById('music-section').style.display = 'none';
  }

  var html = '<div class="reveal-answer">';
  html += '<div class="answer-song">' + payload.song.artist + ' — ' + payload.song.title + '</div>';
  html += '<div class="answer-detail">' + payload.song.year + ' 年</div>';
  html += '</div>';

  html += '<ul class="reveal-result-list">';
  // Hero result
  var hero = players[gameState.currentPlayerIndex];
  var heroBadges = [];
  if (payload.heroCorrect) heroBadges.push('年代正確 +1分');
  if (payload.heroBothCorrect) heroBadges.push('猜歌正確 +1籌碼');
  else if (payload.heroArtistCorrect && !payload.heroTitleCorrect) heroBadges.push('歌手對/歌名錯');
  else if (!payload.heroArtistCorrect && payload.heroTitleCorrect) heroBadges.push('歌名對/歌手錯');
  var heroClass = (payload.heroCorrect || payload.heroBothCorrect) ? 'result-correct' : 'result-wrong';
  html += '<li>' + hero.name + ' (主角) <span class="' + heroClass + '">' + (heroBadges.length ? heroBadges.join(', ') : '年代錯誤') + '</span></li>';

  // Bet results
  var betKeys = Object.keys(payload.betResults);
  for (var k = 0; k < betKeys.length; k++) {
    var pid = betKeys[k];
    var res = payload.betResults[pid];
    var p = players.find(function(pp) { return pp.id === pid; });
    if (!p) continue;
    var badges = [];
    if (res.hasBetPosition) {
      if (res.correct) badges.push('年代正確 +1分');
      else badges.push('年代錯誤 -1籌碼');
    }
    if (res.bothCorrect) badges.push('猜歌正確 +1籌碼 (最快搶答)');
    else if (res.blocked) badges.push('猜歌正確 但已被搶答');
    else if (res.artistMatch && !res.titleMatch) badges.push('歌手對/歌名錯');
    else if (!res.artistMatch && res.titleMatch) badges.push('歌名對/歌手錯');
    var resultClass = (res.correct || res.bothCorrect) ? 'result-correct' : 'result-wrong';
    html += '<li>' + p.name + ' <span class="' + resultClass + '">' + (badges.length ? badges.join(', ') : '未參與') + '</span></li>';
  }
  html += '</ul>';

  document.getElementById('reveal-content').innerHTML = html;

  // Host shows "next round" button
  document.getElementById('btn-next-round').style.display = isHost ? '' : 'none';
}

// --- Next round ---
function nextRound() {
  if (!isHost) return;
  var nextIndex = (gameState.currentPlayerIndex + 1) % players.length;
  var isFullRoundEnd = nextIndex === 0; // wrapped around = everyone played

  // Check win condition only at end of a full round
  if (isFullRoundEnd) {
    var qualifiers = players.filter(function(p) { return p.score >= winScore; });
    if (qualifiers.length === 1) {
      // Clear winner
      broadcastSync({ type: 'game_over', winner: qualifiers[0], players: players });
      return;
    } else if (qualifiers.length > 1) {
      // Tie — find highest score
      var maxScore = Math.max.apply(null, qualifiers.map(function(p) { return p.score; }));
      var topPlayers = qualifiers.filter(function(p) { return p.score === maxScore; });
      if (topPlayers.length === 1) {
        broadcastSync({ type: 'game_over', winner: topPlayers[0], players: players });
        return;
      }
      // Multiple tied at max — enter sudden death (continue playing)
      broadcastSync({ type: 'sudden_death', tiedPlayers: topPlayers.map(function(p) { return p.name; }), players: players });
      // Don't return — fall through to next turn
    }
  }

  gameState.currentPlayerIndex = nextIndex;
  gameState.round += 1;

  var song = drawRandomSong();
  if (!song) {
    alert('題庫中的歌曲已全部使用完畢！');
    return;
  }
  gameState.currentSong = song;
  gameState.usedSongIds.push(song.youtubeId);
  gameState.heroPlacement = null;
  gameState.bets = {};
  gameState.phase = 'playing';

  broadcastSync({
    type: 'next_round',
    currentPlayerIndex: gameState.currentPlayerIndex,
    round: gameState.round,
    fullSong: song,
    currentSong: { youtubeId: song.youtubeId },
    players: players,
  });
}

// --- Swap song ---
function swapSong() {
  const me = players.find(p => p.id === myId);
  if (!me || me.tokens < 1) return;
  me.tokens -= 1;

  const song = drawRandomSong();
  if (!song) { alert('沒有更多歌曲可換！'); return; }
  gameState.currentSong = song;
  gameState.usedSongIds.push(song.youtubeId);

  broadcastSync({
    type: 'swap_song',
    playerId: myId,
    fullSong: song,
    currentSong: { youtubeId: song.youtubeId },
    players,
  });
}

function handleSwapSong(payload) {
  gameState.currentSong = payload.fullSong || payload.currentSong;
  players = payload.players || players;
  renderScoreboard();

  const amHero = players[gameState.currentPlayerIndex].id === myId;
  if (amHero && ytPlayer) {
    hasSeekStarted = false;
    ytPlayer.cueVideoById(gameState.currentSong.youtubeId);
    secondsLeft = CONFIG.PLAYBACK_SECONDS;
    updateTimerDisplay();
    document.getElementById('btn-play').disabled = false;
    selectedGapIndex = null;
    document.getElementById('btn-submit-placement').disabled = true;

    const swapBtn = document.getElementById('btn-swap');
    const me = players.find(p => p.id === myId);
    swapBtn.style.display = (me && me.tokens >= 1) ? '' : 'none';
  }
}

// --- Game over / Sudden death ---
function handleGameOver(payload) {
  players = payload.players || players;
  gameState.phase = 'gameover';
  renderScoreboard();

  document.getElementById('music-section').style.display = 'none';
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  var w = payload.winner;
  var html = '<div class="winner-announcement">🏆 ' + w.name + ' 以 ' + w.score + ' 分獲勝！</div>';
  html += '<div class="final-scoreboard"><h3 style="margin: 1rem 0 0.5rem; color: var(--text-muted);">最終排名</h3><ul class="reveal-result-list">';
  var sorted = players.slice().sort(function(a, b) { return b.score - a.score; });
  for (var i = 0; i < sorted.length; i++) {
    var medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
    html += '<li>' + medal + ' ' + sorted[i].name + ' <span class="result-correct">' + sorted[i].score + ' 分</span></li>';
  }
  html += '</ul></div>';
  document.getElementById('reveal-content').innerHTML = html;
  document.getElementById('btn-next-round').style.display = 'none';
}

function handleSuddenDeath(payload) {
  players = payload.players || players;
  renderScoreboard();
  // Show a brief announcement, then continue
  var names = payload.tiedPlayers.join('、');
  alert('⚡ 延長賽！' + names + ' 同分，繼續比賽直到分出勝負！');
}

// --- Direct score (3 tokens) ---
function directScore() {
  var me = players.find(function(p) { return p.id === myId; });
  if (!me || me.tokens < 3) { alert('籌碼不足（需要 3 個籌碼）'); return; }
  if (gameState.phase !== 'playing') return;

  var song = gameState.currentSong;
  me.tokens -= 3;
  me.score += 1;

  // Insert song into correct position on timeline
  insertIntoTimeline(me.timeline, 0, song); // insertIntoTimeline re-sorts

  stopPlayback();

  broadcastSync({
    type: 'direct_score',
    playerId: myId,
    song: song,
    players: players,
  });
}

function handleDirectScore(payload) {
  players = payload.players || players;
  gameState.phase = 'reveal';

  // Update timeline display
  var currentPlayer = players[gameState.currentPlayerIndex];
  renderTimeline('timeline', currentPlayer.timeline, false);
  renderScoreboard();

  // Show reveal; YouTube only for the hero player
  var amHero = currentPlayer.id === myId;
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  if (amHero) {
    document.getElementById('music-section').style.display = '';
    var mask = document.getElementById('yt-mask');
    if (mask) mask.style.display = 'none';
    document.querySelector('.playback-controls').style.display = 'none';
    isRevealPlayback = true;
    if (ytPlayer && payload.song && payload.song.youtubeId) {
      try { ytPlayer.loadVideoById(payload.song.youtubeId); } catch (e) { /* ignore */ }
    }
  } else {
    document.getElementById('music-section').style.display = 'none';
  }

  var scorer = players.find(function(p) { return p.id === payload.playerId; });
  var html = '<div class="reveal-answer">';
  html += '<div class="answer-song">' + payload.song.artist + ' — ' + payload.song.title + '</div>';
  html += '<div class="answer-detail">' + payload.song.year + ' 年</div>';
  html += '</div>';
  html += '<div style="text-align:center; margin: 1rem 0; color: var(--accent); font-size: 1.1rem;">';
  html += '💰 ' + (scorer ? scorer.name : '???') + ' 花費 3 籌碼直接得分！';
  html += '</div>';

  document.getElementById('reveal-content').innerHTML = html;
  document.getElementById('btn-next-round').style.display = isHost ? '' : 'none';
}

// ============================================================
// E. TIMELINE HELPERS
// ============================================================

// Returns array of gap indices where placing this year would be correct
function getCorrectGapIndices(timeline, year) {
  // Timeline is sorted by year. Gaps are numbered 0..timeline.length
  // Gap i is between timeline[i-1] and timeline[i]
  const correct = [];
  for (let i = 0; i <= timeline.length; i++) {
    const before = i > 0 ? timeline[i - 1].year : -Infinity;
    const after = i < timeline.length ? timeline[i].year : Infinity;
    if (year >= before && year <= after) {
      correct.push(i);
    }
  }
  return correct;
}

function insertIntoTimeline(timeline, gapIndex, song) {
  timeline.splice(gapIndex, 0, { artist: song.artist, title: song.title, year: song.year });
  // Re-sort to maintain order (in case of same year)
  timeline.sort((a, b) => a.year - b.year);
}

function capTokens(player) {
  if (player.tokens > CONFIG.MAX_TOKENS) player.tokens = CONFIG.MAX_TOKENS;
}

function normalizeGuess(str) {
  if (!str) return '';
  // Remove all whitespace, punctuation, special chars; keep alphanumeric + CJK
  // Also normalize full-width to half-width
  var s = str.toLowerCase();
  // Full-width alphanumeric → half-width
  s = s.replace(/[\uff01-\uff5e]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
  });
  // Remove everything except letters, digits, CJK unified ideographs, kana, hangul, bopomofo
  s = s.replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3100-\u312f]/g, '');
  return s;
}

// ============================================================
// F. UI RENDERING
// ============================================================

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');

  // If entering game screen and YT API is ready, ensure player exists
  if (screenId === 'screen-game' && ytReady && !ytPlayer) {
    const vid = gameState.currentSong ? gameState.currentSong.youtubeId : undefined;
    createYTPlayer(vid);
  }
}

function generateQRCode(code) {
  var container = document.getElementById('qr-container');
  if (!container) return;
  var url = window.location.origin + window.location.pathname + '?room=' + code;
  try {
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    // Replace canvas with generated image
    var img = qr.createImgTag(5, 8);
    var qrEl = container.querySelector('.qr-img');
    if (qrEl) qrEl.remove();
    var div = document.createElement('div');
    div.className = 'qr-img';
    div.innerHTML = img;
    // Style the image
    var imgEl = div.querySelector('img');
    if (imgEl) {
      imgEl.style.borderRadius = '8px';
      imgEl.style.filter = 'invert(1) hue-rotate(180deg)';
    }
    container.insertBefore(div, container.firstChild);
  } catch (e) {
    console.warn('QR generation failed:', e);
  }
}

function renderWaitingRoom() {
  const listEl = document.getElementById('player-list');
  listEl.innerHTML = players.map(p =>
    `<div class="player-item">
      <span>${p.name}</span>
      ${p.isHost ? '<span class="host-badge">房主</span>' : ''}
    </div>`
  ).join('');

  document.getElementById('btn-start-game').style.display = isHost && players.length >= 1 ? '' : 'none';
  document.getElementById('host-settings').style.display = isHost ? '' : 'none';
  document.getElementById('waiting-hint').style.display = isHost ? 'none' : '';
}

function renderScoreboard() {
  const el = document.getElementById('scoreboard');
  el.innerHTML = players.map((p, i) =>
    `<div class="score-chip ${i === gameState.currentPlayerIndex ? 'active-player' : ''}">
      <span>${p.name}</span>
      <span class="chip-pts">${p.score}分</span>
      <span class="chip-tokens">${p.tokens}籌碼</span>
    </div>`
  ).join('');
}

function renderTimeline(containerId, timeline, interactive) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  // Gap 0
  if (interactive) {
    container.appendChild(createGapElement(0, false));
  }

  timeline.forEach((card, idx) => {
    // Card
    const cardEl = document.createElement('div');
    cardEl.className = 'timeline-card';
    cardEl.innerHTML = '<div class="card-year">' + card.year + '</div><div class="card-title">' + card.title + '</div><div class="card-artist">' + card.artist + '</div>';
    container.appendChild(cardEl);

    // Gap after card
    if (interactive) {
      container.appendChild(createGapElement(idx + 1, false));
    }
  });

  // If timeline is empty and interactive, show a single gap
  if (timeline.length === 0 && interactive) {
    // Gap 0 already added
  }
}

function createGapElement(gapIndex, isBet) {
  const gap = document.createElement('div');
  gap.className = 'timeline-gap';
  if (!isBet && gapIndex === selectedGapIndex) gap.classList.add('selected');
  if (isBet && gapIndex === betSelectedGapIndex) gap.classList.add('bet-selected');
  gap.textContent = '+';
  gap.addEventListener('click', () => {
    if (isBet) {
      betSelectedGapIndex = gapIndex;
      document.querySelectorAll('#bet-timeline .timeline-gap').forEach(g => g.classList.remove('bet-selected'));
      gap.classList.add('bet-selected');
      const me = players.find(p => p.id === myId);
      document.getElementById('btn-submit-bet').disabled = !(me && me.tokens >= 1);
    } else {
      selectedGapIndex = gapIndex;
      document.querySelectorAll('#timeline .timeline-gap').forEach(g => g.classList.remove('selected'));
      gap.classList.add('selected');
      // Enable submit if music has played
      if (secondsLeft < CONFIG.PLAYBACK_SECONDS) {
        document.getElementById('btn-submit-placement').disabled = false;
      }
    }
  });
  return gap;
}

function renderBettingTimeline(heroTimeline, heroGapIndex) {
  const container = document.getElementById('bet-timeline');
  container.innerHTML = '';

  // Show timeline with all gaps EXCEPT the one the hero chose
  for (let i = 0; i <= heroTimeline.length; i++) {
    if (i !== heroGapIndex) {
      container.appendChild(createGapElement(i, true));
    }

    if (i < heroTimeline.length) {
      const cardEl = document.createElement('div');
      cardEl.className = 'timeline-card';
      cardEl.innerHTML = '<div class="card-year">' + heroTimeline[i].year + '</div><div class="card-title">' + heroTimeline[i].title + '</div><div class="card-artist">' + heroTimeline[i].artist + '</div>';
      container.appendChild(cardEl);
    }
  }
}

// ============================================================
// G. EVENT BINDINGS
// ============================================================
function initEventListeners() {
  // Lobby
  document.getElementById('btn-create-room').addEventListener('click', () => {
    myName = document.getElementById('player-name').value.trim();
    if (!myName) { alert('請輸入暱稱'); return; }
    if (!isGoogleSheetLoaded) { alert('題庫尚未載入完成'); return; }

    myId = generateId();
    isHost = true;
    roomCode = generateRoomCode();

    players = [{
      id: myId,
      name: myName,
      isHost: true,
      score: 0,
      tokens: CONFIG.INITIAL_TOKENS,
      timeline: [],
    }];

    document.getElementById('display-room-code').textContent = roomCode;
    showScreen('screen-waiting');
    generateQRCode(roomCode);
    joinChannel(roomCode);
    renderWaitingRoom();
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    myName = document.getElementById('player-name').value.trim();
    if (!myName) { alert('請輸入暱稱'); return; }
    if (!isGoogleSheetLoaded) { alert('題庫尚未載入完成'); return; }

    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!code) { alert('請輸入房間代碼'); return; }

    myId = generateId();
    isHost = false;
    roomCode = code;

    // Add self to local list (host will send full list)
    players = [{
      id: myId,
      name: myName,
      isHost: false,
      score: 0,
      tokens: CONFIG.INITIAL_TOKENS,
      timeline: [],
    }];

    document.getElementById('display-room-code').textContent = roomCode;
    showScreen('screen-waiting');
    generateQRCode(roomCode);
    joinChannel(roomCode);
    renderWaitingRoom();
  });

  // Waiting room
  document.getElementById('btn-start-game').addEventListener('click', startGame);

  // Game controls
  document.getElementById('btn-play').addEventListener('click', () => {
    if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
      ytPlayer.playVideo();
      document.getElementById('btn-play').disabled = true;
    }
  });

  document.getElementById('btn-submit-placement').addEventListener('click', submitPlacement);
  document.getElementById('btn-submit-bet').addEventListener('click', submitBet);
  document.getElementById('btn-next-round').addEventListener('click', nextRound);
  document.getElementById('btn-swap').addEventListener('click', swapSong);
  document.getElementById('btn-direct-score').addEventListener('click', directScore);

  document.getElementById('btn-replay').addEventListener('click', function() {
    if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
      ytPlayer.seekTo(currentRandomStart, true);
      ytPlayer.playVideo();
      // Restart timer
      secondsLeft = CONFIG.PLAYBACK_SECONDS;
      updateTimerDisplay();
      clearInterval(playbackTimer);
      playbackTimer = setInterval(function() {
        secondsLeft--;
        updateTimerDisplay();
        if (secondsLeft <= 0) {
          clearInterval(playbackTimer);
          if (ytPlayer) ytPlayer.pauseVideo();
        }
      }, 1000);
      document.getElementById('btn-replay').style.display = 'none';
    }
  });
}

// ============================================================
// INIT
// ============================================================
function initApp() {
  initSupabase();
  loadYouTubeAPI();
  loadSongDatabase();
  initEventListeners();

  // Auto-fill room code from URL ?room=XXXXX
  var params = new URLSearchParams(window.location.search);
  var roomParam = params.get('room');
  if (roomParam) {
    document.getElementById('room-code-input').value = roomParam.toUpperCase();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

})(); // end IIFE
