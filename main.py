#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import asyncio
import json
import os
import random
import re
from pathlib import Path
from datetime import datetime

from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from telethon.tl.functions.messages import ImportChatInviteRequest
from telethon.tl.types import InputPeerChat, InputPeerChannel

# ========== КОНФИГУРАЦИЯ ==========
CONFIG = {
    "api_id": 2040,
    "api_hash": "b18441a1ff607e10a989891a5462e627",
    "interval": 60,  # интервал отправки (секунд)
    "accounts_file": "./accounts.json",
    "chats_file": "./chats.json",
    "messages_file": "./messages.json",
    "session_dir": "./sessions",
    "distribution_file": "./distribution.json"
}

# Глобальные переменные
distribution = {}
messages = []
all_chats = []
accounts = []
clients = {}  # phone -> client

# ========== РАБОТА С РАСПРЕДЕЛЕНИЕМ ==========

def load_distribution():
    global distribution
    try:
        if os.path.exists(CONFIG["distribution_file"]):
            with open(CONFIG["distribution_file"], "r", encoding="utf-8") as f:
                distribution = json.load(f)
            print("📋 Загружено распределение чатов по аккаунтам")
            for acc, chats in distribution.items():
                print(f"   👤 {acc}: {len(chats)} чатов")
    except Exception as e:
        print(f"Ошибка загрузки distribution.json: {e}")
        distribution = {}

def save_distribution():
    try:
        with open(CONFIG["distribution_file"], "w", encoding="utf-8") as f:
            json.dump(distribution, f, ensure_ascii=False, indent=2)
        print("💾 Распределение сохранено")
    except Exception as e:
        print(f"Ошибка сохранения distribution.json: {e}")

def init_distribution():
    global distribution
    if not distribution and accounts:
        first_acc = accounts[0]["phone"]
        distribution[first_acc] = all_chats.copy()
        save_distribution()
        print(f"🔄 Инициализация: все {len(all_chats)} чатов отданы аккаунту {first_acc}")

def reassign_chat(chat, banned_phone):
    global distribution, accounts
    print(f"\n🔄 Чат {chat} переводим от {banned_phone} к следующему...")
    
    if banned_phone in distribution:
        distribution[banned_phone] = [c for c in distribution[banned_phone] if c != chat]
        print(f"   📉 У {banned_phone} осталось {len(distribution[banned_phone])} чатов")
    
    # Ищем следующего аккаунта
    next_acc = None
    for acc in accounts:
        if acc["phone"] != banned_phone:
            next_acc = acc["phone"]
            break
    
    if not next_acc:
        print(f"   ❌ Нет доступных аккаунтов для чата {chat}!")
        return False
    
    if next_acc not in distribution:
        distribution[next_acc] = []
    distribution[next_acc].append(chat)
    print(f"   ✅ Чат {chat} передан {next_acc} (у него теперь {len(distribution[next_acc])} чатов)")
    
    save_distribution()
    return True

def remove_useless_accounts():
    global distribution, accounts, clients
    useless = []
    
    for acc, chats in distribution.items():
        if not chats:
            useless.append(acc)
    
    for acc in useless:
        print(f"🗑️ Аккаунт {acc} не обслуживает ни один чат — удаляем из системы")
        del distribution[acc]
        
        # Удаляем из списка аккаунтов
        accounts = [a for a in accounts if a["phone"] != acc]
        
        # Отключаем клиента
        if acc in clients:
            asyncio.create_task(clients[acc].disconnect())
            del clients[acc]
    
    if useless:
        with open(CONFIG["accounts_file"], "w", encoding="utf-8") as f:
            json.dump({"accounts": accounts}, f, ensure_ascii=False, indent=2)
        save_distribution()
        print(f"💾 Обновлён список аккаунтов (осталось {len(accounts)})")

# ========== РАБОТА С ФАЙЛАМИ ==========

def load_messages():
    global messages
    try:
        with open(CONFIG["messages_file"], "r", encoding="utf-8") as f:
            data = json.load(f)
            messages = data.get("messages", [])
        print(f"✅ Загружено {len(messages)} сообщений")
    except Exception as e:
        print(f"❌ Ошибка загрузки messages.json: {e}")
        messages = ["Тестовое сообщение"]

def load_chats():
    global all_chats
    try:
        with open(CONFIG["chats_file"], "r", encoding="utf-8") as f:
            data = json.load(f)
            all_chats = data.get("chats", [])
        print(f"✅ Загружено {len(all_chats)} чатов")
    except Exception as e:
        print(f"❌ Ошибка загрузки chats.json: {e}")
        exit(1)

def load_accounts():
    global accounts
    try:
        with open(CONFIG["accounts_file"], "r", encoding="utf-8") as f:
            data = json.load(f)
            accounts = data.get("accounts", [])
        print(f"✅ Загружено {len(accounts)} аккаунтов")
        for acc in accounts:
            print(f"   - {acc['name']} ({acc['phone']})")
    except Exception as e:
        print(f"❌ Ошибка загрузки accounts.json: {e}")
        exit(1)

def get_random_message():
    return random.choice(messages)

def get_session_path(phone):
    safe_phone = re.sub(r"[^0-9]", "", phone)
    return Path(CONFIG["session_dir"]) / f"{safe_phone}.session"

def load_session(phone):
    session_path = get_session_path(phone)
    if session_path.exists():
        try:
            with open(session_path, "r", encoding="utf-8") as f:
                session_string = f.read().strip()
            if session_string:
                return StringSession(session_string)
        except Exception as e:
            print(f"Ошибка загрузки сессии для {phone}: {e}")
    return StringSession("")

def save_session(phone, session_string):
    Path(CONFIG["session_dir"]).mkdir(parents=True, exist_ok=True)
    session_path = get_session_path(phone)
    try:
        with open(session_path, "w", encoding="utf-8") as f:
            f.write(session_string)
        print(f"💾 Сессия сохранена для {phone}")
    except Exception as e:
        print(f"Ошибка сохранения сессии для {phone}: {e}")

# ========== РАБОТА С ЧАТАМИ ==========

def extract_invite_hash(link):
    if "t.me/joinchat/" in link:
        return link.split("t.me/joinchat/")[1]
    if "t.me/+" in link:
        return link.split("t.me/+")[1]
    return None

async def join_chat_by_invite_link(client, chat_identifier):
    invite_hash = extract_invite_hash(chat_identifier)
    if not invite_hash:
        return False
    
    try:
        print(f"   🔗 Вступаем по ссылке: {chat_identifier}")
        await client(ImportChatInviteRequest(invite_hash))
        print(f"   ✅ Успешно вступили в чат!")
        return True
    except errors.rpcerrorlist.InviteHashExpiredError:
        print(f"   ❌ Ссылка просрочена")
        return False
    except errors.rpcerrorlist.InviteHashInvalidError:
        print(f"   ❌ Неверная ссылка")
        return False
    except Exception as e:
        if "already a participant" in str(e).lower():
            print(f"   ℹ️ Уже участник чата")
            return True
        print(f"   ❌ Не удалось вступить: {e}")
        return False

async def ensure_can_send(client, chat_identifier):
    try:
        # Пробуем отправить тестовое сообщение
        await client.send_message(chat_identifier, ".")
        return True
    except errors.rpcerrorlist.UserNotParticipantError:
        print(f"   ⚠️ Не участник чата, пробуем вступить...")
        joined = await join_chat_by_invite_link(client, chat_identifier)
        if joined:
            await asyncio.sleep(2)
            return True
        return False
    except Exception as e:
        error_msg = str(e).lower()
        if "not a member" in error_msg or "not participated" in error_msg:
            print(f"   ⚠️ Не участник чата, пробуем вступить...")
            joined = await join_chat_by_invite_link(client, chat_identifier)
            if joined:
                await asyncio.sleep(2)
                return True
        return False

# ========== ОТПРАВКА СООБЩЕНИЙ ==========

async def send_from_account(phone, name, client, message):
    if phone not in distribution:
        return
    
    chats = distribution[phone]
    if not chats:
        return
    
    print(f"\n📤 {name} отправляет в {len(chats)} чатов")
    
    for chat in chats:
        try:
            can_send = await ensure_can_send(client, chat)
            
            if not can_send:
                print(f"  ❌ {name} -> {chat}: НЕТ ДОСТУПА! Передаём другому...")
                reassign_chat(chat, phone)
                continue
            
            await client.send_message(chat, message)
            print(f"  ✅ {name} -> {chat}")
            
        except Exception as e:
            print(f"  ❌ {name} -> {chat}: {str(e)[:50]}")
            reassign_chat(chat, phone)
        
        await asyncio.sleep(1)

async def send_to_all_chats():
    message = get_random_message()
    print(f"\n🔄 Новый цикл ({datetime.now().strftime('%H:%M:%S')})")
    print(f"📝 Сообщение: \"{message}\"")
    
    for account in accounts:
        phone = account["phone"]
        if phone not in clients:
            continue
        
        if phone not in distribution or not distribution[phone]:
            continue
        
        await send_from_account(phone, account["name"], clients[phone], message)
    
    remove_useless_accounts()
    
    print(f"\n📊 Статистика после цикла:")
    for acc, chats in distribution.items():
        print(f"   👤 {acc}: {len(chats)} чатов")

# ========== АВТОРИЗАЦИЯ ==========

async def authorize_account(account):
    phone = account["phone"]
    name = account["name"]
    
    # Поддержка готовой строки сессии
    if "session_string" in account and account["session_string"]:
        print(f"\n👤 Авторизация по готовой строке: {name}")
        session = StringSession(account["session_string"])
        client = TelegramClient(session, CONFIG["api_id"], CONFIG["api_hash"])
        
        try:
            await client.connect()
            if await client.is_user_authorized():
                me = await client.get_me()
                print(f"✅ {name} авторизован (ID: {me.id})")
                save_session(phone, session.save())
                return client
            else:
                raise Exception("Сессия недействительна")
        except Exception as e:
            print(f"❌ Ошибка авторизации: {e}")
            raise
    
    # Обычная авторизация
    session = load_session(phone)
    client = TelegramClient(session, CONFIG["api_id"], CONFIG["api_hash"])
    
    print(f"\n👤 Авторизация: {name} ({phone})")
    
    await client.start(
        phone=phone,
        password=lambda: input("🔐 Введите пароль 2FA (если есть, иначе Enter): ") or None,
        code_callback=lambda: input("📨 Введите код из Telegram: ")
    )
    
    save_session(phone, client.session.save())
    print(f"✅ {name} авторизован")
    
    return client

# ========== MAIN ==========

async def main():
    print("🚀 Запуск Telegram отправителя (автовступление в чаты)")
    print("====================================================\n")
    
    load_accounts()
    load_chats()
    load_messages()
    load_distribution()
    
    if not accounts:
        print("❌ Нет аккаунтов в accounts.json")
        return
    
    if not all_chats:
        print("❌ Нет чатов в chats.json")
        return
    
    print("\n🔐 Авторизация аккаунтов...")
    
    for account in accounts:
        try:
            client = await authorize_account(account)
            clients[account["phone"]] = client
        except Exception as e:
            print(f"❌ Не удалось авторизовать {account['name']}: {e}")
    
    if not clients:
        print("❌ Не удалось авторизовать ни одного аккаунта")
        return
    
    init_distribution()
    
    print(f"\n✅ Авторизовано {len(clients)} аккаунтов")
    print(f"📋 Всего чатов: {len(all_chats)}")
    print(f"⏱️  Интервал: {CONFIG['interval']} секунд")
    print(f"🎲 Сообщения выбираются рандомно")
    print(f"🔗 Аккаунты автоматически вступают в чаты по ссылкам-приглашениям\n")
    
    await send_to_all_chats()
    
    while True:
        await asyncio.sleep(CONFIG["interval"])
        await send_to_all_chats()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Завершение работы...")
        for client in clients.values():
            asyncio.create_task(client.disconnect())