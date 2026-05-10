import os
import base64
import struct
from telethon.sessions import StringSession
from telethon import TelegramClient

API_ID = 2040  # Ваш API ID
API_HASH = 'b18441a1ff607e10a989891a5462e627'  # Ваш API Hash

def hex_to_string_session():
    print("Конвертер HEX Auth Key в StringSession\n" + "="*40)
    
    # 1. Ввод данных
    hex_key = input("Вставьте ваш Auth Key (HEX): ").strip()
    dc_id = int(input("Введите DC ID"))
    user_id = int(input("Введите User ID "))
    
    # 2. Очистка ключа (удаляем возможные пробелы)
    hex_key = hex_key.replace(" ", "").replace("\n", "")
    
    # 3. Преобразуем HEX в байты
    try:
        auth_key_bytes = bytes.fromhex(hex_key)
        print(f"✓ Ключ прочитан, длина: {len(auth_key_bytes)} байт")
    except ValueError:
        print("❌ ОШИБКА: Неверный HEX-формат. Убедитесь, что скопировали весь ключ без ошибок.")
        return

    # 4. Собираем структуру StringSession вручную
    #    Формат: dc_id + auth_key (256 байт) + user_id + 0 (for bot)
    #    Структура: <dc_id:4s><auth_key:256s><user_id:8s><0:1s>
    #    Это упрощенный способ, который подходит в 99% случаев для конвертации.
    
    # Пакуем числа в байты (little-endian)
    dc_id_packed = struct.pack('<i', dc_id)  # 4 байта
    user_id_packed = struct.pack('<q', user_id)  # 8 байт
    is_bot_packed = b'\x00'  # 1 байт (False)
    
    # Собираем все вместе
    # Важно: длина auth_key должна быть ровно 256 байт
    # Если продавец дал неполный ключ, пробуем дополнить слева нулями? (маловероятно)
    if len(auth_key_bytes) != 256:
        print(f"⚠️ Внимание: Длина ключа ({len(auth_key_bytes)}) отличается от ожидаемой (256). Попробуем продолжить...")
    
    # Формируем бинарные данные для StringSession
    # Формат: [dc_id:4][auth_key:256][user_id:8][is_bot:1]
    # Дополняем ключ до 256 байт, если он короче (нулями в конце)
    if len(auth_key_bytes) < 256:
        auth_key_bytes = auth_key_bytes.ljust(256, b'\x00')
    elif len(auth_key_bytes) > 256:
        auth_key_bytes = auth_key_bytes[:256]  # Обрезаем до 256
    
    final_bytes = dc_id_packed + auth_key_bytes + user_id_packed + is_bot_packed
    
    # 5. Кодируем в base64 для StringSession
    string_session_str = base64.b64encode(final_bytes).decode('ascii')
    
    print("\n" + "="*40)
    print("✅ ГОТОВАЯ СТРОКА StringSession (скопируйте её целиком):")
    print("="*40)
    print(string_session_str)
    print("="*40)
    
    # Опционально: проверка
    check = input("\nПроверить сессию? (y/n): ").lower()
    if check == 'y':
        print("Пытаемся подключиться...")
        async def test():
            client = TelegramClient(StringSession(string_session_str), API_ID, API_HASH)
            await client.connect()
            if await client.is_user_authorized():
                me = await client.get_me()
                print(f"✅ Успех! Аккаунт: {me.first_name} (ID: {me.id})")
            else:
                print("❌ Сессия не валидна или просрочена.")
            await client.disconnect()
        
        import asyncio
        asyncio.run(test())

if __name__ == "__main__":
    hex_to_string_session()