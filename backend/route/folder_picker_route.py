# status: complete

"""Route for native folder picker dialog."""

from flask import Flask, jsonify
import tkinter as tk
from tkinter import filedialog
import threading
import sys
import ctypes

from utils.logger import get_logger

logger = get_logger(__name__)


_dpi_awareness_set = False


def _set_dpi_awareness():
    """Set DPI awareness for Windows to prevent blurry tkinter dialogs."""
    global _dpi_awareness_set

    if _dpi_awareness_set or sys.platform != 'win32':
        return

    try:
        # Try Windows 10+ method first 
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        logger.debug("[FOLDER_PICKER] Set DPI awareness (Per-Monitor V2)")
        _dpi_awareness_set = True
    except Exception:
        try:
            # Fallback to Windows 8.1+ method
            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # PROCESS_SYSTEM_DPI_AWARE
            logger.debug("[FOLDER_PICKER] Set DPI awareness (System)")
            _dpi_awareness_set = True
        except Exception:
            try:
                # Fallback to older Windows method
                ctypes.windll.user32.SetProcessDPIAware()
                logger.debug("[FOLDER_PICKER] Set DPI awareness (Basic)")
                _dpi_awareness_set = True
            except Exception as e:
                logger.warning(f"[FOLDER_PICKER] Could not set DPI awareness: {e}")


class FolderPickerRoute:
    """Route handler for native folder picker dialog."""

    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()

    def _register_routes(self) -> None:
        self.app.route("/api/folder-picker/select", methods=["POST"], endpoint="folder_picker_select")(self.select_folder)

    def select_folder(self):
        """Open native folder picker dialog and return selected path."""
        selected_path = [None]  

        def run_dialog():
            try:
                _set_dpi_awareness()

                root = tk.Tk()
                root.withdraw()
                root.attributes('-topmost', True) 

                folder_path = filedialog.askdirectory(
                    title="Select Workspace Folder",
                    mustexist=True
                )

                selected_path[0] = folder_path
                root.destroy()

            except Exception as e:
                logger.error(f"[FOLDER_PICKER] Error opening dialog: {e}")
                selected_path[0] = None

        dialog_thread = threading.Thread(target=run_dialog)
        dialog_thread.start()
        dialog_thread.join() 

        if selected_path[0]:
            logger.info(f"[FOLDER_PICKER] User selected folder: {selected_path[0]}")
            return jsonify({
                "success": True,
                "path": selected_path[0]
            })
        else:
            logger.info("[FOLDER_PICKER] User cancelled folder selection")
            return jsonify({
                "success": False,
                "cancelled": True
            }), 200


def register_folder_picker_routes(app: Flask) -> None:
    """Register the folder picker routes with the Flask application."""
    FolderPickerRoute(app)
