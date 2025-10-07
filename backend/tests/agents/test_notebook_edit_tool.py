"""Comprehensive unit tests for notebook edit tool.

This module tests the file.notebook_edit tool including:
- Replace: Modify cell content by cell_id or cell_number
- Insert: Add new cells at specified positions
- Delete: Remove cells from notebooks
- Edge cases and error handling
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from agents.tools.tool_registry import ToolExecutionContext
from agents.tools.file_ops.notebook_edit_func import _tool_notebook_edit


class TestNotebookEditReplace(unittest.TestCase):
    """Test notebook edit replace mode functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_notebook_replace"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def _create_test_notebook(self, filename="test.ipynb"):
        """Create a basic test notebook."""
        notebook = {
            "cells": [
                {
                    "cell_type": "code",
                    "id": "cell1",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["print('hello')\n"],
                    "outputs": []
                },
                {
                    "cell_type": "markdown",
                    "id": "cell2",
                    "metadata": {},
                    "source": ["# Title\n"]
                },
                {
                    "cell_type": "code",
                    "id": "cell3",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["x = 42\n"],
                    "outputs": []
                }
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
        notebook_path = self.temp_path / filename
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1)
        return notebook_path

    def test_replace_cell_by_cell_id(self):
        """Should replace cell content by cell_id."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "replace",
                "cell_id": "cell1",
                "new_source": "print('modified')\n",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["operation"], "replace")
        self.assertEqual(result.output["cell_id"], "cell1")

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        self.assertEqual(notebook["cells"][0]["source"], ["print('modified')\n"])

    def test_replace_cell_by_cell_number(self):
        """Should replace cell content by cell_number (0-indexed)."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "replace",
                "cell_number": 1,
                "new_source": "## Modified Title",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["cell_index"], 1)

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        self.assertEqual(notebook["cells"][1]["source"], ["## Modified Title"])

    def test_replace_cell_and_change_type(self):
        """Should replace cell and change its type from code to markdown."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "replace",
                "cell_id": "cell1",
                "new_source": "# Now markdown",
                "cell_type": "markdown",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["old_cell_type"], "code")
        self.assertEqual(result.output["new_cell_type"], "markdown")

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        cell = notebook["cells"][0]
        self.assertEqual(cell["cell_type"], "markdown")
        self.assertNotIn("execution_count", cell)
        self.assertNotIn("outputs", cell)

    def test_replace_multiline_content(self):
        """Should handle multiline content in replace mode."""
        notebook_path = self._create_test_notebook()
        new_content = "def foo():\n    return 42\n\nfoo()"

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "replace",
                "cell_number": 0,
                "new_source": new_content,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        source = notebook["cells"][0]["source"]
        self.assertEqual(len(source), 4)
        self.assertEqual(source[0], "def foo():\n")
        self.assertEqual(source[3], "foo()")

    def test_replace_invalid_cell_id(self):
        """Should raise ValueError for non-existent cell_id."""
        notebook_path = self._create_test_notebook()

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "replace",
                    "cell_id": "nonexistent",
                    "new_source": "test",
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("not found", str(cm.exception))

    def test_replace_invalid_cell_number(self):
        """Should raise ValueError for out of range cell_number."""
        notebook_path = self._create_test_notebook()

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "replace",
                    "cell_number": 99,
                    "new_source": "test",
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("out of range", str(cm.exception))

    def test_replace_both_cell_id_and_number(self):
        """Should raise ValueError when both cell_id and cell_number are specified."""
        notebook_path = self._create_test_notebook()

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "replace",
                    "cell_id": "cell1",
                    "cell_number": 0,
                    "new_source": "test",
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("Cannot specify both", str(cm.exception))

    def test_replace_neither_cell_id_nor_number(self):
        """Should raise ValueError when neither cell_id nor cell_number is specified."""
        notebook_path = self._create_test_notebook()

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "replace",
                    "new_source": "test",
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("Must specify either", str(cm.exception))

    def test_replace_missing_new_source(self):
        """Should raise ValueError when new_source is missing."""
        notebook_path = self._create_test_notebook()

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "replace",
                    "cell_number": 0,
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("new_source is required", str(cm.exception))


class TestNotebookEditInsert(unittest.TestCase):
    """Test notebook edit insert mode functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_notebook_insert"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def _create_test_notebook(self, filename="test.ipynb"):
        """Create a basic test notebook."""
        notebook = {
            "cells": [
                {
                    "cell_type": "code",
                    "id": "cell1",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["print('hello')\n"],
                    "outputs": []
                },
                {
                    "cell_type": "code",
                    "id": "cell2",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["x = 42\n"],
                    "outputs": []
                }
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
        notebook_path = self.temp_path / filename
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1)
        return notebook_path

    def test_insert_cell_at_end(self):
        """Should insert cell at end when no cell reference is given."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "insert",
                "new_source": "print('new cell')",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["operation"], "insert")
        self.assertEqual(result.output["new_cell_count"], 3)

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        self.assertEqual(len(notebook["cells"]), 3)
        self.assertEqual(notebook["cells"][2]["source"], ["print('new cell')"])

    def test_insert_cell_after_cell_id(self):
        """Should insert cell after specified cell_id."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "insert",
                "cell_id": "cell1",
                "new_source": "# Inserted after cell1",
                "cell_type": "markdown",
                "insert_after": True,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["cell_index"], 1)

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        self.assertEqual(len(notebook["cells"]), 3)
        self.assertEqual(notebook["cells"][1]["cell_type"], "markdown")
        self.assertEqual(notebook["cells"][1]["source"], ["# Inserted after cell1"])

    def test_insert_cell_before_cell_number(self):
        """Should insert cell before specified cell_number."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "insert",
                "cell_number": 0,
                "new_source": "# First cell now",
                "cell_type": "markdown",
                "insert_after": False,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["cell_index"], 0)

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        self.assertEqual(len(notebook["cells"]), 3)
        self.assertEqual(notebook["cells"][0]["cell_type"], "markdown")
        self.assertEqual(notebook["cells"][0]["source"], ["# First cell now"])

    def test_insert_code_cell_has_execution_count(self):
        """Should create code cell with execution_count and outputs."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "insert",
                "new_source": "x = 1",
                "cell_type": "code",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        new_cell = notebook["cells"][-1]
        self.assertEqual(new_cell["cell_type"], "code")
        self.assertIn("execution_count", new_cell)
        self.assertIn("outputs", new_cell)
        self.assertIsNone(new_cell["execution_count"])
        self.assertEqual(new_cell["outputs"], [])

    def test_insert_markdown_cell_no_execution_count(self):
        """Should create markdown cell without execution_count or outputs."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "insert",
                "new_source": "# Markdown",
                "cell_type": "markdown",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        new_cell = notebook["cells"][-1]
        self.assertEqual(new_cell["cell_type"], "markdown")
        self.assertNotIn("execution_count", new_cell)
        self.assertNotIn("outputs", new_cell)

    def test_insert_missing_new_source(self):
        """Should raise ValueError when new_source is missing."""
        notebook_path = self._create_test_notebook()

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "insert",
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("new_source is required", str(cm.exception))

    def test_insert_invalid_cell_type(self):
        """Should raise ValueError for invalid cell_type."""
        notebook_path = self._create_test_notebook()

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "insert",
                    "new_source": "test",
                    "cell_type": "invalid_type",
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("Invalid cell_type", str(cm.exception))


class TestNotebookEditDelete(unittest.TestCase):
    """Test notebook edit delete mode functionality."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_notebook_delete"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def _create_test_notebook(self, filename="test.ipynb"):
        """Create a basic test notebook."""
        notebook = {
            "cells": [
                {
                    "cell_type": "code",
                    "id": "cell1",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["print('hello')\n"],
                    "outputs": []
                },
                {
                    "cell_type": "markdown",
                    "id": "cell2",
                    "metadata": {},
                    "source": ["# Title\n"]
                },
                {
                    "cell_type": "code",
                    "id": "cell3",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["x = 42\n"],
                    "outputs": []
                }
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
        notebook_path = self.temp_path / filename
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1)
        return notebook_path

    def test_delete_cell_by_cell_id(self):
        """Should delete cell by cell_id."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "delete",
                "cell_id": "cell2",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["operation"], "delete")
        self.assertEqual(result.output["cell_id"], "cell2")
        self.assertEqual(result.output["new_cell_count"], 2)

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        self.assertEqual(len(notebook["cells"]), 2)
        cell_ids = [cell["id"] for cell in notebook["cells"]]
        self.assertNotIn("cell2", cell_ids)

    def test_delete_cell_by_cell_number(self):
        """Should delete cell by cell_number."""
        notebook_path = self._create_test_notebook()

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "delete",
                "cell_number": 0,
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertEqual(result.output["cell_index"], 0)

        with open(notebook_path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)
        self.assertEqual(len(notebook["cells"]), 2)
        self.assertEqual(notebook["cells"][0]["id"], "cell2")

    def test_delete_last_remaining_cell(self):
        """Should raise ValueError when trying to delete the last cell."""
        notebook = {
            "cells": [
                {
                    "cell_type": "code",
                    "id": "cell1",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["print('only cell')\n"],
                    "outputs": []
                }
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
        notebook_path = self.temp_path / "single_cell.ipynb"
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1)

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "delete",
                    "cell_number": 0,
                    "create_backup": False
                },
                self.ctx
            )

        self.assertIn("last remaining cell", str(cm.exception))


class TestNotebookEditValidation(unittest.TestCase):
    """Test notebook edit validation and error handling."""

    def setUp(self):
        """Create test context and temporary directory."""
        self.ctx = ToolExecutionContext(
            chat_id="test_chat",
            plan_id="test_plan",
            task_id="test_task",
            ctx_id="test_ctx_notebook_validation"
        )
        self.temp_dir = tempfile.mkdtemp()
        self.temp_path = Path(self.temp_dir)

    def tearDown(self):
        """Clean up temporary files."""
        import shutil
        if self.temp_path.exists():
            shutil.rmtree(self.temp_path)

    def test_nonexistent_file(self):
        """Should raise ValueError for nonexistent file."""
        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": "nonexistent.ipynb",
                    "edit_mode": "replace",
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("does not exist", str(cm.exception))

    def test_not_ipynb_file(self):
        """Should raise ValueError for non-.ipynb file."""
        text_file = self.temp_path / "test.txt"
        text_file.write_text("not a notebook", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(text_file),
                    "edit_mode": "replace",
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("not a Jupyter notebook", str(cm.exception))

    def test_invalid_json(self):
        """Should raise ValueError for invalid JSON file."""
        invalid_notebook = self.temp_path / "invalid.ipynb"
        invalid_notebook.write_text("{ invalid json", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(invalid_notebook),
                    "edit_mode": "replace",
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("not a valid JSON", str(cm.exception))

    def test_invalid_notebook_structure_no_cells(self):
        """Should raise ValueError for notebook without cells field."""
        invalid_notebook = self.temp_path / "no_cells.ipynb"
        with open(invalid_notebook, 'w', encoding='utf-8') as f:
            json.dump({"metadata": {}, "nbformat": 4}, f)

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(invalid_notebook),
                    "edit_mode": "replace",
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("not a valid Jupyter notebook", str(cm.exception))
        self.assertIn("cells", str(cm.exception))

    def test_invalid_notebook_structure_no_metadata(self):
        """Should raise ValueError for notebook without metadata field."""
        invalid_notebook = self.temp_path / "no_metadata.ipynb"
        with open(invalid_notebook, 'w', encoding='utf-8') as f:
            json.dump({"cells": [], "nbformat": 4}, f)

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(invalid_notebook),
                    "edit_mode": "replace",
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("not a valid Jupyter notebook", str(cm.exception))
        self.assertIn("metadata", str(cm.exception))

    def test_missing_file_path(self):
        """Should raise ValueError when file_path is missing."""
        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "edit_mode": "replace",
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("file_path is required", str(cm.exception))

    def test_missing_edit_mode(self):
        """Should raise ValueError when edit_mode is missing."""
        notebook_path = self.temp_path / "test.ipynb"
        notebook_path.write_text("{}", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("edit_mode is required", str(cm.exception))

    def test_invalid_edit_mode(self):
        """Should raise ValueError for invalid edit_mode."""
        notebook_path = self.temp_path / "test.ipynb"
        notebook_path.write_text("{}", encoding='utf-8')

        with self.assertRaises(ValueError) as cm:
            _tool_notebook_edit(
                {
                    "file_path": str(notebook_path),
                    "edit_mode": "invalid_mode",
                    "cell_number": 0,
                    "new_source": "test"
                },
                self.ctx
            )

        self.assertIn("Invalid edit_mode", str(cm.exception))

    def test_backup_creation(self):
        """Should create backup when create_backup=True."""
        notebook = {
            "cells": [
                {
                    "cell_type": "code",
                    "id": "cell1",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["print('hello')\n"],
                    "outputs": []
                }
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
        notebook_path = self.temp_path / "test.ipynb"
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1)

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "replace",
                "cell_number": 0,
                "new_source": "modified",
                "create_backup": True
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertIsNotNone(result.output["backup_path"])
        self.assertTrue(Path(result.output["backup_path"]).exists())

    def test_no_backup_creation(self):
        """Should not create backup when create_backup=False."""
        notebook = {
            "cells": [
                {
                    "cell_type": "code",
                    "id": "cell1",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["print('hello')\n"],
                    "outputs": []
                }
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
        notebook_path = self.temp_path / "test.ipynb"
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1)

        result = _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "replace",
                "cell_number": 0,
                "new_source": "modified",
                "create_backup": False
            },
            self.ctx
        )

        self.assertEqual(result.output["status"], "success")
        self.assertIsNone(result.output["backup_path"])

    def test_notebook_remains_valid_after_edit(self):
        """Should produce valid notebook JSON after edits."""
        notebook = {
            "cells": [
                {
                    "cell_type": "code",
                    "id": "cell1",
                    "metadata": {},
                    "execution_count": None,
                    "source": ["print('hello')\n"],
                    "outputs": []
                }
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5
        }
        notebook_path = self.temp_path / "test.ipynb"
        with open(notebook_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=1)

        # Perform edit
        _tool_notebook_edit(
            {
                "file_path": str(notebook_path),
                "edit_mode": "replace",
                "cell_number": 0,
                "new_source": "print('modified')",
                "create_backup": False
            },
            self.ctx
        )

        with open(notebook_path, 'r', encoding='utf-8') as f:
            result_notebook = json.load(f)

        self.assertIn("cells", result_notebook)
        self.assertIn("metadata", result_notebook)
        self.assertIn("nbformat", result_notebook)
        self.assertIsInstance(result_notebook["cells"], list)


if __name__ == "__main__":
    unittest.main()
