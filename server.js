const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

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
// ENVIRONMENT CHECKS
// ============================================================
const requiredEnvVars = ['DATABASE_URL'];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Please set them in Render dashboard -> Environment.');
  process.exit(1);
}

if (!process.env.ALOC_ACCESS_TOKEN) {
  console.warn('⚠️ ALOC_ACCESS_TOKEN not set – past questions will use fallback only.');
}

// ============================================================
// POSTGRES CONNECTION
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err);
});

// ============================================================
// INIT DATABASE TABLES
// ============================================================
async function initDatabase() {
  try {
    // Groups table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        avatar TEXT DEFAULT '📚',
        created_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Group members
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        joined_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (group_id, user_id)
      );
    `);
    // Group messages
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW(),
        reply_to_id TEXT,
        edited BOOLEAN DEFAULT FALSE,
        edited_at TIMESTAMP,
        deleted BOOLEAN DEFAULT FALSE,
        deleted_for TEXT[] DEFAULT '{}'
      );
    `);
    // Message reactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT REFERENCES group_messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
    `);
    // Group pins
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_pins (
        group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES group_messages(id) ON DELETE CASCADE
      );
    `);
    // Past questions cache (permanent)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS past_questions_cache (
        exam TEXT NOT NULL,
        subject TEXT NOT NULL,
        year TEXT NOT NULL,
        questions JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (exam, subject, year)
      );
    `);
    console.log('✅ Database tables ready');
  } catch (err) {
    console.error('❌ DB init error:', err);
    process.exit(1);
  }
}
initDatabase();

// ============================================================
// IN‑MEMORY GROUPS (loaded from DB on startup)
// ============================================================
const groups = {};

async function loadGroupsFromDB() {
  try {
    const groupRes = await pool.query('SELECT * FROM groups');
    for (const g of groupRes.rows) {
      groups[g.id] = {
        name: g.name,
        description: g.description || '',
        avatar: g.avatar || '📚',
        createdBy: g.created_by,
        members: [],
        messages: [],
        admins: [],
        pinned: null
      };
      // Load members
      const membersRes = await pool.query(
        'SELECT user_id, user_name, is_admin FROM group_members WHERE group_id = $1',
        [g.id]
      );
      groups[g.id].members = membersRes.rows.map(m => ({ id: m.user_id, name: m.user_name }));
      groups[g.id].admins = membersRes.rows.filter(m => m.is_admin).map(m => m.user_id);
      // Load messages (last 50)
      const msgRes = await pool.query(
        `SELECT * FROM group_messages WHERE group_id = $1 AND deleted = false ORDER BY timestamp DESC LIMIT 50`,
        [g.id]
      );
      groups[g.id].messages = msgRes.rows.reverse().map(m => ({
        id: m.id,
        senderId: m.sender_id,
        senderName: m.sender_name,
        text: m.text,
        timestamp: m.timestamp.toISOString(),
        replyTo: m.reply_to_id ? { id: m.reply_to_id } : null,
        edited: m.edited,
        editedAt: m.edited_at ? m.edited_at.toISOString() : null,
        deleted: m.deleted,
        deletedFor: m.deleted_for || [],
        reactions: {}
      }));
      // Load reactions
      for (const msg of groups[g.id].messages) {
        const reactRes = await pool.query(
          'SELECT user_id, emoji FROM message_reactions WHERE message_id = $1',
          [msg.id]
        );
        const reactions = {};
        reactRes.rows.forEach(r => {
          if (!reactions[r.emoji]) reactions[r.emoji] = [];
          reactions[r.emoji].push(r.user_id);
        });
        msg.reactions = reactions;
      }
      // Load pinned message
      const pinRes = await pool.query('SELECT message_id FROM group_pins WHERE group_id = $1', [g.id]);
      if (pinRes.rows.length) {
        groups[g.id].pinned = pinRes.rows[0].message_id;
      }
    }
    console.log(`✅ Loaded ${Object.keys(groups).length} groups from DB`);
  } catch (err) {
    console.error('❌ Error loading groups from DB:', err);
  }
}
loadGroupsFromDB();

async function saveGroupToDB(groupId) {
  const g = groups[groupId];
  if (!g) return;
  try {
    await pool.query(
      `INSERT INTO groups (id, name, description, avatar, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         avatar = EXCLUDED.avatar`,
      [groupId, g.name, g.description, g.avatar, g.createdBy]
    );
    await pool.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);
    for (const m of g.members) {
      await pool.query(
        'INSERT INTO group_members (group_id, user_id, user_name, is_admin) VALUES ($1, $2, $3, $4)',
        [groupId, m.id, m.name, g.admins.includes(m.id)]
      );
    }
  } catch (err) {
    console.error('❌ Error saving group to DB:', err);
  }
}

// ============================================================
// AI HELPER
// ============================================================
const PROXY_URL = process.env.PROXY_URL || "https://studentnija-proxy.donchester111.workers.dev";
const AI_MODEL = process.env.AI_MODEL || "llama-3.1-8b-instant";
const AI_SYSTEM_PROMPT = `You are StudentNija, an advanced AI study assistant for Nigerian students.
You are helpful, thorough, and encouraging. Use markdown for formatting.
If you don't know something, say so honestly. Current date: ${new Date().toLocaleDateString()}.`;

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
// SOCKET.IO – Full Chat Implementation
// ============================================================
io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);

  // ---- CREATE GROUP ----
  socket.on('createGroup', async (data, callback) => {
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
      pinned: null
    };
    await saveGroupToDB(trimmed);

    socket.join(trimmed);
    socket.data.groupId = trimmed;
    socket.data.userId = userId;

    callback?.({ success: true, groupId: trimmed, members: groups[trimmed].members, messages: [], createdBy: userId });
    io.to(trimmed).emit('membersUpdate', groups[trimmed].members);
  });

  // ---- JOIN GROUP ----
  socket.on('joinGroup', async (data) => {
    const { groupId, userName, userId } = data;
    if (!groups[groupId]) return socket.emit('groupNotFound', { groupId });

    socket.join(groupId);
    socket.data.groupId = groupId;
    socket.data.userId = userId;

    if (!groups[groupId].members.find(m => m.id === userId)) {
      groups[groupId].members.push({ id: userId, name: userName });
      await saveGroupToDB(groupId);
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

  // ---- SEND MESSAGE ----
  socket.on('sendMessage', async (data) => {
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
      replyTo,
      edited: false,
      deleted: false,
      deletedFor: []
    };

    groups[groupId].messages.push(message);
    if (groups[groupId].messages.length > 500) groups[groupId].messages.shift();

    await pool.query(
      `INSERT INTO group_messages (id, group_id, sender_id, sender_name, text, timestamp, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [message.id, groupId, senderId, senderName, text, message.timestamp, replyToId || null]
    );

    io.to(groupId).emit('newMessage', message);
  });

  // ---- AI REQUEST ----
  socket.on('requestAI', async (data) => {
    const { groupId, prompt, context = '', personality = 'Friendly Tutor', senderName, senderId } = data;
    if (!groups[groupId]) return;

    io.to(groupId).emit('aiTyping', { typing: true });

    const history = context ? `Here is the recent conversation:\n${context}\n\n` : '';
    const userInfo = senderName ? `The user asking is "${senderName}" (ID: ${senderId}).` : '';
    const fullPrompt = `${history}${userInfo}\nNow, answer this question from ${senderName || 'the user'}: "${prompt}". 
      Address the user by their name (if provided) and be helpful, friendly, and concise.
      If you are unsure, say so honestly.`;

    const aiReply = await callAIHelper(fullPrompt, AI_SYSTEM_PROMPT, personality);
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

    await pool.query(
      `INSERT INTO group_messages (id, group_id, sender_id, sender_name, text, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [message.id, groupId, 'ai_bot', '✦ StudentNija AI', replyText, message.timestamp]
    );

    io.to(groupId).emit('newMessage', message);
  });

  // ---- REACTION ----
  socket.on('react', async (data) => {
    const { groupId, messageId, emoji, userId } = data;
    if (!groups[groupId]) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg || msg.deleted) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(userId);
    if (idx === -1) {
      msg.reactions[emoji].push(userId);
      await pool.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)`,
        [messageId, userId, emoji]
      );
    } else {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
      await pool.query(
        `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [messageId, userId, emoji]
      );
    }
    io.to(groupId).emit('reactionUpdate', { messageId, reactions: msg.reactions });
  });

  // ---- EDIT MESSAGE ----
  socket.on('editMessage', async (data) => {
    const { groupId, messageId, newText, userId } = data;
    if (!groups[groupId]) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg || msg.senderId !== userId) return;
    msg.text = newText;
    msg.edited = true;
    msg.editedAt = new Date().toISOString();
    await pool.query(
      `UPDATE group_messages SET text = $1, edited = true, edited_at = $2 WHERE id = $3`,
      [newText, msg.editedAt, messageId]
    );
    io.to(groupId).emit('messageEdited', { messageId, newText, editedAt: msg.editedAt });
  });

  // ---- DELETE MESSAGE ----
  socket.on('deleteMessage', async (data) => {
    const { groupId, messageId, userId, forAll } = data;
    if (!groups[groupId]) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg) return;
    const isAdmin = groups[groupId].admins?.includes(userId) || groups[groupId].createdBy === userId;
    if (forAll && (msg.senderId === userId || isAdmin)) {
      msg.deleted = true;
      msg.text = 'This message was deleted.';
      await pool.query(`UPDATE group_messages SET deleted = true, text = $1 WHERE id = $2`, [msg.text, messageId]);
      io.to(groupId).emit('messageDeleted', { messageId, forAll: true });
    } else if (msg.senderId === userId) {
      if (!msg.deletedFor) msg.deletedFor = [];
      if (!msg.deletedFor.includes(userId)) {
        msg.deletedFor.push(userId);
        await pool.query(
          `UPDATE group_messages SET deleted_for = array_append(deleted_for, $1) WHERE id = $2`,
          [userId, messageId]
        );
        io.to(groupId).emit('messageDeletedForSelf', { messageId, userId });
      }
    }
  });

  // ---- PIN / UNPIN ----
  socket.on('pinMessage', async (data) => {
    const { groupId, messageId, userId } = data;
    if (!groups[groupId]) return;
    const isAdmin = groups[groupId].admins?.includes(userId) || groups[groupId].createdBy === userId;
    if (!isAdmin) return;
    const msg = groups[groupId].messages.find(m => m.id === messageId);
    if (!msg || msg.deleted) return;
    if (groups[groupId].pinned === messageId) {
      groups[groupId].pinned = null;
      await pool.query(`DELETE FROM group_pins WHERE group_id = $1`, [groupId]);
      io.to(groupId).emit('messageUnpinned', { messageId });
    } else {
      groups[groupId].pinned = messageId;
      await pool.query(
        `INSERT INTO group_pins (group_id, message_id) VALUES ($1, $2) ON CONFLICT (group_id) DO UPDATE SET message_id = $2`,
        [groupId, messageId]
      );
      io.to(groupId).emit('messagePinned', { messageId });
    }
  });

  // ---- ADMIN ACTIONS ----
  socket.on('toggleAdmin', async (data) => {
    const { groupId, userId, targetUserId, add } = data;
    if (!groups[groupId] || groups[groupId].createdBy !== userId) return socket.emit('error', { message: 'Not authorized' });
    if (add && !groups[groupId].admins.includes(targetUserId)) {
      groups[groupId].admins.push(targetUserId);
    } else if (!add) {
      groups[groupId].admins = groups[groupId].admins.filter(id => id !== targetUserId);
    }
    await saveGroupToDB(groupId);
    io.to(groupId).emit('adminUpdated', { targetUserId, isAdmin: add });
  });

  socket.on('renameGroup', async (data) => {
    const { groupId, newName, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      groups[groupId].name = newName;
      await saveGroupToDB(groupId);
      io.to(groupId).emit('groupRenamed', { newName, groupId });
    } else socket.emit('error', { message: 'Not authorized' });
  });

  socket.on('updateGroupMeta', async (data) => {
    const { groupId, userId, description, avatar } = data;
    if (!groups[groupId]) return;
    const isAdmin = groups[groupId].admins?.includes(userId) || groups[groupId].createdBy === userId;
    if (!isAdmin) return socket.emit('error', { message: 'Not authorized' });
    if (description !== undefined) groups[groupId].description = description;
    if (avatar !== undefined) groups[groupId].avatar = avatar;
    await saveGroupToDB(groupId);
    io.to(groupId).emit('groupMetaUpdated', { description: groups[groupId].description, avatar: groups[groupId].avatar });
  });

  socket.on('deleteGroup', async (data) => {
    const { groupId, userId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      io.to(groupId).emit('groupDeleted', { groupId });
      await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
      delete groups[groupId];
    } else socket.emit('error', { message: 'Not authorized' });
  });

  socket.on('removeMember', async (data) => {
    const { groupId, userId, targetUserId } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      groups[groupId].members = groups[groupId].members.filter(m => m.id !== targetUserId);
      await saveGroupToDB(groupId);
      io.to(groupId).emit('membersUpdate', groups[groupId].members);
      io.to(groupId).emit('memberRemoved', { userId: targetUserId });
    } else socket.emit('error', { message: 'Not authorized' });
  });

  socket.on('addMember', async (data) => {
    const { groupId, userId, newUserId, newUserName } = data;
    if (groups[groupId] && groups[groupId].createdBy === userId) {
      if (!groups[groupId].members.find(m => m.id === newUserId)) {
        groups[groupId].members.push({ id: newUserId, name: newUserName });
        await saveGroupToDB(groupId);
        io.to(groupId).emit('membersUpdate', groups[groupId].members);
        io.to(groupId).emit('memberAdded', { userId: newUserId, name: newUserName });
      }
    } else socket.emit('error', { message: 'Not authorized' });
  });

  // ---- TYPING ----
  socket.on('typing', (data) => {
    const { groupId, senderName, senderId } = data;
    socket.to(groupId).emit('typing', { senderName, senderId });
  });

  // ---- LEAVE / DISCONNECT ----
  socket.on('leaveGroup', async () => {
    const gid = socket.data.groupId;
    const uid = socket.data.userId;
    if (gid && groups[gid]) {
      groups[gid].members = groups[gid].members.filter(m => m.id !== uid);
      await saveGroupToDB(gid);
      io.to(gid).emit('membersUpdate', groups[gid].members);
    }
    socket.data.groupId = null;
    socket.data.userId = null;
  });

  socket.on('disconnect', async () => {
    const gid = socket.data.groupId;
    const uid = socket.data.userId;
    if (gid && groups[gid]) {
      groups[gid].members = groups[gid].members.filter(m => m.id !== uid);
      await saveGroupToDB(gid);
      io.to(gid).emit('membersUpdate', groups[gid].members);
    }
  });
});

// ============================================================
// REST API – ALOC PROXY with DB cache + format transformation
// ============================================================
app.get('/api/past-questions', async (req, res) => {
  const { exam, subject, year } = req.query;
  if (!exam || !subject || !year) {
    return res.status(400).json({ error: 'Missing exam, subject, or year' });
  }

  const token = process.env.ALOC_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'ALOC token not configured on server' });
  }

  const examMap = { jamb: 'utme', waec: 'wassce', neco: 'neco' };
  const type = examMap[exam.toLowerCase()] || 'utme';

  try {
    // 1️⃣ Check PostgreSQL cache (permanent)
    const cacheResult = await pool.query(
      'SELECT questions FROM past_questions_cache WHERE exam = $1 AND subject = $2 AND year = $3',
      [exam, subject, year]
    );
    if (cacheResult.rows.length > 0) {
      console.log(`✅ Cache hit (permanent): ${exam} ${subject} ${year}`);
      return res.json({ questions: cacheResult.rows[0].questions });
    }

    // 2️⃣ Fetch from ALOC
    console.log(`📡 Fetching from ALOC: ${subject} ${year} ${type}`);
    const url = `https://questions.aloc.com.ng/api/v2/q/50?subject=${encodeURIComponent(subject)}&year=${year}&type=${type}`;
    const response = await fetch(url, {
      headers: { 'AccessToken': token }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ ALOC error:', response.status, errorText);
      return res.status(response.status).json({ error: errorText || 'ALOC error' });
    }

    const data = await response.json();

    // 3️⃣ Transform ALOC format to frontend format
    const rawQuestions = data.data || data.questions || [];
    const questions = rawQuestions.map(q => {
      // Extract options from the `option` object
      const options = [
        q.option?.A || '',
        q.option?.B || '',
        q.option?.C || '',
        q.option?.D || ''
      ];
      // Determine correctOption index from answer letter
      let correctOption = 0;
      if (q.answer === 'A') correctOption = 0;
      else if (q.answer === 'B') correctOption = 1;
      else if (q.answer === 'C') correctOption = 2;
      else if (q.answer === 'D') correctOption = 3;
      return {
        question: q.question,
        options: options,
        correctOption: correctOption,
        explanation: q.explanation || ''
      };
    });

    console.log(`✅ ALOC returned ${questions.length} transformed questions`);

    // 4️⃣ Cache in PostgreSQL (permanent)
    if (questions.length > 0) {
      await pool.query(
        `INSERT INTO past_questions_cache (exam, subject, year, questions)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (exam, subject, year) DO UPDATE SET questions = EXCLUDED.questions`,
        [exam, subject, year, JSON.stringify(questions)]
      );
      console.log(`💾 Stored permanently: ${questions.length} questions`);
    }

    res.json({ questions });
  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', groups: Object.keys(groups).length });
});

app.get('/', (req, res) => {
  res.send('🚀 StudentNija Chat Server with ALOC & DB running!');
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, closing server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`   Database: ${process.env.DATABASE_URL ? '✅ connected' : '❌ missing'}`);
  console.log(`   ALOC: ${process.env.ALOC_ACCESS_TOKEN ? '✅ token set' : '⚠️ token missing (fallback only)'}`);
        });
