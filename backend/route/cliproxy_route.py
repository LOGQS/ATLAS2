# status: complete

from flask import Blueprint, jsonify, request

from utils.logger import get_logger

logger = get_logger(__name__)

cliproxy_bp = Blueprint("cliproxy", __name__, url_prefix="/api/cliproxy")


def _get_manager():
    """Get the CLIProxy manager instance."""
    from services.cliproxy.manager import get_cliproxy_manager
    return get_cliproxy_manager()


def _get_provider():
    """Get the CLIProxy provider instance."""
    from utils.config import get_provider_map
    providers = get_provider_map()
    return providers.get("cliproxy")


@cliproxy_bp.get("/status")
def get_status():
    """
    Get CLIProxy service status and authentication state for all providers.

    Returns:
        {
            "running": bool,
            "healthy": bool,
            "providers": {
                "gemini": {"name": "Gemini CLI", "authenticated": true, "account_count": 2, ...},
                "claude": {"name": "Claude Code", "authenticated": false, ...},
                ...
            }
        }
    """
    try:
        manager = _get_manager()

        is_running = manager.is_running()
        is_healthy = manager.health_check() if is_running else False

        # Always get auth status from filesystem - it's independent of proxy health
        # Auth files exist on disk regardless of whether proxy is running
        auth_status = manager.get_auth_status()

        status = {
            "running": is_running,
            "healthy": is_healthy,
            "has_existing_auth": manager.has_existing_auth(),
            "providers": auth_status.get("providers", {}),
        }

        if "error" in auth_status:
            status["auth_error"] = auth_status["error"]

        return jsonify(status)

    except Exception as e:
        logger.error(f"Failed to get CLIProxy status: {e}")
        return jsonify({"error": str(e)}), 500


@cliproxy_bp.post("/start")
def start_proxy():
    """
    Start the CLIProxy service.

    Returns:
        {"success": bool, "message": str}
    """
    try:
        manager = _get_manager()

        if manager.is_running():
            return jsonify({"success": True, "message": "CLIProxy already running"})

        success = manager.start()
        if success:
            return jsonify({"success": True, "message": "CLIProxy started successfully"})
        else:
            return jsonify({"success": False, "error": "Failed to start CLIProxy"}), 500

    except Exception as e:
        logger.error(f"Failed to start CLIProxy: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@cliproxy_bp.post("/stop")
def stop_proxy():
    """
    Stop the CLIProxy service.

    Returns:
        {"success": bool, "message": str}
    """
    try:
        manager = _get_manager()

        if not manager.is_running():
            return jsonify({"success": True, "message": "CLIProxy not running"})

        success = manager.stop()
        if success:
            return jsonify({"success": True, "message": "CLIProxy stopped successfully"})
        else:
            return jsonify({"success": False, "error": "Failed to stop CLIProxy"}), 500

    except Exception as e:
        logger.error(f"Failed to stop CLIProxy: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@cliproxy_bp.post("/login/<provider_id>")
def start_login(provider_id: str):
    """
    Start OAuth login flow for a provider.

    Args:
        provider_id: One of 'gemini', 'claude', 'codex', 'qwen', 'iflow', 'antigravity'

    Returns:
        {
            "success": bool,
            "url": str,  // OAuth URL to open in browser
            "state": str,  // State token for polling
            "provider": str,
            "provider_name": str
        }
    """
    try:
        manager = _get_manager()
        result = manager.start_oauth_login(provider_id)

        if result.get("success"):
            return jsonify(result)
        else:
            return jsonify(result), 400

    except Exception as e:
        logger.error(f"Failed to start OAuth login for {provider_id}: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@cliproxy_bp.get("/login/poll")
def poll_login():
    """
    Poll OAuth login completion status.

    Query params:
        state: The state token from start_login response

    Returns:
        {"status": "wait"|"ok"|"error", ...}
    """
    state = request.args.get("state")
    if not state:
        return jsonify({"status": "error", "error": "state parameter required"}), 400

    try:
        manager = _get_manager()
        result = manager.poll_oauth_status(state)

        # If login completed, refresh the provider's model list
        if result.get("status") == "ok":
            provider = _get_provider()
            if provider:
                provider.refresh_models()

        return jsonify(result)

    except Exception as e:
        logger.error(f"Failed to poll OAuth status: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


@cliproxy_bp.delete("/logout")
def logout_account():
    """
    Remove an authenticated account.

    Query params:
        filename: The auth file to remove (e.g., 'gemini-user@example.com.json')

    Returns:
        {"success": bool}
    """
    filename = request.args.get("filename")
    if not filename:
        return jsonify({"success": False, "error": "filename parameter required"}), 400

    try:
        manager = _get_manager()
        result = manager.logout_account(filename)

        # Refresh provider's model list after logout
        if result.get("success"):
            provider = _get_provider()
            if provider:
                provider.refresh_models()

        return jsonify(result)

    except Exception as e:
        logger.error(f"Failed to logout account: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@cliproxy_bp.get("/models")
def get_models():
    """
    Get all available models from authenticated providers.

    Returns:
        {
            "models": {
                "gemini-2.5-pro": {"name": "Gemini 2.5 Pro", "supports_reasoning": true, ...},
                ...
            }
        }
    """
    try:
        provider = _get_provider()
        if provider:
            models = provider.get_available_models()
            return jsonify({"models": models})
        else:
            return jsonify({"models": {}})

    except Exception as e:
        logger.error(f"Failed to get CLIProxy models: {e}")
        return jsonify({"error": str(e)}), 500


@cliproxy_bp.post("/refresh")
def refresh_models():
    """
    Force refresh of available models and provider status.

    Returns:
        {"success": bool, "model_count": int}
    """
    try:
        provider = _get_provider()
        if provider:
            provider.refresh_models()
            models = provider.get_available_models()
            return jsonify({"success": True, "model_count": len(models)})
        else:
            return jsonify({"success": False, "error": "CLIProxy provider not available"}), 404

    except Exception as e:
        logger.error(f"Failed to refresh CLIProxy models: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


def register_cliproxy_routes(app) -> None:
    """Register CLIProxy routes with the Flask app."""
    app.register_blueprint(cliproxy_bp)
