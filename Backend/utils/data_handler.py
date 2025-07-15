# status: to implement later

"""
This module handles data/file conversion and preprocessing for the application.
"""

def encoder_cycler():
    """
    This function cycles through the encoders and returns the appropriate encoder for the file type.
    """
    pass

class FileTypeRouter:
    """
    This class routes the file to the appropriate processor based on the file type.
    """
    pass

class CanWithImageFile:
    """
    This class is used to process files that can have an embedded image. (e.g. pdf, docx, etc.)
    It turns the textual part of the file into markdown format returns it in a variable, and the 
    image path is returned in another variable which makes it conditionally accessible.
    """
    pass

class WithoutImageFile:
    """
    This class is used to process files that do not have an embedded image. (e.g. txt, csv, etc.)
    """
    pass

class CodeFileProcessor:
    """
    This class is used to process code files. (e.g. py, js, etc.)
    Turns them into text with line numbers for easy processing.
    """
    pass

class ImageHandler:
    """
    This class is used to process image files. (e.g. png, jpg, etc.)
    It converts all images to a widely supported format (e.g. png) and returns the path to the image.
    """
    pass

class AudioHandler:
    """
    This class is used to process audio files. (e.g. mp3, wav, etc.)
    It converts all audio files to a widely supported format (e.g. mp3) and returns the path to the audio.
    """
    pass

class VideoHandler:
    """
    This class is used to process video files. (e.g. mp4, mov, etc.)
    It converts all video files to a widely supported format (e.g. mp4) and returns the path to the video.
    """
    pass


def process_file():
    """
    This function leverages the FileTypeRouter to route the file to the appropriate processor then 
    calls the appropriate method to process the file.
    """
    pass
