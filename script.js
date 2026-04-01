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

function onPlayerStateChange(event) {
  // When video first starts playing, seek to random segment
  if (event.data === YT.PlayerState.PLAYING && !hasSeekStarted) {
    hasSeekStarted = true;
    try {
      var duration = ytPlayer.getDuration();
      if (duration > CONFIG.PLAYBACK_SECONDS + 10) {
        // Pick a random start between 10% and 70% of the song
        var minStart = Math.floor(duration * 0.1);
        var maxStart = Math.floor(duration * 0.7);
        var randomStart = minStart + Math.floor(Math.random() * (maxStart - minStart));
        ytPlayer.seekTo(randomStart, true);
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
  playbackTimer = setInterval(() => {
    secondsLeft--;
    updateTimerDisplay();
    if (secondsLeft <= 0) {
      clearInterval(playbackTimer);
      if (ytPlayer) ytPlayer.pauseVideo();
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
  var winEl = document.getElementById('win-score-select-waiting');
  winScore = parseInt(winEl ? winEl.value : document.getElementById('win-score-select').value, 10) || 5;
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

  // Restore YT mask for new round
  var mask = document.getElementById('yt-mask');
  if (mask) mask.style.display = '';

  setupTurnUI();
}

function setupTurnUI() {
  const currentPlayer = players[gameState.currentPlayerIndex];
  const amHero = currentPlayer.id === myId;

  document.getElementById('current-turn-label').textContent = `輪到：${currentPlayer.name}`;
  document.getElementById('round-label').textContent = `第 ${gameState.round} 回合`;

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

  // Hero artist/title guesses
  var heroArtistCorrect = normalizeGuess(gameState.heroPlacement.guessArtist) === normalizeGuess(song.artist);
  var heroTitleCorrect = normalizeGuess(gameState.heroPlacement.guessTitle) === normalizeGuess(song.title);
  if (heroArtistCorrect) currentPlayer.tokens += 1;
  if (heroTitleCorrect) currentPlayer.tokens += 1;

  // Insert song into hero's timeline
  insertIntoTimeline(currentPlayer.timeline, gameState.heroPlacement.gapIndex, song);

  // Score bettors — use betOrder for first-submit priority
  var betResults = {};
  var artistTokenClaimed = heroArtistCorrect;  // hero has priority
  var titleTokenClaimed = heroTitleCorrect;     // hero has priority
  var betOrder = gameState.betOrder || Object.keys(gameState.bets);

  for (var b = 0; b < betOrder.length; b++) {
    var pid = betOrder[b];
    var bet = gameState.bets[pid];
    if (!bet) continue;
    var bettor = players.find(function(p) { return p.id === pid; });
    if (!bettor) continue;

    var betPositionCorrect = false;
    var betArtistCorrect = false;
    var betTitleCorrect = false;

    // Position bet: costs 1 token only if they chose a position
    if (bet.gapIndex !== null) {
      bettor.tokens -= 1;
      betPositionCorrect = correctGaps.includes(bet.gapIndex);
      if (betPositionCorrect) {
        bettor.score += 1;
        bettor.tokens += 2; // net +1 profit
      }
    }

    // Artist/title guess: only first correct guesser gets token (hero has priority)
    if (!artistTokenClaimed && normalizeGuess(bet.guessArtist) === normalizeGuess(song.artist)) {
      betArtistCorrect = true;
      bettor.tokens += 1;
      artistTokenClaimed = true;
    }
    if (!titleTokenClaimed && normalizeGuess(bet.guessTitle) === normalizeGuess(song.title)) {
      betTitleCorrect = true;
      bettor.tokens += 1;
      titleTokenClaimed = true;
    }

    betResults[pid] = {
      correct: betPositionCorrect,
      hasBetPosition: bet.gapIndex !== null,
      artistCorrect: betArtistCorrect,
      titleCorrect: betTitleCorrect,
      artistBlocked: !betArtistCorrect && normalizeGuess(bet.guessArtist) === normalizeGuess(song.artist),
      titleBlocked: !betTitleCorrect && normalizeGuess(bet.guessTitle) === normalizeGuess(song.title),
    };
  }

  // Check win condition
  var winner = players.find(function(p) { return p.score >= winScore; });

  broadcastSync({
    type: 'reveal',
    song: song,
    heroCorrect: heroCorrect,
    heroArtistCorrect: heroArtistCorrect,
    heroTitleCorrect: heroTitleCorrect,
    heroPlacement: gameState.heroPlacement,
    betResults: betResults,
    players: players,
    correctGaps: correctGaps,
    winner: winner ? { id: winner.id, name: winner.name, score: winner.score } : null,
  });
}

function handleReveal(payload) {
  gameState.phase = 'reveal';
  players = payload.players;

  // Update timeline display
  var currentPlayer = players[gameState.currentPlayerIndex];
  renderTimeline('timeline', currentPlayer.timeline, false);
  renderScoreboard();

  // Show reveal
  document.getElementById('music-section').style.display = 'none';
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  // Remove YT mask to reveal the video
  var mask = document.getElementById('yt-mask');
  if (mask) mask.style.display = 'none';

  var html = '<div class="reveal-answer">';
  html += '<div class="answer-song">' + payload.song.artist + ' — ' + payload.song.title + '</div>';
  html += '<div class="answer-detail">' + payload.song.year + ' 年</div>';
  html += '</div>';

  html += '<ul class="reveal-result-list">';
  // Hero result
  var hero = players[gameState.currentPlayerIndex];
  var heroBadges = [];
  if (payload.heroCorrect) heroBadges.push('年代正確 +1分');
  if (payload.heroArtistCorrect) heroBadges.push('歌手正確 +1籌碼');
  if (payload.heroTitleCorrect) heroBadges.push('歌名正確 +1籌碼');
  var heroClass = payload.heroCorrect ? 'result-correct' : 'result-wrong';
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
    if (res.artistCorrect) badges.push('歌手正確 +1籌碼 (搶答最快)');
    else if (res.artistBlocked) badges.push('歌手正確 但已被搶答');
    if (res.titleCorrect) badges.push('歌名正確 +1籌碼 (搶答最快)');
    else if (res.titleBlocked) badges.push('歌名正確 但已被搶答');
    var resultClass = (res.correct || res.artistCorrect || res.titleCorrect) ? 'result-correct' : 'result-wrong';
    html += '<li>' + p.name + ' <span class="' + resultClass + '">' + (badges.length ? badges.join(', ') : '未參與') + '</span></li>';
  }
  html += '</ul>';

  // Check for winner
  if (payload.winner) {
    html += '<div class="winner-announcement">🏆 ' + payload.winner.name + ' 達到 ' + payload.winner.score + ' 分，獲勝！</div>';
  }

  document.getElementById('reveal-content').innerHTML = html;

  // Host shows "next round" button (unless game over)
  if (payload.winner) {
    document.getElementById('btn-next-round').style.display = 'none';
  } else {
    document.getElementById('btn-next-round').style.display = isHost ? '' : 'none';
  }
}

// --- Next round ---
function nextRound() {
  if (!isHost) return;
  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % players.length;
  gameState.round += 1;

  const song = drawRandomSong();
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
    players,
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

  // Show reveal
  document.getElementById('music-section').style.display = 'none';
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  // Remove mask
  var mask = document.getElementById('yt-mask');
  if (mask) mask.style.display = 'none';

  var scorer = players.find(function(p) { return p.id === payload.playerId; });
  var html = '<div class="reveal-answer">';
  html += '<div class="answer-song">' + payload.song.artist + ' — ' + payload.song.title + '</div>';
  html += '<div class="answer-detail">' + payload.song.year + ' 年</div>';
  html += '</div>';
  html += '<div style="text-align:center; margin: 1rem 0; color: var(--accent); font-size: 1.1rem;">';
  html += '💰 ' + (scorer ? scorer.name : '???') + ' 花費 3 籌碼直接得分！';
  html += '</div>';

  // Check winner
  var winner = players.find(function(p) { return p.score >= winScore; });
  if (winner) {
    html += '<div class="winner-announcement">🏆 ' + winner.name + ' 達到 ' + winner.score + ' 分，獲勝！</div>';
    document.getElementById('btn-next-round').style.display = 'none';
  } else {
    document.getElementById('btn-next-round').style.display = isHost ? '' : 'none';
  }

  document.getElementById('reveal-content').innerHTML = html;
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

function normalizeGuess(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\s+/g, '').replace(/[^\w\u4e00-\u9fff]/g, '');
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
    cardEl.innerHTML = `<div class="card-year">${card.year}</div><div class="card-artist">${card.artist}</div>`;
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
      cardEl.innerHTML = `<div class="card-year">${heroTimeline[i].year}</div><div class="card-artist">${heroTimeline[i].artist}</div>`;
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
}

// ============================================================
// INIT
// ============================================================
function initApp() {
  initSupabase();
  loadYouTubeAPI();
  loadSongDatabase();
  initEventListeners();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

})(); // end IIFE
