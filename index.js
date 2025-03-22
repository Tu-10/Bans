require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const moment = require('moment-timezone');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  Options
} = require('discord.js');

// For GitHub API requests (if needed)
const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

//------------------------------------------------------------------------------
// Configuration & Constants
//------------------------------------------------------------------------------
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'YOUR_DISCORD_BOT_TOKEN';
const primaryServerId = '955845654528286740';
const banChannelId = '955845658894553099';
const unbanChannelId = '955845659385290762';
const statsServerId = '969025362770165812';
const statsChannelId = '1240327815946305598';
const ownerId = '568484211644825612';
const whitelistedUsers = [ownerId];
const MIN_BAN_DATE = new Date(2024, 0, 1);
const DB_PATH = './bans.db';
const FOOTER_TEXT = 'Made with ♡ by 𝑻𝒖𝒓𝒌𝒊 10';

// Express server port
const PORT = process.env.PORT || 3000;

//------------------------------------------------------------------------------
// Express Setup
//------------------------------------------------------------------------------
const app = express();

// Serve static files from the "public" folder
app.use(express.static('public'));

// API Endpoint: Return active bans as JSON
app.get('/api/active-bans', async (req, res) => {
  try {
    const activeBans = await computeActiveBans();
    res.json(activeBans);
  } catch (err) {
    console.error('Error fetching active bans:', err);
    res.status(500).json({ error: 'Error fetching active bans' });
  }
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Express server is running on port ${PORT}`);
});

//------------------------------------------------------------------------------
// SQLite Setup
//------------------------------------------------------------------------------
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('Failed to open SQLite database:', err);
  else console.log('Connected to bans.db SQLite database.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      messageId TEXT UNIQUE,
      adminId TEXT,
      banId TEXT,
      reason TEXT,
      date INTEGER,
      url TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS unbans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      messageId TEXT UNIQUE,
      adminId TEXT,
      unbanId TEXT,
      date INTEGER,
      url TEXT
    )
  `);
});

//------------------------------------------------------------------------------
// Helper Functions
//------------------------------------------------------------------------------

// Generate Discord Snowflake from Date
function snowflakeFromDate(date) {
  const discordEpoch = 1420070400000;
  const timestampDiff = date.getTime() - discordEpoch;
  const snowflake = BigInt(timestampDiff) << BigInt(22);
  return snowflake.toString();
}

// Config get/set
function getConfig(key) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT value FROM config WHERE key = ?`, [key], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.value : null);
    });
  });
}

function setConfig(key, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO config(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      [key, value],
      function(err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

// Store ban and unban messages
function storeBan(messageId, ban) {
  return new Promise((resolve, reject) => {
    const dateTs = new Date(ban.date).getTime();
    db.run(
      `INSERT OR IGNORE INTO bans (messageId, adminId, banId, reason, date, url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [messageId, ban.adminId, ban.banId, ban.reason, dateTs, ban.url],
      function(err) {
        if (err) return reject(err);
        console.log(`[BAN ADDED] Admin: ${ban.adminId} | Ban ID: ${ban.banId} | Reason: ${ban.reason}`);
        resolve(this.changes);
      }
    );
  });
}

function storeUnban(messageId, unban) {
  return new Promise((resolve, reject) => {
    const dateTs = new Date(unban.date).getTime();
    db.run(
      `INSERT OR IGNORE INTO unbans (messageId, adminId, unbanId, date, url)
       VALUES (?, ?, ?, ?, ?)`,
      [messageId, unban.adminId, unban.unbanId, dateTs, unban.url],
      function(err) {
        if (err) return reject(err);
        console.log(`[UNBAN ADDED] Admin: ${unban.adminId} | Unban ID: ${unban.unbanId}`);
        resolve(this.changes);
      }
    );
  });
}

// Get all bans and unbans
function getAllBans() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM bans`, [], (err, rows) => {
      if (err) return reject(err);
      const data = rows.map(r => ({
        id: r.id,
        messageId: r.messageId,
        adminId: r.adminId,
        banId: r.banId,
        reason: r.reason,
        date: new Date(r.date),
        url: r.url
      }));
      resolve(data);
    });
  });
}

function getAllUnbans() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM unbans`, [], (err, rows) => {
      if (err) return reject(err);
      const data = rows.map(r => ({
        id: r.id,
        messageId: r.messageId,
        adminId: r.adminId,
        unbanId: r.unbanId,
        date: new Date(r.date),
        url: r.url
      }));
      resolve(data);
    });
  });
}

// Compute active bans (remove those with a later unban)
async function computeActiveBans() {
  const bans = await getAllBans();
  const unbans = await getAllUnbans();
  const active = [];
  for (const b of bans) {
    const banTime = new Date(b.date);
    const hasUnban = unbans.some(u => u.unbanId === b.banId && (new Date(u.date) > banTime));
    if (!hasUnban) {
      active.push(b);
    }
  }
  // Remove duplicates by banId
  const uniqueBans = [];
  const seen = new Set();
  for (const ban of active) {
    if (!seen.has(ban.banId)) {
      seen.add(ban.banId);
      uniqueBans.push(ban);
    }
  }
  return uniqueBans;
}

//------------------------------------------------------------------------------
// Message Extraction Functions
//------------------------------------------------------------------------------
function extractBanDetailsFromMessage(message) {
  if (!message.embeds || message.embeds.length === 0) return null;
  const embed = message.embeds[0];
  const desc = embed.description || '';
  const title = embed.title || '';
  let adminId = 'Unknown';
  let banId = 'Unknown';
  let reason = 'No reason';

  // Style 1
  {
    const adminIdRegex = /\*\*Admin ID\s*:\*\*\s*`(-?\d+)`/i;
    const banIdRegex = /\*\*(?:Ban|OffBan) ID\s*:\*\*\s*`(-?\d+)`/i;
    const reasonRegex = /\*\*Reason\s*:\*\*\s*`([^`]+)`/i;
    const a = desc.match(adminIdRegex);
    const b = desc.match(banIdRegex);
    const r = desc.match(reasonRegex);
    if (a && b) {
      adminId = a[1];
      banId = b[1];
      if (r) reason = r[1];
      return { adminId, banId, reason, date: message.createdAt, url: message.url };
    }
  }
  // Style 2
  if (title.toLowerCase().includes('normal ban') || desc.toLowerCase().includes('banned [id | reason]:')) {
    const adminRegex = /Admin id:\s*\*\*(.+?)\*\*/i;
    const banRegex = /banned\s*\[id\s*\|\s*reason\]:\s*\*\*\[([^|]+)\|\s*(.+)\]\*\*/i;
    const a = desc.match(adminRegex);
    const b = desc.match(banRegex);
    if (a && b) {
      adminId = a[1].trim();
      banId = b[1].trim();
      reason = b[2].trim() || 'No reason';
      return { adminId, banId, reason, date: message.createdAt, url: message.url };
    }
  }
  // Style 3
  {
    const adminIdRegex = /Admin Name\s*:\s*`[^`]*`\s*\|\s*ID\s*:\s*`(-?\d+)`/i;
    const reasonRegex = /Ban Player\s*\|\s*Reason\s*:\s*`([^`]+)`/i;
    const banIdRegex1 = /To Player\s*:\s*ID\s*:\s*`(\d+)`/i;
    const banIdRegex2 = /To Player\s*:\s*`(\d+)`\s*\|\s*ID\s*:\s*`(\d+)`/i;
    const a = desc.match(adminIdRegex);
    const r = desc.match(reasonRegex);
    if (a) adminId = a[1];
    if (r) reason = r[1];
    let b1 = desc.match(banIdRegex1);
    let b2 = desc.match(banIdRegex2);
    if (b2) {
      banId = b2[2];
    } else if (b1) {
      banId = b1[1];
    }
    if (adminId !== 'Unknown' && banId !== 'Unknown') {
      return { adminId, banId, reason, date: message.createdAt, url: message.url };
    }
  }
  return null;
}

function extractUnbanDetailsFromMessage(message) {
  if (!message.embeds || message.embeds.length === 0) return null;
  const embed = message.embeds[0];
  const desc = embed.description || '';
  const title = embed.title || '';
  let adminId = 'Unknown';
  let unbanId = 'Unknown';

  // Style 1
  {
    const adminIdRegex = /\*\*Admin ID\s*:\*\*\s*`(-?\d+)`/i;
    const unbanIdRegex = /\*\*UnBanned ID\s*:\*\*\s*`(-?\d+)`/i;
    const a = desc.match(adminIdRegex);
    const b = desc.match(unbanIdRegex);
    if (a && b) {
      adminId = a[1];
      unbanId = b[1];
      return { adminId, unbanId, date: message.createdAt, url: message.url };
    }
  }
  // Style 2
  if (title.toLowerCase().includes('unban') || desc.toLowerCase().includes('unbanned [id | reason]:')) {
    const adminRegex = /Admin id:\s*\*\*(.+?)\*\*/i;
    const unbanRegex = /unbanned\s*\[id\s*\|\s*reason\]:\s*\*\*\[([^|]+)\|(.*)\]\*\*/i;
    const a = desc.match(adminRegex);
    const b = desc.match(unbanRegex);
    if (a && b) {
      adminId = a[1].trim();
      unbanId = b[1].trim();
      return { adminId, unbanId, date: message.createdAt, url: message.url };
    }
  }
  // Style 3
  {
    const adminIdRegex = /Admin Name\s*:\s*`[^`]*`\s*\|\s*ID\s*:\s*`(-?\d+)`/i;
    const unbanIdRegex = /UnBan Player\s*\|\s*ID\s*:\s*`(-?\d+)`/i;
    const a = desc.match(adminIdRegex);
    const b = desc.match(unbanIdRegex);
    if (a && b) {
      adminId = a[1];
      unbanId = b[1];
      return { adminId, unbanId, date: message.createdAt, url: message.url };
    }
  }
  return null;
}

//------------------------------------------------------------------------------
// Discord Client Setup
//------------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  // Limit cache for messages if desired
  makeCache: Options.cacheWithLimits({
    MessageManager: { maxSize: 50 }
  })
});

//------------------------------------------------------------------------------
// Discord Bot Event Handling
//------------------------------------------------------------------------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Commands for owner/whitelisted users
  if (whitelistedUsers.includes(message.author.id)) {
    const args = message.content.trim().split(' ');
    const command = args[0].toLowerCase();

    if (command === '!تحديث' && message.author.id === ownerId) {
      const replyMsg = await message.reply({
        embeds: [
          new EmbedBuilder()
            .setDescription('جاري التحديث وجلب الرسائل...')
            .setColor(0xFFA500)
            .setFooter({ text: FOOTER_TEXT })
        ]
      });
      try {
        await autoUpdateBans();
        await replyMsg.edit({
          embeds: [
            new EmbedBuilder()
              .setDescription('تم التحديث بنجاح.')
              .setColor(0xFFA500)
              .setFooter({ text: FOOTER_TEXT })
          ]
        });
        setTimeout(() => { replyMsg.delete().catch(() => {}); }, 5000);
      } catch (err) {
        console.error(err);
        await replyMsg.edit({
          embeds: [
            new EmbedBuilder()
              .setDescription('حدث خطأ أثناء التحديث.')
              .setColor(0xff0000)
              .setFooter({ text: FOOTER_TEXT })
          ]
        });
        setTimeout(() => { replyMsg.delete().catch(() => {}); }, 5000);
      }
    } else if (command === '!help') {
      const helpText = `
**أوامر البوت**:
- \`!تحديث\`: جلب الرسائل القديمة وتحديث البيانات.
- \`!help\`: عرض رسالة المساعدة.
      `;
      const embed = new EmbedBuilder()
        .setTitle('أوامر البوت')
        .setDescription(helpText)
        .setColor(0xFFA500)
        .setFooter({ text: FOOTER_TEXT });
      await message.reply({ embeds: [embed] });
    }
  }

  // Process messages in ban/unban channels if message has embeds
  if (!message.embeds.length) return;
  if (message.channel.id === banChannelId) {
    const details = extractBanDetailsFromMessage(message);
    if (details) {
      try {
        const changes = await storeBan(message.id, details);
        if (changes > 0) {
          console.log(`[BAN] New ban => Admin:${details.adminId}, BanID:${details.banId}`);
          await autoUpdateBans();
        } else {
          console.log('[BAN] Duplicate or no changes.');
        }
      } catch (err) {
        console.error('Error storing ban message:', err);
      }
    } else {
      console.log('[BAN] Embed found but not matched by the regex patterns.');
    }
  } else if (message.channel.id === unbanChannelId) {
    const details = extractUnbanDetailsFromMessage(message);
    if (details) {
      try {
        const changes = await storeUnban(message.id, details);
        if (changes > 0) {
          console.log(`[UNBAN] New unban => Admin:${details.adminId}, UnbanID:${details.unbanId}`);
          await autoUpdateBans();
        } else {
          console.log('[UNBAN] Duplicate or no changes.');
        }
      } catch (err) {
        console.error('Error storing unban message:', err);
      }
    } else {
      console.log('[UNBAN] Embed found but not matched by the regex patterns.');
    }
  }
});

//------------------------------------------------------------------------------
// Auto-Update Ban/Unban Messages
//------------------------------------------------------------------------------
async function autoUpdateBans() {
  console.log('Fetching ban/unban messages...');
  let newBanMessages = 0;
  let newUnbanMessages = 0;
  try {
    const guildA = client.guilds.cache.get(primaryServerId);
    if (!guildA) {
      console.log('Primary guild not found.');
      return;
    }
    const banCh = await guildA.channels.fetch(banChannelId).catch(() => null);
    const unbanCh = await guildA.channels.fetch(unbanChannelId).catch(() => null);
    if (!banCh || !unbanCh) {
      console.log('Ban/Unban channels not found.');
      return;
    }
    newBanMessages += await fetchBanMessages(banCh);
    newUnbanMessages += await fetchUnbanMessages(unbanCh);
    console.log(`[AUTO] Done. Bans: ${newBanMessages}, Unbans: ${newUnbanMessages}`);
  } catch (err) {
    console.error('autoUpdateBans error:', err);
  }
}

async function fetchBanMessages(channel) {
  let lastId = await getConfig('lastBanMessageId');
  let fetchedCount = 0;
  let done = false;
  while (!done) {
    let options = { limit: 100 };
    if (lastId) {
      options.after = lastId;
    } else {
      options.after = snowflakeFromDate(MIN_BAN_DATE);
    }
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) {
      done = true;
      break;
    }
    const sorted = fetched.sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
    let newestMsg = null;
    for (const [mid, msg] of sorted) {
      const msgDate = new Date(msg.createdAt);
      if (msgDate < MIN_BAN_DATE) continue;
      const details = extractBanDetailsFromMessage(msg);
      if (details) {
        const changes = await storeBan(msg.id, details);
        if (changes > 0) fetchedCount++;
      }
      newestMsg = msg;
    }
    if (newestMsg) {
      lastId = newestMsg.id;
      await setConfig('lastBanMessageId', lastId);
    }
    if (fetched.size < 100) {
      done = true;
    }
  }
  return fetchedCount;
}

async function fetchUnbanMessages(channel) {
  let lastId = await getConfig('lastUnbanMessageId');
  let fetchedCount = 0;
  let done = false;
  while (!done) {
    let options = { limit: 100 };
    if (lastId) {
      options.after = lastId;
    } else {
      options.after = snowflakeFromDate(MIN_BAN_DATE);
    }
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) {
      done = true;
      break;
    }
    const sorted = fetched.sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
    let newestMsg = null;
    for (const [mid, msg] of sorted) {
      const msgDate = new Date(msg.createdAt);
      if (msgDate < MIN_BAN_DATE) continue;
      const details = extractUnbanDetailsFromMessage(msg);
      if (details) {
        const changes = await storeUnban(msg.id, details);
        if (changes > 0) fetchedCount++;
      }
      newestMsg = msg;
    }
    if (newestMsg) {
      lastId = newestMsg.id;
      await setConfig('lastUnbanMessageId', lastId);
    }
    if (fetched.size < 100) {
      done = true;
    }
  }
  return fetchedCount;
}

//------------------------------------------------------------------------------
// Discord Client Ready Event
//------------------------------------------------------------------------------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}. Running initial autoUpdateBans...`);
  await autoUpdateBans();
  setInterval(async () => { await autoUpdateBans(); }, 600000); // every 10 minutes
});

//------------------------------------------------------------------------------
// Log in the Discord Client
//------------------------------------------------------------------------------
client.login('MTI2NjIzNDUxNzY4NjA2MzE0NQ.G2DIBd.LZ47DXFLNiFxh0wippcXs8TWt1O2iS0eXNPCxY');
