import array
import importlib.util
import tempfile
import unittest
from unittest.mock import patch, Mock
from pathlib import Path

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_gain_scales_and_clips_pcm(self):
        raw = array.array('h', [1000, -2000, 30000, -30000]).tobytes()
        self.assertEqual(list(array.array('h', bridge.scale_pcm(raw, 2))), [2000, -4000, 32767, -32768])
        self.assertEqual(bridge.scale_pcm(raw, 1.0), raw)

    def test_gain_table_targets_quiet_voices(self):
        self.assertEqual(len(bridge.GAIN), 36)
        self.assertTrue(all(0.3 < value < 6 for value in bridge.GAIN.values()))
        self.assertEqual(bridge.GAIN_CASE['乐乐'], bridge.GAIN['乐乐'])

    def test_lan_origin_host_and_key(self):
        request=Mock()
        request.server.origins={'http://192.168.31.178:8000'}
        request.server.hosts={'192.168.31.178:8790'}
        request.server.access_key='secret-key'
        request.command='GET'
        request.headers={'Origin':'http://192.168.31.178:8000','Host':'192.168.31.178:8790','X-Breeze-Key':'secret-key'}
        self.assertTrue(bridge.Handler.allowed(request))
        request.headers['X-Breeze-Key']='wrong'
        self.assertFalse(bridge.Handler.allowed(request))
        self.assertEqual(request.answer.call_args.args[1],401)
        request.command='OPTIONS'
        self.assertTrue(bridge.Handler.allowed(request))
        request.headers['Origin']='http://untrusted.test'
        self.assertFalse(bridge.Handler.allowed(request))
        request.headers['Origin']='http://192.168.31.178:8000'
        request.headers['Host']='untrusted.test:8790'
        self.assertFalse(bridge.Handler.allowed(request))

    def test_fixed_launcher_and_deduplication(self):
        command = bridge.startup_command()
        self.assertEqual(command[-1], '-NoBrowser')
        self.assertEqual(Path(command[-2]).name, '启动轻声.ps1')
        self.assertIn('-File', command)
        self.assertNotIn('-Command', command)
        process = Mock()
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory, patch.dict(bridge.os.environ, {'LOCALAPPDATA': directory}), patch.object(bridge.subprocess, 'Popen', return_value=process) as spawn:
            bridge.START_PROCESS = None
            bridge.start_launcher()
            bridge.start_launcher()
            self.assertEqual(spawn.call_count, 1)
            self.assertEqual(spawn.call_args.args[0], command)
            self.assertEqual(spawn.call_args.kwargs['creationflags'], getattr(bridge.subprocess, 'CREATE_NO_WINDOW', 0))
        bridge.START_PROCESS = None

    def test_only_valid_encoded_voice_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'good.breeze').write_bytes(b'BRZV1234')
            (root / 'not-a-voice.breeze').write_bytes(b'bad')
            (root / 'audio.wav').write_bytes(b'RIFF')
            (root / '姐姐.breeze').write_bytes(b'BRZVchinese')
            self.assertEqual({row['name'] for row in bridge.voice_files(root)}, {'good', '姐姐'})
            self.assertTrue(bridge.voice_files(root)[0]['revision'])
            self.assertTrue(all(bridge.VOICE_ID.fullmatch(row['id']) for row in bridge.voice_files(root)))
            original = next(row for row in bridge.voice_files(root) if row['name'] == 'good')
            (root / 'good.breeze').rename(root / '改名后的音色.breeze')
            renamed = next(row for row in bridge.voice_files(root) if row['name'] == '改名后的音色')
            self.assertEqual(original['id'], renamed['id'])
            self.assertEqual(original['revision'], renamed['revision'])
            prepared = root / 'private-runtime'
            rows = bridge.prepare_voices(root, prepared)
            self.assertEqual(len(rows), 2)
            self.assertEqual((prepared / (renamed['id'] + '.breeze')).read_bytes(), b'BRZV1234')
            self.assertTrue((root / '改名后的音色.breeze').exists())
        self.assertIsNone(bridge.VOICE_ID.fullmatch('../escape'))


if __name__ == '__main__':
    unittest.main()
