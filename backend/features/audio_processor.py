# status: complete

"""
Audio processing utilities for chunking large audio files and handling size limits
"""

import os
import shutil
import uuid
from typing import List, Dict, Any
from pathlib import Path
from utils.logger import get_logger

logger = get_logger(__name__)

class AudioProcessor:
    """
    Audio processor for handling large audio files and chunking them into smaller segments
    """

    MAX_FILE_SIZE = 25 * 1024 * 1024 
    CHUNK_SIZE = 10 * 1024 * 1024

    def __init__(self):
        self.temp_dir = None

    def _ensure_temp_dir(self) -> Path:
        """Ensure temporary directory exists for processing chunks in project data folder"""
        if not self.temp_dir:
            backend_dir = Path(__file__).parent.parent
            project_root = backend_dir.parent
            data_dir = project_root / "data"

            if not data_dir.exists():
                data_dir.mkdir(parents=True, exist_ok=True)
                logger.info(f"[AUDIO_PROCESSOR] Created data directory: {data_dir}")

            audio_temp_dir = data_dir / "audio_temp"
            if not audio_temp_dir.exists():
                audio_temp_dir.mkdir(parents=True, exist_ok=True)

            session_id = uuid.uuid4().hex[:8]
            self.temp_dir = audio_temp_dir / f"session_{session_id}"
            self.temp_dir.mkdir(parents=True, exist_ok=True)

            logger.info(f"[AUDIO_PROCESSOR] Created temp directory: {self.temp_dir}")
        return self.temp_dir

    def needs_chunking(self, file_path: str) -> bool:
        """Check if audio file exceeds size limit and needs chunking"""
        try:
            file_size = os.path.getsize(file_path)
            logger.info(f"[AUDIO_PROCESSOR] File size: {file_size} bytes ({file_size / (1024*1024):.2f}MB)")
            return file_size > self.MAX_FILE_SIZE
        except OSError as e:
            logger.error(f"[AUDIO_PROCESSOR] Error checking file size: {e}")
            return False

    def chunk_audio_file(self, file_path: str) -> List[str]:
        """
        Split large audio file into smaller chunks for processing

        Args:
            file_path: Path to the audio file to chunk

        Returns:
            List of paths to chunk files
        """
        try:
            from pydub import AudioSegment
        except ImportError as e:
            logger.error(f"[AUDIO_PROCESSOR] pydub not installed: {e}")
            raise RuntimeError("pydub library required for audio chunking. Install with: pip install pydub")

        if not self.needs_chunking(file_path):
            logger.info(f"[AUDIO_PROCESSOR] File {file_path} does not need chunking")
            return [file_path]

        logger.info(f"[AUDIO_PROCESSOR] Starting chunking process for {file_path}")

        try:
            audio = AudioSegment.from_file(file_path)
            total_duration_ms = len(audio)
            logger.info(f"[AUDIO_PROCESSOR] Loaded audio: {total_duration_ms/1000:.2f} seconds")

            file_size = os.path.getsize(file_path)
            size_ratio = file_size / self.CHUNK_SIZE
            chunk_duration_ms = int(total_duration_ms / size_ratio)

            chunk_duration_ms = max(chunk_duration_ms, 30000)

            logger.info(f"[AUDIO_PROCESSOR] Target chunk duration: {chunk_duration_ms/1000:.2f} seconds")

            temp_dir = self._ensure_temp_dir()
            chunk_files = []

            start_time = 0
            chunk_index = 0

            while start_time < total_duration_ms:
                end_time = min(start_time + chunk_duration_ms, total_duration_ms)
                chunk = audio[start_time:end_time]

                chunk_filename = f"chunk_{chunk_index:03d}.wav"
                chunk_path = temp_dir / chunk_filename

                chunk.export(str(chunk_path), format="wav")
                chunk_files.append(str(chunk_path))

                chunk_size = os.path.getsize(chunk_path)
                logger.info(f"[AUDIO_PROCESSOR] Created chunk {chunk_index}: {chunk_path} "
                           f"({chunk_size / (1024*1024):.2f}MB, {(end_time-start_time)/1000:.2f}s)")

                start_time = end_time
                chunk_index += 1

            logger.info(f"[AUDIO_PROCESSOR] Successfully created {len(chunk_files)} chunks")
            return chunk_files

        except Exception as e:
            logger.error(f"[AUDIO_PROCESSOR] Error chunking audio file: {e}")
            self.cleanup_temp_files()
            raise

    def cleanup_temp_files(self):
        """Clean up temporary chunk files"""
        if self.temp_dir and self.temp_dir.exists():
            try:
                shutil.rmtree(self.temp_dir)
                logger.info(f"[AUDIO_PROCESSOR] Cleaned up temp directory: {self.temp_dir}")
                self.temp_dir = None
            except Exception as e:
                logger.error(f"[AUDIO_PROCESSOR] Error cleaning up temp files: {e}")

    def get_file_info(self, file_path: str) -> Dict[str, Any]:
        """Get detailed information about an audio file"""
        try:
            from pydub import AudioSegment

            file_size = os.path.getsize(file_path)
            audio = AudioSegment.from_file(file_path)

            info = {
                'file_size_bytes': file_size,
                'file_size_mb': file_size / (1024 * 1024),
                'duration_seconds': len(audio) / 1000.0,
                'duration_minutes': len(audio) / 60000.0,
                'channels': audio.channels,
                'frame_rate': audio.frame_rate,
                'sample_width': audio.sample_width,
                'needs_chunking': self.needs_chunking(file_path)
            }

            logger.info(f"[AUDIO_PROCESSOR] File info for {file_path}: {info}")
            return info

        except Exception as e:
            logger.error(f"[AUDIO_PROCESSOR] Error getting file info: {e}")
            return {
                'file_size_bytes': os.path.getsize(file_path) if os.path.exists(file_path) else 0,
                'error': str(e)
            }