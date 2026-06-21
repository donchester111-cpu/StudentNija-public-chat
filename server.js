const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

const groups = {};

io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);

  // Join a group
  socket.on('joinGroup', (data) => {
    const { groupId, userName, userId } = data;
    socket.join(groupId);
    socket.data.groupId = groupId;
    socket.data.userName = userName;
    socket.data.userId = userId;

    if (!groups[groupId]) {
      groups[groupId] = {
        members: [],
        messages: [],
        createdBy: userId,
        name: groupId
      };
    }
    // Set creator if not set
    if (!groups[groupId].createdBy) {
      groups[groupId].createdBy = userId;
    }
    if (!groups[groupId].members.find(m => m.id === userId)) {
      groups[groupId].members.push({ id: userId, name: userName });
    }

    socket.emit('groupState', {
      members: groups[groupId].members,
      messages: groups[groupId].messages.slice(-50),
      createdBy: groups[groupId].createdBy
    });
    io.to(groupId).emit('membersUpdate', groups[groupId].members);
  });

  // Send message (FIX: no duplicate)
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
      if (groups[groupId].messages.length > 500) groups[groupId].messages.shift();
    }
    // Broadcast to ALL in group (including sender) – no separate echo
    io.to(groupId).emit('newMessage', message);
  });

  // AI request
  socket.on('requestAI', (data) => {
    const { groupId, prompt } = data;
    const aiReply = `🤖 AI: (You asked: "${prompt}") – I'll help you study!`;
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      senderId: 'ai_bot',
      senderName: '🤖 StudentNija AI',
      text: aiReply,
      timestamp: new Date().toISOString()
    };
    if (groups[groupId]) {
      groups[groupId].messages.push(message);
      if (groups[groupId].messages.length > 500) groups[groupId].messages.shift();
    }
    io.to(groupId).emit('newMessage', message);
  });

  // Typing
  socket.on('typing', (data) => {
    const { groupId, senderName, senderId } = data;
    socket.to(groupId).emit('typing', { senderName, senderId });
  });

  // --- Admin actions ---

  // Rename group (only creator)
  socket.on('renameGroup', (data) => {
    const { groupId, newName, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      const oldName = groupId;
      // We need to handle renaming – groups are keyed by ID. We'll just change the stored name.
      // For simplicity, we keep the same groupId but update the display name.
      groups[groupId].name = newName;
      io.to(groupId).emit('groupRenamed', { newName, groupId });
    } else {
      socket.emit('error', { message: 'Not authorized' });
    }
  });

  // Delete group (only creator)
  socket.on('deleteGroup', (data) => {
    const { groupId, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      // Notify all members, then delete
      io.to(groupId).emit('groupDeleted', { groupId });
      delete groups[groupId];
    } else {
      socket.emit('error', { message: 'Not authorized' });
    }
  });

  // Remove member (only creator)
  socket.on('removeMember', (data) => {
    const { groupId, userId, targetUserId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      const memberIndex = groups[groupId].members.findIndex(m => m.id === targetUserId);
      if (memberIndex !== -1) {
        const removed = groups[groupId].members.splice(memberIndex, 1)[0];
        io.to(groupId).emit('memberRemoved', { userId: targetUserId, name: removed.name });
        // Also notify the removed user (they might be offline)
        // We could send a private message or just rely on the group update.
        io.to(groupId).emit('membersUpdate', groups[groupId].members);
      }
    } else {
      socket.emit('error', { message: 'Not authorized' });
    }
  });

  // Add member (only creator) – we just add by userId/name (invite system simplified)
  socket.on('addMember', (data) => {
    const { groupId, userId, newUserId, newUserName } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      if (!groups[groupId].members.find(m => m.id === newUserId)) {
        groups[groupId].members.push({ id: newUserId, name: newUserName });
        io.to(groupId).emit('membersUpdate', groups[groupId].members);
        io.to(groupId).emit('memberAdded', { userId: newUserId, name: newUserName });
      }
    } else {
      socket.emit('error', { message: 'Not authorized' });
    }
  });

  // Leave group
  socket.on('leaveGroup', () => {
    const gid = socket.data.groupId;
    const uid = socket.data.userId;
    if (gid && groups[gid]) {
      groups[gid].members = groups[gid].members.filter(m => m.id !== uid);
      io.to(gid).emit('membersUpdate', groups[gid].members);
    }
  });

  socket.on('disconnect', () => {
    const gid = socket.data.groupId;
    const uid = socket.data.userId;
    if (gid && groups[gid]) {
      groups[gid].members = groups[gid].members.filter(m => m.id !== uid);
      io.to(gid).emit('membersUpdate', groups[gid].members);
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', groups: Object.keys(groups).length });
});

app.get('/', (req, res) => {
  res.send('🚀 StudentNija Chat Server is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
