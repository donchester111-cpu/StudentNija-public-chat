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

// ============================================================
// CONFIG
// ============================================================
const PROXY_URL = process.env.PROXY_URL || "https://studentnija-proxy.donchester111.workers.dev";
const AI_MODEL = process.env.AI_MODEL || "llama-3.1-8b-instant";
const AI_SYSTEM_PROMPT = `You are StudentNija, an advanced AI study assistant for Nigerian students.
You are helpful, thorough, and encouraging. Use markdown for formatting.
If you don't know something, say so honestly. Current date: ${new Date().toLocaleDateString()}.`;

const groups = {};

// ============================================================
// AI HELPER
// ============================================================
async function callAIHelper(userPrompt, systemPrompt = AI_SYSTEM_PROMPT, personality = "Friendly Tutor") {
  const messages = [
    { role: "system", content: systemPrompt + ` Personality: ${personality}.` },
    { role: "user", content: userPrompt }
  ];

  try {
    const response = await fetch(`${PROXY_URL}/groq`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Proxy error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content;
    } else {
      throw new Error('Unexpected response format from AI');
    }
  } catch (err) {
    console.error('AI error:', err.message);
    return null;
  }
}

// ============================================================
// SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);

  // ------------------------------------------------------------
  // CREATE GROUP
  // ------------------------------------------------------------
  socket.on('createGroup', (data, callback) => {
    const { groupId, userName, userId } = data;

    if (!groupId || !groupId.trim()) {
      if (callback) callback({ success: false, error: 'Group name is required' });
      return;
    }
    const trimmed = groupId.trim();
    if (groups[trimmed]) {
      if (callback) callback({ success: false, error: 'Group already exists' });
      return;
    }

    // Create the group
    groups[trimmed] = {
      members: [{ id: userId, name: userName }],
      messages: [],
      createdBy: userId,
      name: trimmed
    };

    // Join the creator to the socket room
    socket.join(trimmed);
    socket.data.groupId = trimmed;
    socket.data.userName = userName;
    socket.data.userId = userId;

    // Send back success and the group state
    if (callback) {
      callback({
        success: true,
        groupId: trimmed,
        members: groups[trimmed].members,
        messages: [],
        createdBy: userId
      });
    }

    // Optionally broadcast to the group (only the creator is in it)
    io.to(trimmed).emit('membersUpdate', groups[trimmed].members);
  });

  // ------------------------------------------------------------
  // JOIN GROUP (only if exists)
  // ------------------------------------------------------------
  socket.on('joinGroup', (data) => {
    const { groupId, userName, userId } = data;

    if (!groups[groupId]) {
      socket.emit('groupNotFound', { groupId });
      return;
    }

    socket.join(groupId);
    socket.data.groupId = groupId;
    socket.data.userName = userName;
    socket.data.userId = userId;

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

  // ------------------------------------------------------------
  // SEND MESSAGE
  // ------------------------------------------------------------
  socket.on('sendMessage', (data) => {
    const { groupId, text, senderName, senderId, timestamp } = data;
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      senderId,
      senderName,
      text,
      timestamp: timestamp || new Date().toISOString(),
      reactions: {}
    };

    if (groups[groupId]) {
      groups[groupId].messages.push(message);
      if (groups[groupId].messages.length > 500) groups[groupId].messages.shift();
    }
    io.to(groupId).emit('newMessage', message);
  });

  // ------------------------------------------------------------
  // AI REQUEST
  // ------------------------------------------------------------
  socket.on('requestAI', async (data) => {
    const { groupId, prompt, context = '', personality = 'Friendly Tutor' } = data;

    let fullPrompt = prompt;
    if (context) {
      fullPrompt = `Previous messages:\n${context}\n\nUser question: ${prompt}`;
    }

    let aiReply = await callAIHelper(fullPrompt, AI_SYSTEM_PROMPT, personality);
    if (!aiReply) {
      aiReply = `🤖 I'm sorry, I couldn't reach my AI brain right now. Please try again later.`;
    }

    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      senderId: 'ai_bot',
      senderName: '🤖 StudentNija AI',
      text: aiReply,
      timestamp: new Date().toISOString(),
      reactions: {}
    };

    if (groups[groupId]) {
      groups[groupId].messages.push(message);
      if (groups[groupId].messages.length > 500) groups[groupId].messages.shift();
    }
    io.to(groupId).emit('newMessage', message);
  });

  // ------------------------------------------------------------
  // REACTION
  // ------------------------------------------------------------
  socket.on('react', (data) => {
    const { groupId, messageId, emoji, userId } = data;
    if (!groups[groupId]) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const userIndex = msg.reactions[emoji].indexOf(userId);
    if (userIndex === -1) {
      msg.reactions[emoji].push(userId);
    } else {
      msg.reactions[emoji].splice(userIndex, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    }

    io.to(groupId).emit('reactionUpdate', {
      messageId,
      reactions: msg.reactions
    });
  });

  // ------------------------------------------------------------
  // TYPING
  // ------------------------------------------------------------
  socket.on('typing', (data) => {
    const { groupId, senderName, senderId } = data;
    socket.to(groupId).emit('typing', { senderName, senderId });
  });

  // ------------------------------------------------------------
  // ADMIN ACTIONS
  // ------------------------------------------------------------
  socket.on('renameGroup', (data) => {
    const { groupId, newName, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      groups[groupId].name = newName;
      io.to(groupId).emit('groupRenamed', { newName, groupId });
    } else {
      socket.emit('error', { message: 'Not authorized or group does not exist' });
    }
  });

  socket.on('deleteGroup', (data) => {
    const { groupId, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      io.to(groupId).emit('groupDeleted', { groupId });
      delete groups[groupId];
    } else {
      socket.emit('error', { message: 'Not authorized or group does not exist' });
    }
  });

  socket.on('removeMember', (data) => {
    const { groupId, userId, targetUserId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      const memberIndex = groups[groupId].members.findIndex(m => m.id === targetUserId);
      if (memberIndex !== -1) {
        const removed = groups[groupId].members.splice(memberIndex, 1)[0];
        io.to(groupId).emit('memberRemoved', { userId: targetUserId, name: removed.name });
        io.to(groupId).emit('membersUpdate', groups[groupId].members);
      }
    } else {
      socket.emit('error', { message: 'Not authorized' });
    }
  });

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

  // ------------------------------------------------------------
  // LEAVE / DISCONNECT
  // ------------------------------------------------------------
  socket.on('leaveGroup', () => {
    const gid = socket.data.groupId;
    const uid = socket.data.userId;
    if (gid && groups[gid]) {
      groups[gid].members = groups[gid].members.filter(m => m.id !== uid);
      io.to(gid).emit('membersUpdate', groups[gid].members);
    }
    socket.data.groupId = null;
    socket.data.userId = null;
  });

  socket.on('disconnect', () => {
    const gid = socket.data.groupId;
    const uid = socket.data.userId;
    if (gid && groups[gid]) {
      groups[gid].members = groups[gid].members.filter(m => m.id !== uid);
      io.to(gid).emit('membersUpdate', groups[gid].members);
    }
    console.log('❌ Disconnected:', socket.id);
  });
});

// ============================================================
// REST ENDPOINTS
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    groups: Object.keys(groups).length,
    totalMembers: Object.values(groups).reduce((acc, g) => acc + g.members.length, 0)
  });
});

app.get('/', (req, res) => {
  res.send('🚀 StudentNija Chat Server with Real AI, Reactions & Group Creation!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   AI Proxy: ${PROXY_URL}`);
  console.log(`   AI Model: ${AI_MODEL}`);
});
