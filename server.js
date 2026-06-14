const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
// ===== HTTP 轮询 API（WebSocket 不可用时的备份）=====
var httpLoc = {};
setInterval(function() {
  var now = Date.now();
  for (var room in httpLoc) {
    httpLoc[room] = httpLoc[room].filter(function(u) { return now - u.t < 30000; });
    if (httpLoc[room].length === 0) delete httpLoc[room];
  }
}, 10000);

app.post('/api/location', function(req, res) {
  var data = req.body;
  if (!data || !data.room || !data.name) return res.json({ok: false});
  if (!httpLoc[data.room]) httpLoc[data.room] = [];
  var users = httpLoc[data.room];
  var found = false;
  for (var i = 0; i < users.length; i++) {
    if (users[i].name === data.name) { users[i] = {name: data.name, emoji: data.emoji || '', lat: data.lat, lng: data.lng, t: Date.now()}; found = true; break; }
  }
  if (!found) users.push({name: data.name, emoji: data.emoji || '', lat: data.lat, lng: data.lng, t: Date.now()});
  var peers = users.filter(function(u) { return u.name !== data.name; }).map(function(u) { return {name: u.name, emoji: u.emoji, lat: u.lat, lng: u.lng}; });
  res.json({ok: true, peers: peers});
});

app.get('/api/location', function(req, res) {
  var room = req.query.room;
  if (!room) return res.json({ok: false, peers: []});
  var users = httpLoc[room] || [];
  var peers = users.filter(function(u) { return u.name !== req.query.me; }).map(function(u) { return {name: u.name, emoji: u.emoji, lat: u.lat, lng: u.lng}; });
  res.json({ok: true, peers: peers});
});


// 房间管理：roomCode -> Set<WebSocket>
const rooms = new Map();
// 存储每个用户的信息：ws -> { room, name, emoji, lat, lng }
const userInfo = new Map();

wss.on('connection', (ws) => {
  console.log('新的连接');
  let currentRoom = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'join') {
        // 加入房间
        currentRoom = msg.room;
        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, new Set());
        }
        rooms.get(currentRoom).add(ws);
        userInfo.set(ws, {
          room: currentRoom,
          name: msg.name,
          emoji: msg.emoji || '💙',
          lat: null,
          lng: null,
          timestamp: Date.now()
        });

        console.log(`${msg.name} 加入了房间 ${currentRoom}`);

        // 通知房间内其他用户有人加入
        broadcastToRoom(currentRoom, ws, {
          type: 'peer-joined',
          name: msg.name,
          emoji: msg.emoji || '💙',
          peers: getPeersInfo(currentRoom)
        });

        // 发送当前房间已有用户信息给新加入者
        ws.send(JSON.stringify({
          type: 'room-info',
          peers: getPeersInfo(currentRoom)
        }));
      }

      if (msg.type === 'location') {
        const info = userInfo.get(ws);
        if (info) {
          info.lat = msg.lat;
          info.lng = msg.lng;
          info.timestamp = Date.now();

          // 广播位置给房间内其他用户
          broadcastToRoom(currentRoom, ws, {
            type: 'peer-location',
            name: info.name,
            emoji: info.emoji,
            lat: msg.lat,
            lng: msg.lng,
            timestamp: Date.now()
          });
        }
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  });

  ws.on('close', () => {
    console.log('连接断开');
    const info = userInfo.get(ws);
    if (info) {
      const room = rooms.get(info.room);
      if (room) {
        room.delete(ws);
        if (room.size === 0) {
          rooms.delete(info.room);
        } else {
          // 通知其他人有人离开
          broadcastToRoom(info.room, ws, {
            type: 'peer-left',
            name: info.name,
            peers: getPeersInfo(info.room)
          });
        }
      }
      userInfo.delete(ws);
    }
  });
});

function broadcastToRoom(roomCode, senderWs, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  room.forEach((client) => {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function getPeersInfo(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  const peers = [];
  room.forEach((client) => {
    const info = userInfo.get(client);
    if (info) {
      peers.push({
        name: info.name,
        emoji: info.emoji,
        lat: info.lat,
        lng: info.lng
      });
    }
  });
  return peers;
}

const PORT = process.env.PORT || 3333;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`💕 爱在地图服务已启动: http://localhost:${PORT}`);
  console.log(`   局域网访问: http://<本机IP>:${PORT}`);
});
