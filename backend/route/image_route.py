# status: complete

from flask import Blueprint, request, jsonify, send_file
from features.image_generation import ImageGeneration
from utils.logger import get_logger
from pathlib import Path

logger = get_logger(__name__)

image_bp = Blueprint('image', __name__)
image_gen = ImageGeneration()

@image_bp.route('/api/image/generate', methods=['POST'])
def generate_image():
    """Generate an image from text prompt"""
    try:
        data = request.json
        if not data or 'prompt' not in data:
            return jsonify({"success": False, "error": "Prompt is required"}), 400

        prompt = data.get('prompt')
        width = data.get('width', 1024)
        height = data.get('height', 1024)
        seed = data.get('seed')
        model = data.get('model', 'flux')
        provider = data.get('provider')

        logger.info(f"[IMAGE-ROUTE] Generating image with prompt: '{prompt[:50]}...'")

        result = image_gen.generate_image(
            prompt=prompt,
            width=width,
            height=height,
            seed=seed,
            model=model,
            provider=provider
        )

        if result.get('success'):
            logger.info(f"[IMAGE-ROUTE] Image generated successfully: {result.get('filename')}")
        else:
            logger.error(f"[IMAGE-ROUTE] Image generation failed: {result.get('error')}")

        return jsonify(result)

    except Exception as e:
        logger.error(f"[IMAGE-ROUTE] Error generating image: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500


@image_bp.route('/api/image/models', methods=['GET'])
def get_available_models():
    """Get available image generation models"""
    try:
        models = image_gen.get_all_available_models()
        return jsonify({"success": True, "models": models})

    except Exception as e:
        logger.error(f"[IMAGE-ROUTE] Error getting models: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@image_bp.route('/api/image/status', methods=['GET'])
def get_status():
    """Check if image generation service is available"""
    try:
        providers_status = {}
        for provider_name in image_gen.providers.keys():
            providers_status[provider_name] = image_gen.is_available(provider_name)

        return jsonify({
            "success": True,
            "providers": providers_status,
            "default_provider": image_gen.default_provider
        })

    except Exception as e:
        logger.error(f"[IMAGE-ROUTE] Error checking status: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

@image_bp.route('/api/image/<filename>', methods=['GET'])
def get_image(filename):
    """Serve a generated image by filename"""
    try:
        file_path = Path(__file__).resolve().parent.parent.parent / "data" / "generated_images" / filename

        if not file_path.exists():
            logger.warning(f"[IMAGE-ROUTE] Image not found: {filename}")
            return jsonify({"success": False, "error": "Image not found"}), 404

        logger.info(f"[IMAGE-ROUTE] Serving image: {filename}")
        return send_file(file_path, mimetype='image/jpeg')

    except Exception as e:
        logger.error(f"[IMAGE-ROUTE] Error serving image: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500