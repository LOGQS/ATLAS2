# status: complete

from flask import Flask, jsonify, request
from utils.config import Config, available_routes, ROUTE_MODEL_MAP
from utils.logger import get_logger
from agents.roles.router import router
from chat.chat import Chat

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
                'default_model': Config.get_default_model(),
                'model_override': getattr(router, 'model_override', None),
                'provider_override': getattr(router, 'provider_override', None)
            })
        except Exception as e:
            logger.error(f"Error getting router status: {e}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/router/toggle', methods=['POST'])
    def toggle_router():
        """Toggle router on/off and optionally set a model override"""
        try:
            data = request.get_json() or {}

            # If 'enabled' is explicitly provided, use it; otherwise toggle
            if 'enabled' in data:
                router.router_enabled = bool(data['enabled'])
            else:
                router.router_enabled = not router.router_enabled

            # Handle model override
            model_override = data.get('model_override')
            provider_override = data.get('provider_override')

            if model_override:
                router.model_override = model_override
                router.provider_override = provider_override
            else:
                router.model_override = None
                router.provider_override = None

            logger.info(f"Router toggled: enabled={router.router_enabled}, model_override={router.model_override}, provider_override={router.provider_override}")

            return jsonify({
                'success': True,
                'enabled': router.router_enabled,
                'model_override': router.model_override,
                'provider_override': router.provider_override,
                'default_model': Config.get_default_model()
            })
        except Exception as e:
            logger.error(f"Error toggling router: {e}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/models/all', methods=['GET'])
    def get_all_models():
        """Get all available models from all providers with structured info"""
        try:
            chat = Chat()
            raw_models = chat.get_all_available_models()

            # Group by provider for better organization
            models_by_provider = {}
            flat_models = []

            for full_id, model_info in raw_models.items():
                provider = model_info.get('provider', 'unknown')
                model_id = model_info.get('model_id', full_id)

                if provider not in models_by_provider:
                    models_by_provider[provider] = []

                model_entry = {
                    'id': full_id,  # provider:model_id format
                    'model_id': model_id,  # raw model ID
                    'provider': provider,
                    'name': model_info.get('name', model_id),
                    'supports_reasoning': model_info.get('supports_reasoning', False)
                }

                models_by_provider[provider].append(model_entry)
                flat_models.append(model_entry)

            return jsonify({
                'success': True,
                'models': flat_models,
                'by_provider': models_by_provider,
                'default_model': Config.get_default_model(),
                'router_enabled': router.router_enabled,
                'model_override': getattr(router, 'model_override', None),
                'provider_override': getattr(router, 'provider_override', None)
            })
        except Exception as e:
            logger.error(f"Error getting all models: {e}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    logger.info("Agent routes registered successfully")