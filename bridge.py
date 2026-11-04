"""Breeze bridge with an authenticated LAN mode and fixed local launcher."""
import argparse
import hashlib
import json
import os
import re
import secrets
import select
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from array import array
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = 'http://127.0.0.1:8080'
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.Lock()
VOICE_ID = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
START_LOCK = threading.Lock()
START_PROCESS = None

# 各音色的裸输出响度差到 10.9 LU，这里按实测值统一到约 -16 LUFS，与音色工坊、一键脚本一致。
# 键是音色文件名，值是增益倍数；不在表里的音色按 1.0 原样输出。换音色后需要重测。
GAIN = {
    '乐乐': 1.224,
    '夏茉低音': 1.152,
    '姐姐': 1.602,
    '小茉莉': 0.893,
    '星糖': 1.091,
    '椰椰卷': 0.718,
    '欣神': 1.045,
    '欣神2': 1.37,
    '珏涵': 1.813,
    '甜': 1.091,
    '童声': 1.179,
    '糯叽叽': 0.901,
    '软糯': 0.643,
    '软萌': 0.938,
    '软软': 0.996,
    '骚御': 1.131,
    '可莉': 2.096,
    '雷电将军': 3.114,
    '胡桃': 2.681,
    '黑塔': 1.576,
    '克拉拉': 1.498,
    '布洛妮娅': 1.319,
    '停云': 1.430,
    '素裳': 1.535,
    '白露': 1.550,
    '符玄': 1.850,
    '娜塔莎': 1.484,
    '各级Ayako': 1.130,
    '舟玄玄': 1.016,
    '咩咩虾片': 1.310,
    'Sakura樱酱': 1.508,
    '猫猫毛': 1.259,
    '憨憨滴凌晨': 1.631,
    '歆酱': 1.183,
    '文案1': 4.089,
    '文案2': 3.416,
}
# 文件名大小写可能与测量时不同（Windows 不区分大小写），按小写再查一次。
GAIN_CASE = {name.lower(): value for name, value in GAIN.items()}


def scale_pcm(data, gain):
    """int16 PCM 整体乘增益，超出 16 位范围的部分裁掉。"""
    samples = array('h', data)
    return array('h', (max(-32768, min(32767, int(v * gain))) for v in samples)).tobytes()


def startup_command():
    powershell = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    return [str(powershell), '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', str(Path(__file__).resolve().with_name('启动轻声.ps1')), '-NoBrowser']


def start_launcher():
    global START_PROCESS
    with START_LOCK:
        if START_PROCESS is not None and START_PROCESS.poll() is None:
            return
        log_directory = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'BreezeReader'
        log_directory.mkdir(parents=True, exist_ok=True)
        with (log_directory / 'button-start.log').open('ab') as log:
            START_PROCESS = subprocess.Popen(startup_command(), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def startup_status():
    ready = False
    try:
        with urllib.request.urlopen(MODEL + '/health', timeout=2) as response:
            health = json.load(response)
        ready = health.get('status') == 'ok' and health.get('sample_rate') == 24000
    except (OSError, ValueError):
        pass
    with START_LOCK:
        code = START_PROCESS.poll() if START_PROCESS is not None else None
        return {'modelReady': ready, 'starting': START_PROCESS is not None and code is None, 'exitCode': code}


def voice_files(directory, legacy_directory=None):
    result = []
    legacy = {}
    if legacy_directory and legacy_directory.is_dir():
        for row in voice_files(legacy_directory):
            legacy.setdefault(row['revision'], []).append(row['name'])
    duplicates = {}
    for path in sorted(directory.glob('*.breeze')):
        if path.is_symlink():
            continue
        try:
            with path.open('rb') as source:
                data = source.read(8 * 1024 * 1024 + 1)
                if not data.startswith(b'BRZV') or len(data) > 8 * 1024 * 1024:
                    continue
            digest = hashlib.sha256(data).hexdigest()
            number = duplicates.get(digest, 0)
            duplicates[digest] = number + 1
            identifier = 'brv_' + digest[:32] + (f'_{number}' if number else '')
            stat = path.stat()
            result.append({'id': identifier, 'name': path.stem, 'revision': digest,
                           'legacyRevision': f'{len(data)}:{stat.st_mtime_ns}',
                           'aliases': [path.stem, *legacy.get(digest, [])]})
        except OSError:
            continue
    return result


def prepare_voices(directory, prepared):
    """Keep model IDs ASCII: this Windows build corrupts Unicode voice IDs."""
    prepared.mkdir(parents=True, exist_ok=True)
    rows = voice_files(directory)
    for row in rows:
        source = directory / (row['name'] + '.breeze')
        target = prepared / (row['id'] + '.breeze')
        if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != row['revision']:
            data = source.read_bytes()
            if hashlib.sha256(data).hexdigest() != row['revision']:
                raise ValueError('音色文件正在修改，请保存后重新启动。')
            temporary = prepared / (row['id'] + f'.{os.getpid()}.tmp')
            temporary.write_bytes(data)
            temporary.replace(target)
    return rows


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def allowed(self):
        origin = self.headers.get('Origin')
        if origin and origin not in self.server.origins:
            self.send_error(403)
            return False
        if self.headers.get('Host') not in self.server.hosts:
            self.send_error(403)
            return False
        if self.command!='OPTIONS' and self.server.access_key and not secrets.compare_digest(self.headers.get('X-Breeze-Key',''), self.server.access_key):
            self.answer({'error':'Invalid connection key'},401)
            self.close_connection=True
            return False
        return True

    def cors(self):
        origin = self.headers.get('Origin')
        if origin in self.server.origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')

    def answer(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self.allowed():
            return
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Breeze-Token, X-Breeze-Key')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self.allowed():
            return
        if self.path == '/health':
            self.answer({'status': 'ok', 'bridge': 'breeze-reader-3', 'token': TOKEN, 'voiceDirectory': str(self.server.voices)})
        elif self.path == '/status':
            self.answer(startup_status())
        elif self.path == '/voices':
            try:
                with urllib.request.urlopen(MODEL + '/v1/voices', timeout=5) as response:
                    loaded = json.load(response)
                ids = {row['id'] for row in loaded}
                files = voice_files(self.server.voices, self.server.legacy)
                for row in files:
                    row['loaded'] = row['id'] in ids
                self.answer({'voices': files})
            except (OSError, ValueError, KeyError):
                self.answer({'error': '本地模型未就绪，请运行启动轻声。'}, 503)
        else:
            self.answer({'error': 'Not found'}, 404)

    def disconnected(self):
        readable, _, _ = select.select([self.connection], [], [], 0)
        return bool(readable) and self.connection.recv(1, socket.MSG_PEEK) == b''

    def do_POST(self):
        if not self.allowed():
            return
        if self.path not in ('/speech', '/start') or not secrets.compare_digest(self.headers.get('X-Breeze-Token', ''), TOKEN):
            self.answer({'error': 'Invalid bridge token or route'}, 403)
            self.close_connection = True
            return
        if self.path == '/start':
            if os.name!='nt' or self.client_address[0] not in ('127.0.0.1','::1'):
                self.answer({'error':'请在模型电脑启动轻声，手机只连接服务。'},403)
                self.close_connection=True
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 32 or json.loads(self.rfile.read(length)) != {}:
                    raise ValueError('Invalid startup request')
                start_launcher()
                self.answer({'starting': True}, 202)
            except ValueError:
                self.answer({'error': '启动请求只接受空对象。'}, 400)
                self.close_connection = True
            except OSError:
                self.answer({'error': '无法启动轻声。'}, 503)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 16384:
                raise ValueError('请求大小无效。')
            body = json.loads(self.rfile.read(size))
            text, voice = body.get('input'), body.get('voice')
            if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                raise ValueError('正文必须为 1–2000 字符。')
            names = {row['id']: row['name'] for row in voice_files(self.server.voices)}
            if not isinstance(voice, str) or voice not in names:
                raise ValueError('音色不在指定音色目录中。')
            gain = GAIN.get(names[voice], GAIN_CASE.get(names[voice].lower(), 1.0))
            # Instructions are deliberately disabled until delivery has been calibrated.
            payload = json.dumps({'input': text, 'voice': voice, 'response_format': 'pcm', 'model': 'tts-1'}).encode()
        except (ValueError, TypeError):
            self.answer({'error': '正文或音色无效。'}, 400)
            self.close_connection = True
            return
        acquired = False
        streaming = False
        try:
            deadline = time.monotonic() + 120
            while not acquired:
                if self.disconnected():
                    return
                acquired = LOCK.acquire(timeout=.2)
                if time.monotonic() > deadline:
                    self.answer({'error': '模型等待超时。'}, 503)
                    return
            while True:
                if self.disconnected():
                    return
                try:
                    upstream = urllib.request.urlopen(urllib.request.Request(MODEL + '/v1/audio/speech', data=payload, headers={'Content-Type': 'application/json'}), timeout=120)
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 409 or time.monotonic() > deadline:
                        self.answer({'error': f'模型请求失败（{error.code}）。'}, 502)
                        return
                    error.close()
                    time.sleep(.5)
            with upstream:
                if 'audio/pcm' not in upstream.headers.get('Content-Type', ''):
                    self.answer({'error': '模型未返回 PCM。'}, 502)
                    return
                self.send_response(200)
                self.cors()
                self.send_header('Content-Type', 'audio/pcm')
                self.send_header('X-Sample-Rate', '24000')
                self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                streaming = True
                pending = b''
                while True:
                    chunk = upstream.read1(8192)
                    if not chunk:
                        break
                    if gain != 1.0:
                        chunk = pending + chunk
                        if len(chunk) & 1:  # 采样被切在两块之间时留一个字节到下一块
                            pending, chunk = chunk[-1:], chunk[:-1]
                        else:
                            pending = b''
                        chunk = scale_pcm(chunk, gain)
                    if chunk:  # 空块会被当成结束标记
                        self.wfile.write(f'{len(chunk):X}\r\n'.encode() + chunk + b'\r\n')
                        self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()
        except (OSError, TimeoutError):
            if streaming:
                self.close_connection = True
            else:
                try:
                    self.answer({'error': '本地语音服务连接失败。'}, 503)
                except OSError:
                    pass
        finally:
            if acquired:
                LOCK.release()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--voices', type=Path, required=True)
    parser.add_argument('--origin', action='append', default=[])
    parser.add_argument('--port', type=int, default=8789)
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--key-file',type=Path)
    parser.add_argument('--allow-host',action='append',default=[])
    parser.add_argument('--model',default=MODEL)
    parser.add_argument('--legacy-voices', type=Path, default=Path(r'D:\BASE\桌面\其他工作区\语音\voices'))
    parser.add_argument('--prepare-voices', action='store_true')
    parser.add_argument('--prepared', type=Path)
    args = parser.parse_args()
    model_url=urllib.parse.urlsplit(args.model)
    if model_url.scheme not in ('http','https') or not model_url.hostname or model_url.username or model_url.password or model_url.query or model_url.fragment:
        parser.error('Invalid model URL')
    MODEL=args.model.rstrip('/')
    if args.prepare_voices:
        if args.prepared is None:
            parser.error('--prepared is required')
        rows = prepare_voices(args.voices.resolve(strict=True), args.prepared)
        print(json.dumps({'ids': [row['id'] for row in rows], 'count': len(rows)}))
        raise SystemExit(0)
    access_key=args.key_file.read_text(encoding='utf-8-sig').strip() if args.key_file else os.environ.get('BREEZE_ACCESS_KEY','').strip()
    if args.host!='127.0.0.1' and (len(access_key)<32 or not args.origin):
        parser.error('LAN mode requires a key file (at least 32 characters) and explicit origins')
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.voices = args.voices.resolve(strict=True)
    server.legacy = args.legacy_voices
    server.origins = set(args.origin)
    server.access_key=access_key
    server.hosts={f'{host}:{args.port}' for host in ['127.0.0.1','localhost',*args.allow_host]}
    server.serve_forever()
