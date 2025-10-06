# status: complete

"""
File format converter for normalizing multimedia files to standard formats.
Provides optional conversion with graceful fallback to original files.
"""

import subprocess
import tempfile
from pathlib import Path
from typing import Optional, Tuple
from utils.logger import get_logger

logger = get_logger(__name__)

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.ico'}
AUDIO_EXTENSIONS = {'.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus'}
VIDEO_EXTENSIONS = {'.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.mpg', '.mpeg', '.3gp'}


def _check_ffmpeg_available() -> bool:
    """Check if ffmpeg is available in system PATH"""
    try:
        result = subprocess.run(
            ['ffmpeg', '-version'],
            capture_output=True,
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
        return False


def _is_audio_only_video(source_path: str) -> bool:
    """
    Check if a video file contains only audio streams (no video).
    Common for WhatsApp audio messages (MP4) and other audio files using video containers.

    Args:
        source_path: Path to video file

    Returns:
        True if file is audio-only, False otherwise
    """
    try:
        if not _check_ffmpeg_available():
            return False

        cmd = [
            'ffprobe',
            '-v', 'error',
            '-show_entries', 'stream=codec_type',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            str(source_path)
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
        )

        if result.returncode != 0:
            return False

        streams = result.stdout.decode('utf-8', errors='ignore').strip().split('\n')
        has_audio = 'audio' in streams
        has_video = 'video' in streams

        is_audio_only = has_audio and not has_video

        if is_audio_only:
            logger.info(f"[CONVERT] Detected audio-only video file: {Path(source_path).name}")

        return is_audio_only

    except Exception as e:
        logger.debug(f"[CONVERT] Could not determine if video file is audio-only: {str(e)}")
        return False


def convert_image_to_png(source_path: str) -> Optional[str]:
    """
    Convert an image file to PNG format.

    Args:
        source_path: Path to source image file

    Returns:
        Path to converted PNG file, or None if conversion fails
    """
    try:
        from PIL import Image

        source = Path(source_path)
        if not source.exists():
            logger.warning(f"[CONVERT] Source image does not exist: {source_path}")
            return None

        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as temp_file:
            temp_path = temp_file.name

        with Image.open(source_path) as img:
            if img.mode in ('RGBA', 'LA', 'P'):
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                background.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
                img = background
            elif img.mode not in ('RGB', 'L'):
                img = img.convert('RGB')

            img.save(temp_path, 'PNG', optimize=True)

        logger.info(f"[CONVERT] Image converted to PNG: {source.name} -> {Path(temp_path).name}")
        return temp_path

    except ImportError:
        logger.warning("[CONVERT] Pillow not available, skipping image conversion")
        return None
    except Exception as e:
        logger.warning(f"[CONVERT] Failed to convert image {source_path}: {str(e)}")
        return None


def convert_audio_to_mp3(source_path: str) -> Optional[str]:
    """
    Convert an audio file to MP3 format using ffmpeg.

    Args:
        source_path: Path to source audio file

    Returns:
        Path to converted MP3 file, or None if conversion fails
    """
    try:
        source = Path(source_path)
        if not source.exists():
            logger.warning(f"[CONVERT] Source audio does not exist: {source_path}")
            return None

        if not _check_ffmpeg_available():
            logger.warning("[CONVERT] ffmpeg not available, skipping audio conversion")
            return None

        with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as temp_file:
            temp_path = temp_file.name

        cmd = [
            'ffmpeg',
            '-i', str(source_path),
            '-acodec', 'libmp3lame',
            '-ab', '192k',
            '-ar', '44100',
            '-y', 
            temp_path
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=300, 
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
        )

        if result.returncode != 0:
            logger.warning(f"[CONVERT] ffmpeg audio conversion failed: {result.stderr.decode('utf-8', errors='ignore')}")
            Path(temp_path).unlink(missing_ok=True)
            return None

        logger.info(f"[CONVERT] Audio converted to MP3: {source.name} -> {Path(temp_path).name}")
        return temp_path

    except subprocess.TimeoutExpired:
        logger.warning(f"[CONVERT] Audio conversion timeout for {source_path}")
        return None
    except Exception as e:
        logger.warning(f"[CONVERT] Failed to convert audio {source_path}: {str(e)}")
        return None


def convert_video_to_mp4(source_path: str) -> Optional[str]:
    """
    Convert a video file to MP4 format using ffmpeg.

    Args:
        source_path: Path to source video file

    Returns:
        Path to converted MP4 file, or None if conversion fails
    """
    try:
        source = Path(source_path)
        if not source.exists():
            logger.warning(f"[CONVERT] Source video does not exist: {source_path}")
            return None

        if not _check_ffmpeg_available():
            logger.warning("[CONVERT] ffmpeg not available, skipping video conversion")
            return None

        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_file:
            temp_path = temp_file.name

        cmd = [
            'ffmpeg',
            '-i', str(source_path),
            '-c:v', 'libx264', 
            '-preset', 'medium',
            '-crf', '23', 
            '-c:a', 'aac', 
            '-b:a', '128k',
            '-movflags', '+faststart', 
            '-y', 
            temp_path
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=600,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
        )

        if result.returncode != 0:
            logger.warning(f"[CONVERT] ffmpeg video conversion failed: {result.stderr.decode('utf-8', errors='ignore')}")
            Path(temp_path).unlink(missing_ok=True)
            return None

        logger.info(f"[CONVERT] Video converted to MP4: {source.name} -> {Path(temp_path).name}")
        return temp_path

    except subprocess.TimeoutExpired:
        logger.warning(f"[CONVERT] Video conversion timeout for {source_path}")
        return None
    except Exception as e:
        logger.warning(f"[CONVERT] Failed to convert video {source_path}: {str(e)}")
        return None


def try_convert_file(source_path: str, original_filename: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Attempt to convert a file to a standard format based on its extension.

    Args:
        source_path: Path to source file
        original_filename: Original filename (used to determine type)

    Returns:
        Tuple of (converted_path, new_extension, new_filename):
        - converted_path: Path to converted file, or None if no conversion
        - new_extension: New file extension (e.g., '.png'), or None
        - new_filename: New filename with updated extension, or None
    """
    try:
        source_ext = Path(original_filename).suffix.lower()

        if source_ext in IMAGE_EXTENSIONS:
            converted_path = convert_image_to_png(source_path)
            if converted_path:
                new_filename = Path(original_filename).stem + '.png'
                return converted_path, '.png', new_filename

        elif source_ext in AUDIO_EXTENSIONS:
            converted_path = convert_audio_to_mp3(source_path)
            if converted_path:
                new_filename = Path(original_filename).stem + '.mp3'
                return converted_path, '.mp3', new_filename

        elif source_ext == '.mp4' or source_ext in VIDEO_EXTENSIONS:
            if _is_audio_only_video(source_path):
                logger.info(f"[CONVERT] Converting audio-only video file to MP3: {original_filename}")
                converted_path = convert_audio_to_mp3(source_path)
                if converted_path:
                    new_filename = Path(original_filename).stem + '.mp3'
                    return converted_path, '.mp3', new_filename

            if source_ext == '.mp4':
                return None, None, None
            else:
                converted_path = convert_video_to_mp4(source_path)
                if converted_path:
                    new_filename = Path(original_filename).stem + '.mp4'
                    return converted_path, '.mp4', new_filename

        return None, None, None

    except Exception as e:
        logger.error(f"[CONVERT] Unexpected error in try_convert_file: {str(e)}")
        return None, None, None
