"""Unit tests for backend/app.py Flask application initialization and lifecycle."""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call, Mock
import threading

backend_dir = Path(__file__).resolve().parents[1]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))


class TestRunStartupHousekeeping(unittest.TestCase):
    """Test _run_startup_housekeeping function for idempotency and error handling."""

    def setUp(self):
        """Reset global state and ensure fresh app module import."""
        # Remove app and related modules to ensure clean state
        modules_to_remove = [m for m in sys.modules if m.startswith('app') or m.startswith('route.')]
        for mod in modules_to_remove:
            del sys.modules[mod]

    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_runs_housekeeping_once(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result
    ):
        """Should execute housekeeping operations exactly once despite multiple calls."""
        mock_sync.return_value = {'success': True, 'summary': 'Test sync completed'}
        mock_set_static.return_value = 5

        # Import app within test after mocks are in place
        import app
        app._startup_housekeeping_done = False

        # First call - should execute
        app._run_startup_housekeeping()

        # Second call - should skip
        app._run_startup_housekeeping()

        # Assertions
        mock_setup.assert_called_once()
        mock_sync.assert_called_once()
        mock_set_static.assert_called_once()
        mock_mark_init.assert_called_once()
        mock_set_result.assert_called_once_with({'success': True, 'summary': 'Test sync completed'}, 5)

    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_handles_sync_success(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result
    ):
        """Should process successful sync and log result."""
        mock_sync.return_value = {'success': True, 'summary': 'Synced 10 files'}
        mock_set_static.return_value = 3

        import app
        app._startup_housekeeping_done = False

        app._run_startup_housekeeping()

        mock_set_result.assert_called_once_with(
            {'success': True, 'summary': 'Synced 10 files'},
            3
        )

    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_handles_sync_failure(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result
    ):
        """Should process failed sync and store error."""
        mock_sync.return_value = {'success': False, 'error': 'Database connection failed'}
        mock_set_static.return_value = 0

        import app
        app._startup_housekeeping_done = False

        app._run_startup_housekeeping()

        mock_set_result.assert_called_once_with(
            {'success': False, 'error': 'Database connection failed'},
            0
        )

    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_handles_exception_during_setup(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result
    ):
        """Should catch exceptions during housekeeping and record error state."""
        mock_setup.side_effect = Exception('Filespace creation failed')

        import app
        app._startup_housekeeping_done = False

        with self.assertRaises(Exception) as cm:
            app._run_startup_housekeeping()

        self.assertIn('Filespace creation failed', str(cm.exception))
        mock_set_result.assert_called_once()
        args = mock_set_result.call_args[0]
        self.assertEqual(args[0]['success'], False)
        self.assertIn('Filespace creation failed', args[0]['error'])
        self.assertEqual(args[1], 0)

    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_handles_zero_chat_reset_count(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result
    ):
        """Should handle case when no active chats need resetting."""
        mock_sync.return_value = {'success': True, 'summary': 'No files to sync'}
        mock_set_static.return_value = 0

        import app
        app._startup_housekeeping_done = False

        app._run_startup_housekeeping()

        mock_set_result.assert_called_once_with(
            {'success': True, 'summary': 'No files to sync'},
            0
        )

    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_thread_safe_idempotency(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result
    ):
        """Should be thread-safe and execute only once when called concurrently."""
        mock_sync.return_value = {'success': True, 'summary': 'Test'}
        mock_set_static.return_value = 0

        import app
        app._startup_housekeeping_done = False

        threads = []
        for _ in range(5):
            t = threading.Thread(target=app._run_startup_housekeeping)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Should only execute once despite concurrent calls
        mock_setup.assert_called_once()
        mock_sync.assert_called_once()


class TestHandleShutdown(unittest.TestCase):
    """Test handle_shutdown function for cleanup and graceful termination."""

    def setUp(self):
        """Reset shutdown state before each test."""
        # Remove app and related modules to ensure clean state
        modules_to_remove = [m for m in sys.modules if m.startswith('app') or m.startswith('route.')]
        for mod in modules_to_remove:
            del sys.modules[mod]

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_executes_shutdown_once(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static
    ):
        """Should execute shutdown operations exactly once despite multiple calls."""
        mock_pool = MagicMock()
        mock_pool.get_stats.return_value = {
            'ready_workers': 2,
            'spawning_workers': 0,
            'total_workers': 2
        }
        mock_get_pool.return_value = mock_pool
        mock_set_static.return_value = 3

        import app
        app._shutdown_handled = False

        # First call
        app.handle_shutdown()
        # Second call - should skip
        app.handle_shutdown()

        mock_shutdown_pool.assert_called_once()
        mock_stop_monitor.assert_called_once()
        mock_set_static.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_shuts_down_worker_pool(self, mock_get_pool, mock_shutdown_pool, mock_stop_monitor, mock_set_static):
        """Should shut down worker pool if it exists."""
        mock_pool = MagicMock()
        mock_pool.get_stats.return_value = {'ready_workers': 4, 'spawning_workers': 1, 'total_workers': 5}
        mock_get_pool.return_value = mock_pool
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        app.handle_shutdown()

        mock_get_pool.assert_called_once()
        mock_pool.get_stats.assert_called_once()
        mock_shutdown_pool.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_handles_no_worker_pool(self, mock_get_pool, mock_shutdown_pool, mock_stop_monitor, mock_set_static):
        """Should handle case when no worker pool exists."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        app.handle_shutdown()

        mock_get_pool.assert_called_once()
        mock_shutdown_pool.assert_not_called()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_stops_filesystem_monitor(self, mock_get_pool, mock_shutdown_pool, mock_stop_monitor, mock_set_static):
        """Should stop filesystem monitoring."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        app.handle_shutdown()

        mock_stop_monitor.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_sets_chats_to_static(self, mock_get_pool, mock_shutdown_pool, mock_stop_monitor, mock_set_static):
        """Should set all active chats to static state."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 7

        import app
        app._shutdown_handled = False

        app.handle_shutdown()

        mock_set_static.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_handles_pool_shutdown_exception(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static
    ):
        """Should continue shutdown even if pool shutdown fails."""
        mock_pool = MagicMock()
        mock_pool.get_stats.side_effect = Exception('Pool stats failed')
        mock_get_pool.return_value = mock_pool
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        app.handle_shutdown()  # Should not raise

        # Should still attempt to stop monitor and set chats static
        mock_stop_monitor.assert_called_once()
        mock_set_static.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_handles_filesystem_monitor_exception(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static
    ):
        """Should continue shutdown even if monitor stop fails."""
        mock_get_pool.return_value = None
        mock_stop_monitor.side_effect = Exception('Monitor stop failed')
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        app.handle_shutdown()  # Should not raise

        # Should still attempt to set chats static
        mock_set_static.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_handles_db_exception(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static
    ):
        """Should handle database errors gracefully during shutdown."""
        mock_get_pool.return_value = None
        mock_set_static.side_effect = Exception('DB connection lost')

        import app
        app._shutdown_handled = False

        app.handle_shutdown()  # Should not raise

    @patch('services.cliproxy.manager.get_cliproxy_manager')
    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_stops_cliproxy_if_running(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static,
        mock_get_cliproxy
    ):
        """Should stop cliproxy service if it's running."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        mock_manager = MagicMock()
        mock_manager.is_running.return_value = True
        mock_get_cliproxy.return_value = mock_manager

        import app
        app._shutdown_handled = False

        app.handle_shutdown()

        mock_manager.is_running.assert_called_once()
        mock_manager.stop.assert_called_once()

    @patch('services.cliproxy.manager.get_cliproxy_manager')
    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_skips_cliproxy_if_not_running(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static,
        mock_get_cliproxy
    ):
        """Should not attempt to stop cliproxy if it's not running."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        mock_manager = MagicMock()
        mock_manager.is_running.return_value = False
        mock_get_cliproxy.return_value = mock_manager

        import app
        app._shutdown_handled = False

        app.handle_shutdown()

        mock_manager.is_running.assert_called_once()
        mock_manager.stop.assert_not_called()

    @patch('sys.exit')
    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_exits_when_signal_provided(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static,
        mock_exit
    ):
        """Should call sys.exit when signal number is provided."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        app.handle_shutdown(signum=15)

        mock_exit.assert_called_once_with(0)

    @patch('sys.exit')
    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_no_exit_when_no_signal(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static,
        mock_exit
    ):
        """Should not call sys.exit when no signal is provided."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        app.handle_shutdown()

        mock_exit.assert_not_called()


class TestFlaskEndpoints(unittest.TestCase):
    """Test Flask endpoint responses using integration approach with real Flask app."""

    @patch('app.start_filesystem_monitor')
    @patch('services.cliproxy.manager.get_cliproxy_manager')
    @patch('app.load_rate_limit_overrides')
    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_health_endpoint_returns_success(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result,
        mock_load_limits,
        mock_get_cliproxy,
        mock_start_monitor
    ):
        """Should return healthy status with default config values."""
        # Setup mocks
        mock_sync.return_value = {'success': True, 'summary': 'Test'}
        mock_set_static.return_value = 0
        mock_manager = MagicMock()
        mock_manager.has_existing_auth.return_value = False
        mock_get_cliproxy.return_value = mock_manager

        # Import and create app
        import app
        app._startup_housekeeping_done = False
        flask_app = app.create_app()
        client = flask_app.test_client()

        response = client.get('/health')

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data['status'], 'healthy')
        self.assertEqual(data['message'], 'ATLAS2 backend is running')
        self.assertIn('default_model', data)
        self.assertIn('default_streaming', data)

    @patch('app.start_filesystem_monitor')
    @patch('services.cliproxy.manager.get_cliproxy_manager')
    @patch('app.load_rate_limit_overrides')
    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_config_endpoint_returns_settings(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result,
        mock_load_limits,
        mock_get_cliproxy,
        mock_start_monitor
    ):
        """Should return client-side configuration values."""
        # Setup mocks
        mock_sync.return_value = {'success': True, 'summary': 'Test'}
        mock_set_static.return_value = 0
        mock_manager = MagicMock()
        mock_manager.has_existing_auth.return_value = False
        mock_get_cliproxy.return_value = mock_manager

        # Import and create app
        import app
        app._startup_housekeeping_done = False
        flask_app = app.create_app()
        client = flask_app.test_client()

        response = client.get('/api/config')

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIn('maxConcurrentChats', data)
        self.assertIn('executionMode', data)
        self.assertIn('defaultModel', data)
        self.assertIn('defaultStreaming', data)


class TestHandleShutdownEdgeCases(unittest.TestCase):
    """Additional edge case tests for handle_shutdown."""

    def setUp(self):
        """Reset shutdown state before each test."""
        modules_to_remove = [m for m in sys.modules if m.startswith('app') or m.startswith('route.')]
        for mod in modules_to_remove:
            del sys.modules[mod]

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_thread_safe_shutdown_idempotency(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static
    ):
        """Should be thread-safe and execute shutdown only once when called concurrently."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        threads = []
        for _ in range(5):
            t = threading.Thread(target=app.handle_shutdown)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Should only execute shutdown once despite concurrent calls
        mock_stop_monitor.assert_called_once()
        mock_set_static.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_handles_cliproxy_import_error(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static
    ):
        """Should continue shutdown even if cliproxy import fails."""
        mock_get_pool.return_value = None
        mock_set_static.return_value = 0

        import app
        app._shutdown_handled = False

        # Patch the import to simulate failure
        with patch.dict('sys.modules', {'services.cliproxy.manager': None}):
            with patch('services.cliproxy.manager.get_cliproxy_manager', side_effect=ImportError("No module")):
                app.handle_shutdown()  # Should not raise

        # Should still complete other shutdown tasks
        mock_stop_monitor.assert_called_once()
        mock_set_static.assert_called_once()

    @patch('app.db.set_all_chats_static')
    @patch('app.stop_filesystem_monitor')
    @patch('app.shutdown_pool')
    @patch('app.get_pool')
    def test_handles_all_components_failing(
        self,
        mock_get_pool,
        mock_shutdown_pool,
        mock_stop_monitor,
        mock_set_static
    ):
        """Should complete shutdown even if all components fail."""
        mock_pool = MagicMock()
        mock_pool.get_stats.side_effect = Exception("Pool error")
        mock_get_pool.return_value = mock_pool
        mock_stop_monitor.side_effect = Exception("Monitor error")
        mock_set_static.side_effect = Exception("DB error")

        import app
        app._shutdown_handled = False

        # Should not raise despite all failures
        app.handle_shutdown()


class TestCreateAppEdgeCases(unittest.TestCase):
    """Additional edge case tests for create_app."""

    def setUp(self):
        """Reset state before each test."""
        modules_to_remove = [m for m in sys.modules if m.startswith('app') or m.startswith('route.')]
        for mod in modules_to_remove:
            del sys.modules[mod]

    @patch('app.start_filesystem_monitor')
    @patch('services.cliproxy.manager.get_cliproxy_manager')
    @patch('app.load_rate_limit_overrides')
    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_handles_filesystem_monitor_start_failure(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result,
        mock_load_limits,
        mock_get_cliproxy,
        mock_start_monitor
    ):
        """Should continue app creation even if filesystem monitor fails to start."""
        mock_sync.return_value = {'success': True, 'summary': 'Test'}
        mock_set_static.return_value = 0
        mock_manager = MagicMock()
        mock_manager.has_existing_auth.return_value = False
        mock_get_cliproxy.return_value = mock_manager
        mock_start_monitor.side_effect = Exception("Monitor failed to start")

        import app
        app._startup_housekeeping_done = False

        # Should not raise - app creation should continue
        flask_app = app.create_app()
        self.assertIsNotNone(flask_app)



class TestStartupHousekeepingEdgeCases(unittest.TestCase):
    """Additional edge case tests for _run_startup_housekeeping."""

    def setUp(self):
        """Reset state before each test."""
        modules_to_remove = [m for m in sys.modules if m.startswith('app') or m.startswith('route.')]
        for mod in modules_to_remove:
            del sys.modules[mod]

    @patch('app.startup_state.set_housekeeping_result')
    @patch('app.startup_state.mark_initializing')
    @patch('app.db.set_all_chats_static')
    @patch('app.sync_files_with_database')
    @patch('app.setup_filespace')
    def test_handles_db_set_static_failure(
        self,
        mock_setup,
        mock_sync,
        mock_set_static,
        mock_mark_init,
        mock_set_result
    ):
        """Should handle database failure when setting chats static."""
        mock_sync.return_value = {'success': True, 'summary': 'Test'}
        mock_set_static.side_effect = Exception("DB connection failed")

        import app
        app._startup_housekeeping_done = False

        with self.assertRaises(Exception) as cm:
            app._run_startup_housekeeping()

        self.assertIn('DB connection failed', str(cm.exception))
        mock_set_result.assert_called_once()
        args = mock_set_result.call_args[0]
        self.assertEqual(args[0]['success'], False)

if __name__ == '__main__':
    unittest.main()
