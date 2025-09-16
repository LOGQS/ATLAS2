# status: complete

from typing import Dict, Any, Optional
from dotenv import load_dotenv
import os
from groq import Groq as GroqClient
from utils.logger import get_logger

load_dotenv()

logger = get_logger(__name__)

class Groq:
    """
    Groq API provider for Speech-to-Text
    """

    AVAILABLE_MODELS = {
        "whisper-large-v3-turbo": "Whisper Large V3 Turbo",
        "whisper-large-v3": "Whisper Large V3"
    }

    def __init__(self):
        self.api_key = os.getenv("GROQ_API_KEY")
        self.status = "enabled" if self.api_key else "disabled"
        self.client = None

        if self.api_key:
            try:
                self.client = GroqClient(api_key=self.api_key)
                logger.info("Groq STT client initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize Groq client: {str(e)}")
                self.status = "disabled"

    def is_available(self) -> bool:
        """Check if provider is available"""
        return self.status == "enabled" and self.client is not None

    def get_available_models(self) -> Dict[str, str]:
        """Get available STT models for this provider"""
        return self.AVAILABLE_MODELS.copy()

    def transcribe_audio(self, file_path: str, model: str = "whisper-large-v3-turbo",
                        language: Optional[str] = None) -> Dict[str, Any]:
        """
        Transcribe audio file to text

        Args:
            file_path: Path to audio file
            model: Model to use for transcription
            language: Language of the audio (optional)

        Returns:
            Dict with transcription results
        """
        if not self.is_available():
            return {"success": False, "error": "Provider not available"}

        try:
            with open(file_path, "rb") as audio_file:
                transcription = self.client.audio.transcriptions.create(
                    file=audio_file,
                    model=model,
                    language=language,
                    response_format="json"
                )

                return {
                    "success": True,
                    "text": transcription.text,
                    "model": model
                }

        except Exception as e:
            logger.error(f"Transcription failed: {str(e)}")
            return {"success": False, "error": str(e)}