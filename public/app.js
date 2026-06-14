// ============================================================
// 💕 我们的距离 - 核心逻辑
// ============================================================

// 配置
const CONFIG = {
  // !! 重要 !! 去 https://lbs.amap.com/ 注册免费获取
  // 创建一个"Web端(JS API)"应用，拿到 Key 和 安全密钥
  amapKey: 'YOUR_AMAP_KEY',
  amapSecret: 'YOUR_AMAP_SECRET',

  wsUrl: (() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  })(),

  // 位置更新间隔（毫秒）
  locationInterval: 10000,
};

// ===== 状态 =====
let ws = null;
let amap = null;
let myMarker = null;
let taMarker = null;
let heartLine = null;
let myLat = null;
let myLng = null;
let taLat = null;
let taLng = null;
let watchId = null;
let myName = '';
let myEmoji = '💙';
let roomCode = '';
let isConnected = false;
let taConnected = false;
let taName = 'TA';
let taEmoji = '💜';
let locationIntervalId = null;

// ===== 配对页 =====
function selectEmoji(el) {
  document.querySelectorAll('.emoji-option').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  myEmoji = el.dataset.emoji;
}

document.querySelectorAll('.emoji-option').forEach(el => {
  el.addEventListener('click', () => selectEmoji(el));
});

document.getElementById('nickname-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
document.getElementById('room-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
  myName = document.getElementById('nickname-input').value.trim() || '我';
  roomCode = document.getElementById('room-input').value.trim();

  if (!roomCode) {
    document.getElementById('room-input').style.borderColor = '#F87171';
    document.getElementById('room-input').focus();
    setTimeout(() => {
      document.getElementById('room-input').style.borderColor = 'transparent';
    }, 1500);
    return;
  }

  document.getElementById('pairing-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'flex';
  document.getElementById('my-name').textContent = myName;
  document.getElementById('my-avatar').textContent = myEmoji;
  document.getElementById('room-display').textContent = `🏠 ${roomCode}`;

  initApp();
}

function disconnect() {
  if (ws) ws.close();
  if (watchId) navigator.geolocation.clearWatch(watchId);
  if (locationIntervalId) clearInterval(locationIntervalId);
  document.getElementById('main-screen').style.display = 'none';
  document.getElementById('pairing-screen').style.display = 'flex';
}

// ===== 初始化 =====
async function initApp() {
  // 1. 连接 WebSocket
  connectWebSocket();

  // 2. 初始化高德地图
  await initMap();

  // 3. 开始获取位置
  startLocationTracking();

  // 4. 定期发送位置（兜底）
  locationIntervalId = setInterval(() => {
    if (myLat && myLng && ws && ws.readyState === WebSocket.OPEN) {
      sendLocation();
    }
  }, CONFIG.locationInterval);
}

// ===== WebSocket =====
function connectWebSocket() {
  ws = new WebSocket(CONFIG.wsUrl);

  ws.onopen = () => {
    setStatus('connected', '已连接');
    ws.send(JSON.stringify({
      type: 'join',
      room: roomCode,
      name: myName,
      emoji: myEmoji
    }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    setStatus('disconnected', '连接断开，10秒后重连...');
    taConnected = false;
    updateTAStatus();
    setTimeout(connectWebSocket, 10000);
  };

  ws.onerror = () => {
    setStatus('disconnected', '连接异常');
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'room-info':
      // 房间已有用户信息
      msg.peers.forEach(p => {
        if (p.name !== myName) {
          taName = p.name;
          taEmoji = p.emoji || '💜';
          if (p.lat && p.lng) {
            taLat = p.lat;
            taLng = p.lng;
          }
          updateTACard();
          if (p.lat && p.lng) {
            updateMap();
            fetchWeather(p.lat, p.lng, 'ta');
            reverseGeocode(p.lat, p.lng, 'ta');
          }
        }
      });
      break;

    case 'peer-joined':
      taName = msg.name;
      taEmoji = msg.emoji || '💜';
      taConnected = true;
      updateTACard();
      updateTAStatus();
      updateStatusMsg('❤️ ' + taName + ' 已加入');
      break;

    case 'peer-location':
      taLat = msg.lat;
      taLng = msg.lng;
      taName = msg.name;
      taEmoji = msg.emoji || '💜';
      taConnected = true;
      updateTACard();
      updateTAStatus();
      updateMap();
      updateDistance();
      fetchWeather(msg.lat, msg.lng, 'ta');
      reverseGeocode(msg.lat, msg.lng, 'ta');
      break;

    case 'peer-left':
      taConnected = false;
      taLat = null;
      taLng = null;
      updateTACard();
      updateTAStatus();
      updateMap();
      updateDistance();
      updateStatusMsg('💔 ' + msg.name + ' 已离开');
      break;
  }
}

function sendLocation() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'location',
      room: roomCode,
      lat: myLat,
      lng: myLng,
      name: myName,
      emoji: myEmoji
    }));
    document.getElementById('last-update').textContent = '刚刚更新';
  }
}

// ===== 高德地图 =====
async function initMap() {
  return new Promise((resolve) => {
    // 如果高德地图 API 还未加载，等一会
    const checkAMap = () => {
      if (typeof AMap !== 'undefined') {
        createMap();
        resolve();
      } else {
        setTimeout(checkAMap, 500);
      }
    };

    const createMap = () => {
      try {
        // 尝试用安全密钥方式加载
        if (CONFIG.amapKey && CONFIG.amapKey !== 'YOUR_AMAP_KEY') {
          window._AMapSecurityConfig = {
            securityJsCode: CONFIG.amapSecret,
          };
        }

        amap = new AMap.Map('map-container', {
          zoom: 5,
          center: [104.0, 35.0], // 中国中心
          mapStyle: 'amap://styles/light',
          resizeEnable: true,
          showIndoorMap: false,
          features: ['bg', 'road', 'building', 'point']
        });

        // 地图加载完成
        amap.on('complete', () => {
          if (myLat && myLng) {
            updateMap();
          }
          resolve();
        });

      } catch (e) {
        console.error('地图初始化失败:', e);
        document.getElementById('map-container').innerHTML =
          '<div style="padding:40px;text-align:center;color:#999;">' +
          '地图加载失败<br><small>请确保已配置高德地图 API Key</small></div>';
        resolve();
      }
    };

    if (typeof AMap !== 'undefined') {
      createMap();
    } else {
      checkAMap();
    }
  });
}

function updateMap() {
  if (!amap) return;

  // 清除旧标记
  if (myMarker) myMarker.setMap(null);
  if (taMarker) taMarker.setMap(null);
  if (heartLine) heartLine.setMap(null);

  const markers = [];
  const positions = [];

  if (myLat && myLng) {
    myMarker = new AMap.Marker({
      position: [myLng, myLat],
      content: `<div style="
        display:flex;align-items:center;justify-content:center;
        width:42px;height:42px;border-radius:50%;
        background:linear-gradient(135deg,#FF6B8A,#FF8E53);
        box-shadow:0 3px 12px rgba(255,107,138,0.5);
        font-size:20px;border:3px solid white;
      ">${myEmoji}</div>`,
      offset: new AMap.Pixel(-21, -21),
      zIndex: 100,
    });
    myMarker.setMap(amap);
    markers.push(myMarker);
    positions.push([myLng, myLat]);
  }

  if (taLat && taLng) {
    taMarker = new AMap.Marker({
      position: [taLng, taLat],
      content: `<div style="
        display:flex;align-items:center;justify-content:center;
        width:42px;height:42px;border-radius:50%;
        background:linear-gradient(135deg,#667eea,#764ba2);
        box-shadow:0 3px 12px rgba(102,126,234,0.5);
        font-size:20px;border:3px solid white;
      ">${taEmoji}</div>`,
      offset: new AMap.Pixel(-21, -21),
      zIndex: 100,
    });
    taMarker.setMap(amap);
    markers.push(taMarker);
    positions.push([taLng, taLat]);
  }

  // 画连线
  if (positions.length === 2) {
    heartLine = new AMap.Polyline({
      path: positions,
      strokeColor: '#FF6B8A',
      strokeWeight: 3,
      strokeOpacity: 0.6,
      strokeStyle: 'dashed',
      strokeDasharray: [10, 10],
      showDir: false,
    });
    heartLine.setMap(amap);

    // 在连线上加爱心
    const midLng = (positions[0][0] + positions[1][0]) / 2;
    const midLat = (positions[0][1] + positions[1][1]) / 2;

    const heartMarker = new AMap.Marker({
      position: [midLng, midLat],
      content: `<div style="
        font-size:28px;animation:pulse 2s infinite;
        text-shadow:0 2px 8px rgba(255,107,138,0.4);
      ">💕</div>`,
      offset: new AMap.Pixel(-16, -16),
      zIndex: 200,
    });
    heartMarker.setMap(amap);

    // 自适应视野
    amap.setFitView(markers.concat([heartMarker]), false, [60, 60, 60, 60]);
  } else if (positions.length === 1) {
    amap.setZoom(12);
    amap.setCenter(positions[0]);
  }
}

// ===== 位置追踪 =====
function startLocationTracking() {
  if (!navigator.geolocation) {
    updateMyLocation('❌ 设备不支持定位');
    return;
  }

  document.getElementById('loading-overlay').style.display = 'flex';

  // 先获取一次
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById('loading-overlay').style.display = 'none';
      handlePosition(pos);
    },
    (err) => {
      document.getElementById('loading-overlay').style.display = 'none';
      console.error('定位失败:', err);
      updateMyLocation('⚠️ 请开启定位权限');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );

  // 持续追踪（高德地图模式下使用 watchPosition）
  if ('watchPosition' in navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      handlePosition,
      (err) => console.error('位置追踪失败:', err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }
}

function handlePosition(pos) {
  const newLat = pos.coords.latitude;
  const newLng = pos.coords.longitude;

  // 显著变化才更新（减少地图闪烁）
  const changed = !myLat || !myLng ||
    Math.abs(newLat - myLat) > 0.001 ||
    Math.abs(newLng - myLng) > 0.001;

  myLat = newLat;
  myLng = newLng;

  updateMyCard();
  updateMap();
  updateDistance();
  sendLocation();

  fetchWeather(myLat, myLng, 'me');
  reverseGeocode(myLat, myLng, 'me');
}

function forceUpdateLocation() {
  document.getElementById('loading-overlay').style.display = 'flex';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      document.getElementById('loading-overlay').style.display = 'none';
      handlePosition(pos);
    },
    () => {
      document.getElementById('loading-overlay').style.display = 'none';
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ===== 天气 =====
async function fetchWeather(lat, lng, who) {
  const el = who === 'me' ? 'my-weather' : 'ta-weather';
  const container = document.getElementById(el);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.current) {
      const temp = Math.round(data.current.temperature_2m);
      const feels = Math.round(data.current.apparent_temperature);
      const humidity = data.current.relative_humidity_2m;
      const wind = data.current.wind_speed_10m;
      const weatherCode = data.current.weather_code;
      const emoji = getWeatherEmoji(weatherCode);
      const desc = getWeatherDesc(weatherCode);

      container.innerHTML = `
        <span style="font-size:18px">${emoji}</span>
        <span style="font-weight:600;font-size:16px">${temp}°</span>
        <span style="color:var(--text-secondary);font-size:12px">${desc}</span>
        <span style="color:var(--text-muted);font-size:11px">💧${humidity}%</span>
      `;
    }
  } catch (e) {
    console.error('天气获取失败:', e);
    container.innerHTML = `<span class="weather-loading">☁️</span>`;
  }
}

function getWeatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 3) return '🌤️';
  if (code <= 20) return '🌦️';
  if (code <= 30) return '⛈️';
  if (code <= 50) return '🌨️';
  if (code <= 60) return '🌧️';
  if (code <= 70) return '❄️';
  if (code <= 80) return '🌦️';
  if (code <= 99) return '⛈️';
  return '☁️';
}

function getWeatherDesc(code) {
  if (code === 0) return '晴';
  if (code <= 3) return '多云';
  if (code <= 20) return '阴';
  if (code <= 30) return '雷暴';
  if (code <= 50) return '雨夹雪';
  if (code <= 60) return '小雨';
  if (code <= 70) return '中雨';
  if (code <= 80) return '大雨';
  if (code <= 99) return '暴雨';
  return '未知';
}

// ===== 逆地理编码（获取地址名称）=====
async function reverseGeocode(lat, lng, who) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&accept-language=zh`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'LoveMap/1.0' }
    });
    const data = await resp.json();

    let locationName = '未知位置';
    if (data.address) {
      const addr = data.address;
      locationName = addr.city || addr.town || addr.county || addr.state || addr.country || '未知位置';
      // 简写：如果包含市，去掉市字前面的部分保留市级
      if (addr.city && addr.state) {
        locationName = `${addr.city}, ${addr.state}`;
      }
    }

    if (who === 'me') {
      updateMyLocation(locationName);
    } else {
      updateTALocation(locationName);
    }
  } catch (e) {
    console.error('逆地理编码失败:', e);
    const fallback = `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
    if (who === 'me') updateMyLocation(fallback);
    else updateTALocation(fallback);
  }
}

// ===== 距离计算（Haversine）=====
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function updateDistance() {
  const el = document.getElementById('distance-value');
  if (myLat && myLng && taLat && taLng) {
    const dist = calculateDistance(myLat, myLng, taLat, taLng);
    if (dist < 1) {
      el.textContent = (dist * 1000).toFixed(0);
      document.querySelector('.distance-unit').textContent = 'm';
    } else {
      el.textContent = dist.toFixed(1);
      document.querySelector('.distance-unit').textContent = 'km';
    }
  } else {
    el.textContent = '--';
  }
}

// ===== UI 更新 =====
function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  dot.className = 'status-dot ' + state;
  txt.textContent = text;
  isConnected = state === 'connected';
}

function updateMyCard() {
  document.getElementById('my-name').textContent = myName;
  document.getElementById('my-avatar').textContent = myEmoji;
}

function updateMyLocation(loc) {
  document.getElementById('my-location').textContent = '📍 ' + loc;
}

function updateTACard() {
  document.getElementById('ta-name').textContent = taName;
  document.getElementById('ta-avatar').textContent = taEmoji;
  const card = document.querySelector('.user-card.ta');
  if (taConnected) {
    card.classList.remove('waiting');
  } else {
    card.classList.add('waiting');
  }
}

function updateTALocation(loc) {
  document.getElementById('ta-location').textContent = '📍 ' + loc;
}

function updateTAStatus() {
  const loc = document.getElementById('ta-location');
  if (taConnected && taLat && taLng) {
    // 已由 reverseGeocode 更新
  } else if (taConnected) {
    loc.textContent = '⏳ 等待TA分享位置...';
  } else {
    loc.textContent = '💤 等待TA连接...';
    const weather = document.getElementById('ta-weather');
    weather.innerHTML = '<span class="weather-loading">☁️ 等待中...</span>';
  }
}

function updateStatusMsg(msg) {
  const txt = document.getElementById('status-text');
  txt.textContent = msg;
  setTimeout(() => {
    if (isConnected) {
      txt.textContent = '已连接';
    }
  }, 3000);
}

// ===== 高德地图加载备用方案 =====
// 如果页面上的script没加载好，这里兜底
if (typeof AMap === 'undefined' && CONFIG.amapKey !== 'YOUR_AMAP_KEY') {
  const script = document.createElement('script');
  script.src = `https://webapi.amap.com/maps?v=2.0&key=${CONFIG.amapKey}`;
  document.head.appendChild(script);
}
// ============================================================
// 💕 我们的距离 - 核心逻辑
// ============================================================

// ---- 配置 ----
// 想用高德地图？去 https://lbs.amap.com/ 免费注册
// 创建一个"Web端 JS API"应用，拿到 Key
// 然后设置下面 AMapKey 即可自动切换
// 默认使用 Leaflet + OpenStreetMap，无需任何 Key，开箱即用
const CONFIG = {
  AMapKey: '', // 留空用 Leaflet，填 Key 后自动切换高德地图
  wsUrl: (() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  })(),
  locationInterval: 10000, // 位置上报间隔（毫秒）
};

// ===== 状态 =====
let ws = null;
let map = null;
let myMarker = null;
let taMarker = null;
let midMarker = null;
let heartLine = null;
let myLat = null;
let myLng = null;
let taLat = null;
let taLng = null;
let watchId = null;
let myName = '';
let myEmoji = '💙';
let roomCode = '';
let isConnected = false;
let taConnected = false;
let taName = 'TA';
let taEmoji = '💜';
let locationIntervalId = null;
let useAMap = false;

// ===== 配对页 =====
function selectEmoji(el) {
  document.querySelectorAll('.emoji-option').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  myEmoji = el.dataset.emoji;
}

document.querySelectorAll('.emoji-option').forEach(el => {
  el.addEventListener('click', () => selectEmoji(el));
});

document.getElementById('nickname-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
document.getElementById('room-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
  myName = document.getElementById('nickname-input').value.trim() || '我';
  roomCode = document.getElementById('room-input').value.trim();

  if (!roomCode) {
    const input = document.getElementById('room-input');
    input.parentElement.style.borderColor = '#F87171';
    input.focus();
    setTimeout(() => {
      input.parentElement.style.borderColor = 'transparent';
    }, 1500);
    return;
  }

  document.getElementById('pairing-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'flex';
  document.getElementById('my-name').textContent = myName;
  document.getElementById('my-avatar').textContent = myEmoji;
  document.getElementById('room-display').textContent = `🏠 ${roomCode}`;

  initApp();
}

function disconnect() {
  if (ws) { ws.close(); ws = null; }
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (locationIntervalId) { clearInterval(locationIntervalId); locationIntervalId = null; }
  document.getElementById('main-screen').style.display = 'none';
  document.getElementById('pairing-screen').style.display = 'flex';
}

// ===== 初始化 =====
async function initApp() {
  // 1. 初始化地图
  await initMap();

  // 2. 连接 WebSocket
  connectWebSocket();

  // 3. 开始获取位置
  startLocationTracking();

  // 4. 定期发送位置（兜底，防止 watchPosition 不够可靠）
  locationIntervalId = setInterval(() => {
    if (myLat !== null && myLng !== null && ws && ws.readyState === WebSocket.OPEN) {
      sendLocation();
    }
  }, CONFIG.locationInterval);
}

// ===== WebSocket =====
function connectWebSocket() {
  try {
    ws = new WebSocket(CONFIG.wsUrl);
  } catch (e) {
    setStatus('disconnected', '连接失败');
    return;
  }

  ws.onopen = () => {
    setStatus('connected', '已连接');
    ws.send(JSON.stringify({
      type: 'join',
      room: roomCode,
      name: myName,
      emoji: myEmoji
    }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('消息解析失败:', e);
    }
  };

  ws.onclose = () => {
    setStatus('disconnected', '连接断开，10秒后重连...');
    taConnected = false;
    updateTAStatus();
    setTimeout(connectWebSocket, 10000);
  };

  ws.onerror = () => {
    setStatus('disconnected', '连接异常，10秒后重试...');
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'room-info':
      msg.peers.forEach(p => {
        if (p.name !== myName) {
          taName = p.name;
          taEmoji = p.emoji || '💜';
          taConnected = true;
          if (p.lat !== null && p.lng !== null) {
            taLat = p.lat;
            taLng = p.lng;
          }
          updateTACard();
          updateTAStatus();
          updateMap();
          updateDistance();
          if (taLat !== null && taLng !== null) {
            fetchWeather(taLat, taLng, 'ta');
            reverseGeocode(taLat, taLng, 'ta');
          }
        }
      });
      break;

    case 'peer-joined':
      taName = msg.name;
      taEmoji = msg.emoji || '💜';
      taConnected = true;
      updateTACard();
      updateTAStatus();
      updateStatusMsg('❤️ ' + taName + ' 已加入');
      break;

    case 'peer-location':
      taLat = msg.lat;
      taLng = msg.lng;
      taName = msg.name;
      taEmoji = msg.emoji || '💜';
      taConnected = true;
      updateTACard();
      updateTAStatus();
      updateMap();
      updateDistance();
      if (taLat !== null && taLng !== null) {
        fetchWeather(taLat, taLng, 'ta');
        reverseGeocode(taLat, taLng, 'ta');
      }
      break;

    case 'peer-left':
      taConnected = false;
      taLat = null;
      taLng = null;
      updateTACard();
      updateTAStatus();
      updateMap();
      updateDistance();
      updateStatusMsg('💔 ' + msg.name + ' 已离开');
      break;
  }
}

function sendLocation() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'location',
      room: roomCode,
      lat: myLat,
      lng: myLng,
      name: myName,
      emoji: myEmoji
    }));
  }
}

// ===== 地图（Leaflet + OpenStreetMap，开箱即用）=====
// 如果想切换为高德地图，配置 CONFIG.AMapKey 后
// 将下方 L.map 替换为高德地图初始化代码即可

async function initMap() {
  return new Promise((resolve) => {
    const container = document.getElementById('map-container');

    // 创建 Leaflet 地图
    map = L.map(container, {
      center: [35.0, 104.0],
      zoom: 5,
      zoomControl: false,
      attributionControl: false,
    });

    // OpenStreetMap 图层
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'map-tiles',
    }).addTo(map);

    // 中文地图风格 - 改用 OpenStreetMap 的中文友好样式
    L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
      maxZoom: 18,
    }).addTo(map);

    setTimeout(() => {
      map.invalidateSize();
      resolve();
    }, 100);
  });
}

function updateMap() {
  if (!map) return;

  // 清除旧的标记和线条
  if (myMarker) { map.removeLayer(myMarker); myMarker = null; }
  if (taMarker) { map.removeLayer(taMarker); taMarker = null; }
  if (midMarker) { map.removeLayer(midMarker); midMarker = null; }
  if (heartLine) { map.removeLayer(heartLine); heartLine = null; }

  const markers = [];
  const positions = [];

  // 我的位置标记
  if (myLat !== null && myLng !== null) {
    const myIcon = L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        display:flex;align-items:center;justify-content:center;
        width:44px;height:44px;border-radius:50%;
        background:linear-gradient(135deg,#FF6B8A,#FF8E53);
        box-shadow:0 3px 12px rgba(255,107,138,0.5);
        font-size:20px;border:3px solid white;
        transform:translate(-50%,-50%);
      ">${myEmoji}</div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
    myMarker = L.marker([myLat, myLng], { icon: myIcon, zIndexOffset: 100 }).addTo(map);
    markers.push(myMarker);
    positions.push([myLat, myLng]);
  }

  // TA 的位置标记
  if (taLat !== null && taLng !== null) {
    const taIcon = L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        display:flex;align-items:center;justify-content:center;
        width:44px;height:44px;border-radius:50%;
        background:linear-gradient(135deg,#667eea,#764ba2);
        box-shadow:0 3px 12px rgba(102,126,234,0.5);
        font-size:20px;border:3px solid white;
        transform:translate(-50%,-50%);
      ">${taEmoji}</div>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
    taMarker = L.marker([taLat, taLng], { icon: taIcon, zIndexOffset: 100 }).addTo(map);
    markers.push(taMarker);
    positions.push([taLat, taLng]);
  }

  // 画连接线和爱心标
  if (positions.length === 2) {
    heartLine = L.polyline(positions, {
      color: '#FF6B8A',
      weight: 3,
      opacity: 0.5,
      dashArray: '10, 10',
    }).addTo(map);

    const midLat = (positions[0][0] + positions[1][0]) / 2;
    const midLng = (positions[0][1] + positions[1][1]) / 2;

    const midIcon = L.divIcon({
      className: 'mid-heart',
      html: `<div style="
        font-size:30px;
        text-shadow:0 2px 8px rgba(255,107,138,0.4);
        transform:translate(-50%,-50%);
      ">💕</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    midMarker = L.marker([midLat, midLng], { icon: midIcon, zIndexOffset: 200 }).addTo(map);
    markers.push(midMarker);

    // 自适应缩放
    const group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.3));
  } else if (positions.length === 1) {
    map.setView(positions[0], 12);
  }
}

// ===== 位置追踪 =====
function startLocationTracking() {
  if (!navigator.geolocation) {
    updateMyLocation('❌ 设备不支持定位');
    return;
  }

  const overlay = document.getElementById('loading-overlay');
  overlay.style.display = 'flex';

  // 先获取一次
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      overlay.style.display = 'none';
      handlePosition(pos);
    },
    (err) => {
      overlay.style.display = 'none';
      console.error('定位失败:', err);
      if (err.code === 1) {
        updateMyLocation('⚠️ 请在浏览器中允许位置权限');
      } else if (err.code === 2) {
        updateMyLocation('⚠️ 位置不可用，请检查GPS');
      } else {
        updateMyLocation('⚠️ 定位超时，请重试');
      }
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 3000 }
  );

  // 持续追踪
  watchId = navigator.geolocation.watchPosition(
    handlePosition,
    (err) => console.error('位置追踪失败:', err),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
}

function handlePosition(pos) {
  const newLat = pos.coords.latitude;
  const newLng = pos.coords.longitude;

  // 小幅变化跳过更新（减少闪烁）
  if (myLat !== null && myLng !== null) {
    const dLat = Math.abs(newLat - myLat);
    const dLng = Math.abs(newLng - myLng);
    if (dLat < 0.0005 && dLng < 0.0005) return;
  }

  myLat = newLat;
  myLng = newLng;

  updateMyCard();
  updateMap();
  updateDistance();
  sendLocation();
  document.getElementById('last-update').textContent = '刚刚更新';

  fetchWeather(myLat, myLng, 'me');
  reverseGeocode(myLat, myLng, 'me');
}

function forceUpdateLocation() {
  const overlay = document.getElementById('loading-overlay');
  overlay.style.display = 'flex';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      overlay.style.display = 'none';
      handlePosition(pos);
    },
    () => { overlay.style.display = 'none'; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ===== 天气（Open-Meteo API，免费，无需 Key）=====
async function fetchWeather(lat, lng, who) {
  const el = document.getElementById(who === 'me' ? 'my-weather' : 'ta-weather');
  if (!el) return;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('天气API响应异常');
    const data = await resp.json();

    if (data && data.current) {
      const c = data.current;
      const emoji = getWeatherEmoji(c.weather_code);
      const desc = getWeatherDesc(c.weather_code);
      el.innerHTML = `
        <span style="font-size:18px;line-height:1">${emoji}</span>
        <span style="font-weight:600;font-size:16px;margin-left:2px">${Math.round(c.temperature_2m)}°</span>
        <span style="color:var(--text-secondary);font-size:11px;margin-left:4px">${desc}</span>
        <span style="color:var(--text-muted);font-size:10px;margin-left:4px">💧${c.relative_humidity_2m}%</span>
      `;
    }
  } catch (e) {
    console.error('天气获取失败:', e);
  }
}

function getWeatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 20) return '☁️';
  if (code <= 30) return '⛈️';
  if (code <= 50) return '🌦️';
  if (code <= 60) return '🌧️';
  if (code <= 70) return '🌨️';
  if (code <= 80) return '🌧️';
  if (code <= 99) return '⛈️';
  return '☁️';
}

function getWeatherDesc(code) {
  const map = {
    0: '晴', 1: '少云', 2: '多云', 3: '阴',
    45: '雾', 48: '霜雾',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪',
    77: '雪粒',
    80: '阵雨', 81: '中阵雨', 82: '大阵雨',
    85: '小阵雪', 86: '大阵雪',
    95: '雷暴', 96: '雷暴+冰雹', 99: '强雷暴+冰雹',
  };
  return map[code] || '未知';
}

// ===== 逆地理编码（获取地址名称）=====
async function reverseGeocode(lat, lng, who) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&accept-language=zh`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'LoveMap/1.0' }
    });
    if (!resp.ok) throw new Error('地理编码失败: ' + resp.status);
    const data = await resp.json();

    let loc = '未知位置';
    if (data && data.address) {
      const a = data.address;
      loc = a.city || a.town || a.county || a.district || a.state || a.country || '未知位置';
    }

    if (who === 'me') updateMyLocation(loc);
    else updateTALocation(loc);
  } catch (e) {
    console.error('逆地理编码失败:', e);
    const fallback = `${lat.toFixed(3)}°, ${lng.toFixed(3)}°`;
    if (who === 'me') updateMyLocation(fallback);
    else updateTALocation(fallback);
  }
}

// ===== 距离计算（Haversine）=====
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function updateDistance() {
  const el = document.getElementById('distance-value');
  if (!el) return;

  if (myLat !== null && myLng !== null && taLat !== null && taLng !== null) {
    const dist = calculateDistance(myLat, myLng, taLat, taLng);
    const unitEl = document.querySelector('.distance-unit');
    if (dist < 1) {
      el.textContent = (dist * 1000).toFixed(0);
      if (unitEl) unitEl.textContent = 'm';
    } else if (dist < 100) {
      el.textContent = dist.toFixed(1);
      if (unitEl) unitEl.textContent = 'km';
    } else {
      el.textContent = dist.toFixed(0);
      if (unitEl) unitEl.textContent = 'km';
    }
  } else {
    el.textContent = '--';
    const unitEl = document.querySelector('.distance-unit');
    if (unitEl) unitEl.textContent = 'km';
  }
}

// ===== UI 更新 =====
function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  if (dot) dot.className = 'status-dot ' + state;
  if (txt) txt.textContent = text;
  isConnected = state === 'connected';
}

function updateMyCard() {
  const nameEl = document.getElementById('my-name');
  const avatarEl = document.getElementById('my-avatar');
  if (nameEl) nameEl.textContent = myName;
  if (avatarEl) avatarEl.textContent = myEmoji;
}

function updateMyLocation(loc) {
  const el = document.getElementById('my-location');
  if (el) el.textContent = '📍 ' + loc;
}

function updateTACard() {
  const nameEl = document.getElementById('ta-name');
  const avatarEl = document.getElementById('ta-avatar');
  if (nameEl) nameEl.textContent = taName;
  if (avatarEl) avatarEl.textContent = taEmoji;
  const card = document.querySelector('.user-card.ta');
  if (card) {
    if (taConnected) card.classList.remove('waiting');
    else card.classList.add('waiting');
  }
}

function updateTALocation(loc) {
  const el = document.getElementById('ta-location');
  if (el) el.textContent = '📍 ' + loc;
}

function updateTAStatus() {
  const loc = document.getElementById('ta-location');
  if (!loc) return;
  if (taConnected && taLat !== null && taLng !== null) {
    // 已由 reverseGeocode 更新
  } else if (taConnected) {
    loc.textContent = '⏳ 等待TA分享位置...';
  } else {
    loc.textContent = '💤 等待TA连接...';
    const weather = document.getElementById('ta-weather');
    if (weather) weather.innerHTML = '<span class="weather-loading">☁️ 等待中...</span>';
  }
}

function updateStatusMsg(msg) {
  const txt = document.getElementById('status-text');
  if (!txt) return;
  txt.textContent = msg;
  setTimeout(() => {
    if (isConnected && txt) txt.textContent = '已连接';
  }, 3000);
}

// ===== 地图自适应 =====
// 当页面尺寸变化时重新调整地图
window.addEventListener('resize', () => {
  if (map) {
    setTimeout(() => map.invalidateSize(), 200);
  }
});
