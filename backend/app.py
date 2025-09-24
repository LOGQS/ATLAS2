# status: complete

from flask import Flask, jsonify
from flask_cors import CORS
import os
import threading
import time
import sys
import multiprocessing
from pathlib import Path
import signal
import atexit

backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(backend_dir)

from route.chat_route import register_chat_routes
from route.agent_routes import register_agent_routes
from route.db_chat_management_route import register_db_chat_management_routes
from route.db_message_route import register_db_message_routes
from route.db_bulk_route import register_db_bulk_routes
from route.db_versioning_route import register_db_versioning_routes
from route.file_route import register_file_routes
from route.stt_route import register_stt_routes
from route.image_route import image_bp
from utils.config import Config
from utils.logger import get_logger
from file_utils.file_handler import setup_filespace, sync_files_with_database
from utils.db_utils import db
from chat.worker_pool import initialize_pool, shutdown_pool, get_pool

logger = get_logger(__name__)

_shutdown_handled = False

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
            logger.info("[POOL-SHUTDOWN] No worker pool to shutdown")
    except Exception as e:
        logger.error(f"[POOL-SHUTDOWN] Error shutting down worker pool: {e}")

    try:
        updated_count = db.set_all_chats_static()
        if updated_count > 0:
            logger.info(f"Successfully set {updated_count} chat(s) to static state")
        else:
            logger.info("No active chats to update during shutdown")

        logger.info("===== ATLAS2 SHUTDOWN COMPLETED =====")
    except Exception as e:
        logger.error(f"Error during shutdown handler: {e}")

    if signum is not None:
        sys.exit(0)

def create_app():
    """Create and configure the Flask application"""
    app = Flask(__name__)
    
    cors_origins = os.getenv('CORS_ORIGINS', 'http://localhost:3000').split(',')
    CORS(app, origins=[origin.strip() for origin in cors_origins])
    
    setup_filespace()
    
    sync_result = sync_files_with_database()
    if sync_result['success']:
        logger.info(f"File sync completed: {sync_result['summary']}")
    else:
        logger.error(f"File sync failed: {sync_result['error']}")

    startup_reset_count = db.set_all_chats_static()
    if startup_reset_count > 0:
        logger.info(f"Startup: Reset {startup_reset_count} chat(s) to static state")
    else:
        logger.debug("Startup: No active chats to reset")

    register_chat_routes(app)
    register_agent_routes(app)
    register_db_chat_management_routes(app)
    register_db_message_routes(app)
    register_db_bulk_routes(app)
    register_db_versioning_routes(app)
    register_file_routes(app)
    register_stt_routes(app)
    app.register_blueprint(image_bp)
    
    @app.route('/health')
    def health_check():
        return jsonify({
            'status': 'healthy',
            'message': 'ATLAS2 backend is running',
            'default_model': Config.get_default_model(),
            'default_streaming': Config.get_default_streaming()
        })
    
    @app.route('/api')
    def api_info():
        return jsonify({
            'name': 'ATLAS2 API',
            'version': '1.0.0',
            'endpoints': {
                'chat': {
                    'send': '/api/chat/send',
                    'stream': '/api/chat/stream',
                    'history': '/api/chat/history/<chat_id>',
                    'providers': '/api/chat/providers',
                    'models': '/api/chat/models'
                },
                'db': {
                    'chats': '/api/db/chats',
                    'chat': '/api/db/chat/<chat_id>',
                    'settings': '/api/db/settings'
                },
                'files': {
                    'upload': '/api/files/upload',
                    'list': '/api/files',
                    'delete': '/api/files/<file_id>',
                    'rename': '/api/files/<file_id>/rename',
                    'download': '/api/files/<file_id>/download'
                },
                'image': {
                    'generate': '/api/image/generate',
                    'models': '/api/image/models',
                    'status': '/api/image/status',
                    'get': '/api/image/<filename>'
                }
            }
        })
    
    return app

if __name__ == '__main__':
    multiprocessing.set_start_method('spawn', force=True)

    logs_dir = Path("..") / "logs"
    logs_dir.mkdir(exist_ok=True)
    log_file = logs_dir / "atlas.log"
    try:
        with open(log_file, 'w', encoding='utf-8') as f:
            f.truncate(0)
    except (OSError, IOError):
        pass

    app = create_app()

    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true' or not app.debug:
        logger.info("[POOL-INIT] Starting worker pool initialization in background...")

        def init_pool_background():
            try:
                from utils.config import Config
                pool_size = Config.get_worker_pool_size()
                logger.info(f"[POOL-INIT] Initializing worker pool with target size {pool_size}")
                pool = initialize_pool(pool_size=pool_size)

                stats = pool.get_stats()
                logger.info(f"[POOL-INIT] Pool created - ready={stats['ready_workers']}, spawning={stats['spawning_workers']}, target={stats['target_size']}")

                for i in range(6):
                    time.sleep(5)
                    stats = pool.get_stats()
                    logger.info(f"[POOL-STATUS] After {(i+1)*5}s - ready={stats['ready_workers']}, spawning={stats['spawning_workers']}, total={stats['total_workers']}")
                    if stats['ready_workers'] >= stats['target_size']:
                        logger.info(f"[POOL-INIT] Pool fully populated with {stats['ready_workers']} ready workers")
                        break
            except Exception as e:
                logger.error(f"[POOL-INIT] Failed to initialize worker pool: {e}")
                logger.info("[POOL-INIT] Application will continue without worker pool (fallback to direct spawning)")

        pool_thread = threading.Thread(target=init_pool_background, daemon=True)
        pool_thread.start()
    else:
        logger.info("[POOL-INIT] Skipping pool init in reloader parent process")

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
        debug=True,
        threaded=True
    )