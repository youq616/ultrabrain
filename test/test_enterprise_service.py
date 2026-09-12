"""Offline service profile rendering, no installation or production mutation."""
import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('enterprise_service',Path(__file__).resolve().parents[1]/'scripts/install-service.py')
service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
class EnterpriseServiceTests(unittest.TestCase):
    def test_governed_service_profile_is_explicit(self):
        units=service.render(Path('/app'),Path('/private'),Path('/bin/bun'),Path('/bin/python3'),profile='governed')
        self.assertIn('mcp --profile governed --http --bind 127.0.0.1',units['ultrabrain-mcp.service'])
        with self.assertRaises(ValueError):
            service.render(Path('/app'),Path('/private'),Path('/bin/bun'),Path('/bin/python3'),profile='typo')
