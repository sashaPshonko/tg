const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const input = require('input');

const config = {
  apiId: 2040,
  apiHash: 'b18441a1ff607e10a989891a5462e627',
  accountsFile: './accounts.json',
  sessionDir: './sessions',
};

function loadAccounts() {
  try {
    const data = JSON.parse(fs.readFileSync(config.accountsFile, 'utf-8'));
    console.log(`📋 Загружено ${data.accounts.length} аккаунтов:`);
    data.accounts.forEach(acc => {
      console.log(`   - ${acc.name} (${acc.phone})`);
    });
    return data.accounts;
  } catch (error) {
    console.error('❌ Ошибка загрузки accounts.json:', error.message);
    process.exit(1);
  }
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
  // Если есть authKey и dcId — используем их
  if (account.authKey && account.dcId) {
    console.log(`\n🔑 ${account.name}: пробуем авторизацию по Auth Key...`);
    const sessionString = `${account.authKey}${account.dcId}`;
    const session = new StringSession(sessionString);
    const client = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: 3,
      useWSS: true,
      floodSleepThreshold: 60,
    });
    
    try {
      await client.connect();
      const me = await client.getMe();
      console.log(`✅ ${account.name} авторизован по Auth Key (ID: ${me.id})`);
      saveSession(account.phone, session.save());
      await client.disconnect();
      return true;
    } catch (error) {
      console.log(`   ❌ Auth Key не работает: ${error.message}`);
      console.log(`   → Пробуем обычную авторизацию...`);
    }
  }
  
  // Обычная авторизация через код
  console.log(`\n📱 ${account.name} (${account.phone}): авторизация...`);
  
  const session = loadSession(account.phone);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 3,
    useWSS: true,
    floodSleepThreshold: 60,
  });
  
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
    onError: (err) => console.error(`   Ошибка:`, err),
  });
  
  const me = await client.getMe();
  console.log(`✅ ${account.name} авторизован (ID: ${me.id})`);
  saveSession(account.phone, client.session.save());
  await client.disconnect();
  return true;
}

async function main() {
  console.log('🚀 Регистрация всех аккаунтов из accounts.json');
  console.log('===============================================\n');
  
  const accounts = loadAccounts();
  
  if (accounts.length === 0) {
    console.error('❌ Нет аккаунтов в accounts.json');
    process.exit(1);
  }
  
  let success = 0;
  let fail = 0;
  
  for (const account of accounts) {
    try {
      const ok = await authorizeAccount(account);
      if (ok) {
        success++;
      } else {
        fail++;
      }
    } catch (error) {
      console.error(`❌ ${account.name}: ошибка — ${error.message}`);
      fail++;
    }
    console.log('---');
  }
  
  console.log(`\n📊 Итог: ${success} успешно, ${fail} ошибок`);
}

main().catch(console.error);