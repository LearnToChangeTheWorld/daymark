"""Synthetic crypto/WAL regressions: no account or personal messages required."""
import hashlib
from contextlib import closing
import hmac
import os
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
from Crypto.Cipher import AES
import zstandard
from wechat_database import DatabaseReader, message_text, page_key, validate_raw_key
from wechat_vendor.wal_snapshot import _checksum


def plain_page(change):
    page = bytearray(4096)
    page[:16] = b'SQLite format 3\x00'
    struct.pack_into('>H', page, 16, 4096)
    page[18:24] = bytes([1, 1, 80, 64, 32, 32])
    for offset, value in [(24, change), (28, 1), (40, 1), (44, 4), (56, 1), (92, change), (96, 3040001)]:
        struct.pack_into('>I', page, offset, value)
    page[100] = 13
    struct.pack_into('>H', page, 105, 4016)
    return bytes(page)


def encrypted_page(raw, salt, change):
    key = page_key(raw, salt)
    iv = os.urandom(16)
    page = salt + AES.new(key, AES.MODE_CBC, iv).encrypt(plain_page(change)[16:4016]) + iv
    mac = hashlib.pbkdf2_hmac('sha512', key, bytes(x ^ 0x3a for x in salt), 2, 32)
    return page + hmac.new(mac, page[16:] + struct.pack('<I', 1), hashlib.sha512).digest()


def wal(pages):
    salt = os.urandom(8)
    header = struct.pack('>IIII', 0x377f0682, 3007000, 4096, 0) + salt
    state = _checksum(header, '<')
    output = header + struct.pack('>II', *state)
    for page, commit in pages:
        prefix = struct.pack('>II', 1, commit)
        state = _checksum(prefix + page, '<', state)
        output += prefix + salt + struct.pack('>II', *state) + page
    return output


class DatabaseChecks(unittest.TestCase):
    def test_new_messages_and_rebuilt_shards_keep_history_recoverable(self):
        with tempfile.TemporaryDirectory(prefix='wechat-cursor-') as directory:
            root = Path(directory)
            (root / 'message').mkdir()
            group = '123@chatroom'
            table = 'Msg_' + hashlib.md5(group.encode()).hexdigest()
            source = root / 'message/message_0.db'
            generation = ['a']
            class LocalReader(DatabaseReader):
                def status(self):
                    return {'loginState': 'authenticated', 'readable': True}
                def groups(self):
                    return {'groups': [{'id': group, 'name': 'test'}]}
                def connection(self, path):
                    self.cache[str(path)] = (None, path, generation[0])
                    connection = sqlite3.connect(path)
                    connection.row_factory = sqlite3.Row
                    return connection
            def insert(local, server):
                with closing(sqlite3.connect(source, isolation_level=None)) as database:
                    database.execute(f'INSERT INTO "{table}" VALUES (?,?,1,?,?,NULL)',
                                     (local, server, int(time.time()), '请提交报告'))
            with closing(sqlite3.connect(source, isolation_level=None)) as database:
                database.execute(f'CREATE TABLE "{table}" (local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,create_time INTEGER,message_content TEXT,compress_content BLOB)')
            reader = LocalReader(root / 'private')
            reader.root = root
            insert(1, 9001)
            first = reader.read({'groups': [group]})['chats'][0]
            self.assertEqual(first['messages'][0]['id'], 'server:9001')
            payload = {'groups': [group], 'cursors': {group: first['cursors']}}
            self.assertEqual(reader.read(payload)['chats'][0]['messages'], [])
            insert(2, 9002)
            second = reader.read(payload)['chats'][0]
            self.assertEqual([m['id'] for m in second['messages']], ['server:9002'])
            payload['cursors'][group] = second['cursors']
            generation[0] = 'b'
            rebuilt = reader.read(payload)['chats'][0]
            self.assertEqual([m['id'] for m in rebuilt['messages']], ['server:9001', 'server:9002'])
            payload['cursors'][group] = rebuilt['cursors']
            with closing(sqlite3.connect(source, isolation_level=None)) as database:
                database.execute(f'DELETE FROM "{table}"')
            insert(1, 9100)
            self.assertEqual(reader.read(payload)['chats'][0]['messages'][0]['id'], 'server:9100')
            self.assertEqual(reader.read({'groups': ['not-selected@chatroom']})['chats'], [])
            for index in range(2, 25):
                insert(index, 9100 + index)
            before = dict(payload['cursors'][group])
            preview = reader.read({**payload, 'preview': True})['chats'][0]
            self.assertEqual(len(preview['messages']), 12)
            self.assertEqual(preview['cursors'], {})
            self.assertEqual(payload['cursors'][group], before)
            self.assertGreater(len(reader.read(payload)['chats'][0]['messages']), 12, 'preview must not consume collection positions')

    def test_authenticated_committed_wal_excludes_uncommitted_tail(self):
        with tempfile.TemporaryDirectory(prefix='wechat-crypto-') as directory:
            root = Path(directory)
            source = root / 'db_storage/message.db'
            source.parent.mkdir()
            raw, salt = os.urandom(32), os.urandom(16)
            source.write_bytes(encrypted_page(raw, salt, 1))
            Path(str(source) + '-wal').write_bytes(wal([(encrypted_page(raw, salt, 2), 1), (encrypted_page(raw, salt, 3), 0)]))
            reader = DatabaseReader(root / 'private')
            reader.root, reader.raw = source.parent, raw
            target = reader.snapshot(source)
            self.assertEqual(struct.unpack_from('>I', target.read_bytes(), 24)[0], 2)
            connection = sqlite3.connect(target.as_uri() + '?mode=ro', uri=True)
            try:
                self.assertEqual(connection.execute('select count(*) from sqlite_master').fetchone()[0], 0)
            finally:
                connection.close()
            self.assertTrue(validate_raw_key(raw, source.read_bytes()))
            self.assertFalse(validate_raw_key(os.urandom(32), source.read_bytes()))

    def test_page_tampering_preserves_previous_snapshot(self):
        with tempfile.TemporaryDirectory(prefix='wechat-tamper-') as directory:
            root = Path(directory)
            source = root / 'db_storage/message.db'
            source.parent.mkdir()
            raw, salt = os.urandom(32), os.urandom(16)
            source.write_bytes(encrypted_page(raw, salt, 1))
            reader = DatabaseReader(root / 'private')
            reader.root, reader.raw = source.parent, raw
            target = reader.snapshot(source)
            original = target.read_bytes()
            invalid = bytearray(source.read_bytes())
            invalid[200] ^= 1
            source.write_bytes(invalid)
            with self.assertRaisesRegex(ValueError, '校验失败'):
                reader.snapshot(source)
            self.assertEqual(target.read_bytes(), original)

    def test_compressed_text_and_share_cards_do_not_import_xml_noise(self):
        data = zstandard.ZstdCompressor().compress('wxid_author:\n请在周五前提交报告'.encode())
        self.assertEqual(message_text(1, data), '请在周五前提交报告')
        card = '<msg><appmsg><title>实验报告.docx</title><type>6</type><thumburl>private-token</thumburl></appmsg></msg>'
        self.assertEqual(message_text(49, card), '[文件：实验报告.docx]')
        self.assertNotIn('private-token', message_text(49, card))
        self.assertEqual(message_text(3, b'opaque-media'), '[图片]')


if __name__ == '__main__':
    unittest.main()
