#!/usr/bin/python3
"""CI-only console cache reference; never start a unit or change its files.

systemd v255 tracks RefUnit by the caller's unique bus connection:
https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c
https://github.com/systemd/systemd/blob/v255/src/core/unit.c
Synchronous calls need no client event loop. Closing the connection releases
its reference; this pins the console only, not an independently collected target.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import pwd
import selectors
import signal
import sys

UNIT = 'ultrabrain-personal-console.service'
BUS_NAME = 'org.freedesktop.systemd1'
MANAGER_PATH = '/org/freedesktop/systemd1'
MANAGER_INTERFACE = 'org.freedesktop.systemd1.Manager'
UNIT_PATH = MANAGER_PATH+'/unit/ultrabrain_2dpersonal_2dconsole_2eservice'
READY = 'ULTRABRAIN_CACHE_PIN_READY'
RELEASED = 'ULTRABRAIN_CACHE_PIN_RELEASED'


class PinError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PinError('invalid_arguments')


def fixture_home(value):
    if sys.platform != 'linux' or os.getuid() != os.geteuid() or os.getuid() == 0:
        raise PinError('ordinary_ci_account_required')
    expected = Path(pwd.getpwuid(os.getuid()).pw_dir)/'ultrabrain-personal-services-test'
    if (os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('ULTRABRAIN_TEST_ALLOW_WRITE') != '1'
            or os.environ.get('ULTRABRAIN_SYSTEMD_TEST') != '1'
            or os.environ.get('ULTRABRAIN_HOME') != str(expected)
            or value != str(expected)):
        raise PinError('disposable_fixture_required')
    return expected


def verify_owned_console(home):
    # Acquire on the clean A installation before the parent's update sequence.
    # systemd serializes the client reference through later daemon reloads.
    filename = Path(__file__).resolve().parents[1]/'scripts/personal-deploy.py'
    spec = importlib.util.spec_from_file_location('ci_cache_pin_deploy', filename)
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    try:
        context = deploy.Context(home)
        status = context.status()
        expected = status['unit_paths'][UNIT]
        actual = context._links()[UNIT]
        if (status['pending_sha256'] is not None or not status['filesystem_binding_verified']
                or status['current_sha256'] is None or expected is None or actual is None
                or actual['target'] != expected):
            raise PinError('fixture_binding_failed')
    except Exception:
        raise PinError('fixture_binding_failed') from None


def hold_pin(dbus_module, uid, input_fd, output, *, hold_seconds=180):
    """Internal mockable fixture operation; main supplies the actual guarded UID."""
    connection = manager = None
    referenced = False
    try:
        connection = dbus_module.bus.BusConnection('unix:path=/run/user/'+str(uid)+'/bus')
        proxy = connection.get_object(BUS_NAME, MANAGER_PATH, introspect=False)
        manager = dbus_module.Interface(proxy, MANAGER_INTERFACE)
        if str(manager.LoadUnit(UNIT, timeout=5.0)) != UNIT_PATH:
            raise PinError('unexpected_unit_object')
        manager.RefUnit(UNIT, timeout=5.0)
        referenced = True
        # The method reply acknowledges the reference before the parent proceeds.
        print(READY, file=output, flush=True)
        signal.setitimer(signal.ITIMER_REAL, 0)
        with selectors.DefaultSelector() as selector:
            selector.register(input_fd, selectors.EVENT_READ)
            if not selector.select(hold_seconds):
                raise PinError('pin_hold_timeout')
            if os.read(input_fd, 16) not in (b'release\n', b''):
                raise PinError('invalid_release')
    finally:
        # Bound cleanup too; a lost reply must not leave the connection open.
        signal.setitimer(signal.ITIMER_REAL, 10)
        try:
            if referenced:
                manager.UnrefUnit(UNIT, timeout=5.0)
        finally:
            try:
                if connection is not None:
                    connection.close()
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
    print(RELEASED, file=output, flush=True)


def alarm(signum, frame):
    raise PinError('pin_timeout')


def interrupted(signum, frame):
    raise PinError('pin_interrupted')


def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        parser.add_argument('--home', required=True)
        args = parser.parse_args(argv)
        home = fixture_home(args.home)
        signal.signal(signal.SIGALRM, alarm)
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        signal.setitimer(signal.ITIMER_REAL, 15)
        verify_owned_console(home)
        import dbus  # Distribution python3-dbus; no provider or ambient bus used.
        hold_pin(dbus, os.geteuid(), sys.stdin.fileno(), sys.stdout)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, PinError) else 'pin_bus_failed'
        print('ULTRABRAIN_CACHE_PIN_ERROR:'+code, flush=True)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    sys.exit(main())
