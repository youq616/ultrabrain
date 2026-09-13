"""Test loader. Local runs use an explicit ABC fixture; CI can require the real pinned ABC.
This does not instantiate a full Hermes Agent or execute an inference model.
"""
from abc import ABC, abstractmethod
import contextvars
from dataclasses import dataclass
import importlib.util
import os
from pathlib import Path
import sys
import threading
from types import ModuleType


def load_provider():
    reference = os.environ.get('ULTRABRAIN_HERMES_REFERENCE')
    agent = ModuleType('agent'); agent.__path__ = []
    sys.modules['agent'] = agent
    if reference:
        path = Path(reference) / 'agent/memory_provider.py'
        if not path.is_file():
            raise RuntimeError('Pinned Hermes ABC missing; do not silently substitute a fixture')
        spec = importlib.util.spec_from_file_location('agent.memory_provider', path)
        base = importlib.util.module_from_spec(spec); sys.modules[spec.name] = base; spec.loader.exec_module(base)
    else:
        base = ModuleType('agent.memory_provider')
        class MemoryProvider(ABC):
            @property
            @abstractmethod
            def name(self): ...
            @abstractmethod
            def is_available(self): ...
            @abstractmethod
            def initialize(self, session_id, **kwargs): ...
            @abstractmethod
            def get_tool_schemas(self): ...
            def sync_turn(self, *args, **kwargs): pass
            def on_memory_write(self, *args, **kwargs): pass
            def on_session_end(self, *args): pass
        @dataclass
        class RecallStatus:
            provider_label: str
            count: int
        def spawn_context_thread(target, *, name, daemon=True):
            context = contextvars.copy_context()
            return threading.Thread(target=lambda: context.run(target), name=name, daemon=daemon)
        base.MemoryProvider = MemoryProvider; base.RecallStatus = RecallStatus; base.spawn_context_thread = spawn_context_thread
        sys.modules['agent.memory_provider'] = base
    path = Path(__file__).resolve().parents[1] / 'integrations/hermes-ultrabrain/__init__.py'
    spec = importlib.util.spec_from_file_location('hermes_ultrabrain_test', path)
    module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module; spec.loader.exec_module(module)
    return module
