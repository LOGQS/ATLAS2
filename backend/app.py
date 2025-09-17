# status: complete

from flask import Flask, jsonify
from flask_cors import CORS
import os
import sys
import multiprocessing
from pathlib import Path
import signal
import atexit

backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(backend_dir)

from route.chat_route import register_chat_routes
from route.db_chat_management_route import register_db_chat_management_routes
from route.db_message_route import register_db_message_routes
from route.db_bulk_route import register_db_bulk_routes
from route.db_versioning_route import register_db_versioning_routes
from route.file_route import register_file_routes
from route.stt_route import register_stt_routes
from utils.config import Config
from utils.logger import get_logger
from file_utils.file_handler import setup_filespace, sync_files_with_database
from utils.db_utils import db

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
    
    CORS(app, origins=['http://localhost:3000'])
    
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
    register_db_chat_management_routes(app)
    register_db_message_routes(app)
    register_db_bulk_routes(app)
    register_db_versioning_routes(app)
    register_file_routes(app)
    register_stt_routes(app)
    
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