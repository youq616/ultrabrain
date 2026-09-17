"""Synthetic unit states and actual bounded processes, not a live-manager certificate."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('personal_status',ROOT/'scripts/personal-status.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

def records(worker=False):
    out={}
    for name in s.UNITS:
        r=dict(Id=name,LoadState='loaded',ActiveState='active',SubState='active' if name.endswith('.target') else 'running')
        if name.endswith('.service'):r.update(Type='exec',Result='success',ExecMainCode='0',ExecMainStatus='0',NRestarts='0')
        out[name]=r
    out[s.UNITS[0]].update(Type='oneshot',SubState='exited',ExecMainCode='1')
    if not worker:out[s.UNITS[3]].update(LoadState='not-found',ActiveState='inactive',SubState='dead')
    return out

def wire(rows):
    return ('\n\n'.join('\n'.join(k+'='+v for k,v in r.items()) for r in rows.values())+'\n').encode()

class StatusTests(unittest.TestCase):
    def collect(self,rows=None,code=0,worker=False):
        with patch.object(s.os,'geteuid',return_value=1001):return s.collect(worker,runner=lambda:(code,wire(rows or records())))
    def test_running_minimal_plan_worker_not_required(self):
        r=self.collect();self.assertTrue(r['ok']);self.assertEqual(r['units'][3]['reason'],'unit_not_found')
        self.assertFalse(r['worker_required']);self.assertEqual(r['application_ready'],'not_checked')
    def test_expect_worker_does_not_enable_it(self):
        r=self.collect(worker=True);self.assertFalse(r['ok']);self.assertFalse(r['services_started']);self.assertFalse(r['model_called'])
    def test_running_complete_plan(self):self.assertTrue(self.collect(records(True),worker=True)['ok'])
    def test_active_target_does_not_hide_failed_console(self):
        rows=records();rows[s.UNITS[2]].update(ActiveState='failed',SubState='failed',Result='signal',ExecMainCode='2',ExecMainStatus='9')
        self.assertFalse(self.collect(rows)['ok'])
    def test_oneshot_state_is_not_socket_or_database_health(self):
        r=self.collect();self.assertTrue(r['units'][0]['observed_active']);self.assertFalse(r['database_connected'])
        self.assertFalse(r['console_http_checked']);self.assertFalse(r['mcp_checked']);self.assertEqual(r['application_ready'],'not_checked')
    def test_optional_failed_worker_visible_but_not_required(self):
        rows=records(True);rows[s.UNITS[3]].update(ActiveState='failed',SubState='failed',Result='exit-code',ExecMainCode='1',ExecMainStatus='2')
        r=self.collect(rows);self.assertTrue(r['ok']);self.assertEqual(r['warnings'],['optional_worker_failed'])
        self.assertEqual(r['units'][3]['reason'],'worker_exit_2_check_model_configuration');self.assertFalse(self.collect(rows,worker=True)['ok'])
    def test_signal_two_not_claimed_to_be_model_exit(self):
        rows=records(True);rows[s.UNITS[3]].update(ActiveState='failed',SubState='failed',Result='signal',ExecMainCode='2',ExecMainStatus='2')
        self.assertEqual(self.collect(rows)['units'][3]['reason'],'unit_failed')
    def test_restart_counter_is_preserved_with_warning(self):
        rows=records();rows[s.UNITS[2]]['NRestarts']='3';r=self.collect(rows)
        self.assertTrue(r['ok']);self.assertEqual(r['units'][2]['restarts'],3);self.assertIn('service_restart_observed',r['warnings'])
    def test_optional_running_worker_is_reported(self):self.assertIn('worker_running_not_required_by_this_check',self.collect(records(True))['warnings'])
    def test_unknown_state_does_not_echo_raw_values(self):
        rows=records();rows[s.UNITS[2]]['SubState']='SECRET_UNRECOGNIZED'
        r=self.collect(rows);self.assertFalse(r['ok']);self.assertNotIn('SECRET',json.dumps(r));self.assertEqual(r['units'][2]['reason'],'unrecognized_unit_state')
    def test_wrong_service_type_not_accepted(self):
        rows=records();rows[s.UNITS[2]]['Type']='oneshot';self.assertFalse(self.collect(rows)['ok'])
    def test_masked_unit_does_not_pass(self):
        rows=records();rows[s.UNITS[0]]['LoadState']='masked';r=self.collect(rows)
        self.assertFalse(r['ok']);self.assertEqual(r['units'][0]['reason'],'unit_masked')
    def test_transitions_not_claimed_active(self):
        for state,sub in [('activating','start'),('deactivating','stop-sigterm'),('reloading','reload')]:
            rows=records();rows[s.UNITS[2]].update(ActiveState=state,SubState=sub)
            self.assertFalse(self.collect(rows)['ok'])
    def test_absent_required_unit_does_not_pass(self):
        rows=records();rows[s.UNITS[2]].update(LoadState='not-found',ActiveState='inactive',SubState='dead')
        self.assertFalse(self.collect(rows,code=5)['ok'])
    def test_absent_inventory_is_not_unavailable(self):
        rows=records()
        for r in rows.values():r.update(LoadState='not-found',ActiveState='inactive',SubState='dead')
        out=self.collect(rows,code=5);self.assertEqual(out['status'],'required_units_not_active');self.assertEqual(len(out['units']),4)
    def test_nonzero_code_without_absent_unit_is_rejected(self):self.assertEqual(self.collect(records(True),code=1)['status'],'unavailable')
    def test_unknown_exitcode_never_passes(self):self.assertEqual(self.collect(code=124)['status'],'unavailable')
    def test_empty_manager_error_is_not_absent_or_healthy(self):
        with patch.object(s.os,'geteuid',return_value=1001):r=s.collect(runner=lambda:(1,b''))
        self.assertEqual(r['error'],'manager_unavailable');self.assertEqual(r['units'],[])
    def test_os_errors_do_not_echo_credentials(self):
        def fail():raise OSError('SECRET /private/path')
        with patch.object(s.os,'geteuid',return_value=1001):r=s.collect(runner=fail)
        self.assertEqual(r['error'],'manager_unavailable');self.assertNotIn('SECRET',json.dumps(r));self.assertNotIn('/private',json.dumps(r))
    def test_duplicate_properties_fail(self):
        with self.assertRaises(s.StatusError):s.parse_units(wire(records()).replace(b'LoadState=loaded',b'LoadState=loaded\nLoadState=loaded',1),0)
    def test_extra_properties_are_rejected(self):
        with self.assertRaises(s.StatusError):s.parse_units(wire(records())+b'Environment=SECRET\n',0)
    def test_partial_and_duplicate_inventory_fail(self):
        rows=records();rows.pop(s.UNITS[3])
        with self.assertRaises(s.StatusError):s.parse_units(wire(rows),0)
        with self.assertRaises(s.StatusError):s.parse_units(wire(records())+b'\n'+wire({s.UNITS[0]:records()[s.UNITS[0]]}),0)
    def test_foreign_unit_alias_rejected(self):
        rows=records();rows[s.UNITS[0]]['Id']='foreign.service'
        with self.assertRaises(s.StatusError):s.parse_units(wire(rows),0)
    def test_numbers_and_required_fields_checked(self):
        for value in [None,'-1','1.0','1e3','4294967296','SECRET']:
            rows=records()
            if value is None:rows[s.UNITS[2]].pop('NRestarts')
            else:rows[s.UNITS[2]]['NRestarts']=value
            self.assertEqual(self.collect(rows)['error'],'invalid_manager_response')
    def test_binary_control_and_oversize_refused(self):
        for raw in [b'\xff',b'a\0b',b'a\r\nb',b'x'*17000]:
            with self.assertRaises(s.StatusError):s.parse_units(raw,0)
    def test_invalid_args_never_query_or_echo(self):
        with patch.object(s,'collect') as reader,contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(s.main(['--token','SECRET']),2)
        reader.assert_not_called();self.assertNotIn('SECRET',out.getvalue())
    def test_duplicate_flags_refused(self):
        with patch.object(s,'collect') as reader,contextlib.redirect_stdout(io.StringIO()):self.assertEqual(s.main(['--expect-worker']*2),2)
        reader.assert_not_called()
    def test_root_and_nonlinux_refuse_before_probe(self):
        for platform,uid in [('linux',0),('win32',1001)]:
            with patch.object(s.sys,'platform',platform),patch.object(s.os,'geteuid',return_value=uid),patch.object(s,'run_show') as probe:
                self.assertEqual(s.collect()['status'],'unavailable');probe.assert_not_called()
    def test_fixed_command_no_journal_or_secrets(self):
        args=s.command();self.assertEqual(args[0],'/usr/bin/systemctl');self.assertEqual(args[-4:],list(s.UNITS));self.assertIn('show',args)
        for item in ('Environment','ExecStart','FragmentPath','status','journal','start','stop','enable'):
            self.assertNotIn(item,' '.join(args).replace('NRestarts',''))
    def test_environment_not_ambient_remote_manager(self):
        with patch.dict(os.environ,{'OPENAI_API_KEY':'SECRET','DBUS_SESSION_BUS_ADDRESS':'tcp:host=attacker','LD_PRELOAD':'/secret','SYSTEMD_UNIT_PATH':'/secret'}):env=s.manager_environment()
        self.assertNotIn('SECRET',json.dumps(env));self.assertNotIn('attacker',json.dumps(env));self.assertNotIn('LD_PRELOAD',env)
        self.assertEqual(env['DBUS_SESSION_BUS_ADDRESS'],f'unix:path=/run/user/{os.geteuid()}/bus')
    def test_exit_mapping(self):
        for value,code in [({'ok':True,'status':'required_units_active'},0),({'ok':False,'status':'required_units_not_active'},1),({'ok':False,'status':'unavailable'},3)]:
            with patch.object(s,'collect',return_value=value),contextlib.redirect_stdout(io.StringIO()):self.assertEqual(s.main([]),code)

class ProcessTests(unittest.TestCase):
    def invoke(self,program,**kw):
        with patch.object(s,'command',return_value=[sys.executable,'-I','-c',program]):return s.run_show(**kw)
    def test_real_child_stdout_exit_stderr(self):
        code,raw=self.invoke('import sys;print("synthetic");print("SECRET",file=sys.stderr);sys.exit(4)')
        self.assertEqual(code,4);self.assertEqual(raw,b'synthetic\n')
    def test_no_kill_after_successful_wait(self):
        with patch.object(s.os,'killpg',wraps=os.killpg) as kill:self.invoke('print("ok")')
        kill.assert_not_called()
    def test_stdout_bound(self):
        with self.assertRaisesRegex(s.StatusError,'manager_output_limit'):self.invoke('import os;os.write(1,b"x"*32768)',output_limit=500)
    def test_stderr_bound_without_buffering(self):
        with self.assertRaisesRegex(s.StatusError,'manager_output_limit'):self.invoke('import os;os.write(2,b"x"*32768)',output_limit=500)
    def test_timeout_terminates_only_created_group(self):
        start=time.monotonic()
        with patch.object(s.os,'killpg',wraps=os.killpg) as kill:
            with self.assertRaisesRegex(s.StatusError,'manager_timeout'):self.invoke('import time;time.sleep(30)',timeout=.2)
            self.assertEqual(kill.call_count,1);self.assertEqual(kill.call_args.args[1],signal.SIGKILL)
        self.assertLess(time.monotonic()-start,4)
    def test_descendant_cannot_hold_probe_open(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'pid'
            program=f'import os,time;p=os.fork();open({str(path)!r},"w").write(str(p)) if p else time.sleep(30)'
            with self.assertRaisesRegex(s.StatusError,'manager_timeout'):self.invoke(program,timeout=2)
            pid=int(path.read_text());status=Path(f'/proc/{pid}/stat')
            def running_state():
                try:return status.read_text().split()[2]
                except FileNotFoundError:return None
            deadline=time.monotonic()+2
            while running_state() not in (None,'Z') and time.monotonic()<deadline:time.sleep(.01)
            self.assertIn(running_state(),(None,'Z'))
    def test_real_child_env_without_provider_keys(self):
        with patch.dict(os.environ,{'OPENAI_API_KEY':'SECRET'}):_,raw=self.invoke('import os;print(os.environ.get("OPENAI_API_KEY","absent"))')
        self.assertEqual(raw,b'absent\n')

if __name__=='__main__':unittest.main()
