"""Tests for domain_configs auto-discovery and registration system.

This module tests the domain discovery mechanism that scans the domain_configs
package, loads domain modules, and registers them with the domain registry.
"""

import sys
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import Mock, patch, MagicMock
import importlib

import pytest

# Add backend directory to sys.path for imports
backend_dir = Path(__file__).resolve().parents[3]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.domains.domain_configs import discover_and_register_domains
from agents.domains.domain_registry import (
    domain_registry,
    DomainSpec,
    AgentSpec,
    AgentBudget,
    ExecutionMode,
)


@pytest.fixture
def clean_registry():
    """Ensure domain registry starts clean for each test."""
    # Store original domains
    original_domains = domain_registry._domains.copy()
    domain_registry._domains.clear()

    yield domain_registry

    # Restore original state
    domain_registry._domains = original_domains


@pytest.fixture
def mock_domain_spec():
    """Create a mock DomainSpec for testing."""
    return DomainSpec(
        domain_id="test_domain",
        name="Test Domain",
        description="A test domain for unit tests",
        agents=[
            AgentSpec(
                agent_id="test_agent",
                name="Test Agent",
                description="A test agent",
                system_prompt="Test prompt",
                execution_mode=ExecutionMode.SEQUENTIAL,
                default_budget=AgentBudget(max_tool_calls=10),
            )
        ],
        tool_allowlist=["test.tool"],
        procedures=[],
        global_context_allowlist=["test_context"],
        parallel_capable=False,
    )


class TestDiscoverAndRegisterDomains:
    """Test suite for discover_and_register_domains function."""

    def test_discovers_and_registers_actual_domains(self, clean_registry):
        """Test that the function discovers and registers real domain files."""
        # Execute the discovery
        registered_ids = discover_and_register_domains()

        # Verify we found at least some domains
        assert len(registered_ids) > 0, "Should discover at least one domain"

        # Verify common expected domains exist
        assert "coder" in registered_ids, "Should find coder domain"

        # Verify domains are actually in the registry
        for domain_id in registered_ids:
            domain = clean_registry.get(domain_id)
            assert domain is not None
            assert domain.domain_id == domain_id

    def test_skips_init_file(self, clean_registry):
        """Test that __init__.py is not processed as a domain."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            # Create mock path that returns __init__.py
            mock_parent = MagicMock()
            mock_init_file = MagicMock()
            mock_init_file.name = "__init__.py"
            mock_init_file.stem = "__init__"

            mock_parent.glob.return_value = [mock_init_file]
            mock_path.return_value.parent = mock_parent

            # Should return empty list since __init__.py is filtered out
            registered_ids = discover_and_register_domains()

            assert registered_ids == []

    def test_skips_underscore_prefixed_files(self, clean_registry):
        """Test that files starting with underscore are skipped."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            mock_parent = MagicMock()
            mock_private_file = MagicMock()
            mock_private_file.name = "_private_module.py"
            mock_private_file.stem = "_private_module"

            mock_parent.glob.return_value = [mock_private_file]
            mock_path.return_value.parent = mock_parent

            registered_ids = discover_and_register_domains()

            assert registered_ids == []

    def test_handles_module_without_get_domain_spec(self, clean_registry, caplog):
        """Test handling of modules that don't have get_domain_spec function."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                # Setup mock file
                mock_parent = MagicMock()
                mock_file = MagicMock()
                mock_file.name = "bad_domain.py"
                mock_file.stem = "bad_domain"
                mock_parent.glob.return_value = [mock_file]
                mock_path.return_value.parent = mock_parent

                # Mock module without get_domain_spec
                mock_module = MagicMock(spec=[])  # Empty spec, no get_domain_spec
                mock_import.return_value = mock_module

                registered_ids = discover_and_register_domains()

                # Should skip the module and log a warning
                assert registered_ids == []
                assert "does not have get_domain_spec() function" in caplog.text
                assert "bad_domain" in caplog.text

    def test_handles_module_import_error(self, clean_registry, caplog):
        """Test handling of modules that fail to import."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                # Setup mock file
                mock_parent = MagicMock()
                mock_file = MagicMock()
                mock_file.name = "broken_domain.py"
                mock_file.stem = "broken_domain"
                mock_parent.glob.return_value = [mock_file]
                mock_path.return_value.parent = mock_parent

                # Mock import that raises an error
                mock_import.side_effect = ImportError("Module not found")

                registered_ids = discover_and_register_domains()

                # Should handle error gracefully and log it
                assert registered_ids == []
                assert "Failed to load domain from broken_domain.py" in caplog.text

    def test_handles_get_domain_spec_error(self, clean_registry, caplog):
        """Test handling when get_domain_spec raises an exception."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                # Setup mock file
                mock_parent = MagicMock()
                mock_file = MagicMock()
                mock_file.name = "error_domain.py"
                mock_file.stem = "error_domain"
                mock_parent.glob.return_value = [mock_file]
                mock_path.return_value.parent = mock_parent

                # Mock module with get_domain_spec that raises
                mock_module = MagicMock()
                mock_module.get_domain_spec.side_effect = ValueError("Invalid spec")
                mock_import.return_value = mock_module

                registered_ids = discover_and_register_domains()

                # Should handle error gracefully
                assert registered_ids == []
                assert "Failed to load domain from error_domain.py" in caplog.text
                assert "Invalid spec" in caplog.text

    def test_registers_domains_in_sorted_order(self, clean_registry, mock_domain_spec):
        """Test that domains are processed in alphabetical order."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                # Setup multiple mock files with __lt__ for sorting
                mock_parent = MagicMock()
                files = []
                for name in ["zebra", "alpha", "beta"]:
                    mock_file = MagicMock()
                    mock_file.name = f"{name}.py"
                    mock_file.stem = name
                    # Add comparison support for sorting
                    mock_file.__lt__ = lambda self, other: str(self) < str(other)
                    mock_file.__str__ = lambda self: self.name
                    files.append(mock_file)

                # Return unsorted list
                mock_parent.glob.return_value = files
                mock_path.return_value.parent = mock_parent

                # Track import order
                import_order = []

                def track_import(module_name):
                    import_order.append(module_name.split(".")[-1])
                    mock_module = MagicMock()
                    spec = DomainSpec(
                        domain_id=module_name.split(".")[-1],
                        name=f"{module_name} Domain",
                        description="Test",
                        agents=[],
                        tool_allowlist=[],
                        procedures=[],
                        global_context_allowlist=[],
                    )
                    mock_module.get_domain_spec.return_value = spec
                    return mock_module

                mock_import.side_effect = track_import

                registered_ids = discover_and_register_domains()

                # Verify sorted order
                assert import_order == ["alpha", "beta", "zebra"]
                assert registered_ids == ["alpha", "beta", "zebra"]

    def test_logs_successful_registration(self, clean_registry, caplog):
        """Test that successful registrations are logged."""
        # Set caplog to capture INFO level logs
        with caplog.at_level("INFO"):
            registered_ids = discover_and_register_domains()

            # Should log each successful registration
            for domain_id in registered_ids:
                assert f"Registered domain '{domain_id}'" in caplog.text

            # Should log completion summary
            assert "Domain auto-discovery complete" in caplog.text
            assert f"{len(registered_ids)} domains registered" in caplog.text

    def test_returns_list_of_registered_domain_ids(self, clean_registry):
        """Test that function returns list of registered domain IDs."""
        registered_ids = discover_and_register_domains()

        # Should return a list
        assert isinstance(registered_ids, list)

        # All items should be strings
        assert all(isinstance(domain_id, str) for domain_id in registered_ids)

        # Each returned ID should match a registered domain
        for domain_id in registered_ids:
            assert clean_registry.get(domain_id).domain_id == domain_id

    def test_filters_only_python_files(self, clean_registry):
        """Test that only .py files are processed."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            # Setup mock files of different types
            mock_parent = MagicMock()

            # Mock glob to only return .py files (as it would in reality)
            py_file = MagicMock()
            py_file.name = "valid.py"
            py_file.stem = "valid"

            mock_parent.glob.return_value = [py_file]
            mock_path.return_value.parent = mock_parent

            # The glob pattern "*.py" already filters for us
            # Just verify it's using the right pattern
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                mock_module = MagicMock()
                mock_module.get_domain_spec.return_value = DomainSpec(
                    domain_id="valid",
                    name="Valid",
                    description="Test",
                    agents=[],
                    tool_allowlist=[],
                    procedures=[],
                    global_context_allowlist=[],
                )
                mock_import.return_value = mock_module

                registered_ids = discover_and_register_domains()

                # Should call glob with *.py pattern
                mock_parent.glob.assert_called_with("*.py")
                assert "valid" in registered_ids

    def test_handles_empty_domain_directory(self, clean_registry):
        """Test handling when no domain files exist."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            mock_parent = MagicMock()
            mock_parent.glob.return_value = []
            mock_path.return_value.parent = mock_parent

            registered_ids = discover_and_register_domains()

            assert registered_ids == []

    def test_domain_spec_integration(self, clean_registry):
        """Integration test: verify discovered domains have valid specs."""
        registered_ids = discover_and_register_domains()

        for domain_id in registered_ids:
            domain = clean_registry.get(domain_id)

            # Verify required fields are present
            assert domain.domain_id
            assert domain.name
            assert domain.description
            assert isinstance(domain.agents, list)
            assert isinstance(domain.tool_allowlist, list)
            assert isinstance(domain.procedures, list)
            assert isinstance(domain.global_context_allowlist, list)
            assert isinstance(domain.parallel_capable, bool)

            # Verify at least one agent per domain
            assert len(domain.agents) > 0, f"Domain {domain_id} has no agents"

    def test_module_import_path_construction(self, clean_registry):
        """Test that module import paths are constructed correctly."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                mock_parent = MagicMock()
                mock_file = MagicMock()
                mock_file.name = "test_domain.py"
                mock_file.stem = "test_domain"
                mock_parent.glob.return_value = [mock_file]
                mock_path.return_value.parent = mock_parent

                mock_module = MagicMock()
                mock_module.get_domain_spec.return_value = DomainSpec(
                    domain_id="test_domain",
                    name="Test",
                    description="Test",
                    agents=[],
                    tool_allowlist=[],
                    procedures=[],
                    global_context_allowlist=[],
                )
                mock_import.return_value = mock_module

                discover_and_register_domains()

                # Verify correct import path
                mock_import.assert_called_once_with(
                    "agents.domains.domain_configs.test_domain"
                )

    def test_error_recovery_continues_processing(self, clean_registry, caplog):
        """Test that errors in one domain don't stop processing of others."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                # Setup multiple files, one will fail
                mock_parent = MagicMock()
                files = []
                for name in ["good1", "bad", "good2"]:
                    mock_file = MagicMock()
                    mock_file.name = f"{name}.py"
                    mock_file.stem = name
                    # Add comparison support for sorting
                    mock_file.__lt__ = lambda self, other: str(self) < str(other)
                    mock_file.__str__ = lambda self: self.name
                    files.append(mock_file)

                mock_parent.glob.return_value = files
                mock_path.return_value.parent = mock_parent

                # Mock import behavior
                def import_side_effect(module_name):
                    module_stem = module_name.split(".")[-1]
                    if module_stem == "bad":
                        raise ImportError("Intentional error")

                    mock_module = MagicMock()
                    spec = DomainSpec(
                        domain_id=module_stem,
                        name=f"{module_stem} Domain",
                        description="Test",
                        agents=[],
                        tool_allowlist=[],
                        procedures=[],
                        global_context_allowlist=[],
                    )
                    mock_module.get_domain_spec.return_value = spec
                    return mock_module

                mock_import.side_effect = import_side_effect

                with caplog.at_level("ERROR"):
                    registered_ids = discover_and_register_domains()

                    # Should register the good ones despite the bad one
                    assert "good1" in registered_ids
                    assert "good2" in registered_ids
                    assert "bad" not in registered_ids

                    # Should log the error
                    assert "Failed to load domain from bad.py" in caplog.text

    def test_handles_get_domain_spec_returning_none(self, clean_registry, caplog):
        """Test handling when get_domain_spec returns None instead of a spec."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                mock_parent = MagicMock()
                mock_file = MagicMock()
                mock_file.name = "null_domain.py"
                mock_file.stem = "null_domain"
                mock_parent.glob.return_value = [mock_file]
                mock_path.return_value.parent = mock_parent

                mock_module = MagicMock()
                mock_module.get_domain_spec.return_value = None
                mock_import.return_value = mock_module

                registered_ids = discover_and_register_domains()

                assert registered_ids == []
                assert "null_domain" in caplog.text or len(registered_ids) == 0

    def test_handles_domain_with_invalid_spec_type(self, clean_registry, caplog):
        """Test handling when get_domain_spec returns wrong type."""
        with patch("agents.domains.domain_configs.Path") as mock_path:
            with patch("agents.domains.domain_configs.importlib.import_module") as mock_import:
                mock_parent = MagicMock()
                mock_file = MagicMock()
                mock_file.name = "bad_type_domain.py"
                mock_file.stem = "bad_type_domain"
                mock_parent.glob.return_value = [mock_file]
                mock_path.return_value.parent = mock_parent

                mock_module = MagicMock()
                mock_module.get_domain_spec.return_value = "not a DomainSpec"
                mock_import.return_value = mock_module

                # Should handle gracefully (registry.register will fail)
                registered_ids = discover_and_register_domains()
                assert "bad_type_domain" not in registered_ids

