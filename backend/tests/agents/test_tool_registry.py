"""Unit tests for tool registry."""

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import (
    ToolRegistry,
    ToolSpec,
    ToolResult,
    ToolExecutionContext
)


class TestToolExecutionContext(unittest.TestCase):
    """Test ToolExecutionContext dataclass."""

    def test_creates_context_with_all_fields(self):
        """Context should be created with all required fields."""
        ctx = ToolExecutionContext(
            chat_id="chat_123",
            plan_id="plan_456",
            task_id="task_789",
            ctx_id="ctx_abc"
        )

        self.assertEqual(ctx.chat_id, "chat_123")
        self.assertEqual(ctx.plan_id, "plan_456")
        self.assertEqual(ctx.task_id, "task_789")
        self.assertEqual(ctx.ctx_id, "ctx_abc")


class TestToolResult(unittest.TestCase):
    """Test ToolResult dataclass."""

    def test_creates_result_with_output_only(self):
        """Result can be created with just output."""
        result = ToolResult(output="test output")

        self.assertEqual(result.output, "test output")
        self.assertEqual(result.metadata, {})

    def test_creates_result_with_all_fields(self):
        """Result can be created with output and metadata."""
        metadata = {"duration_ms": 150}

        result = ToolResult(
            output="test output",
            metadata=metadata
        )

        self.assertEqual(result.output, "test output")
        self.assertEqual(result.metadata, metadata)

    def test_supports_any_output_type(self):
        """Output can be any type."""
        result_dict = ToolResult(output={"key": "value"})
        result_list = ToolResult(output=[1, 2, 3])
        result_int = ToolResult(output=42)

        self.assertEqual(result_dict.output, {"key": "value"})
        self.assertEqual(result_list.output, [1, 2, 3])
        self.assertEqual(result_int.output, 42)


class TestToolSpec(unittest.TestCase):
    """Test ToolSpec dataclass."""

    def test_creates_spec_with_all_required_fields(self):
        """ToolSpec should be created with all required fields."""
        mock_fn = Mock()

        spec = ToolSpec(
            name="test.tool",
            version="1.0",
            description="Test tool",
            effects=["read"],
            in_schema={"type": "object"},
            out_schema={"type": "object"},
            fn=mock_fn
        )

        self.assertEqual(spec.name, "test.tool")
        self.assertEqual(spec.version, "1.0")
        self.assertEqual(spec.description, "Test tool")
        self.assertEqual(spec.effects, ["read"])
        self.assertEqual(spec.in_schema, {"type": "object"})
        self.assertEqual(spec.out_schema, {"type": "object"})
        self.assertEqual(spec.fn, mock_fn)
        self.assertIsNone(spec.rate_key)

    def test_creates_spec_with_rate_key(self):
        """ToolSpec can include optional rate_key."""
        mock_fn = Mock()

        spec = ToolSpec(
            name="test.tool",
            version="1.0",
            description="Test tool",
            effects=[],
            in_schema={},
            out_schema={},
            fn=mock_fn,
            rate_key="test.rate"
        )

        self.assertEqual(spec.rate_key, "test.rate")


class TestToolRegistry(unittest.TestCase):
    """Test ToolRegistry functionality."""

    def setUp(self):
        """Create a fresh registry for each test."""
        self.registry = ToolRegistry()

    def test_registry_starts_empty(self):
        """New registry should have no tools."""
        tools = self.registry.list()
        self.assertEqual(tools, [])

    def test_register_adds_tool(self):
        """Registering a tool should add it to the registry."""
        mock_fn = Mock()
        spec = ToolSpec(
            name="test.tool",
            version="1.0",
            description="Test",
            effects=[],
            in_schema={},
            out_schema={},
            fn=mock_fn
        )

        self.registry.register(spec)

        tools = self.registry.list()
        self.assertEqual(tools, ["test.tool"])

    def test_register_overwrites_existing_tool(self):
        """Registering same tool name should overwrite."""
        mock_fn1 = Mock(return_value="v1")
        mock_fn2 = Mock(return_value="v2")

        spec1 = ToolSpec(
            name="test.tool",
            version="1.0",
            description="V1",
            effects=[],
            in_schema={},
            out_schema={},
            fn=mock_fn1
        )

        spec2 = ToolSpec(
            name="test.tool",
            version="2.0",
            description="V2",
            effects=[],
            in_schema={},
            out_schema={},
            fn=mock_fn2
        )

        self.registry.register(spec1)
        self.registry.register(spec2)

        retrieved = self.registry.get("test.tool")
        self.assertEqual(retrieved.version, "2.0")
        self.assertEqual(retrieved.description, "V2")

    def test_get_retrieves_registered_tool(self):
        """get() should retrieve a registered tool."""
        mock_fn = Mock()
        spec = ToolSpec(
            name="retrieve.tool",
            version="1.5",
            description="Retrievable",
            effects=["read"],
            in_schema={"type": "object"},
            out_schema={"type": "string"},
            fn=mock_fn
        )

        self.registry.register(spec)
        retrieved = self.registry.get("retrieve.tool")

        self.assertEqual(retrieved.name, "retrieve.tool")
        self.assertEqual(retrieved.version, "1.5")
        self.assertEqual(retrieved.description, "Retrievable")
        self.assertEqual(retrieved.effects, ["read"])

    def test_get_raises_key_error_for_unregistered_tool(self):
        """get() should raise KeyError for unregistered tool."""
        with self.assertRaises(KeyError) as cm:
            self.registry.get("nonexistent.tool")

        self.assertIn("nonexistent.tool", str(cm.exception))
        self.assertIn("not registered", str(cm.exception))

    def test_list_returns_sorted_tool_names(self):
        """list() should return sorted list of tool names."""
        tools = [
            ToolSpec("zebra.tool", "1.0", "Z", [], {}, {}, Mock()),
            ToolSpec("alpha.tool", "1.0", "A", [], {}, {}, Mock()),
            ToolSpec("beta.tool", "1.0", "B", [], {}, {}, Mock())
        ]

        for tool in tools:
            self.registry.register(tool)

        names = self.registry.list()
        self.assertEqual(names, ["alpha.tool", "beta.tool", "zebra.tool"])

    def test_get_all_tools_returns_all_specs(self):
        """get_all_tools() should return list of all ToolSpec objects."""
        spec1 = ToolSpec("tool.one", "1.0", "One", [], {}, {}, Mock())
        spec2 = ToolSpec("tool.two", "1.0", "Two", [], {}, {}, Mock())

        self.registry.register(spec1)
        self.registry.register(spec2)

        all_tools = self.registry.get_all_tools()

        self.assertEqual(len(all_tools), 2)
        tool_names = [tool.name for tool in all_tools]
        self.assertIn("tool.one", tool_names)
        self.assertIn("tool.two", tool_names)

    def test_register_multiple_tools_with_different_names(self):
        """Multiple tools with different names should all be registered."""
        tools = [
            ToolSpec(f"tool.{i}", "1.0", f"Tool {i}", [], {}, {}, Mock())
            for i in range(5)
        ]

        for tool in tools:
            self.registry.register(tool)

        names = self.registry.list()
        self.assertEqual(len(names), 5)
        for i in range(5):
            self.assertIn(f"tool.{i}", names)

    def test_tool_function_is_callable(self):
        """Registered tool function should be callable."""
        def test_fn(params, ctx):
            return ToolResult(output=f"Called with {params}")

        spec = ToolSpec(
            name="callable.tool",
            version="1.0",
            description="Test",
            effects=[],
            in_schema={},
            out_schema={},
            fn=test_fn
        )

        self.registry.register(spec)
        retrieved = self.registry.get("callable.tool")

        ctx = ToolExecutionContext("c1", "p1", "t1", "ctx1")
        result = retrieved.fn({"test": "data"}, ctx)

        self.assertIsInstance(result, ToolResult)
        self.assertEqual(result.output, "Called with {'test': 'data'}")


class TestToolRegistryEdgeCases(unittest.TestCase):
    """Test edge cases and error conditions."""

    def setUp(self):
        """Create a fresh registry for each test."""
        self.registry = ToolRegistry()

    def test_get_all_tools_returns_empty_list_initially(self):
        """get_all_tools() should return empty list for new registry."""
        all_tools = self.registry.get_all_tools()
        self.assertEqual(all_tools, [])

    def test_register_tool_with_empty_effects(self):
        """Tool with no effects should register successfully."""
        spec = ToolSpec(
            name="no.effects",
            version="1.0",
            description="Test",
            effects=[],
            in_schema={},
            out_schema={},
            fn=Mock()
        )

        self.registry.register(spec)
        retrieved = self.registry.get("no.effects")
        self.assertEqual(retrieved.effects, [])

    def test_register_tool_with_complex_schemas(self):
        """Tool with complex schemas should register successfully."""
        in_schema = {
            "type": "object",
            "properties": {
                "field1": {"type": "string"},
                "field2": {"type": "number"},
                "nested": {
                    "type": "object",
                    "properties": {
                        "inner": {"type": "boolean"}
                    }
                }
            },
            "required": ["field1"]
        }

        out_schema = {
            "type": "object",
            "properties": {
                "result": {"type": "string"},
                "status": {"type": "string", "enum": ["success", "error"]}
            }
        }

        spec = ToolSpec(
            name="complex.tool",
            version="1.0",
            description="Complex",
            effects=["read", "write"],
            in_schema=in_schema,
            out_schema=out_schema,
            fn=Mock()
        )

        self.registry.register(spec)
        retrieved = self.registry.get("complex.tool")

        self.assertEqual(retrieved.in_schema, in_schema)
        self.assertEqual(retrieved.out_schema, out_schema)

    def test_register_tool_with_special_characters_in_name(self):
        """Tool names with dots and underscores should work."""
        names = [
            "my_tool.action",
            "tool.with.many.dots",
            "tool_with_underscores",
            "mix_of.both_types.here"
        ]

        for name in names:
            spec = ToolSpec(name, "1.0", "Test", [], {}, {}, Mock())
            self.registry.register(spec)

        registered = self.registry.list()
        for name in names:
            self.assertIn(name, registered)


class TestToolRegistryIsolation(unittest.TestCase):
    """Test that registries are isolated from each other."""

    def test_separate_registries_are_independent(self):
        """Multiple registry instances should be independent."""
        registry1 = ToolRegistry()
        registry2 = ToolRegistry()

        spec1 = ToolSpec("tool.one", "1.0", "One", [], {}, {}, Mock())
        spec2 = ToolSpec("tool.two", "1.0", "Two", [], {}, {}, Mock())

        registry1.register(spec1)
        registry2.register(spec2)

        self.assertEqual(registry1.list(), ["tool.one"])

        self.assertEqual(registry2.list(), ["tool.two"])

        with self.assertRaises(KeyError):
            registry1.get("tool.two")

        with self.assertRaises(KeyError):
            registry2.get("tool.one")


if __name__ == "__main__":
    unittest.main()
