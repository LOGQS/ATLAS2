"""Unit tests for cancellation manager."""

import sys
import threading
import unittest
from concurrent.futures import Future
from pathlib import Path
from unittest.mock import Mock

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.cancellation_manager import CancellationManager


class TestCancellationManagerFileOperations(unittest.TestCase):
    """Test file cancellation operations."""

    def setUp(self):
        """Create a fresh cancellation manager for each test."""
        self.manager = CancellationManager()

    def test_is_cancelled_returns_false_initially(self):
        """New files should not be marked as cancelled."""
        self.assertFalse(self.manager.is_cancelled("file_1"))
        self.assertFalse(self.manager.is_cancelled("file_2"))

    def test_cancel_file_marks_file_as_cancelled(self):
        """Cancelling a file should mark it as cancelled."""
        self.manager.cancel_file("file_1")
        self.assertTrue(self.manager.is_cancelled("file_1"))

    def test_cancel_file_is_isolated_per_file(self):
        """Cancelling one file should not affect others."""
        self.manager.cancel_file("file_1")
        self.assertTrue(self.manager.is_cancelled("file_1"))
        self.assertFalse(self.manager.is_cancelled("file_2"))
        self.assertFalse(self.manager.is_cancelled("file_3"))

    def test_cancel_files_handles_multiple_files(self):
        """cancel_files should cancel all provided file IDs."""
        file_ids = ["file_1", "file_2", "file_3"]
        self.manager.cancel_files(file_ids)

        for file_id in file_ids:
            self.assertTrue(self.manager.is_cancelled(file_id))

    def test_cancel_files_handles_empty_list(self):
        """cancel_files with empty list should not raise errors."""
        self.manager.cancel_files([])

    def test_cleanup_file_removes_cancelled_state(self):
        """cleanup_file should remove cancellation tracking."""
        self.manager.cancel_file("file_1")
        self.assertTrue(self.manager.is_cancelled("file_1"))

        self.manager.cleanup_file("file_1")
        self.assertFalse(self.manager.is_cancelled("file_1"))

    def test_cleanup_file_handles_non_cancelled_files(self):
        """cleanup_file should work on files that were never cancelled."""
        self.manager.cleanup_file("file_never_existed")


class TestCancellationManagerFutureHandling(unittest.TestCase):
    """Test future registration and cancellation."""

    def setUp(self):
        """Create a fresh cancellation manager for each test."""
        self.manager = CancellationManager()

    def test_register_future_tracks_future(self):
        """register_future should track the future for cancellation."""
        mock_future = Mock(spec=Future)
        mock_future.done.return_value = False

        self.manager.register_future("file_1", mock_future)

        self.manager.cancel_file("file_1")
        mock_future.cancel.assert_called_once()

    def test_cancel_file_attempts_to_cancel_pending_future(self):
        """Pending futures should be cancelled when file is cancelled."""
        mock_future = Mock(spec=Future)
        mock_future.done.return_value = False
        mock_future.cancel.return_value = True

        self.manager.register_future("file_1", mock_future)
        self.manager.cancel_file("file_1")

        mock_future.cancel.assert_called_once()

    def test_cancel_file_skips_completed_future(self):
        """Completed futures should not be cancelled."""
        mock_future = Mock(spec=Future)
        mock_future.done.return_value = True

        self.manager.register_future("file_1", mock_future)
        self.manager.cancel_file("file_1")

        mock_future.cancel.assert_not_called()

    def test_unregister_task_removes_future(self):
        """unregister_task should remove future from tracking."""
        mock_future = Mock(spec=Future)
        self.manager.register_future("file_1", mock_future)

        self.manager.unregister_task("file_1", "future")

        self.manager.cancel_file("file_1")
        mock_future.cancel.assert_not_called()


class TestCancellationManagerPollingEvents(unittest.TestCase):
    """Test polling event registration and signaling."""

    def setUp(self):
        """Create a fresh cancellation manager for each test."""
        self.manager = CancellationManager()

    def test_register_polling_event_tracks_event(self):
        """register_polling_event should track the event."""
        mock_event = Mock(spec=threading.Event)

        self.manager.register_polling_event("file_1", mock_event)

        self.manager.cancel_file("file_1")
        mock_event.set.assert_called_once()

    def test_cancel_file_sets_polling_event(self):
        """Polling events should be set when file is cancelled."""
        mock_event = Mock(spec=threading.Event)

        self.manager.register_polling_event("file_1", mock_event)
        self.manager.cancel_file("file_1")

        mock_event.set.assert_called_once()

    def test_unregister_task_removes_polling_event(self):
        """unregister_task should remove polling event from tracking."""
        mock_event = Mock(spec=threading.Event)
        self.manager.register_polling_event("file_1", mock_event)

        self.manager.unregister_task("file_1", "polling_event")

        self.manager.cancel_file("file_1")
        mock_event.set.assert_not_called()


class TestCancellationManagerProcessHandling(unittest.TestCase):
    """Test process registration and termination."""

    def setUp(self):
        """Create a fresh cancellation manager for each test."""
        self.manager = CancellationManager()

    def test_register_process_tracks_process(self):
        """register_process should track the process."""
        mock_process = Mock()
        mock_process.is_alive.return_value = True

        self.manager.register_process("file_1", mock_process)

        self.manager.cancel_file("file_1")
        mock_process.terminate.assert_called_once()

    def test_cancel_file_terminates_alive_process(self):
        """Alive processes should be terminated when file is cancelled."""
        mock_process = Mock()
        mock_process.is_alive.return_value = True

        self.manager.register_process("file_1", mock_process)
        self.manager.cancel_file("file_1")

        mock_process.terminate.assert_called_once()
        mock_process.join.assert_called_once()

    def test_cancel_file_kills_process_if_terminate_fails(self):
        """Process should be killed if it doesn't terminate gracefully."""
        mock_process = Mock()
        mock_process.is_alive.side_effect = [True, True] 

        self.manager.register_process("file_1", mock_process)
        self.manager.cancel_file("file_1")

        mock_process.terminate.assert_called_once()
        mock_process.kill.assert_called_once()

    def test_cancel_file_handles_process_without_kill_method(self):
        """Should handle gracefully if process doesn't have kill() method."""
        mock_process = Mock()
        mock_process.is_alive.side_effect = [True, True]
        del mock_process.kill  

        self.manager.register_process("file_1", mock_process)
        self.manager.cancel_file("file_1")

        mock_process.terminate.assert_called_once()

    def test_cancel_file_skips_dead_process(self):
        """Dead processes should not be terminated."""
        mock_process = Mock()
        mock_process.is_alive.return_value = False

        self.manager.register_process("file_1", mock_process)
        self.manager.cancel_file("file_1")

        mock_process.terminate.assert_not_called()

    def test_unregister_task_removes_process(self):
        """unregister_task should remove process from tracking."""
        mock_process = Mock()
        self.manager.register_process("file_1", mock_process)

        self.manager.unregister_task("file_1", "process")

        self.manager.cancel_file("file_1")
        mock_process.terminate.assert_not_called()


class TestCancellationManagerChatOperations(unittest.TestCase):
    """Test chat cancellation operations."""

    def setUp(self):
        """Create a fresh cancellation manager for each test."""
        self.manager = CancellationManager()

    def test_is_chat_cancelled_returns_false_initially(self):
        """New chats should not be marked as cancelled."""
        self.assertFalse(self.manager.is_chat_cancelled("chat_1"))
        self.assertFalse(self.manager.is_chat_cancelled("chat_2"))

    def test_cancel_chat_marks_chat_as_cancelled(self):
        """Cancelling a chat should mark it as cancelled."""
        self.manager.cancel_chat("chat_1")
        self.assertTrue(self.manager.is_chat_cancelled("chat_1"))

    def test_cancel_chat_is_isolated_per_chat(self):
        """Cancelling one chat should not affect others."""
        self.manager.cancel_chat("chat_1")
        self.assertTrue(self.manager.is_chat_cancelled("chat_1"))
        self.assertFalse(self.manager.is_chat_cancelled("chat_2"))

    def test_cancel_chat_sets_cancel_event(self):
        """Cancelling a chat should set its cancel event."""
        mock_event = Mock(spec=threading.Event)
        mock_thread = Mock(spec=threading.Thread)

        self.manager.register_chat_thread("chat_1", mock_thread, mock_event)
        self.manager.cancel_chat("chat_1")

        mock_event.set.assert_called_once()

    def test_register_chat_thread_tracks_thread_and_event(self):
        """register_chat_thread should track both thread and cancel event."""
        mock_event = Mock(spec=threading.Event)
        mock_thread = Mock(spec=threading.Thread)

        self.manager.register_chat_thread("chat_1", mock_thread, mock_event)

        self.manager.cancel_chat("chat_1")
        mock_event.set.assert_called_once()

    def test_unregister_chat_thread_removes_tracking(self):
        """unregister_chat_thread should remove thread and event tracking."""
        mock_event = Mock(spec=threading.Event)
        mock_thread = Mock(spec=threading.Thread)

        self.manager.register_chat_thread("chat_1", mock_thread, mock_event)
        self.manager.unregister_chat_thread("chat_1")

        self.manager.cancel_chat("chat_1")
        mock_event.set.assert_not_called()

    def test_clear_chat_cancelled_state_preserves_thread_tracking(self):
        """clear_chat_cancelled_state should only clear cancelled flag."""
        mock_event = Mock(spec=threading.Event)
        mock_thread = Mock(spec=threading.Thread)

        self.manager.register_chat_thread("chat_1", mock_thread, mock_event)
        self.manager.cancel_chat("chat_1")
        self.assertTrue(self.manager.is_chat_cancelled("chat_1"))

        self.manager.clear_chat_cancelled_state("chat_1")
        self.assertFalse(self.manager.is_chat_cancelled("chat_1"))

        self.manager.cancel_chat("chat_1")
        mock_event.set.assert_called()

    def test_cleanup_chat_removes_all_tracking(self):
        """cleanup_chat should remove all chat-related tracking."""
        mock_event = Mock(spec=threading.Event)
        mock_thread = Mock(spec=threading.Thread)

        self.manager.register_chat_thread("chat_1", mock_thread, mock_event)
        self.manager.cancel_chat("chat_1")
        self.assertTrue(self.manager.is_chat_cancelled("chat_1"))

        self.manager.cleanup_chat("chat_1")
        self.assertFalse(self.manager.is_chat_cancelled("chat_1"))

        mock_event.reset_mock()
        self.manager.cancel_chat("chat_1")
        mock_event.set.assert_not_called()


class TestCancellationManagerThreadSafety(unittest.TestCase):
    """Test thread safety of cancellation manager."""

    def setUp(self):
        """Create a fresh cancellation manager for each test."""
        self.manager = CancellationManager()

    def test_concurrent_cancellations_are_safe(self):
        """Multiple threads cancelling different files should be safe."""
        file_ids = [f"file_{i}" for i in range(10)]
        threads = []

        def cancel_file(file_id):
            self.manager.cancel_file(file_id)

        for file_id in file_ids:
            thread = threading.Thread(target=cancel_file, args=(file_id,))
            threads.append(thread)
            thread.start()

        for thread in threads:
            thread.join(timeout=1.0)

        for file_id in file_ids:
            self.assertTrue(self.manager.is_cancelled(file_id))

    def test_concurrent_registration_and_cancellation(self):
        """Concurrent registration and cancellation should be safe."""
        file_id = "concurrent_file"
        operations = []

        def register_future():
            mock_future = Mock(spec=Future)
            mock_future.done.return_value = False
            self.manager.register_future(file_id, mock_future)
            operations.append("register")

        def cancel_file():
            self.manager.cancel_file(file_id)
            operations.append("cancel")

        threads = [
            threading.Thread(target=register_future),
            threading.Thread(target=cancel_file),
        ]

        for thread in threads:
            thread.start()

        for thread in threads:
            thread.join(timeout=1.0)

        self.assertEqual(len(operations), 2)


class TestCancellationManagerEdgeCases(unittest.TestCase):
    """Test edge cases and error conditions."""

    def setUp(self):
        """Create a fresh cancellation manager for each test."""
        self.manager = CancellationManager()

    def test_cancel_file_handles_missing_task_info(self):
        """Cancelling file with no registered tasks should not error."""
        self.manager.cancel_file("file_no_tasks")

    def test_cancel_chat_handles_missing_event(self):
        """Cancelling chat with no registered event should not error."""
        self.manager.cancel_chat("chat_no_event")

    def test_unregister_task_handles_nonexistent_file(self):
        """Unregistering task for non-existent file should not error."""
        self.manager.unregister_task("file_never_registered", "future")

    def test_unregister_chat_thread_handles_nonexistent_chat(self):
        """Unregistering non-existent chat thread should not error."""
        self.manager.unregister_chat_thread("chat_never_registered")

    def test_multiple_registrations_on_same_file(self):
        """Multiple registration types on same file should all work."""
        mock_future = Mock(spec=Future)
        mock_future.done.return_value = False
        mock_event = Mock(spec=threading.Event)
        mock_process = Mock()
        mock_process.is_alive.return_value = True

        self.manager.register_future("file_1", mock_future)
        self.manager.register_polling_event("file_1", mock_event)
        self.manager.register_process("file_1", mock_process)

        self.manager.cancel_file("file_1")

        mock_future.cancel.assert_called_once()
        mock_event.set.assert_called_once()
        mock_process.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
