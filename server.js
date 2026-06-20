const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ─── In‑memory storage ───
const groups = {};

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);

  // ─── Join a group ───
  socket.on('joinGroup', (data) => {
    const { groupId, userName, userId } = data;
    socket.join(groupId);
    socket.data.groupId = groupId;
    socket.data.userName = userName;
    socket.data.userId = userId;

    if (!groups[groupId]) {
      groups[groupId] = { members: [], messages: [] };
    }
    if (!groups[groupId].members.find(m => m.id === userId)) {
      groups[groupId].members.push({ id: userId, name: userName });
    }

    socket.emit('groupState', {
      members: groups[groupId].members,
      messages: groups[groupId].messages.slice(-50)
    });
    io.to(groupId).emit('membersUpdate', groups[groupId].members);

    console.log(`📥 ${userName} joined ${groupId}`);
  });

  // ─── Send a message ───
  socket.on('sendMessage', (data) => {
    const { groupId, text, senderName, senderId, timestamp } = data;
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      senderId,
      senderName,
      text,
      timestamp: timestamp || new Date().toISOString()
    };
    if (groups[groupId]) {
      groups[groupId].messages.push(message);
      if (groups[groupId].messages.length > 500) {
        groups[groupId].messages.shift();
      }
    }
    io.to(groupId).emit('newMessage', message);
    socket.emit('newMessage', message); // echo to sender
  });

  // ─── AI request (dummy) ───
  socket.on('requestAI', (data) => {
    const { groupId, prompt, context } = data;
    // Replace this with a call to your AI proxy if desired
    const aiReply = `🤖 AI: I'm a self-hosted AI! (You asked: "${prompt}")`;
    io.to(groupId).emit('newMessage', {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      senderId: 'ai_bot',
      senderName: '🤖 StudentNija AI',
      text: aiReply,
      timestamp: new Date().toISOString()
    });
  });

  // ─── Typing indicator ───
  socket.on('typing', (data) => {
    const { groupId, senderName, senderId } = data;
    socket.to(groupId).emit('typing', { senderName, senderId });
  });

  // ─── Leave group / disconnect ───
  socket.on('leaveGroup', () => {
    const groupId = socket.data.groupId;
    const userId = socket.data.userId;
    if (groupId && groups[groupId]) {
      groups[groupId].members = groups[groupId].members.filter(m => m.id !== userId);
      io.to(groupId).emit('membersUpdate', groups[groupId].members);
    }
  });

  socket.on('disconnect', () => {
    const groupId = socket.data.groupId;
    const userId = socket.data.userId;
    if (groupId && groups[groupId]) {
      groups[groupId].members = groups[groupId].members.filter(m => m.id !== userId);
      io.to(groupId).emit('membersUpdate', groups[groupId].members);
    }
    console.log('❌ User disconnected:', socket.id);
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', groups: Object.keys(groups).length });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Chat server running on port ${PORT}`);
});
