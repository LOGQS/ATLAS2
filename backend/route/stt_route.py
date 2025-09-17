# status: complete

from flask import Flask, request, jsonify
import os
import uuid
from datetime import datetime
from pathlib import Path
from features.stt import STT, LocalSTT
from utils.logger import get_logger
from utils.config import Config

logger = get_logger(__name__)

cloud_stt = STT()
local_stt = LocalSTT(model_size="base")

def get_stt_config():
    """Get STT configuration from Config or environment overrides"""
    use_cloud = os.getenv("STT_USE_CLOUD")
    if use_cloud is not None:
        use_cloud = use_cloud.lower() == "true"
    else:
        use_cloud = Config.get_stt_use_cloud()

    provider = os.getenv("STT_PROVIDER", Config.get_stt_provider()).lower()
    model = os.getenv("STT_MODEL", Config.get_stt_model())

    return {
        "use_cloud": use_cloud,
        "provider": provider,
        "model": model
    }

def ensure_data_directory():
    """Ensure data directory exists in project root"""
    backend_dir = Path(__file__).parent.parent
    project_root = backend_dir.parent
    data_dir = project_root / "data"

    if not data_dir.exists():
        data_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"Created data directory at: {data_dir.absolute()}")

    return data_dir

def register_stt_routes(app: Flask):
    """Register STT routes directly"""

    @app.route('/api/stt/transcribe', methods=['POST'])
    def transcribe_audio():
        """
        Transcribe audio from file upload
        Expected: multipart/form-data with 'audio' file field
        """
        try:
            if 'audio' not in request.files:
                return jsonify({"success": False, "error": "No audio file provided"}), 400

            audio_file = request.files['audio']
            if audio_file.filename == '':
                return jsonify({"success": False, "error": "No file selected"}), 400

            data_dir = ensure_data_directory()
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            file_id = f"{timestamp}_{uuid.uuid4().hex[:8]}"

            file_ext = ".wav"
            if audio_file.content_type:
                if "webm" in audio_file.content_type:
                    file_ext = ".webm"
                elif "mp3" in audio_file.content_type:
                    file_ext = ".mp3"
                elif "ogg" in audio_file.content_type:
                    file_ext = ".ogg"

            file_path = data_dir / f"{file_id}{file_ext}"
            audio_file.save(str(file_path))

            config = get_stt_config()

            if config["use_cloud"]:
                result = cloud_stt.transcribe(
                    file_path=str(file_path),
                    model=config["model"],
                    language=request.form.get('language', None)
                )
            else:
                result = local_stt.transcribe(
                    file_path=str(file_path),
                    language=request.form.get('language', None)
                )

            if result.get("success"):
                return jsonify({
                    "success": True,
                    "text": result.get("text", ""),
                    "file_id": file_id
                })
            else:
                logger.error(f"Transcription failed: {result.get('error')}")
                return jsonify({
                    "success": False,
                    "error": result.get("error", "Transcription failed")
                }), 500

        except Exception as e:
            logger.error(f"Error in transcribe_audio: {str(e)}")
            return jsonify({
                "success": False,
                "error": str(e)
            }), 500

    @app.route('/api/stt/config', methods=['GET'])
    def get_stt_config_route():
        """Get current STT configuration"""
        config = get_stt_config()

        if config["use_cloud"]:
            config["available"] = cloud_stt.is_available()
        else:
            config["available"] = local_stt.is_available()

        return jsonify(config)

    @app.route('/api/stt/models', methods=['GET'])
    def get_stt_models_route():
        """Get available STT models"""
        config = get_stt_config()

        if config["use_cloud"]:
            models = cloud_stt.get_available_models()
        else:
            models = {
                "tiny": "Tiny (39M parameters)",
                "base": "Base (74M parameters)",
                "small": "Small (244M parameters)",
                "medium": "Medium (769M parameters)",
                "large": "Large (1550M parameters)"
            }

        return jsonify({
            "provider": "cloud" if config["use_cloud"] else "local",
            "models": models
        })