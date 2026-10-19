import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2] / 'resources/ellmsha-skills/community/last30days'
class Last30DaysRuntimeGuards(unittest.TestCase):
    @unittest.skipUnless(sys.version_info >= (3, 12), 'Last30days requires Python 3.12+')
    def test_safe_defaults_and_authorized_opt_ins(self):
        RESULTS = []
        with tempfile.TemporaryDirectory(prefix='ellmsha-last30days-safety-') as temp:
            clean = {'PATH': '', 'PYTHONDONTWRITEBYTECODE': '1', 'USER': 'fixture'}
            def isolated_expanduser(path):
                if path == '~' or path.startswith('~/'):
                    return temp + path[1:]
                if path.startswith('~'):
                    raise AssertionError('Named home lookup is not allowed in this fixture')
                return path
            with mock.patch.dict(os.environ, clean, clear=True), mock.patch.object(Path, 'home', return_value=Path(temp)), mock.patch('os.path.expanduser', side_effect=isolated_expanduser):
                sys.path.insert(0, str(ROOT / 'scripts'))
                from lib import env, agentcookie, chrome_cdp, xurl_x, grok_x, github, brightdata, trustpilot
                assert env.CONFIG_FILE is None
                forbid = AssertionError('Unexpected credential/store/subprocess access')
                with mock.patch('subprocess.run', side_effect=forbid), mock.patch.object(agentcookie, 'read_x_cookies', side_effect=forbid), mock.patch.object(agentcookie, 'role_is_sink', side_effect=forbid), mock.patch.object(chrome_cdp, 'read_x_cookies', side_effect=forbid), mock.patch.object(env, 'extract_browser_credentials', side_effect=forbid):
                    for system in ('Darwin', 'Linux', 'Windows'):
                        with mock.patch('platform.system', return_value=system):
                            cfg = env.get_config(env.ConfigLoadPolicy(browser_cookies='read'))
                            assert cfg['AGENTCOOKIE'] == 'off'
                            assert cfg['LAST30DAYS_MEMORY_DIR'] == ''
                            assert not env.x_extras_enabled(cfg)
                            assert env.resolve_memory_dir() == ''
                    RESULTS.append('default config: no stores/session discovery on Darwin/Linux/Windows')
                    with mock.patch.dict(os.environ, {'OPENAI_API_KEY': 'fixture-explicit', 'AUTH_TOKEN': 'fixture-auth', 'CT0': 'fixture-ct0'}):
                        cfg = env.get_config(env.ConfigLoadPolicy(browser_cookies='read'))
                        assert cfg['OPENAI_API_KEY'] == 'fixture-explicit'
                        assert (cfg['AUTH_TOKEN'], cfg['CT0']) == ('fixture-auth', 'fixture-ct0')
                    RESULTS.append('explicit API key/cookie pair retained without store discovery')
                    with mock.patch.dict(os.environ, {'AGENTCOOKIE': 'on', 'FROM_BROWSER': 'firefox', 'BROWSER_CONSENT': '0'}):
                        cfg = env.get_config(env.ConfigLoadPolicy(browser_cookies='read'))
                        assert not env.x_extras_enabled(cfg)
                        assert env.cookie_extraction_browsers(cfg) == []
                    RESULTS.append('browser/sidecar consent refusal blocks discovery')
                for variable, store, call in [('LAST30DAYS_SKIP_KEYCHAIN', 'security', 'find-generic-password'), ('LAST30DAYS_SKIP_PASS', 'pass', 'show')]:
                    with mock.patch.dict(os.environ, {variable: '0'}), mock.patch('platform.system', return_value='Darwin'), mock.patch('shutil.which', side_effect=lambda name: '/fixture/'+name if name == store else None), mock.patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'fixture-store-key\n', '')) as run:
                        cfg = env.get_config()
                        assert cfg['OPENAI_API_KEY'] == 'fixture-store-key'
                        assert run.call_count > 0
                        assert all(c.args[0][1] == call for c in run.call_args_list)
                    RESULTS.append(f'explicit {store} opt-in remains usable with fake store')
                with mock.patch.dict(os.environ, {'AGENTCOOKIE': 'on', 'BROWSER_CONSENT': '1'}), mock.patch.object(agentcookie, 'read_x_cookies', return_value={'auth_token':'fixture-auth','ct0':'fixture-ct0'}) as read, mock.patch.object(env, '_is_mac_mini', return_value=False), mock.patch.object(env, 'extract_browser_credentials', return_value={}), mock.patch.object(chrome_cdp, 'read_x_cookies', side_effect=forbid):
                    cfg = env.get_config(env.ConfigLoadPolicy(browser_cookies='read'))
                    assert read.call_count == 1 and cfg['AUTH_TOKEN'] == 'fixture-auth'
                RESULTS.append('authorized sidecar opt-in remains usable with fake provider')
                with mock.patch.dict(os.environ, {'FROM_BROWSER': 'firefox', 'BROWSER_CONSENT': '1'}), mock.patch.object(env, 'extract_browser_credentials', return_value={'AUTH_TOKEN':'fixture-browser','CT0':'fixture-ct0'}) as read, mock.patch.object(agentcookie, 'read_x_cookies', side_effect=forbid):
                    cfg = env.get_config(env.ConfigLoadPolicy(browser_cookies='read'))
                    assert read.call_count == 1 and cfg['AUTH_TOKEN'] == 'fixture-browser'
                RESULTS.append('authorized browser opt-in remains usable with fake provider')
                assert env.resolve_memory_dir(str(Path(temp) / 'requested-artifact')) == str(Path(temp) / 'requested-artifact')
                assert not (Path(temp) / 'requested-artifact').exists()
                RESULTS.append('explicit artifact directory resolves without creating files')
                for module in (xurl_x, grok_x):
                    with mock.patch.object(module, 'token_store_path', side_effect=forbid), mock.patch('subprocess.run', side_effect=forbid):
                        assert module.stored_auth_status()[0] == module.AUTH_MISSING
                        assert not module.is_available()
                RESULTS.append('default CLI auth denies token-store reads and status subprocesses')
                with mock.patch.dict(os.environ, {'LAST30DAYS_ALLOW_CLI_AUTH': 'xurl'}), mock.patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'bearer: ✓', '')) as run:
                    xurl_x.clear_availability_cache()
                    assert xurl_x.is_available() and run.call_count == 1
                    assert not grok_x.is_available()
                store = Path(temp) / 'fake-grok-auth.json'
                store.write_text('{"access_token":"fixture-only"}')
                with mock.patch.dict(os.environ, {'LAST30DAYS_ALLOW_CLI_AUTH': 'grok'}), mock.patch.object(grok_x, 'token_store_path', return_value=store):
                    assert grok_x.stored_auth_status()[0] == grok_x.AUTH_OK
                RESULTS.append('named CLI auth opt-ins work with fake stores; other CLIs remain disabled')
                with mock.patch('subprocess.run', side_effect=forbid), mock.patch.object(brightdata, '_config_dir', side_effect=forbid):
                    assert github.resolve_token() is None
                    assert github.resolve_token('fixture-explicit') == 'fixture-explicit'
                    assert not brightdata.has_credentials()
                    assert not trustpilot._harvest_allowed({})
                with mock.patch.dict(os.environ, {'LAST30DAYS_ALLOW_CLI_AUTH': 'gh'}), mock.patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'fixture-gh-key', '')) as run:
                    assert github.resolve_token() == 'fixture-gh-key' and run.call_count == 1
                with mock.patch.dict(os.environ, {'LAST30DAYS_TRUSTPILOT_NO_BROWSER': '0', 'BROWSER_CONSENT': '1'}):
                    assert trustpilot._harvest_allowed({})
                RESULTS.append('GitHub/BrightData ambient CLI auth and Trustpilot browser warmup disabled; explicit grants remain usable')
                # Run the documented preflight with only a trap uv binary on PATH.
                # No supported Python is available in that subprocess: it must fail
                # closed without executing uv or provisioning any runtime.
                if os.name != 'nt':
                    bindir = Path(temp) / 'bin'
                    bindir.mkdir()
                    marker = Path(temp) / 'provisioning-was-attempted'
                    uv = bindir / 'uv'
                    uv.write_text('#!/bin/sh\n: > "' + str(marker) + '"\nexit 1\n')
                    uv.chmod(0o755)
                    runtime = (ROOT / 'references/runtime.md').read_text()
                    preflight = runtime.split('## Runtime Preflight', 1)[1].split('```bash', 1)[1].split('```', 1)[0]
                    result = subprocess.run(['/bin/bash', '-c', preflight], env={**clean, 'PATH': str(bindir)}, capture_output=True, text=True, timeout=10)
                    assert result.returncode == 1 and 'requires Python 3.12+' in result.stderr
                    assert not marker.exists()
                    RESULTS.append('documented missing-Python preflight fails without uv provisioning')
                # Full entry-point execution: actual imports/argparse/config/pipeline;
                # network/subprocess attempts fail this check rather than reaching host.
                def no_external(event, args):
                    if event in {'subprocess.Popen', 'socket.connect', 'socket.getaddrinfo', 'os.system', 'os.exec', 'os.posix_spawn', 'urllib.Request'}:
                        raise AssertionError('External operation prohibited in offline fixture: '+event)
                sys.addaudithook(no_external)
                for argv in (['--help'], ['--resolve-save-dir'], ['portable keyboards', '--mock', '--search=github', '--quick', '--emit=json']):
                    sys.argv = [str(ROOT / 'scripts/last30days.py'), *argv]
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        try:
                            runpy.run_path(str(ROOT / 'scripts/last30days.py'), run_name='__main__')
                        except SystemExit as exc:
                            assert exc.code in (0, None), (argv, exc.code, err.getvalue())
                    if '--emit=json' in argv:
                        result = json.loads(out.getvalue())
                        assert result
                    RESULTS.append('offline CLI ' + ' '.join(argv) + ': no external process/network operation')
                assert not (Path(temp) / 'Documents/Last30Days').exists()
                RESULTS.append('no ambient research library created')
                self.assertEqual(len(RESULTS), 16 if os.name != 'nt' else 15)


if __name__ == '__main__':
    unittest.main(verbosity=2)
