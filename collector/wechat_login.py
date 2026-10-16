"""Bounded interaction with the official client's login window only."""
import ctypes
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile

import win32api
import win32con
import win32gui
import win32process
import win32ui
from PIL import Image

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass


def login_windows(pid=None):
    found = []
    def visit(hwnd, _):
        if win32gui.GetClassName(hwnd) not in ('Qt51514QWindowIcon', 'WeChatLoginWndForPC'):
            return
        _, owner = win32process.GetWindowThreadProcessId(hwnd)
        if pid is not None and owner != pid:
            return
        process = None
        try:
            process = win32api.OpenProcess(win32con.PROCESS_QUERY_INFORMATION | win32con.PROCESS_VM_READ, False, owner)
            executable = win32process.GetModuleFileNameEx(process, 0)
            if os.path.basename(executable).casefold() not in ('weixin.exe', 'wechat.exe'):
                return
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            # Never capture or click a main chat window. Login windows are small.
            if 220 <= right - left <= 620 and 250 <= bottom - top <= 720:
                found.append(hwnd)
        except Exception:
            pass
        finally:
            if process is not None:
                process.Close()
    win32gui.EnumWindows(visit, None)
    return found


def capture(hwnd):
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width, height = right - left, bottom - top
    handle = win32gui.GetWindowDC(hwnd)
    source = win32ui.CreateDCFromHandle(handle)
    target = source.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(source, width, height)
        target.SelectObject(bitmap)
        if not ctypes.windll.user32.PrintWindow(hwnd, target.GetSafeHdc(), 2):
            raise OSError('登录窗口截图不可用')
        return Image.frombuffer('RGB', (width, height), bitmap.GetBitmapBits(True), 'raw', 'BGRX', 0, 1)
    finally:
        win32gui.DeleteObject(bitmap.GetHandle())
        target.DeleteDC()
        source.DeleteDC()
        win32gui.ReleaseDC(hwnd, handle)


def login_image():
    windows = login_windows()
    if not windows:
        return None
    output = io.BytesIO()
    capture(windows[0]).save(output, format='PNG')
    return output.getvalue()


def enter_saved_login(directory, pid):
    """Click only the exact local Enter Weixin label; never switch accounts."""
    windows = login_windows(pid)
    if not windows:
        return False
    hwnd = windows[0]
    filename = None
    try:
        fd, filename = tempfile.mkstemp(suffix='.png', dir=directory)
        os.close(fd)
        capture(hwnd).save(filename)
        script = Path(__file__).resolve().parent.parent / 'tools/probe-windows-ocr.ps1'
        result = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                 '-File', str(script), '-ImagePath', filename], capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, timeout=12)
        data = json.loads(result.stdout.decode('utf-8-sig'))
        for line in data.get('lines', []):
            label = ''.join(line.get('text', '').split()).casefold()
            if label not in ('进入微信', '進入微信', 'enterweixin', 'enterwechat'):
                continue
            words = line.get('words', [])
            if not words:
                continue
            x = (min(w['x'] for w in words) + max(w['x'] + w['width'] for w in words)) / 2
            y = (min(w['y'] for w in words) + max(w['y'] + w['height'] for w in words)) / 2
            if hwnd not in login_windows(pid):
                return False
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            if not (0 < x < right - left and 0 < y < bottom - top):
                return False
            client_x, client_y = win32gui.ScreenToClient(hwnd, (left + round(x), top + round(y)))
            position = win32api.MAKELONG(client_x, client_y)
            # Deliver the exact button click to this verified login window;
            # Windows may reject foreground activation while the user is away.
            win32gui.PostMessage(hwnd, win32con.WM_MOUSEMOVE, 0, position)
            win32gui.PostMessage(hwnd, win32con.WM_LBUTTONDOWN, win32con.MK_LBUTTON, position)
            win32gui.PostMessage(hwnd, win32con.WM_LBUTTONUP, 0, position)
            return True
    except Exception:
        return False
    finally:
        if filename and os.path.exists(filename):
            os.unlink(filename)
    return False
