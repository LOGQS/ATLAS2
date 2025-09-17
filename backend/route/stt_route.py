# status: complete

from flask import Flask, request, jsonify
import os
import uuid
from datetime import datetime
from pathlib import Path
from features.stt import STT, LocalSTT
from features.audio_processor import AudioProcessor
from utils.logger import get_logger
from utils.config import Config

logger = get_logger(__name__)

cloud_stt = STT()
local_stt = LocalSTT(model_size="base")
audio_processor = AudioProcessor()

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

def process_audio_chunks(chunk_files, config, language=None):
    """
    Process multiple audio chunks and combine the results

    Args:
        chunk_files: List of paths to chunk files
        config: STT configuration
        language: Language for transcription

    Returns:
        Combined transcription result
    """
    combined_text = ""
    all_segments = []
    total_chunks = len(chunk_files)

    logger.info(f"[STT_CHUNKED] Processing {total_chunks} audio chunks")

    for i, chunk_file in enumerate(chunk_files):
        try:
            logger.info(f"[STT_CHUNKED] Processing chunk {i+1}/{total_chunks}: {chunk_file}")

            if config["use_cloud"]:
                result = cloud_stt.transcribe(
                    file_path=chunk_file,
                    model=config["model"],
                    language=language
                )
            else:
                result = local_stt.transcribe(
                    file_path=chunk_file,
                    language=language
                )

            if result.get("success"):
                chunk_text = result.get("text", "").strip()
                if chunk_text:
                    if combined_text:
                        combined_text += " " + chunk_text
                    else:
                        combined_text = chunk_text

                    if "segments" in result:
                        time_offset = i * 30  
                        for segment in result["segments"]:
                            adjusted_segment = segment.copy()
                            adjusted_segment["start"] += time_offset
                            adjusted_segment["end"] += time_offset
                            all_segments.append(adjusted_segment)

                logger.info(f"[STT_CHUNKED] Chunk {i+1} transcribed successfully: {len(chunk_text)} characters")
            else:
                logger.error(f"[STT_CHUNKED] Chunk {i+1} failed: {result.get('error')}")

        except Exception as e:
            logger.error(f"[STT_CHUNKED] Error processing chunk {i+1}: {str(e)}")
            continue

    audio_processor.cleanup_temp_files()

    return {
        "success": True,
        "text": combined_text,
        "chunks_processed": total_chunks,
        "segments": all_segments if all_segments else None
    }

def register_stt_routes(app: Flask):
    """Register STT routes directly"""

    @app.route('/api/stt/transcribe', methods=['POST'])
    def transcribe_audio():
        """
        Transcribe audio from file upload
        Expected: multipart/form-data with 'audio' file field
        """
        file_path = None
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
            language = request.form.get('language', None)

            if audio_processor.needs_chunking(str(file_path)):
                logger.info(f"[STT_TRANSCRIBE] File exceeds size limit, chunking required for: {file_path}")
                try:
                    chunk_files = audio_processor.chunk_audio_file(str(file_path))
                    result = process_audio_chunks(chunk_files, config, language)
                except Exception as e:
                    logger.error(f"[STT_TRANSCRIBE] Error in chunking process: {str(e)}")
                    return jsonify({
                        "success": False,
                        "error": f"Audio chunking failed: {str(e)}"
                    }), 500
            else:
                if config["use_cloud"]:
                    result = cloud_stt.transcribe(
                        file_path=str(file_path),
                        model=config["model"],
                        language=language
                    )
                else:
                    result = local_stt.transcribe(
                        file_path=str(file_path),
                        language=language
                    )

            if result.get("success"):
                response_data = {
                    "success": True,
                    "text": result.get("text", ""),
                    "file_id": file_id
                }

                if "chunks_processed" in result:
                    response_data["chunked"] = True
                    response_data["chunks_processed"] = result["chunks_processed"]
                    logger.info(f"[STT_TRANSCRIBE] Chunked transcription completed: {result['chunks_processed']} chunks")

                return jsonify(response_data)
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

        finally:
            if file_path:
                try:
                    os.unlink(file_path)
                    logger.info(f"[STT_TRANSCRIBE] Deleted audio file: {file_path}")
                except:
                    logger.warning(f"[STT_TRANSCRIBE] Failed to delete audio file: {file_path}")
                    pass

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