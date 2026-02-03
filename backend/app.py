from flask import Flask, jsonify
from flask_cors import CORS
import os
import threading
import sys
import multiprocessing
from pathlib import Path
import signal
import atexit
from dotenv import load_dotenv

load_dotenv()

backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(backend_dir)

from route.chat_route import register_chat_routes, broadcast_global_event
from route.agent_routes import register_agent_routes
from route.db_chat_management_route import register_db_chat_management_routes
from route.db_message_route import register_db_message_routes
from route.db_bulk_route import register_db_bulk_routes
from route.db_versioning_route import register_db_versioning_routes
from route.file_route import register_file_routes
from route.file_browser_route import register_file_browser_routes
from route.coder_workspace_route import register_coder_workspace_routes
from route.folder_picker_route import register_folder_picker_routes
from route.coder_git_route import register_coder_git_routes
from route.stt_route import register_stt_routes
from route.image_route import register_image_routes
from route.rate_limit_route import register_rate_limit_routes
from route.token_route import register_token_routes
from route.cliproxy_route import register_cliproxy_routes
from utils.config import Config
from utils.logger import get_logger
from file_utils.file_handler import setup_filespace, sync_files_with_database
from utils import startup_state
from file_utils.filesystem_watcher import start_filesystem_monitor, stop_filesystem_monitor
from utils.db_utils import db
from chat.worker_pool import initialize_pool, shutdown_pool, get_pool
from utils.rate_limit_store import load_rate_limit_overrides

from agents.tools import tool_registry as _tool_registry  # triggers tool registration

logger = get_logger(__name__)

DEBUG_ENABLED = os.getenv("FLASK_DEBUG", "1") == "1"

_shutdown_handled = False
_startup_lock = threading.Lock()
_startup_housekeeping_done = False


def _run_startup_housekeeping():
    """Perform one-time filesystem/database coordination during startup."""
    global _startup_housekeeping_done

    if _startup_housekeeping_done:
        return

    with _startup_lock:
        if _startup_housekeeping_done:
            return

        startup_state.mark_initializing()

        try:
            setup_filespace()

            sync_result = sync_files_with_database()
            if sync_result.get('success'):
                logger.info("File sync completed: %s", sync_result['summary'])
            else:
                logger.error("File sync failed: %s", sync_result.get('error', 'unknown error'))

            reset_count = db.set_all_chats_static()
            if reset_count > 0:
                logger.info("Startup: Reset %d chat(s) to static state", reset_count)
            else:
                logger.debug("Startup: No active chats to reset")

            startup_state.set_housekeeping_result(sync_result, reset_count)
        except Exception as exc:
            startup_state.set_housekeeping_result({'success': False, 'error': str(exc)}, 0)
            raise

        _startup_housekeeping_done = True


def handle_shutdown(signum=None, frame=None):
    """Handle graceful shutdown - set all active chats to static state"""
    global _shutdown_handled

    if _shutdown_handled:
        logger.debug("Shutdown handler already executed, skipping duplicate call")
        return

    _shutdown_handled = True

    logger.info("===== ATLAS2 SHUTDOWN INITIATED =====")

    if signum:
        logger.info(f"Received signal: {signum}")

    try:
        pool = get_pool()
        if pool:
            stats = pool.get_stats()
            logger.info(f"[POOL-SHUTDOWN] Shutting down worker pool - Stats: ready={stats['ready_workers']}, spawning={stats['spawning_workers']}, total={stats['total_workers']}")
            shutdown_pool()
            logger.info("[POOL-SHUTDOWN] Worker pool shut down successfully")
        else:
            logger.debug("[POOL-SHUTDOWN] No worker pool to shutdown")
    except Exception as e:
        logger.error(f"[POOL-SHUTDOWN] Error shutting down worker pool: {e}")

    try:
        stop_filesystem_monitor()
        logger.debug("[FILE_WATCHER] Filesystem monitor stopped")
    except Exception as exc:
        logger.error(f"[FILE_WATCHER] Error stopping filesystem monitor: {exc}")

    try:
        from services.cliproxy.manager import get_cliproxy_manager
        cliproxy_manager = get_cliproxy_manager()
        if cliproxy_manager.is_running():
            logger.info("[CLIPROXY] Stopping proxy...")
            cliproxy_manager.stop()
            logger.info("[CLIPROXY] Proxy stopped")
    except Exception as exc:
        logger.error(f"[CLIPROXY] Error stopping proxy: {exc}")

    try:
        updated_count = db.set_all_chats_static()
        if updated_count > 0:
            logger.info(f"Successfully set {updated_count} chat(s) to static state")
        else:
            logger.debug("No active chats to update during shutdown")
    except Exception as e:
        logger.error(f"[DB] Error setting chats to static state: {e}")

    logger.info("===== ATLAS2 SHUTDOWN COMPLETED =====")

    if signum is not None:
        sys.exit(0)

def create_app():
    """Create and configure the Flask application"""
    app = Flask(__name__)
    app.debug = DEBUG_ENABLED
    
    cors_origins = os.getenv('CORS_ORIGINS', 'http://localhost:3000').split(',')
    CORS(app, origins=[origin.strip() for origin in cors_origins])
    
    load_rate_limit_overrides()
    _run_startup_housekeeping()

    try:
        from services.cliproxy.manager import get_cliproxy_manager
        cliproxy_manager = get_cliproxy_manager()
        if cliproxy_manager.has_existing_auth():
            logger.info("[CLIPROXY] Existing auth files found, starting proxy...")
            if cliproxy_manager.start():
                logger.info("[CLIPROXY] Proxy started successfully")
            else:
                logger.warning("[CLIPROXY] Failed to start proxy on startup")
        else:
            logger.debug("[CLIPROXY] No existing auth files, proxy will start on first login")
    except Exception as exc:
        logger.warning(f"[CLIPROXY] Failed to initialize: {exc}")

    register_chat_routes(app)
    register_agent_routes(app)
    register_db_chat_management_routes(app)
    register_db_message_routes(app)
    register_db_bulk_routes(app)
    register_db_versioning_routes(app)
    register_file_routes(app)
    register_file_browser_routes(app)
    register_coder_workspace_routes(app)
    register_folder_picker_routes(app)
    register_coder_git_routes(app)
    register_stt_routes(app)
    register_token_routes(app)
    register_rate_limit_routes(app)
    register_cliproxy_routes(app)
    register_image_routes(app)

    try:
        start_filesystem_monitor(broadcast_global_event)
        logger.debug("[FILE_WATCHER] Filesystem monitor started")
    except Exception as exc:
        logger.error(f"[FILE_WATCHER] Failed to start filesystem monitor: {exc}")
    
    @app.route('/health')
    def health_check():
        return jsonify({
            'status': 'healthy',
            'message': 'ATLAS2 backend is running',
            'default_model': Config.get_default_model(),
            'default_streaming': Config.get_default_streaming()
        })

    @app.route('/api/config')
    def api_config():
        """Get client-side configuration values"""
        return jsonify({
            'maxConcurrentChats': Config.get_max_concurrent_chats(),
            'executionMode': Config.get_chat_execution_mode(),
            'defaultModel': Config.get_default_model(),
            'defaultStreaming': Config.get_default_streaming()
        })

    return app

if __name__ == '__main__':
    try:
        multiprocessing.set_start_method('spawn')
    except RuntimeError as e:
        if "context has already been set" not in str(e):
            raise

    logs_dir = Path(backend_dir).parent / "logs"
    logs_dir.mkdir(exist_ok=True)
    try:
        (logs_dir / "atlas.log").write_text('')
    except (OSError, IOError):
        pass

    app = create_app()

    is_reloader_child = os.environ.get('WERKZEUG_RUN_MAIN') == 'true'
    is_production = not DEBUG_ENABLED

    if Config.should_init_worker_pool():
        logger.debug(f"[POOL-INIT] Debug mode: {app.debug}, WERKZEUG_RUN_MAIN: {os.environ.get('WERKZEUG_RUN_MAIN')}")
        if is_reloader_child or is_production:
            logger.info("[POOL-INIT] Starting worker pool initialization in background...")

            def init_pool_background():
                try:
                    pool_size = Config.get_worker_pool_size()
                    logger.info(f"[POOL-INIT] Initializing worker pool with target size {pool_size}")
                    pool = initialize_pool(pool_size=pool_size)

                    if pool is None:
                        logger.warning("[POOL-INIT] Pool initialization returned None - likely blocked in reloader parent")
                        return

                    stats = pool.get_stats()
                    logger.info(f"[POOL-INIT] Pool created - ready={stats['ready_workers']}, spawning={stats['spawning_workers']}, target={stats['target_size']}")

                    def on_pool_ready(stats):
                        logger.info(f"[POOL-INIT] Pool fully populated with {stats['ready_workers']} ready workers")

                    pool.set_on_ready_callback(on_pool_ready)
                except Exception as e:
                    logger.error(f"[POOL-INIT] Failed to initialize worker pool: {e}")
                    logger.info("[POOL-INIT] Application will continue without worker pool (fallback to direct spawning)")

            pool_thread = threading.Thread(target=init_pool_background, daemon=True)
            pool_thread.start()
        else:
            logger.info("[POOL-INIT] Skipping pool init in reloader parent process")
    else:
        logger.info("[POOL-INIT] Worker pool initialization skipped (execution mode: %s)", Config.get_chat_execution_mode())

    logger.info("Registering shutdown handlers...")

    atexit.register(handle_shutdown)

    signal.signal(signal.SIGTERM, handle_shutdown)

    signal.signal(signal.SIGINT, handle_shutdown)

    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, handle_shutdown)

    logger.info("Shutdown handlers registered successfully")
    logger.info("Starting ATLAS2 Backend on 0.0.0.0:5000")

    app.run(
        host='0.0.0.0',
        port=5000,
        debug=DEBUG_ENABLED,
        threaded=True,
        reloader_type='stat'
    )

