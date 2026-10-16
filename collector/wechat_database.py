"""Read-only Windows Weixin 4.x adapter. Never writes original databases.

SQLCipher 4 authenticated pages + committed WAL snapshots; plaintext copies are
private local caches. Active account comes from the official process's open DB
handles, never from whichever account directory happens to have a newer mtime.
"""
import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import struct
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

from Crypto.Cipher import AES
import win32api
import win32crypt
import zstandard
from wechat_vendor.wal_snapshot import read_snapshot

PAGE = 4096
VENDOR = Path(__file__).parent / 'wechat_vendor'


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, path)


def page_key(raw, salt):
    return hashlib.pbkdf2_hmac('sha512', raw, salt, 256000, 32)


def authenticate_page(key, page, number, salt):
    mac = hashlib.pbkdf2_hmac('sha512', key, bytes(x ^ 0x3a for x in salt), 2, 32)
    offset = 16 if number == 1 else 0
    actual = hmac.new(mac, page[offset:4032] + struct.pack('<I', number), hashlib.sha512).digest()
    return hmac.compare_digest(actual, page[4032:4096])


def validate_raw_key(raw, page):
    return len(page) == PAGE and authenticate_page(page_key(raw, page[:16]), page, 1, page[:16])


def active_storage():
    """Enumerate only Weixin process disk handles, without opening chat contents."""
    nt = ctypes.WinDLL('ntdll')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    query = nt.NtQuerySystemInformation
    query.argtypes = [wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
    query.restype = ctypes.c_long
    kernel.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.DuplicateHandle.restype = wintypes.BOOL
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.restype = wintypes.DWORD
    kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    # tasklist avoids inspecting unrelated process command lines.
    import csv
    import io
    result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'],
                            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=5)
    pids = {int(r[1]) for r in csv.reader(io.StringIO(result.stdout.decode(errors='replace')))
            if len(r) > 1 and r[0].casefold() == 'weixin.exe' and r[1].isdigit()}
    if not pids:
        return [], False
    size, required = 1024 * 1024, wintypes.ULONG()
    while size <= 128 * 1024 * 1024:
        buffer = ctypes.create_string_buffer(size)
        status = query(64, buffer, size, ctypes.byref(required))
        if status == 0:
            break
        if status != -1073741820:
            raise OSError('无法核对微信正在使用的账号')
        size = max(size * 2, required.value + 65536)
    else:
        raise OSError('系统文件句柄列表过大')
    raw = buffer.raw
    count = min(struct.unpack_from('<Q', raw)[0], (len(raw) - 16) // 40)
    handles, roots = {}, set()
    try:
        for index in range(count):
            _obj, pid, handle, _access, _trace, _kind, _attr, _reserved = struct.unpack_from('<QQQIHHII', raw, 16 + index * 40)
            if pid not in pids:
                continue
            if pid not in handles:
                try:
                    handles[pid] = win32api.OpenProcess(0x40, False, pid)
                except Exception:
                    handles[pid] = None
            if handles[pid] is None:
                continue
            local = wintypes.HANDLE()
            if not kernel.DuplicateHandle(int(handles[pid]), handle, int(win32api.GetCurrentProcess()), ctypes.byref(local), 0, False, 2):
                continue
            try:
                if kernel.GetFileType(local) != 1:
                    continue
                path = ctypes.create_unicode_buffer(4096)
                length = kernel.GetFinalPathNameByHandleW(local, path, 4096, 0)
                if not 0 < length < 4096:
                    continue
                value = path.value.removeprefix('\\\\?\\')
                parts = Path(value).parts
                if 'db_storage' in parts:
                    index = parts.index('db_storage')
                    roots.add(str(Path(*parts[:index + 1])))
            finally:
                kernel.CloseHandle(local)
    finally:
        for process in handles.values():
            if process is not None:
                process.Close()
    return sorted(roots), True


def decode_content(value):
    if value is None:
        return ''
    if isinstance(value, bytes):
        if value.startswith(b'\x28\xb5\x2f\xfd'):
            value = zstandard.ZstdDecompressor().decompress(value, max_output_size=4 * 1024 * 1024)
        value = value.decode('utf-8', errors='strict')
    return re.sub(r'^(?:wxid_[^\s:]+|[^\s:]{1,64}@[^\s:]+):\r?\n', '', str(value)).strip()


def message_text(kind, content, compressed=None):
    kind = int(kind) & 0xffffffff
    if kind in (3, 34, 43, 47, 42, 48, 50):
        return {3: '[图片]', 34: '[语音]', 43: '[视频]', 47: '[表情]', 42: '[名片]', 48: '[位置]', 50: '[通话]'}[kind]
    value = decode_content(content if content else compressed)
    if kind == 1:
        return value
    if kind == 49:
        try:
            root = ET.fromstring(value)
            app = root if root.tag == 'appmsg' else root.find('.//appmsg')
            if app is None:
                return '[未识别的分享消息]'
            subtype = app.findtext('type', '')
            title = app.findtext('title', '').strip()
            if subtype == '6':
                return '[文件：' + (title or '未命名') + ']'
            pieces = [title, app.findtext('des', '').strip()]
            if subtype == '57':
                quoted = app.findtext('refermsg/content', '').strip()
                if quoted and not quoted.startswith('<'):
                    pieces.append('引用：' + quoted)
            return '\n'.join(dict.fromkeys(p for p in pieces if p)) or '[分享消息]'
        except ET.ParseError:
            return '[未识别的分享消息]'
    if kind in (10000, 10002):
        if value.startswith('<'):
            try:
                root = ET.fromstring(value)
                return next((root.findtext('.//' + field) for field in ('replacemsg', 'content', 'title') if root.findtext('.//' + field)), '[系统消息]')
            except ET.ParseError:
                return '[系统消息]'
        return value or '[系统消息]'
    return '[暂不支持的消息类型]'


class DatabaseReader:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.cache = {}
        self.derivations = {}
        self.root = None
        self.raw = None
        self.account = ''
        self.setup_child = None

    def status(self):
        common = {'mode': 'local_database', 'supportsHistory': True, 'readable': False}
        if self.setup_child and self.setup_child.poll() is None:
            return {**common, 'loginState': 'initializing', 'message': '正在初始化本机消息读取。微信打开后会尝试进入；出现二维码时请用手机确认。'}
        setup_error = None
        if not self.setup_child or self.setup_child.poll() is not None:
            try:
                setup = json.loads((self.directory / 'setup-status.json').read_text(encoding='utf-8'))
                if setup.get('phase') == 'error':
                    setup_error = setup.get('message')
            except FileNotFoundError:
                if self.setup_child:
                    setup_error = '初始化进程已退出，尚未取得可校验的密钥，请重试。'
            except Exception:
                setup_error = '无法读取初始化结果，请重新初始化。'
        roots, running = active_storage()
        if len(roots) > 1:
            return {**common, 'loginState': 'unreadable', 'message': '检测到多个微信账号同时打开数据库，请保留一个账号后重新检查。'}
        if not roots:
            message = '请在官方微信完成扫码或点击进入微信，再检查连接。' if running else '请打开官方电脑微信。本软件不会在后台反复拉起客户端。'
            return {**common, 'loginState': 'waiting_scan' if running else 'not_running', 'message': (setup_error + ' ' if setup_error else '') + message}
        root = Path(roots[0])
        previous_root = self.root
        self.root = root
        record_path = self.directory / (root.parent.name + '.dpapi.json')
        try:
            record = json.loads(record_path.read_text(encoding='utf-8'))
            raw = win32crypt.CryptUnprotectData(base64.b64decode(record['protectedKey']), None, None, None, 0)[1]
            with (root / 'contact/contact.db').open('rb') as source:
                first = source.read(PAGE)
            if not validate_raw_key(raw, first):
                raise ValueError('key changed')
        except Exception:
            # Never return decrypted keys, DPAPI errors or database payloads.
            return {**common, 'loginState': 'setup_failed' if setup_error else 'needs_key', 'message': setup_error or '尚未初始化此账号的本机消息读取，或微信更新后密钥已变化。点击“初始化消息读取”后会重启一次电脑微信。'}
        if previous_root != root or self.raw != raw:
            self.cache.clear()
            self.derivations.clear()
        self.root, self.raw, self.account = root, raw, root.parent.name.rsplit('_', 1)[0]
        return {**common, 'loginState': 'authenticated', 'readable': True, 'accountId': self.account,
                'account': self.account, 'message': '已连接本机微信消息库。选择群后补读近 7 天电脑已缓存的历史，并持续检查新消息；无需打开群窗口。'}

    def initialize(self):
        if not self.setup_child or self.setup_child.poll() is not None:
            self.setup_child = subprocess.Popen([os.sys.executable, str(Path(__file__).with_name('wechat_key.py')),
                                                '--data-dir', str(self.directory),
                                                *(['--source-root', str(self.root)] if self.root else [])],
                                               creationflags=subprocess.CREATE_NO_WINDOW,
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return self.status()

    def snapshot(self, source):
        def signature():
            values = []
            for path in (source, Path(str(source) + '-wal')):
                try:
                    stat = path.stat()
                    values.append((stat.st_size, stat.st_mtime_ns))
                except FileNotFoundError:
                    values.append(None)
            return tuple(values)
        sig = signature()
        if str(source) in self.cache and self.cache[str(source)][0] == sig:
            return self.cache[str(source)][1]
        data = read_snapshot(str(source))
        if signature() != sig:
            raise ValueError('微信正在写入消息，稍后会自动重试')
        if len(data) < PAGE or len(data) % PAGE:
            raise ValueError('消息库页面不完整')
        salt = data[:16]
        if salt not in self.derivations:
            key = page_key(self.raw, salt)
            mac = hashlib.pbkdf2_hmac('sha512', key, bytes(x ^ 0x3a for x in salt), 2, 32)
            self.derivations[salt] = (key, mac)
        key, mac = self.derivations[salt]
        plain = bytearray()
        for offset in range(0, len(data), PAGE):
            page, number = data[offset:offset + PAGE], offset // PAGE + 1
            start = 16 if number == 1 else 0
            actual = hmac.new(mac, page[start:4032] + struct.pack('<I', number), hashlib.sha512).digest()
            if not hmac.compare_digest(actual, page[4032:]):
                raise ValueError('消息库校验失败，保留上次结果并稍后重试')
            if number == 1:
                plain.extend(b'SQLite format 3\x00')
            plain.extend(AES.new(key, AES.MODE_CBC, page[4016:4032]).decrypt(page[start:4016]))
            plain.extend(page[4016:])
        cache_dir = self.directory / 'cache' / self.root.parent.name
        cache_dir.mkdir(parents=True, exist_ok=True)
        target = cache_dir / (hashlib.sha256(str(source).encode()).hexdigest() + '.db')
        fd, temporary = tempfile.mkstemp(dir=cache_dir)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(plain)
            # Validate the SQLite schema before publishing a replacement.
            connection = sqlite3.connect(Path(temporary).as_uri() + '?mode=ro', uri=True)
            try:
                connection.execute('PRAGMA query_only=ON')
                connection.execute('SELECT name FROM sqlite_master LIMIT 1').fetchall()
            finally:
                connection.close()
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.cache[str(source)] = (sig, target, salt.hex())
        return target

    def connection(self, source):
        database = sqlite3.connect(self.snapshot(source).as_uri() + '?mode=ro', uri=True)
        database.row_factory = sqlite3.Row
        database.execute('PRAGMA query_only=ON')
        return database

    def groups(self):
        state = self.status()
        if not state['readable']:
            return {**state, 'groups': []}
        database = self.connection(self.root / 'contact/contact.db')
        try:
            rows = database.execute("SELECT username,nick_name,remark,chat_room_notify FROM contact WHERE username LIKE '%@chatroom' AND is_in_chat_room=1 AND COALESCE(delete_flag,0)=0").fetchall()
            return {**state, 'groups': sorted([{'id': r['username'], 'name': r['remark'] or r['nick_name'] or r['username'], 'muted': r['chat_room_notify'] == 0} for r in rows], key=lambda g: g['name']),
                    'message': '仅采集勾选群，免打扰群也可读取。历史限于电脑微信已缓存的数据，缺少更早记录时请先在微信中同步。'}
        finally:
            database.close()

    def read(self, payload):
        state = self.status()
        if not state['readable']:
            return {**state, 'chats': [], 'errors': [state['message']]}
        selected = payload.get('groups', [])
        if not isinstance(selected, list) or len(selected) > 30:
            raise ValueError('群聊选择不正确')
        available = {g['id']: g for g in self.groups()['groups']}
        cutoff = int(time.time()) - 7 * 86400
        preview = payload.get('preview') is True
        cursors = {} if preview else payload.get('cursors') or {}
        chats = {group: {'id': group, 'messages': [], 'cursors': dict(cursors.get(group, {})), 'more': False, 'shards': 0} for group in selected if group in available}
        errors = [group + '：当前账号中没有这个群，请重新选择' for group in selected if group not in available]
        for source in sorted((self.root / 'message').glob('message_*.db')):
            if not re.fullmatch(r'message_\d+\.db', source.name):
                continue
            try:
                database = self.connection(source)
            except Exception:
                errors.append(source.name + '：读取或页面校验失败，将自动重试，未推进采集位置')
                continue
            try:
                for group, chat in chats.items():
                    table = 'Msg_' + hashlib.md5(group.encode()).hexdigest()
                    if not database.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
                        continue
                    chat['shards'] += 1
                    cursor = chat['cursors'].get(source.name, 0)
                    generation = self.cache[str(source)][2]
                    if isinstance(cursor, dict):
                        after = int(cursor.get('position', 0)) if cursor.get('generation') == generation else 0
                    else:
                        after = int(cursor)
                    maximum = database.execute(f'SELECT MAX(local_id) FROM "{table}"').fetchone()[0] or 0
                    if after > maximum:
                        after = 0  # A rebuilt shard must not strand an old position.
                    if preview:
                        rows = database.execute(f'SELECT local_id,server_id,local_type,create_time,message_content,compress_content FROM "{table}" WHERE create_time>=? ORDER BY create_time DESC LIMIT 12', (cutoff,)).fetchall()
                    else:
                        rows = database.execute(f'SELECT local_id,server_id,local_type,create_time,message_content,compress_content FROM "{table}" WHERE local_id>? AND create_time>=? ORDER BY local_id LIMIT 501', (after, cutoff)).fetchall()
                    chat['more'] |= len(rows) > 500
                    for row in rows[:500]:
                        try:
                            text = message_text(row['local_type'], row['message_content'], row['compress_content'])
                        except Exception:
                            errors.append(available[group]['name'] + '：有一条消息无法解码，保留位置并自动重试')
                            break
                        if text:
                            server_id = str(row['server_id'] or '')
                            stable = 'server:' + server_id if server_id and server_id != '0' else 'local:' + source.name + ':' + generation + ':' + str(row['local_id'])
                            chat['messages'].append({'id': stable, 'text': text[:12000], 'publishedAt': datetime.fromtimestamp(row['create_time'], timezone.utc).isoformat()})
                        chat['cursors'][source.name] = {'generation': generation, 'position': row['local_id']}
            finally:
                database.close()
        if preview:
            for chat in chats.values():
                chat['messages'] = sorted(chat['messages'], key=lambda m: m['publishedAt'], reverse=True)[:12]
                chat['cursors'] = {}  # Discovery never advances collection positions.
        return {**state, 'chats': list(chats.values()), 'errors': list(dict.fromkeys(errors)), 'cutoff': datetime.fromtimestamp(cutoff, timezone.utc).isoformat()}
