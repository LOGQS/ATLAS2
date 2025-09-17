# status: complete

"""
Speech-to-Text main module providing unified abstraction for STT providers
and local STT implementation using faster_whisper
"""

from typing import Dict, Any, Optional
from utils.logger import get_logger
from features.stt_providers import Groq
from faster_whisper import WhisperModel

logger = get_logger(__name__)

class STT:
    """
    Main STT class that manages speech-to-text operations
    """

    def __init__(self):
        self.provider = Groq()

    def is_available(self) -> bool:
        """Check if STT provider is available"""
        return self.provider.is_available()

    def get_available_models(self) -> Dict[str, str]:
        """Get available models from provider"""
        return self.provider.get_available_models()

    def transcribe(self, file_path: str, model: str = "whisper-large-v3-turbo",
                  language: Optional[str] = None) -> Dict[str, Any]:
        """
        Transcribe audio to text

        Args:
            file_path: Path to audio file
            model: Model to use for transcription
            language: Language of the audio (optional)

        Returns:
            Dict with transcription results
        """
        if not self.provider.is_available():
            return {"success": False, "error": "Provider not available"}

        return self.provider.transcribe_audio(
            file_path=file_path,
            model=model,
            language=language
        )

class LocalSTT:
    """
    Local STT implementation using faster_whisper library
    """

    def __init__(self, model_size: str = "base"):
        """
        Initialize LocalSTT

        Args:
            model_size: Whisper model size (tiny, base, small, medium, large)
        """
        self.model_size = model_size

    def is_available(self) -> bool:
        """Check if faster_whisper is installed"""
        try:
            import faster_whisper
            return True
        except ImportError:
            return False

    def transcribe(self, file_path: str,
                  language: Optional[str] = None) -> Dict[str, Any]:
        """
        Transcribe audio using local Whisper model

        Args:
            file_path: Path to audio file
            language: Language code for audio

        Returns:
            Dict with transcription results
        """
        if not self.is_available():
            return {
                "success": False,
                "error": "faster_whisper not installed. Install with: pip install faster-whisper"
            }

        try:
            model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
            segments, info = model.transcribe(
                file_path,
                beam_size=5,
                language=language,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500)
            )

            transcription = ""
            segment_list = []

            for segment in segments:
                transcription += segment.text + " "
                segment_list.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text
                })

            return {
                'success': True,
                'text': transcription.strip(),
                'language': info.language,
                'segments': segment_list
            }

        except Exception as e:
            logger.error(f"Local transcription failed: {str(e)}")
            return {"success": False, "error": str(e)}