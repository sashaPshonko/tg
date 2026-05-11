const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api, errors } = require('telegram');
const fs = require('fs');
const path = require('path');
const input = require('input');

// КОНФИГУРАЦИЯ
const config = {
  apiId: 2040,
  apiHash: 'b18441a1ff607e10a989891a5462e627',
  interval: 60 * 1000,
  accountsFile: './accounts.json',
  chatsFile: './chats.json',
  messagesFile: './messages.json',
  sessionDir: './sessions',
  distributionFile: './distribution.json',
};

let distribution = {};
let messages = [];
let allChats = [];
let accounts = [];
let clients = new Map();

// ========== FLOOD И SLOW MODE HANDLERS ==========

function getFloodWaitSeconds(error) {
  if (error.message && error.message.match(/FLOOD_WAIT_(\d+)/i)) {
    const match = error.message.match(/FLOOD_WAIT_(\d+)/i);
    return parseInt(match[1], 10);
  }
  
  if (error.seconds && typeof error.seconds === 'number') {
    return error.seconds;
  }
  
  if (error.message) {
    const numbers = error.message.match(/\b(\d+)\b/);
    if (numbers && error.message.toLowerCase().includes('flood')) {
      return parseInt(numbers[1], 10);
    }
  }
  
  return null;
}

function getSlowModeWaitSeconds(error) {
  const msg = error.message || '';
  const match = msg.match(/wait of (\d+) seconds/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function isFloodError(error) {
  if (error.name === 'FloodWaitError' || error.name === 'RpcError') {
    const msg = (error.message || '').toLowerCase();
    if (msg.includes('flood_wait') || msg.includes('flood')) {
      return true;
    }
  }
  
  if (error instanceof errors.FloodWaitError) {
    return true;
  }
  
  const msg = (error.message || '').toLowerCase();
  return msg.includes('flood') || msg.includes('too many requests');
}

function isSlowModeError(error) {
  const msg = (error.message || '').toLowerCase();
  const name = error.name || '';
  
  if (name === 'SlowModeWaitError') {
    return true;
  }
  
  if (msg.includes('slow mode') || 
      (msg.includes('wait of') && msg.includes('seconds') && msg.includes('before sending'))) {
    return true;
  }
  
  return false;
}

function isNotMemberError(error) {
  const msg = (error.message || '').toLowerCase();
  return msg.includes('not a member') || 
         msg.includes('not participated') ||
         msg.includes('user not participant') ||
         msg.includes('chat_write_forbidden') ||
         msg.includes('user is not a member') ||
         msg.includes('member access');
}

// ========== РАБОТА С РАСПРЕДЕЛЕНИЕМ ==========

function loadDistribution() {
  try {
    if (fs.existsSync(config.distributionFile)) {
      const data = JSON.parse(fs.readFileSync(config.distributionFile, 'utf-8'));
      distribution = data;
      console.log(`📋 Загружено распределение чатов по аккаунтам`);
      for (const [acc, chats] of Object.entries(distribution)) {
        console.log(`   👤 ${acc}: ${chats.length} чатов`);
      }
    }
  } catch (error) {
    console.error('Ошибка загрузки distribution.json:', error.message);
    distribution = {};
  }
}

function saveDistribution() {
  try {
    fs.writeFileSync(config.distributionFile, JSON.stringify(distribution, null, 2), 'utf-8');
    console.log(`💾 Распределение сохранено`);
  } catch (error) {
    console.error('Ошибка сохранения distribution.json:', error.message);
  }
}

function initDistribution() {
  if (Object.keys(distribution).length === 0 && accounts.length > 0) {
    const firstBot = accounts[0].phone;
    distribution[firstBot] = [...allChats];
    saveDistribution();
    console.log(`🔄 Инициализация: все ${allChats.length} чатов отданы аккаунту ${firstBot}`);
  }
}

async function reassignChat(chat, bannedBot) {
  console.log(`\n🔄 Чат ${chat} переводим от ${bannedBot} к следующему...`);
  
  if (distribution[bannedBot]) {
    distribution[bannedBot] = distribution[bannedBot].filter(c => c !== chat);
    console.log(`   📉 У ${bannedBot} осталось ${distribution[bannedBot].length} чатов`);
  }
  
  let nextBot = null;
  for (const account of accounts) {
    if (account.phone !== bannedBot) {
      nextBot = account.phone;
      break;
    }
  }
  
  if (!nextBot) {
    console.log(`   ❌ Нет доступных аккаунтов для чата ${chat}!`);
    return false;
  }
  
  if (!distribution[nextBot]) {
    distribution[nextBot] = [];
  }
  distribution[nextBot].push(chat);
  console.log(`   ✅ Чат ${chat} передан ${nextBot} (у него теперь ${distribution[nextBot].length} чатов)`);
  
  saveDistribution();
  return true;
}

function removeUselessAccounts() {
  const uselessAccounts = [];
  
  for (const [acc, chats] of Object.entries(distribution)) {
    if (chats.length === 0) {
      uselessAccounts.push(acc);
    }
  }
  
  for (const acc of uselessAccounts) {
    console.log(`🗑️ Аккаунт ${acc} не обслуживает ни один чат — удаляем из системы`);
    delete distribution[acc];
    
    const index = accounts.findIndex(accData => accData.phone === acc);
    if (index !== -1) {
      accounts.splice(index, 1);
    }
    
    const client = clients.get(acc);
    if (client) {
      client.disconnect().catch(() => {});
      clients.delete(acc);
    }
  }
  
  if (uselessAccounts.length > 0) {
    const accountsData = { accounts: accounts };
    fs.writeFileSync(config.accountsFile, JSON.stringify(accountsData, null, 2), 'utf-8');
    saveDistribution();
    console.log(`💾 Обновлён список аккаунтов (осталось ${accounts.length})`);
  }
}

// ========== ФУНКЦИИ ДЛЯ РАБОТЫ С ЧАТАМИ ==========

function extractInviteHash(link) {
  if (link.includes('t.me/joinchat/')) {
    return link.split('t.me/joinchat/')[1];
  }
  if (link.includes('t.me/+')) {
    return link.split('t.me/+')[1];
  }
  return null;
}

async function joinChatByInviteLink(client, chatIdentifier) {
  try {
    const inviteHash = extractInviteHash(chatIdentifier);
    if (!inviteHash) {
      console.log(`   ⚠️ Не удалось извлечь invite hash из: ${chatIdentifier}`);
      return false;
    }
    
    console.log(`   🔗 Вступаем по ссылке: ${chatIdentifier}`);
    
    const result = await client.invoke(new Api.messages.ImportChatInvite({
      hash: inviteHash
    }));
    
    console.log(`   ✅ Успешно вступили в чат!`);
    return true;
  } catch (error) {
    console.log(`   ❌ Ошибка при вступлении: ${error.message}`);
    
    if (error.message.includes('already a participant')) {
      console.log(`   ℹ️ Уже участник чата`);
      return true;
    }
    
    if (error.message.includes('invite hash expired')) {
      console.log(`   ⏰ Ссылка-приглашение просрочена!`);
    }
    
    if (error.message.includes('USER_BANNED_IN_CHANNEL')) {
      console.log(`   🚫 Пользователь забанен в этом канале/чате!`);
    }
    
    if (error.message.includes('CHANNEL_PRIVATE')) {
      console.log(`   🔒 Канал/чат приватный, нет доступа`);
    }
    
    return false;
  }
}

function usernameToInviteLink(username) {
  const cleanUsername = username.replace('@', '');
  return `https://t.me/${cleanUsername}`;
}

function isUsername(chatIdentifier) {
  if (typeof chatIdentifier !== 'string') return false;
  if (chatIdentifier.includes('t.me/')) return false;
  if (chatIdentifier.includes('http')) return false;
  if (/^[\+\d]+$/.test(chatIdentifier)) return false;
  return true;
}

async function joinPublicChatByUsername(client, username) {
  try {
    console.log(`   🔗 Пробуем вступить по username: ${username}`);
    
    try {
      const entity = await client.getEntity(username);
      console.log(`   📊 Получена сущность: ${entity.className}, ID: ${entity.id}`);
      
      if (entity.className === 'Channel') {
        console.log(`   📺 Это канал, пробуем подписаться...`);
        await client.invoke(new Api.channels.JoinChannel({
          channel: entity
        }));
        console.log(`   ✅ Подписались на канал!`);
        return true;
      }
      
      if (entity.className === 'Chat') {
        console.log(`   👥 Это группа, пробуем вступить...`);
        const inviteLink = usernameToInviteLink(username);
        return await joinChatByInviteLink(client, inviteLink);
      }
      
    } catch (error) {
      console.log(`   ❌ Ошибка при работе с сущностью: ${error.message}`);
    }
    
    return false;
  } catch (error) {
    console.log(`   ❌ Не удалось вступить в ${username}: ${error.message}`);
    return false;
  }
}

async function tryJoinChat(client, chat) {
  console.log(`   🔗 Пробуем вступить в чат...`);
  
  if (chat.includes('t.me/joinchat/') || chat.includes('t.me/+')) {
    return await joinChatByInviteLink(client, chat);
  } else if (isUsername(chat)) {
    return await joinPublicChatByUsername(client, chat);
  } else {
    return await joinChatByInviteLink(client, chat);
  }
}

// ========== ОСНОВНАЯ ФУНКЦИЯ ОТПРАВКИ ==========

async function sendFromAccount(botPhone, botName, client, message) {
  const botChats = distribution[botPhone] || [];
  
  if (botChats.length === 0) {
    return;
  }
  
  console.log(`\n📤 ${botName} отправляет в ${botChats.length} чатов`);
  
  for (const chat of botChats) {
    try {
      // Пробуем отправить сообщение сразу, без тестового
      await client.sendMessage(chat, { message });
      console.log(`  ✅ ${botName} -> ${chat}`);
      
    } catch (error) {
      // 1. SLOW MODE - просто пропускаем, чат НЕ ПЕРЕВОДИМ
      if (isSlowModeError(error)) {
        const waitSeconds = getSlowModeWaitSeconds(error);
        if (waitSeconds) {
          console.log(`  🐌 ${botName} -> ${chat}: SLOW MODE (ждать ${waitSeconds}с), пропускаем в этом цикле`);
        } else {
          console.log(`  🐌 ${botName} -> ${chat}: SLOW MODE, пропускаем в этом цикле`);
        }
        console.log(`  📋 Тип ошибки: SlowModeWaitError → чат остаётся у этого аккаунта, попробуем в следующем цикле`);
        // Просто пропускаем этот чат в текущем цикле
        continue;
      }
      
      // 2. FLOOD - ждём и пробуем снова
      if (isFloodError(error)) {
        const waitSeconds = getFloodWaitSeconds(error) || 30;
        console.log(`  🌊 ${botName} -> ${chat}: FLOOD_WAIT ${waitSeconds}с, ждём...`);
        
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        
        try {
          await client.sendMessage(chat, { message });
          console.log(`  ✅ ${botName} -> ${chat}: успешно после FLOOD_WAIT`);
        } catch (retryError) {
          if (isSlowModeError(retryError)) {
            console.log(`  🐌 ${botName} -> ${chat}: SLOW MODE после FLOOD, пропускаем`);
          } else if (isFloodError(retryError)) {
            console.log(`  ⏭️ ${botName} -> ${chat}: опять FLOOD, пропускаем на этот раз`);
          } else if (isNotMemberError(retryError)) {
            console.log(`  🔑 ${botName} -> ${chat}: нет доступа после FLOOD, пробуем вступить...`);
            const joined = await tryJoinChat(client, chat);
            if (joined) {
              try {
                await client.sendMessage(chat, { message });
                console.log(`  ✅ ${botName} -> ${chat}: успешно после вступления`);
              } catch (sendError) {
                console.log(`  ❌ ${botName} -> ${chat}: не удалось отправить, передаём другому`);
                await reassignChat(chat, botPhone);
              }
            } else {
              await reassignChat(chat, botPhone);
            }
          } else {
            console.log(`  ❌ ${botName} -> ${chat}: повторная отправка не удалась, передаём другому`);
            await reassignChat(chat, botPhone);
          }
        }
        continue;
      }
      
      // 3. Нет доступа / не участник чата - пробуем вступить
      if (isNotMemberError(error)) {
        console.log(`  🔑 ${botName} -> ${chat}: нет доступа, пробуем вступить...`);
        const joined = await tryJoinChat(client, chat);
        
        if (joined) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          try {
            await client.sendMessage(chat, { message });
            console.log(`  ✅ ${botName} -> ${chat}: успешно после вступления`);
          } catch (sendError) {
            console.log(`  ❌ ${botName} -> ${chat}: не удалось отправить после вступления, передаём другому`);
            await reassignChat(chat, botPhone);
          }
        } else {
          console.log(`  ❌ ${botName} -> ${chat}: не удалось вступить, передаём другому`);
          await reassignChat(chat, botPhone);
        }
        continue;
      }
      
      // 4. Все остальные ошибки - переassign
      console.log(`  🚫 ${botName} -> ${chat}: ${error.message.substring(0, 80)}`);
      console.log(`  📋 Тип ошибки: ${error.constructor.name}, переводим на другой аккаунт`);
      await reassignChat(chat, botPhone);
    }
    
    // Задержка между отправками
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function sendToAllChats() {
  const message = getRandomMessage();
  console.log(`\n🔄 Новый цикл (${new Date().toLocaleTimeString()})`);
  console.log(`📝 Сообщение: "${message}"`);
  
  for (const account of accounts) {
    const client = clients.get(account.phone);
    if (!client) continue;
    
    const botChats = distribution[account.phone] || [];
    if (botChats.length === 0) continue;
    
    await sendFromAccount(account.phone, account.name, client, message);
  }
  
  removeUselessAccounts();
  
  console.log(`\n📊 Статистика после цикла:`);
  for (const [acc, chats] of Object.entries(distribution)) {
    console.log(`   👤 ${acc}: ${chats.length} чатов`);
  }
}

// ========== ЗАГРУЗОЧНЫЕ ФУНКЦИИ ==========

function loadMessages() {
  try {
    const data = JSON.parse(fs.readFileSync(config.messagesFile, 'utf-8'));
    messages = data.messages;
    console.log(`✅ Загружено ${messages.length} сообщений`);
  } catch (error) {
    console.error('❌ Ошибка загрузки messages.json:', error.message);
    messages = ['Тестовое сообщение'];
  }
}

function loadChats() {
  try {
    const data = JSON.parse(fs.readFileSync(config.chatsFile, 'utf-8'));
    allChats = data.chats;
    console.log(`✅ Загружено ${allChats.length} чатов`);
  } catch (error) {
    console.error('❌ Ошибка загрузки chats.json:', error.message);
    process.exit(1);
  }
}

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(config.accountsFile, 'utf-8'));
    accounts = data.accounts;
    console.log(`✅ Загружено ${accounts.length} аккаунтов`);
    accounts.forEach(acc => {
      console.log(`   - ${acc.name} (${acc.phone})`);
    });
  } catch (error) {
    console.error('❌ Ошибка загрузки accounts.json:', error.message);
    process.exit(1);
  }
}

function getRandomMessage() {
  const randomIndex = Math.floor(Math.random() * messages.length);
  return messages[randomIndex];
}

function loadSession(phone) {
  const safePhone = phone.replace(/[^0-9]/g, '');
  const sessionPath = path.join(config.sessionDir, `${safePhone}.json`);
  try {
    if (fs.existsSync(sessionPath)) {
      const sessionData = fs.readFileSync(sessionPath, 'utf-8');
      return new StringSession(sessionData);
    }
  } catch (error) {
    console.error(`Ошибка загрузки сессии для ${phone}:`, error.message);
  }
  return new StringSession('');
}

function saveSession(phone, sessionString) {
  if (!fs.existsSync(config.sessionDir)) {
    fs.mkdirSync(config.sessionDir, { recursive: true });
  }
  const safePhone = phone.replace(/[^0-9]/g, '');
  const sessionPath = path.join(config.sessionDir, `${safePhone}.json`);
  try {
    fs.writeFileSync(sessionPath, sessionString, 'utf-8');
    console.log(`💾 Сессия сохранена для ${phone}`);
  } catch (error) {
    console.error(`Ошибка сохранения сессии для ${phone}:`, error.message);
  }
}

async function authorizeAccount(account) {
  if (account.authKey && account.dcId) {
    console.log(`\n👤 Авторизация по Auth Key: ${account.name}`);
    const sessionString = `${account.authKey}${account.dcId}`;
    const session = new StringSession(sessionString);
    const client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: 3,
      useWSS: true,
      floodSleepThreshold: 60,
    });
    try {
      await client.connect();
      await client.getMe();
      console.log(`✅ ${account.name} авторизован по Auth Key`);
      saveSession(account.phone, session.save());
      return { client, name: account.name, phone: account.phone };
    } catch (error) {
      console.error(`❌ Ошибка авторизации по Auth Key: ${error.message}`);
      throw error;
    }
  }
  
  const session = loadSession(account.phone);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 3,
    useWSS: true,
    floodSleepThreshold: 60,
  });

  console.log(`\n👤 Авторизация: ${account.name} (${account.phone})`);
  
  await client.start({
    phoneNumber: async () => account.phone,
    password: async () => {
      const pass = await input.text('🔐 Введите пароль 2FA (если есть, иначе Enter): ');
      return pass || undefined;
    },
    phoneCode: async () => {
      const code = await input.text('📨 Введите код из Telegram: ');
      return code;
    },
    onError: (err) => console.error(`Ошибка ${account.name}:`, err),
  });

  saveSession(account.phone, client.session.save());
  console.log(`✅ ${account.name} авторизован`);
  
  return { client, name: account.name, phone: account.phone };
}

// ========== MAIN ==========

async function main() {
  console.log('🚀 Запуск Telegram отправителя (автовступление в чаты)');
  console.log('====================================================\n');
  
  loadAccounts();
  loadChats();
  loadMessages();
  loadDistribution();
  
  if (accounts.length === 0) {
    console.error('❌ Нет аккаунтов в accounts.json');
    process.exit(1);
  }
  
  if (allChats.length === 0) {
    console.error('❌ Нет чатов в chats.json');
    process.exit(1);
  }
  
  console.log('\n🔐 Авторизация аккаунтов...');
  
  for (const account of accounts) {
    try {
      const { client, name, phone } = await authorizeAccount(account);
      clients.set(phone, client);
    } catch (error) {
      console.error(`❌ Не удалось авторизовать ${account.name}:`, error.message);
    }
  }
  
  if (clients.size === 0) {
    console.error('❌ Не удалось авторизовать ни одного аккаунта');
    process.exit(1);
  }
  
  initDistribution();
  
  console.log(`\n✅ Авторизовано ${clients.size} аккаунтов`);
  console.log(`📋 Всего чатов: ${allChats.length}`);
  console.log(`⏱️  Интервал: ${config.interval / 1000} секунд`);
  console.log(`🎲 Сообщения выбираются рандомно`);
  console.log(`🔗 Аккаунты автоматически вступают в чаты при необходимости\n`);
  
  await sendToAllChats();
  
  setInterval(sendToAllChats, config.interval);
  
  process.on('SIGINT', async () => {
    console.log('\n\n👋 Завершение работы...');
    for (const client of clients.values()) {
      await client.disconnect();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});