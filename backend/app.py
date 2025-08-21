# status: complete

from flask import Flask, jsonify
from flask_cors import CORS
import os
import sys

backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(backend_dir)

from route.chat_route import register_chat_routes
from route.db_route import register_db_routes
from utils.config import Config
from utils.logger import get_logger

logger = get_logger(__name__)

def create_app():
    """Create and configure the Flask application"""
    app = Flask(__name__)
    
    CORS(app, origins=['http://localhost:3000'])
    
    register_chat_routes(app)
    register_db_routes(app)
    
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
                }
            }
        })
    
    return app

if __name__ == '__main__':
    app = create_app()
    
    logger.info("Starting ATLAS2 Backend on 0.0.0.0:5000")
    
    app.run(
        host='0.0.0.0',
        port=5000,
        debug=True,
        threaded=True
    )