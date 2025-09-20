# status: complete

from flask import Flask, jsonify
from utils.config import Config, available_routes, ROUTE_MODEL_MAP
from utils.logger import get_logger
from agents.roles.router import router

logger = get_logger(__name__)

def register_agent_routes(app: Flask):
    """Register agent and router related routes"""

    @app.route('/api/router/available', methods=['GET'])
    def get_available_routes():
        """Get list of available routing options"""
        try:
            routes_with_models = []
            for route in available_routes:
                route_name = route['route_name']
                routes_with_models.append({
                    **route,
                    'model': ROUTE_MODEL_MAP.get(route_name, Config.get_default_model())
                })

            return jsonify({
                'success': True,
                'routes': routes_with_models
            })
        except Exception as e:
            logger.error(f"Error getting available routes: {e}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/router/status', methods=['GET'])
    def get_router_status():
        """Get router enabled status and current configuration"""
        try:
            return jsonify({
                'success': True,
                'enabled': router.router_enabled,
                'router_model': router.router_model,
                'default_model': Config.get_default_model()
            })
        except Exception as e:
            logger.error(f"Error getting router status: {e}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    logger.info("Agent routes registered successfully")