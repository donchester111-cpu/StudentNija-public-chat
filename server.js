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
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
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

// In‑memory store
const groups = {};

// ============================================================
// AI HELPER
// ============================================================
async function callAIHelper(userPrompt, systemPrompt = AI_SYSTEM_PROMPT, personality = "Friendly Tutor") {
  try {
    const response = await fetch(`${PROXY_URL}/groq`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt + ` Personality: ${personality}.` },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 500
      })
    });
    if (!response.ok) throw new Error(`Proxy error: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
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
    const { groupId, userName, userId, description = '', avatar = '' } = data;
    const trimmed = groupId?.trim();
    if (!trimmed) return callback?.({ success: false, error: 'Group name required' });
    if (groups[trimmed]) return callback?.({ success: false, error: 'Group already exists' });

    groups[trimmed] = {
      name: trimmed,
      description: description || '',
      avatar: avatar || '📚',
      createdBy: userId,
      admins: [userId],
      members: [{ id: userId, name: userName }],
      messages: [],
      pinned: null // pinned message id
    };

    socket.join(trimmed);
    socket.data.groupId = trimmed;
    socket.data.userId = userId;

    callback?.({ success: true, groupId: trimmed, members: groups[trimmed].members, messages: [], createdBy: userId });
    io.to(trimmed).emit('membersUpdate', groups[trimmed].members);
  });

  // ------------------------------------------------------------
  // JOIN GROUP (only if exists)
  // ------------------------------------------------------------
  socket.on('joinGroup', (data) => {
    const { groupId, userName, userId } = data;
    if (!groups[groupId]) return socket.emit('groupNotFound', { groupId });

    socket.join(groupId);
    socket.data.groupId = groupId;
    socket.data.userId = userId;

    if (!groups[groupId].members.find(m => m.id === userId)) {
      groups[groupId].members.push({ id: userId, name: userName });
    }
    socket.emit('groupState', {
      members: groups[groupId].members,
      messages: groups[groupId].messages.slice(-50),
      createdBy: groups[groupId].createdBy,
      admins: groups[groupId].admins || [],
      name: groups[groupId].name,
      description: groups[groupId].description,
      avatar: groups[groupId].avatar,
      pinned: groups[groupId].pinned
    });
    io.to(groupId).emit('membersUpdate', groups[groupId].members);
  });

  // ------------------------------------------------------------
  // SEND MESSAGE (with reply support)
  // ------------------------------------------------------------
  socket.on('sendMessage', (data) => {
    const { groupId, text, senderName, senderId, timestamp, replyToId } = data;
    if (!groups[groupId]) return;

    let replyTo = null;
    if (replyToId) {
      const original = groups[groupId].messages.find(m => m.id === replyToId);
      if (original) {
        replyTo = {
          id: original.id,
          senderName: original.senderName,
          text: original.text.length > 50 ? original.text.substring(0, 50) + '…' : original.text
        };
      }
    }

    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      senderId,
      senderName,
      text,
      timestamp: timestamp || new Date().toISOString(),
      reactions: {},
      replyTo: replyTo,
      edited: false,
      deleted: false,
      deletedFor: [] // userIds who have deleted it for themselves
    };

    groups[groupId].messages.push(message);
    if (groups[groupId].messages.length > 500) groups[groupId].messages.shift();
    io.to(groupId).emit('newMessage', message);
  });

  // ------------------------------------------------------------
  // AI REQUEST (with typing indicator)
  // ------------------------------------------------------------
  socket.on('requestAI', async (data) => {
    const { groupId, prompt, context = '', personality = 'Friendly Tutor' } = data;
    if (!groups[groupId]) return;

    // Tell everyone AI is typing
    io.to(groupId).emit('aiTyping', { typing: true });

    const fullPrompt = context ? `Previous messages:\n${context}\n\nUser question: ${prompt}` : prompt;
    const aiReply = await callAIHelper(fullPrompt, AI_SYSTEM_PROMPT, personality);

    // Stop typing indicator
    io.to(groupId).emit('aiTyping', { typing: false });

    const replyText = aiReply || `✦ I'm sorry, I couldn't reach my AI brain right now. Please try again later.`;
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      senderId: 'ai_bot',
      senderName: '✦ StudentNija AI',
      text: replyText,
      timestamp: new Date().toISOString(),
      reactions: {},
      replyTo: null,
      edited: false,
      deleted: false,
      deletedFor: []
    };

    groups[groupId].messages.push(message);
    if (groups[groupId].messages.length > 500) groups[groupId].messages.shift();
    io.to(groupId).emit('newMessage', message);
  });

  // ------------------------------------------------------------
  // REACTION (toggle)
  // ------------------------------------------------------------
  socket.on('react', (data) => {
    const { groupId, messageId, emoji, userId } = data;
    if (!groups[groupId]) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg || msg.deleted) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(userId);
    if (idx === -1) msg.reactions[emoji].push(userId);
    else msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];

    io.to(groupId).emit('reactionUpdate', { messageId, reactions: msg.reactions });
  });

  // ------------------------------------------------------------
  // EDIT MESSAGE
  // ------------------------------------------------------------
  socket.on('editMessage', (data) => {
    const { groupId, messageId, newText, userId } = data;
    if (!groups[groupId]) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg || msg.senderId !== userId) return;
    msg.text = newText;
    msg.edited = true;
    msg.editedAt = new Date().toISOString();
    io.to(groupId).emit('messageEdited', { messageId, newText, editedAt: msg.editedAt });
  });

  // ------------------------------------------------------------
  // DELETE MESSAGE (for self or all)
  // ------------------------------------------------------------
  socket.on('deleteMessage', (data) => {
    const { groupId, messageId, userId, forAll } = data;
    if (!groups[groupId]) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg) return;
    const isAdmin = groups[groupId].admins?.includes(userId) || groups[groupId].createdBy === userId;
    if (forAll && (msg.senderId === userId || isAdmin)) {
      msg.deleted = true;
      msg.text = 'This message was deleted.';
      io.to(groupId).emit('messageDeleted', { messageId, forAll: true });
    } else if (msg.senderId === userId) {
      if (!msg.deletedFor) msg.deletedFor = [];
      if (!msg.deletedFor.includes(userId)) {
        msg.deletedFor.push(userId);
        io.to(groupId).emit('messageDeletedForSelf', { messageId, userId });
      }
    }
  });

  // ------------------------------------------------------------
  // PIN / UNPIN MESSAGE
  // ------------------------------------------------------------
  socket.on('pinMessage', (data) => {
    const { groupId, messageId, userId } = data;
    if (!groups[groupId]) return;
    const isAdmin = groups[groupId].admins?.includes(userId) || groups[groupId].createdBy === userId;
    if (!isAdmin) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg || msg.deleted) return;
    if (groups[groupId].pinned === messageId) {
      groups[groupId].pinned = null;
      io.to(groupId).emit('messageUnpinned', { messageId });
    } else {
      groups[groupId].pinned = messageId;
      io.to(groupId).emit('messagePinned', { messageId });
    }
  });

  // ------------------------------------------------------------
  // GROUP ADMIN ACTIONS
  // ------------------------------------------------------------
  socket.on('toggleAdmin', (data) => {
    const { groupId, userId, targetUserId, add } = data;
    if (!groups[groupId]) return;
    if (groups[groupId].createdBy !== userId) return socket.emit('error', { message: 'Only creator can manage admins' });
    if (!groups[groupId].admins) groups[groupId].admins = [];
    if (add && !groups[groupId].admins.includes(targetUserId)) {
      groups[groupId].admins.push(targetUserId);
      io.to(groupId).emit('adminUpdated', { targetUserId, isAdmin: true });
    } else if (!add) {
      groups[groupId].admins = groups[groupId].admins.filter(id => id !== targetUserId);
      io.to(groupId).emit('adminUpdated', { targetUserId, isAdmin: false });
    }
  });

  socket.on('renameGroup', (data) => {
    const { groupId, newName, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      groups[groupId].name = newName;
      io.to(groupId).emit('groupRenamed', { newName, groupId });
    } else socket.emit('error', { message: 'Not authorized' });
  });

  socket.on('updateGroupMeta', (data) => {
    const { groupId, userId, description, avatar } = data;
    if (!groups[groupId]) return;
    const isAdmin = groups[groupId].admins?.includes(userId) || groups[groupId].createdBy === userId;
    if (!isAdmin) return socket.emit('error', { message: 'Not authorized' });
    if (description !== undefined) groups[groupId].description = description;
    if (avatar !== undefined) groups[groupId].avatar = avatar;
    io.to(groupId).emit('groupMetaUpdated', { description: groups[groupId].description, avatar: groups[groupId].avatar });
  });

  socket.on('deleteGroup', (data) => {
    const { groupId, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      io.to(groupId).emit('groupDeleted', { groupId });
      delete groups[groupId];
    } else socket.emit('error', { message: 'Not authorized' });
  });

  socket.on('removeMember', (data) => {
    const { groupId, userId, targetUserId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      groups[groupId].members = groups[groupId].members.filter(m => m.id !== targetUserId);
      io.to(groupId).emit('membersUpdate', groups[groupId].members);
      io.to(groupId).emit('memberRemoved', { userId: targetUserId });
    } else socket.emit('error', { message: 'Not authorized' });
  });

  socket.on('addMember', (data) => {
    const { groupId, userId, newUserId, newUserName } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      if (!groups[groupId].members.find(m => m.id === newUserId)) {
        groups[groupId].members.push({ id: newUserId, name: newUserName });
        io.to(groupId).emit('membersUpdate', groups[groupId].members);
        io.to(groupId).emit('memberAdded', { userId: newUserId, name: newUserName });
      }
    } else socket.emit('error', { message: 'Not authorized' });
  });

  // ------------------------------------------------------------
  // TYPING (user typing)
  // ------------------------------------------------------------
  socket.on('typing', (data) => {
    const { groupId, senderName, senderId } = data;
    socket.to(groupId).emit('typing', { senderName, senderId });
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
  });
});

// ============================================================
// REST ENDPOINTS
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', groups: Object.keys(groups).length });
});
app.get('/', (req, res) => res.send('🚀 StudentNija Chat Server (Full WhatsApp‑like) running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
