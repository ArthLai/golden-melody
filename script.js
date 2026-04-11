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
  PHASE_SECONDS: 60,
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

// Phase timer
var phaseTimer = null;
var phaseSecondsLeft = 0;
var phaseTimerTotal = 0;

// Game mode: 'music' | 'movie' | 'ad'
var gameMode = 'music';

var MODE_CONFIG = {
  music: {
    title: '金曲猜歌王',
    subtitle: '多人連線猜歌桌遊',
    icon: '🎵',
    useMask: true,
    playFromStart: false,
    guessFields: ['artist', 'title'],
    guessLabels: { artist: '猜歌手', title: '猜歌名' },
    betGuessLabels: { artist: '搶答歌手', title: '搶答歌名' },
    revealFormat: function(song) { return song.artist + ' — ' + song.title; },
    cardDisplay: function(card) {
      return '<div class="card-year">' + card.year + '</div><div class="card-title">' + card.title + '</div><div class="card-artist">' + card.artist + '</div>';
    },
    phaseHero: '📍 選擇時間軸位置放入這首歌',
    phaseSpectator: function(name) { return '🎧 ' + name + ' 正在聽歌...'; },
    guessHint: '聽完歌曲後，點擊時間軸上的「＋」將歌曲插入你認為正確的年代位置。猜對歌手＋歌名可額外獲得 1 籌碼',
    betHint: '點擊「＋」選擇你認為正確的位置（-1 籌碼），再點一次取消',
    betGuessHint: '猜對歌手＋歌名 → 最快答對者 +1 籌碼',
    swapLabel: '🔄 換歌 (-1 籌碼)',
    guessSectionTitle: '🎯 猜年代',
    betSectionTitle: '🎰 下注猜年代',
    maskIcon: '🎵',
    noTokenBetHint: '籌碼不足，無法下注位置（可猜歌手/歌名）',
  },
  movie: {
    title: '電影猜猜王',
    subtitle: '多人連線猜電影桌遊',
    icon: '🎬',
    useMask: false,
    playFromStart: true,
    guessFields: ['title'],
    guessLabels: { title: '猜電影名稱' },
    betGuessLabels: { title: '搶答電影名稱' },
    revealFormat: function(song) { return song.title; },
    cardDisplay: function(card) {
      return '<div class="card-year">' + card.year + '</div><div class="card-title">' + card.title + '</div>';
    },
    phaseHero: '📍 選擇時間軸位置放入這部電影',
    phaseSpectator: function(name) { return '🎬 ' + name + ' 正在看預告片...'; },
    guessHint: '看完預告片後，點擊時間軸上的「＋」將電影插入你認為正確的年代位置。猜對電影名稱可額外獲得 1 籌碼',
    betHint: '點擊「＋」選擇你認為正確的位置（-1 籌碼），再點一次取消',
    betGuessHint: '猜對電影名稱 → 最快答對者 +1 籌碼',
    swapLabel: '🔄 換片 (-1 籌碼)',
    guessSectionTitle: '🎯 猜年代',
    betSectionTitle: '🎰 下注猜年代',
    maskIcon: '🎬',
    noTokenBetHint: '籌碼不足，無法下注位置（可猜電影名稱）',
  },
  ad: {
    title: '廣告猜猜王',
    subtitle: '多人連線猜廣告桌遊',
    icon: '📺',
    useMask: false,
    playFromStart: true,
    guessFields: ['artist', 'title'],
    guessLabels: { artist: '猜品牌', title: '猜商品' },
    betGuessLabels: { artist: '搶答品牌', title: '搶答商品' },
    revealFormat: function(song) { return song.artist + ' — ' + song.title; },
    cardDisplay: function(card) {
      return '<div class="card-year">' + card.year + '</div><div class="card-title">' + card.title + '</div><div class="card-artist">' + card.artist + '</div>';
    },
    phaseHero: '📍 選擇時間軸位置放入這支廣告',
    phaseSpectator: function(name) { return '📺 ' + name + ' 正在看廣告...'; },
    guessHint: '看完廣告後，點擊時間軸上的「＋」將廣告插入你認為正確的年代位置。猜對品牌＋商品可額外獲得 1 籌碼',
    betHint: '點擊「＋」選擇你認為正確的位置（-1 籌碼），再點一次取消',
    betGuessHint: '猜對品牌＋商品 → 最快答對者 +1 籌碼',
    swapLabel: '🔄 換片 (-1 籌碼)',
    guessSectionTitle: '🎯 猜年代',
    betSectionTitle: '🎰 下注猜年代',
    maskIcon: '📺',
    noTokenBetHint: '籌碼不足，無法下注位置（可猜品牌/商品）',
  },
};

function getModeConfig() {
  return MODE_CONFIG[gameMode] || MODE_CONFIG.music;
}

function getRevealBadgeText() {
  if (gameMode === 'movie') {
    return { guessCorrect: '猜片正確', artistRight: null, titleRight: '片名對', artistWrong: null, titleWrong: '片名錯' };
  } else if (gameMode === 'ad') {
    return { guessCorrect: '猜對品牌商品', artistRight: '品牌對', titleRight: '商品對', artistWrong: '品牌錯', titleWrong: '商品錯' };
  }
  return { guessCorrect: '猜歌正確', artistRight: '歌手對', titleRight: '歌名對', artistWrong: '歌手錯', titleWrong: '歌名錯' };
}

function renderModeRules() {
  var mc = getModeConfig();
  var container = document.getElementById('game-rules-container');
  if (!container) return;
  var rules = '';
  if (gameMode === 'music') {
    rules = '<details open><summary>📖 遊戲規則</summary><ul>' +
      '<li>每位玩家輪流聆聽一段隨機歌曲片段（30秒）</li>' +
      '<li>根據歌曲年代，將其放入自己的時間軸正確位置</li>' +
      '<li>放置正確 → <strong>+1 分</strong></li>' +
      '<li>同時猜對歌手＋歌名 → <strong>+1 籌碼</strong>（上限 5 枚）</li>' +
      '<li>其他玩家可下注猜年代位置（-1 籌碼，猜對 +1 分 +2 籌碼）</li>' +
      '<li>技能：🔄 換歌 (-1)、💰 直接得分 (-3)</li>' +
      '<li>率先達到指定分數者獲勝（整輪結束後判定）</li>' +
      '</ul></details>';
  } else if (gameMode === 'movie') {
    rules = '<details open><summary>📖 遊戲規則</summary><ul>' +
      '<li>每位玩家輪流觀看一段電影預告片（30秒）</li>' +
      '<li>根據電影年代，將其放入自己的時間軸正確位置</li>' +
      '<li>放置正確 → <strong>+1 分</strong></li>' +
      '<li>猜對電影名稱 → <strong>+1 籌碼</strong>（上限 5 枚）</li>' +
      '<li>其他玩家可下注猜年代位置（-1 籌碼，猜對 +1 分 +2 籌碼）</li>' +
      '<li>技能：🔄 換片 (-1)、💰 直接得分 (-3)</li>' +
      '<li>率先達到指定分數者獲勝（整輪結束後判定）</li>' +
      '</ul></details>';
  } else if (gameMode === 'ad') {
    rules = '<details open><summary>📖 遊戲規則</summary><ul>' +
      '<li>每位玩家輪流觀看一支廣告影片（30秒）</li>' +
      '<li>根據廣告年代，將其放入自己的時間軸正確位置</li>' +
      '<li>放置正確 → <strong>+1 分</strong></li>' +
      '<li>同時猜對品牌＋商品 → <strong>+1 籌碼</strong>（上限 5 枚）</li>' +
      '<li>其他玩家可下注猜年代位置（-1 籌碼，猜對 +1 分 +2 籌碼）</li>' +
      '<li>技能：🔄 換片 (-1)、💰 直接得分 (-3)</li>' +
      '<li>率先達到指定分數者獲勝（整輪結束後判定）</li>' +
      '</ul></details>';
  }
  container.innerHTML = rules;
}

function applyModeUI() {
  var mc = getModeConfig();
  // Update page title
  document.title = mc.title;
  // Update guess field visibility and placeholders
  var guessArtist = document.getElementById('guess-artist');
  var guessTitle = document.getElementById('guess-title');
  var betGuessArtist = document.getElementById('bet-guess-artist');
  var betGuessTitle = document.getElementById('bet-guess-title');
  if (mc.guessFields.indexOf('artist') === -1) {
    if (guessArtist) guessArtist.style.display = 'none';
    if (betGuessArtist) betGuessArtist.style.display = 'none';
  } else {
    if (guessArtist) { guessArtist.style.display = ''; guessArtist.placeholder = mc.guessLabels.artist + '（選填）...'; }
    if (betGuessArtist) { betGuessArtist.style.display = ''; betGuessArtist.placeholder = mc.betGuessLabels.artist + '（選填）...'; }
  }
  if (guessTitle) guessTitle.placeholder = mc.guessLabels.title + '（選填）...';
  if (betGuessTitle) betGuessTitle.placeholder = mc.betGuessLabels.title + '（選填）...';
  // Apply or remove yt-hide-title class
  var ytContainer = document.getElementById('yt-player-container');
  if (ytContainer) {
    if (!mc.useMask) {
      ytContainer.classList.add('yt-hide-title');
    } else {
      ytContainer.classList.remove('yt-hide-title');
    }
  }
  // Update mask icon
  var maskIcon = document.querySelector('.mask-icon');
  if (maskIcon) maskIcon.textContent = mc.maskIcon;
}

// ============================================================
// A. DATA MODULE — Google Sheet loader
// ============================================================
// NOTE: The Google Sheet may have different tabs for different modes (music/movie/ad).
// For now, all modes load from the same default sheet. The CSV columns stay the same:
// (語言, 歌手/品牌, 歌名/電影名/商品, 年代, YouTube連結).
// The data interpretation changes by mode but the column structure is the same.
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
    var modePool = getModePool();
    statusEl.textContent = '題庫載入完成！共 ' + modePool.length + ' 筆';
    statusEl.className = 'loading-status loaded';
    document.getElementById('btn-create-room').disabled = false;
    document.getElementById('btn-join-room').disabled = false;
  } catch (err) {
    statusEl.textContent = `題庫載入失敗：${err.message}`;
    statusEl.className = 'loading-status error';
    console.error('Sheet load error:', err);
  }
}

// Mode-to-language mapping:
// 語言 column holds: 中文, 粵語, 台語, ... (music), 電影 (movie), 廣告 (ad)
var MODE_LANGUAGES = {
  music: null,    // null = everything EXCEPT movie/ad keywords
  movie: ['電影'],
  ad: ['廣告'],
};
var NON_MUSIC_KEYWORDS = ['電影', '廣告'];

function getModePool() {
  var modeLangs = MODE_LANGUAGES[gameMode];
  if (modeLangs) {
    // Movie/Ad: filter to rows matching these language values
    return songDatabase.filter(function(s) { return modeLangs.includes(s.language); });
  }
  // Music: exclude movie/ad rows
  return songDatabase.filter(function(s) { return !NON_MUSIC_KEYWORDS.includes(s.language); });
}

function populateLanguageSelect() {
  const sel = document.getElementById('lang-select');
  var pool = getModePool();
  var langSet = new Set(pool.map(function(s) { return s.language; }));
  var langs = Array.from(langSet).sort();

  sel.innerHTML = '<option value="全部">全部</option>';
  langs.forEach(function(lang) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    sel.appendChild(opt);
  });

  // Hide language selector if only one category (e.g. movie/ad)
  var langRow = sel.closest('.lobby-card') ? sel.previousElementSibling : null;
  if (langs.length <= 1) {
    sel.style.display = 'none';
    if (langRow && langRow.tagName === 'LABEL') langRow.style.display = 'none';
  } else {
    sel.style.display = '';
    if (langRow && langRow.tagName === 'LABEL') langRow.style.display = '';
  }
}

function getFilteredSongs() {
  var pool = getModePool();
  const lang = document.getElementById('lang-select').value;
  if (lang === '全部') return pool;
  return pool.filter(function(s) { return s.language === lang; });
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
  // Clean up any existing channel first (e.g. from attemptRejoin)
  if (channel) {
    try { supabaseClient.removeChannel(channel); } catch (e) { /* ignore */ }
    channel = null;
  }
  roomCode = code;
  channel = supabaseClient.channel(`room-${code}`, {
    config: { broadcast: { self: true } },
  });

  channel.on('broadcast', { event: 'sync' }, ({ payload }) => {
    handleSyncMessage(payload);
  });

  channel.subscribe((status, err) => {
    if (status === 'SUBSCRIBED') {
      // announce self
      broadcastSync({
        type: 'player_join',
        player: { id: myId, name: myName, isHost },
      });
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.error('Channel subscribe failed:', status, err);
      alert('連線失敗，請重試。(' + status + ')');
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
    case 'game_sync':
      handleGameSync(payload);
      break;
    case 'player_rejoin':
      handlePlayerRejoin(payload);
      break;
    case 'rejoin_state':
      handleRejoinState(payload);
      break;
  }
}

// ============================================================
// C. YOUTUBE PLAYER MODULE
// ============================================================
function loadYouTubeAPI() {
  if (document.querySelector('script[src*="youtube.com/iframe_api"]')) return;
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

// Ensure YT player exists and load reveal video (hero=sound, others=muted)
function ensureYTPlayerForReveal(song, amHero) {
  if (!song || !song.youtubeId) return;
  function loadAndSetVolume() {
    try {
      if (amHero) {
        ytPlayer.unMute();
        ytPlayer.setVolume(100);
      } else {
        ytPlayer.mute();
      }
      ytPlayer.loadVideoById(song.youtubeId);
    } catch (e) { /* ignore */ }
  }
  if (ytPlayer) {
    loadAndSetVolume();
  } else if (typeof YT !== 'undefined' && YT.Player) {
    // Create player for non-hero who didn't have one yet
    ytPlayer = new YT.Player('yt-player', {
      height: '100%',
      width: '100%',
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
      },
      events: {
        onReady: function() {
          loadAndSetVolume();
        },
        onStateChange: onPlayerStateChange,
      },
    });
  }
}

var hasSeekStarted = false;
var isRevealPlayback = false;
var currentRandomStart = 0;  // store the random start position for replay

function onPlayerStateChange(event) {
  // When video first starts playing, seek to random segment (but not during reveal)
  if (event.data === YT.PlayerState.PLAYING && !hasSeekStarted && !isRevealPlayback) {
    hasSeekStarted = true;
    var modeConf = getModeConfig();
    if (modeConf.playFromStart) {
      // Movie/ad mode: play from start, no random seek
      currentRandomStart = 0;
    } else {
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
    }
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

  // Start 60s phase timer for hero placing
  startPhaseTimer(CONFIG.PHASE_SECONDS, function() {
    // Auto-submit: if no gap selected, pick gap 0
    if (selectedGapIndex === null) selectedGapIndex = 0;
    submitPlacement();
  });
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
      var newPlayer = {
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        score: 0,
        tokens: CONFIG.INITIAL_TOKENS,
        timeline: [],
      };

      // If game is already in progress, give them an initial timeline card
      if (gameState.phase !== 'waiting') {
        var pool = getFilteredSongs().filter(function(s) {
          return !gameState.usedSongIds.includes(s.youtubeId);
        });
        if (pool.length > 0) {
          var idx = Math.floor(Math.random() * pool.length);
          var initSong = pool[idx];
          newPlayer.timeline = [{ artist: initSong.artist, title: initSong.title, year: initSong.year }];
          gameState.usedSongIds.push(initSong.youtubeId);
        }
      }

      players.push(newPlayer);
    }
    // Broadcast full list
    broadcastSync({ type: 'player_list', players });

    // If game is in progress, also send game state so late joiner can catch up
    if (gameState.phase !== 'waiting') {
      broadcastSync({
        type: 'game_sync',
        players: players,
        winScore: winScore,
        gameMode: gameMode,
        gameState: {
          phase: gameState.phase,
          currentPlayerIndex: gameState.currentPlayerIndex,
          round: gameState.round,
          currentSong: gameState.currentSong,
          heroPlacement: gameState.heroPlacement,
          usedSongIds: gameState.usedSongIds,
        },
      });
    }
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
    gameMode: gameMode,
    gameState: {
      ...gameState,
      // Only send youtubeId to all; artist/title/year hidden until reveal
      currentSong: { youtubeId: song.youtubeId },
    },
    fullSong: song,
  });
}

function handleGameStart(payload) {
  gameMode = payload.gameMode || 'music';
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
  applyModeUI();
  showScreen('screen-game');
  setupTurnUI();
}

// --- New turn ---
function handleNewTurn(payload) {
  stopPhaseTimer();
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

  // Phase status
  var mc = getModeConfig();
  if (amHero) {
    updatePhaseStatus(mc.phaseHero);
  } else {
    updatePhaseStatus(mc.phaseSpectator(currentPlayer.name));
  }

  // Mode-aware guess section labels and fields
  var guessSectionEl = document.getElementById('guess-section');
  if (guessSectionEl) {
    guessSectionEl.querySelector('h3').textContent = mc.guessSectionTitle;
    guessSectionEl.querySelector('.section-hint').textContent = mc.guessHint;
  }
  var guessArtistEl = document.getElementById('guess-artist');
  var guessTitleEl = document.getElementById('guess-title');
  if (mc.guessFields.indexOf('artist') === -1) {
    if (guessArtistEl) guessArtistEl.style.display = 'none';
  } else {
    if (guessArtistEl) { guessArtistEl.style.display = ''; guessArtistEl.placeholder = mc.guessLabels.artist + '（選填）...'; }
  }
  if (guessTitleEl) guessTitleEl.placeholder = mc.guessLabels.title + '（選填）...';

  // Swap button label
  var swapBtnEl = document.getElementById('btn-swap');
  if (swapBtnEl) swapBtnEl.textContent = mc.swapLabel;

  // Mask and YT title overlay
  var ytContainer = document.getElementById('yt-player-container');
  var mask = document.getElementById('yt-mask');
  if (!mc.useMask) {
    if (mask) mask.style.display = 'none';
    if (ytContainer) ytContainer.classList.add('yt-hide-title');
  } else {
    if (mask) mask.style.display = '';
    if (ytContainer) ytContainer.classList.remove('yt-hide-title');
  }

  // Update mask icon
  var maskIconEl = document.querySelector('.mask-icon');
  if (maskIconEl) maskIconEl.textContent = mc.maskIcon;

  // Always stop phase timer on new turn
  stopPhaseTimer();

  if (amHero) {
    // Hero view
    document.getElementById('timeline-owner-label').textContent = '我的時間軸';
    renderTimeline('timeline', currentPlayer.timeline, true);
    document.getElementById('my-timeline-section').style.display = 'none';
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

    // Load video — explicitly unmute for hero's turn
    hasSeekStarted = false;
    if (gameState.currentSong) {
      if (ytReady && !ytPlayer) {
        createYTPlayer(gameState.currentSong.youtubeId);
      } else if (ytPlayer) {
        try {
          ytPlayer.unMute();
          ytPlayer.setVolume(100);
        } catch (e) { /* ignore */ }
        ytPlayer.cueVideoById(gameState.currentSong.youtubeId);
      }
    }

    selectedGapIndex = null;
  } else {
    // Spectator: show hero's timeline (read-only) while waiting
    document.getElementById('timeline-owner-label').textContent = currentPlayer.name + ' 的時間軸';
    renderTimeline('timeline', currentPlayer.timeline, false);

    // Always show my own timeline
    var me = players.find(function(p) { return p.id === myId; });
    var mySection = document.getElementById('my-timeline-section');
    if (me && mySection) {
      mySection.style.display = '';
      document.getElementById('my-timeline-label').textContent = '我的時間軸';
      renderTimeline('my-timeline', me.timeline, false);
    }

    // Show waiting message
    document.getElementById('guess-section').style.display = 'none';
  }
}

// --- Hero submits placement ---
function submitPlacement() {
  if (selectedGapIndex === null) return;
  stopPhaseTimer();
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
  stopPhaseTimer();

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
    updatePhaseStatus('🎰 其他玩家下注中...');

    // If no other players, auto-reveal immediately
    if (isHost) {
      var nonHeroPlayers = players.filter(function(p, i) { return i !== gameState.currentPlayerIndex; });
      if (nonHeroPlayers.length === 0) {
        setTimeout(function() { triggerReveal(); }, 500);
      }
    }

    // Host: start 60s betting countdown; auto-reveal if timer expires
    if (isHost) {
      startPhaseTimer(CONFIG.PHASE_SECONDS, function() {
        triggerReveal();
      });
    }
  } else {
    // Spectator enters betting mode
    document.getElementById('music-section').style.display = 'none';
    document.getElementById('betting-section').style.display = '';
    document.getElementById('reveal-section').style.display = 'none';
    updatePhaseStatus('🎰 選擇你認為正確的年代位置');

    // Render betting timeline: hero's timeline with hero's chosen gap shown as special marker
    const heroTimeline = currentPlayer.timeline;
    renderBettingTimeline(heroTimeline, payload.placement.gapIndex);

    betSelectedGapIndex = null;
    document.getElementById('btn-submit-bet').disabled = false; // allow skip (no gap selected = skip bet position)
    document.getElementById('bet-guess-artist').value = '';
    document.getElementById('bet-guess-title').value = '';

    // Mode-aware betting section
    var bmc = getModeConfig();
    var bettingSectionEl = document.getElementById('betting-section');
    if (bettingSectionEl) {
      bettingSectionEl.querySelector('h3').textContent = bmc.betSectionTitle;
      var sectionHintEl = bettingSectionEl.querySelector('.section-hint');
      if (sectionHintEl) sectionHintEl.textContent = bmc.betGuessHint;
    }
    var betArtistEl = document.getElementById('bet-guess-artist');
    var betTitleEl = document.getElementById('bet-guess-title');
    if (bmc.guessFields.indexOf('artist') === -1) {
      if (betArtistEl) betArtistEl.style.display = 'none';
    } else {
      if (betArtistEl) { betArtistEl.style.display = ''; betArtistEl.placeholder = bmc.betGuessLabels.artist + '（選填）...'; }
    }
    if (betTitleEl) betTitleEl.placeholder = bmc.betGuessLabels.title + '（選填）...';

    const me = players.find(p => p.id === myId);
    if (me && me.tokens < 1) {
      document.querySelector('.bet-hint').textContent = bmc.noTokenBetHint;
    } else {
      document.querySelector('.bet-hint').textContent = bmc.betHint;
    }

    // Start 60s betting timer; auto-submit when expires
    startPhaseTimer(CONFIG.PHASE_SECONDS, function() {
      var btn = document.getElementById('btn-submit-bet');
      if (btn && !btn.disabled) submitBet();
    });

    // Also render my timeline in spectator view
    var myPlayer = players.find(function(p) { return p.id === myId; });
    var mySection = document.getElementById('my-timeline-section');
    if (myPlayer && mySection) {
      mySection.style.display = '';
      renderTimeline('my-timeline', myPlayer.timeline, false);
    }
  }
}

// --- Betting ---
function submitBet() {
  stopPhaseTimer();
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
  stopPhaseTimer();

  // Update timeline display
  var currentPlayer = players[gameState.currentPlayerIndex];
  renderTimeline('timeline', currentPlayer.timeline, false);
  renderScoreboard();

  // Update my timeline
  var me = players.find(function(p) { return p.id === myId; });
  var mySection = document.getElementById('my-timeline-section');
  if (me && mySection && currentPlayer.id !== myId) {
    mySection.style.display = '';
    renderTimeline('my-timeline', me.timeline, false);
  }

  // Show reveal; YouTube for ALL players (hero with sound, others muted)
  var amHero = currentPlayer.id === myId;
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  // Show YouTube to everyone
  document.getElementById('music-section').style.display = '';
  var mask = document.getElementById('yt-mask');
  if (mask) mask.style.display = 'none';
  document.querySelector('.playback-controls').style.display = 'none';
  isRevealPlayback = true;
  ensureYTPlayerForReveal(payload.song, amHero);

  updatePhaseStatus('📊 結算中');

  var rmc = getModeConfig();
  var rbt = getRevealBadgeText();

  var html = '<div class="reveal-answer reveal-animate">';
  html += '<div class="answer-song">' + rmc.revealFormat(payload.song) + '</div>';
  html += '<div class="answer-detail">' + payload.song.year + ' 年</div>';
  html += '</div>';

  // Show hero's guess if they guessed something
  if (payload.heroPlacement && (payload.heroPlacement.guessArtist || payload.heroPlacement.guessTitle)) {
    var guessA = payload.heroPlacement.guessArtist || '—';
    var guessT = payload.heroPlacement.guessTitle || '—';
    var heroPlayer = players[gameState.currentPlayerIndex];
    var heroGuessText;
    if (rmc.guessFields.indexOf('artist') === -1) {
      heroGuessText = heroPlayer.name + ' 的猜測：' + guessT;
    } else {
      heroGuessText = heroPlayer.name + ' 的猜測：' + guessA + ' — ' + guessT;
    }
    html += '<p style="text-align:center; font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">' + heroGuessText + '</p>';
  }

  html += '<ul class="reveal-result-list">';
  // Hero result
  var hero = players[gameState.currentPlayerIndex];
  var heroBadges = [];
  if (payload.heroCorrect) heroBadges.push('年代正確 +1分');
  if (payload.heroBothCorrect) heroBadges.push(rbt.guessCorrect + ' +1籌碼');
  else {
    if (rbt.artistRight !== null) {
      if (payload.heroArtistCorrect && !payload.heroTitleCorrect) heroBadges.push(rbt.artistRight + '/' + rbt.titleWrong);
      else if (!payload.heroArtistCorrect && payload.heroTitleCorrect) heroBadges.push(rbt.titleRight + '/' + rbt.artistWrong);
    } else {
      if (!payload.heroTitleCorrect && payload.heroPlacement && payload.heroPlacement.guessTitle) heroBadges.push(rbt.titleWrong);
      else if (payload.heroTitleCorrect && !payload.heroBothCorrect) heroBadges.push(rbt.titleRight);
    }
  }
  var heroClass = (payload.heroCorrect || payload.heroBothCorrect) ? 'result-correct' : 'result-wrong';
  html += '<li>' + hero.name + ' <span class="' + heroClass + '">' + (heroBadges.length ? heroBadges.join(', ') : '年代錯誤') + '</span></li>';

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
    if (res.bothCorrect) badges.push(rbt.guessCorrect + ' +1籌碼 (最快搶答)');
    else if (res.blocked) badges.push(rbt.guessCorrect + ' 但已被搶答');
    else {
      if (rbt.artistRight !== null) {
        if (res.artistMatch && !res.titleMatch) badges.push(rbt.artistRight + '/' + rbt.titleWrong);
        else if (!res.artistMatch && res.titleMatch) badges.push(rbt.titleRight + '/' + rbt.artistWrong);
      } else {
        if (!res.titleMatch && (res.titleMatch !== undefined)) { /* no partial badge for single field */ }
        else if (res.titleMatch && !res.bothCorrect) badges.push(rbt.titleRight);
      }
    }
    var resultClass = (res.correct || res.bothCorrect) ? 'result-correct' : 'result-wrong';
    html += '<li>' + p.name + ' <span class="' + resultClass + '">' + (badges.length ? badges.join(', ') : '未參與') + '</span></li>';
  }
  html += '</ul>';

  // Non-host hint
  if (!isHost) {
    html += '<p class="hint" style="text-align:center; margin-top:0.75rem;">等待房主進入下一回合...</p>';
  }

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
  stopPhaseTimer();
  renderScoreboard();

  document.getElementById('music-section').style.display = 'none';
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  updatePhaseStatus('');

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
  document.getElementById('btn-back-lobby').style.display = '';
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
  stopPhaseTimer();

  // Update timeline display
  var currentPlayer = players[gameState.currentPlayerIndex];
  renderTimeline('timeline', currentPlayer.timeline, false);
  renderScoreboard();

  // Show reveal; YouTube for ALL players (hero with sound, others muted)
  var amHero = currentPlayer.id === myId;
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';

  // Show YouTube to everyone
  document.getElementById('music-section').style.display = '';
  var mask = document.getElementById('yt-mask');
  if (mask) mask.style.display = 'none';
  document.querySelector('.playback-controls').style.display = 'none';
  isRevealPlayback = true;
  ensureYTPlayerForReveal(payload.song, amHero);

  updatePhaseStatus('📊 結算中');

  var dmc = getModeConfig();
  var scorer = players.find(function(p) { return p.id === payload.playerId; });
  var html = '<div class="reveal-answer reveal-animate">';
  html += '<div class="answer-song">' + dmc.revealFormat(payload.song) + '</div>';
  html += '<div class="answer-detail">' + payload.song.year + ' 年</div>';
  html += '</div>';
  html += '<div style="text-align:center; margin: 1rem 0; color: var(--accent); font-size: 1.1rem;">';
  html += '💰 ' + (scorer ? scorer.name : '???') + ' 花費 3 籌碼直接得分！';
  html += '</div>';

  // Non-host hint
  if (!isHost) {
    html += '<p class="hint" style="text-align:center; margin-top:0.75rem;">等待房主進入下一回合...</p>';
  }

  document.getElementById('reveal-content').innerHTML = html;
  document.getElementById('btn-next-round').style.display = isHost ? '' : 'none';
}

// --- Late join / Game sync ---
function handleGameSync(payload) {
  // Only process if I'm not the host and I'm still in waiting screen
  if (isHost) return;
  gameMode = payload.gameMode || 'music';
  players = payload.players.map(function(p) {
    return {
      ...p,
      timeline: p.timeline || [],
      score: p.score || 0,
      tokens: p.tokens ?? CONFIG.INITIAL_TOKENS,
    };
  });
  winScore = payload.winScore || 5;
  gameState = {
    ...payload.gameState,
    betOrder: [],
    bets: {},
  };
  applyModeUI();

  // Switch to game screen as a spectator
  showScreen('screen-game');
  var currentPlayer = players[gameState.currentPlayerIndex];
  document.getElementById('current-turn-label').textContent = '輪到：' + currentPlayer.name;
  document.getElementById('round-label').textContent = '第 ' + gameState.round + ' 回合';
  document.getElementById('win-score-label').textContent = '目標 ' + winScore + ' 分';
  renderScoreboard();
  document.getElementById('timeline-owner-label').textContent = currentPlayer.name + ' 的時間軸';
  renderTimeline('timeline', currentPlayer.timeline, false);
  // Hide all control sections until next turn
  document.getElementById('music-section').style.display = 'none';
  document.getElementById('guess-section').style.display = 'none';
  document.getElementById('betting-section').style.display = 'none';
  document.getElementById('reveal-section').style.display = '';
  document.getElementById('reveal-content').innerHTML = '<h3>等待本回合結束...</h3>';
  document.getElementById('btn-next-round').style.display = 'none';
}

// --- Player disconnect handling ---
// Supabase presence doesn't auto-track disconnects, so we handle it
// by keeping disconnected players' data intact but skipping their turn
function isPlayerActive(playerId) {
  // For now, all players are considered active (their data is preserved)
  // Disconnected players simply don't submit; host auto-skips after timeout
  return true;
}

// --- Session persistence for reconnection ---
function saveSession() {
  try {
    localStorage.setItem('gm_session', JSON.stringify({
      myId: myId,
      myName: myName,
      roomCode: roomCode,
      isHost: isHost,
      timestamp: Date.now(),
    }));
  } catch (e) { /* ignore */ }
}

// Update timestamp to keep session alive
function touchSession() {
  try {
    var raw = localStorage.getItem('gm_session');
    if (!raw) return;
    var s = JSON.parse(raw);
    s.timestamp = Date.now();
    localStorage.setItem('gm_session', JSON.stringify(s));
  } catch (e) { /* ignore */ }
}

function clearSession() {
  try { localStorage.removeItem('gm_session'); } catch (e) { /* ignore */ }
}

function getSavedSession() {
  try {
    var raw = localStorage.getItem('gm_session');
    if (!raw) return null;
    var s = JSON.parse(raw);
    // Expire after 2 hours
    if (Date.now() - s.timestamp > 2 * 60 * 60 * 1000) {
      clearSession();
      return null;
    }
    return s;
  } catch (e) { return null; }
}

// Host receives rejoin request and sends full state to that player
function handlePlayerRejoin(payload) {
  if (!isHost) return;
  var rejoinId = payload.playerId;
  var existing = players.find(function(p) { return p.id === rejoinId; });
  if (!existing) return; // unknown player, ignore

  // Check if the rejoining player was originally the host
  var wasHost = existing.isHost || false;

  // Send full game state targeted to this player
  broadcastSync({
    type: 'rejoin_state',
    targetId: rejoinId,
    wasHost: wasHost,
    players: players,
    winScore: winScore,
    gameMode: gameMode,
    gameState: {
      phase: gameState.phase,
      currentPlayerIndex: gameState.currentPlayerIndex,
      round: gameState.round,
      currentSong: gameState.currentSong,
      heroPlacement: gameState.heroPlacement,
      usedSongIds: gameState.usedSongIds,
    },
  });
}

// Rejoining player receives full state
function handleRejoinState(payload) {
  if (payload.targetId !== myId) return; // not for me

  // Restore host status if this player was originally the host
  if (payload.wasHost) {
    isHost = true;
  }

  gameMode = payload.gameMode || 'music';
  players = payload.players.map(function(p) {
    return {
      ...p,
      timeline: p.timeline || [],
      score: p.score || 0,
      tokens: p.tokens ?? CONFIG.INITIAL_TOKENS,
    };
  });
  winScore = payload.winScore || 5;
  gameState = {
    ...payload.gameState,
    betOrder: gameState.betOrder || [],
    bets: gameState.bets || {},
  };
  applyModeUI();

  // Determine if game hasn't started yet
  if (gameState.phase === 'waiting') {
    showScreen('screen-waiting');
    document.getElementById('display-room-code').textContent = roomCode;
    generateQRCode(roomCode);
    renderWaitingRoom();
    return;
  }

  // Switch to game screen
  showScreen('screen-game');
  loadYouTubeAPI(); // ensure YT API is loaded

  var currentPlayer = players[gameState.currentPlayerIndex];
  var amHero = currentPlayer.id === myId;

  document.getElementById('current-turn-label').textContent = '輪到：' + currentPlayer.name;
  document.getElementById('round-label').textContent = '第 ' + gameState.round + ' 回合';
  document.getElementById('win-score-label').textContent = '目標 ' + winScore + ' 分';
  renderScoreboard();

  if (amHero && (gameState.phase === 'playing' || gameState.phase === 'placing')) {
    // It's my turn — restore full hero UI
    setupTurnUI();
  } else if (!amHero && gameState.phase === 'betting' && gameState.heroPlacement) {
    // Betting phase — let me bet
    document.getElementById('timeline-owner-label').textContent = currentPlayer.name + ' 的時間軸';
    renderTimeline('timeline', currentPlayer.timeline, false);
    document.getElementById('music-section').style.display = 'none';
    document.getElementById('guess-section').style.display = 'none';
    document.getElementById('betting-section').style.display = '';
    document.getElementById('reveal-section').style.display = 'none';
    renderBettingTimeline(currentPlayer.timeline, gameState.heroPlacement.gapIndex);

    // Show own timeline
    var me = players.find(function(p) { return p.id === myId; });
    var mySection = document.getElementById('my-timeline-section');
    if (me && mySection) {
      mySection.style.display = '';
      renderTimeline('my-timeline', me.timeline, false);
    }
  } else {
    // Other phases or spectating — show current state and wait
    document.getElementById('timeline-owner-label').textContent = currentPlayer.name + ' 的時間軸';
    renderTimeline('timeline', currentPlayer.timeline, false);

    // Show own timeline
    var me2 = players.find(function(p) { return p.id === myId; });
    var mySection2 = document.getElementById('my-timeline-section');
    if (me2 && mySection2 && !amHero) {
      mySection2.style.display = '';
      renderTimeline('my-timeline', me2.timeline, false);
    }

    document.getElementById('music-section').style.display = 'none';
    document.getElementById('guess-section').style.display = 'none';
    document.getElementById('betting-section').style.display = 'none';
    document.getElementById('reveal-section').style.display = '';
    document.getElementById('reveal-content').innerHTML = '<h3>已重新連線，等待下一回合...</h3>';
    document.getElementById('btn-next-round').style.display = isHost ? '' : 'none';
  }

  saveSession(); // refresh session timestamp
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
// E2. PHASE TIMER
// ============================================================
function startPhaseTimer(seconds, onExpire) {
  stopPhaseTimer();
  phaseSecondsLeft = seconds;
  phaseTimerTotal = seconds;
  var bar = document.getElementById('phase-timer-bar');
  if (bar) bar.style.display = '';
  renderPhaseTimer();

  phaseTimer = setInterval(function() {
    phaseSecondsLeft--;
    renderPhaseTimer();
    if (phaseSecondsLeft <= 0) {
      stopPhaseTimer();
      if (typeof onExpire === 'function') onExpire();
    }
  }, 1000);
}

function stopPhaseTimer() {
  clearInterval(phaseTimer);
  phaseTimer = null;
  var bar = document.getElementById('phase-timer-bar');
  if (bar) bar.style.display = 'none';
}

function renderPhaseTimer() {
  var countEl = document.getElementById('phase-timer-count');
  var fillEl = document.getElementById('phase-timer-fill');
  var bar = document.getElementById('phase-timer-bar');
  if (countEl) countEl.textContent = phaseSecondsLeft + 's';
  if (fillEl) fillEl.style.width = (phaseSecondsLeft / phaseTimerTotal * 100) + '%';
  if (bar) {
    if (phaseSecondsLeft <= 10) {
      bar.classList.add('urgent');
    } else {
      bar.classList.remove('urgent');
    }
  }
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
  el.innerHTML = players.map((p, i) => {
    var classes = 'score-chip';
    if (i === gameState.currentPlayerIndex) classes += ' active-player';
    if (p.id === myId) classes += ' score-chip-me';
    var displayName = (p.id === myId ? '(我) ' : '') + p.name;
    return `<div class="${classes}">
      <span>${displayName}</span>
      <span class="chip-pts">${p.score}分</span>
      <span class="chip-tokens">${p.tokens}籌碼</span>
    </div>`;
  }).join('');
}

function renderTimeline(containerId, timeline, interactive) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  // Gap 0
  if (interactive) {
    container.appendChild(createGapElement(0, false));
  }

  var tlmc = getModeConfig();
  timeline.forEach((card, idx) => {
    // Card
    const cardEl = document.createElement('div');
    cardEl.className = 'timeline-card';
    cardEl.innerHTML = tlmc.cardDisplay(card);
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
  gap.textContent = '\uFF0B';
  gap.title = '點擊插入歌曲到此位置';
  gap.addEventListener('click', () => {
    if (isBet) {
      // Toggle: click same gap again to deselect
      if (betSelectedGapIndex === gapIndex) {
        betSelectedGapIndex = null;
        gap.classList.remove('bet-selected');
      } else {
        betSelectedGapIndex = gapIndex;
        document.querySelectorAll('#bet-timeline .timeline-gap').forEach(g => g.classList.remove('bet-selected'));
        gap.classList.add('bet-selected');
      }
      // Always allow submit (can submit guess-only without position bet)
      document.getElementById('btn-submit-bet').disabled = false;
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

  // Show timeline with all gaps; hero's chosen gap shown as inverted marker
  for (let i = 0; i <= heroTimeline.length; i++) {
    if (i === heroGapIndex) {
      // Show hero's selected gap as a non-clickable inverted marker
      var heroGap = document.createElement('div');
      heroGap.className = 'timeline-gap hero-selected';
      var heroName = players[gameState.currentPlayerIndex] ? players[gameState.currentPlayerIndex].name : '???';
      heroGap.textContent = heroName + '\n已選';
      container.appendChild(heroGap);
    } else {
      container.appendChild(createGapElement(i, true));
    }

    if (i < heroTimeline.length) {
      var btmc = getModeConfig();
      const cardEl = document.createElement('div');
      cardEl.className = 'timeline-card';
      cardEl.innerHTML = btmc.cardDisplay(heroTimeline[i]);
      container.appendChild(cardEl);
    }
  }
}

// ============================================================
// F2. PHASE STATUS HELPER
// ============================================================
function updatePhaseStatus(text) {
  var el = document.getElementById('phase-status');
  if (el) el.textContent = text;
}

// ============================================================
// G. EVENT BINDINGS
// ============================================================
function initEventListeners() {
  // Mode selector
  document.getElementById('mode-select').addEventListener('change', function() {
    gameMode = this.value;
    renderModeRules();
    populateLanguageSelect();
    var mc = getModeConfig();
    document.querySelector('.game-title').textContent = mc.title;
    document.querySelector('.subtitle').textContent = mc.subtitle;
    // Update loading status with mode-filtered count
    if (isGoogleSheetLoaded) {
      var pool = getModePool();
      var statusEl = document.getElementById('loading-status');
      if (statusEl) {
        statusEl.textContent = '題庫載入完成！共 ' + pool.length + ' 筆';
        statusEl.className = 'loading-status loaded';
      }
    }
  });

  // Lobby
  document.getElementById('btn-create-room').addEventListener('click', () => {
    myName = document.getElementById('player-name').value.trim();
    if (!myName) { alert('請輸入暱稱'); return; }
    if (!isGoogleSheetLoaded) { alert('題庫尚未載入完成'); return; }

    // Clear any stale state from previous sessions
    clearSession();
    if (channel) {
      try { supabaseClient.removeChannel(channel); } catch (e) { /* ignore */ }
      channel = null;
    }

    myId = generateId();
    isHost = true;
    roomCode = generateRoomCode();
    gameMode = document.getElementById('mode-select').value;

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
    saveSession();
    renderWaitingRoom();
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    myName = document.getElementById('player-name').value.trim();
    if (!myName) { alert('請輸入暱稱'); return; }
    if (!isGoogleSheetLoaded) { alert('題庫尚未載入完成'); return; }

    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (!code) { alert('請輸入房間代碼'); return; }

    // Clear any stale state from previous sessions
    clearSession();
    if (channel) {
      try { supabaseClient.removeChannel(channel); } catch (e) { /* ignore */ }
      channel = null;
    }

    myId = generateId();
    isHost = false;
    roomCode = code;
    gameMode = document.getElementById('mode-select').value;

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
    saveSession();
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

  // Back to lobby button
  document.getElementById('btn-back-lobby').addEventListener('click', function() {
    clearSession();
    showScreen('screen-lobby');
  });

  // Copy room code button
  document.getElementById('btn-copy-code').addEventListener('click', function() {
    var btn = document.getElementById('btn-copy-code');
    navigator.clipboard.writeText(roomCode).then(function() {
      btn.textContent = '✅ 已複製';
      setTimeout(function() { btn.textContent = '📋 複製代碼'; }, 2000);
    }).catch(function() {
      btn.textContent = '複製失敗';
      setTimeout(function() { btn.textContent = '📋 複製代碼'; }, 2000);
    });
  });

  // Copy invite link button
  document.getElementById('btn-copy-link').addEventListener('click', function() {
    var btn = document.getElementById('btn-copy-link');
    var url = window.location.origin + window.location.pathname + '?room=' + roomCode;
    navigator.clipboard.writeText(url).then(function() {
      btn.textContent = '✅ 已複製';
      setTimeout(function() { btn.textContent = '📋 複製邀請連結'; }, 2000);
    }).catch(function() {
      btn.textContent = '複製失敗';
      setTimeout(function() { btn.textContent = '📋 複製邀請連結'; }, 2000);
    });
  });

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
  renderModeRules();

  // Auto-fill room code from URL ?room=XXXXX
  var params = new URLSearchParams(window.location.search);
  var roomParam = params.get('room');
  if (roomParam) {
    document.getElementById('room-code-input').value = roomParam.toUpperCase();
  }

  // Attempt to rejoin saved session (only pre-fill name, don't auto-connect)
  var saved = getSavedSession();
  if (saved && saved.myName) {
    document.getElementById('player-name').value = saved.myName;
  }
  // Auto-rejoin only if the page was NOT manually navigated to (no fresh load intent)
  // We detect this by checking if there's a ?rejoin param or if the session is very recent (< 30s)
  if (saved && saved.myId && saved.roomCode && (Date.now() - saved.timestamp < 30000)) {
    myId = saved.myId;
    myName = saved.myName;
    roomCode = saved.roomCode;
    isHost = saved.isHost || false;

    document.getElementById('display-room-code').textContent = roomCode;

    // Show reconnecting notice
    var loadingEl = document.getElementById('loading-status');
    if (loadingEl) {
      loadingEl.textContent = '正在重新連線到房間 ' + roomCode + '...';
      loadingEl.style.display = '';
    }

    attemptRejoin();

    // Timeout: if no response in 5 seconds, give up and stay in lobby
    setTimeout(function() {
      var currentScreen = document.querySelector('.screen.active');
      if (currentScreen && currentScreen.id === 'screen-lobby') {
        // Still in lobby — rejoin didn't work, clean up
        if (channel) {
          try { supabaseClient.removeChannel(channel); } catch (e) { /* ignore */ }
          channel = null;
        }
        clearSession();
        myId = '';
        roomCode = '';
        var el = document.getElementById('loading-status');
        if (el && el.textContent.indexOf('重新連線') >= 0) {
          if (isGoogleSheetLoaded) {
            el.textContent = '題庫載入完成！共 ' + getModePool().length + ' 筆';
            el.className = 'loading-status loaded';
          } else {
            el.textContent = '正在載入題庫...';
            el.className = 'loading-status';
          }
        }
      }
    }, 5000);
  }

  // Detect app resume (mobile tab switch / screen lock)
  // Only reconnect if we're actually in a game screen (not lobby)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible') return;
    var activeScreen = document.querySelector('.screen.active');
    if (!activeScreen || activeScreen.id === 'screen-lobby') return;
    if (!roomCode || !myId) return;
    touchSession();
    // Check if channel is disconnected
    if (!channel) {
      attemptRejoin();
    }
  });
}

function attemptRejoin() {
  // Clean up old channel if exists
  if (channel) {
    try { supabaseClient.removeChannel(channel); } catch (e) { /* ignore */ }
    channel = null;
  }

  channel = supabaseClient.channel('room-' + roomCode, {
    config: { broadcast: { self: true } },
  });
  channel.on('broadcast', { event: 'sync' }, function(msg) {
    handleSyncMessage(msg.payload);
  });
  channel.subscribe(function(status) {
    if (status === 'SUBSCRIBED') {
      broadcastSync({
        type: 'player_rejoin',
        playerId: myId,
        playerName: myName,
      });

      // Hide reconnecting notice
      var loadingEl = document.getElementById('loading-status');
      if (loadingEl && loadingEl.textContent.indexOf('重新連線') >= 0) {
        loadingEl.textContent = '已重新連線！';
        setTimeout(function() { loadingEl.style.display = 'none'; }, 1500);
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

})(); // end IIFE
