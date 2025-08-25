from flask import Flask, request, jsonify, send_file
import tempfile
import os
from utils.file_handler import save_file, delete_file, batch_delete_files, edit_filename, list_files, get_file_path, file_provider_manager
from utils.logger import get_logger
from utils.db_utils import db
from utils.config import Config

logger = get_logger(__name__)

class FileRoute:
    """File management route handler"""
    
    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()
    
    def _register_routes(self):
        """Register all file-related routes"""
        self.app.route('/api/files/upload', methods=['POST'])(self.upload_file)
        self.app.route('/api/files', methods=['GET'])(self.get_files)
        self.app.route('/api/files/<file_id>', methods=['DELETE'])(self.delete_file_route)
        self.app.route('/api/files/batch', methods=['DELETE'])(self.batch_delete_files_route)
        self.app.route('/api/files/<file_id>/rename', methods=['PUT'])(self.rename_file)
        self.app.route('/api/files/<file_id>/download', methods=['GET'])(self.download_file)
        self.app.route('/api/files/process', methods=['POST'])(self.process_files)
        self.app.route('/api/files/readiness', methods=['POST'])(self.check_files_readiness)
        self.app.route('/api/files/status', methods=['GET'])(self.get_files_status)
    
    def upload_file(self):
        """Handle file upload from frontend - supports single or multiple files"""
        try:
            if 'files' in request.files:
                files = request.files.getlist('files')
            elif 'file' in request.files:
                files = [request.files['file']]
            else:
                return jsonify({'error': 'No files provided'}), 400
            
            if not files or all(f.filename == '' for f in files):
                return jsonify({'error': 'No files selected'}), 400
            
            chat_id = request.form.get('chat_id')
            
            uploaded_files = []
            errors = []
            
            for file in files:
                if file.filename == '':
                    continue
                    
                temp_path = None
                try:
                    with tempfile.NamedTemporaryFile(delete=False) as temp_file:
                        file.save(temp_file.name)
                        temp_path = temp_file.name
                    
                    result = save_file(
                        source_path=temp_path, 
                        filename=file.filename,
                        file_type=file.content_type,
                        chat_id=chat_id
                    )
                    
                    if result['success']:
                        logger.info(f"File uploaded successfully: {result['file_id']} - {result['original_name']}")
                        
                        # Automatically trigger API processing for the default provider
                        default_provider = Config.get_default_provider()
                        logger.info(f"Triggering automatic API processing for file {result['file_id']} with provider {default_provider}")
                        
                        try:
                            process_result = file_provider_manager.process_and_upload_files(
                                [result['file_id']], 
                                default_provider
                            )
                            
                            if process_result['success'] and process_result['results']:
                                file_result = process_result['results'][0]
                                api_state = file_result.get('state', 'local')
                                provider = default_provider if file_result.get('success') else None
                                
                                logger.info(f"File {result['file_id']} processed with API state: {api_state}")
                            else:
                                api_state = 'error'
                                provider = None
                                logger.warning(f"File {result['file_id']} failed to process: {process_result}")
                        except Exception as e:
                            logger.error(f"Error during automatic file processing: {str(e)}")
                            api_state = 'local'
                            provider = None
                        
                        uploaded_files.append({
                            'id': result['file_id'],
                            'name': result['original_name'],
                            'size': result['size'],
                            'type': result['file_type'],
                            'extension': result['file_extension'],
                            'api_state': api_state,
                            'provider': provider
                        })
                    else:
                        errors.append(f"Failed to upload {file.filename}: {result['error']}")
                
                except Exception as e:
                    errors.append(f"Failed to upload {file.filename}: {str(e)}")
                
                finally:
                    if temp_path:
                        try:
                            os.unlink(temp_path)
                        except:
                            pass
            
            if uploaded_files and not errors:
                return jsonify({
                    'success': True,
                    'message': f'{len(uploaded_files)} file(s) uploaded successfully',
                    'files': uploaded_files
                })
            elif uploaded_files and errors:
                return jsonify({
                    'success': True,
                    'message': f'{len(uploaded_files)} file(s) uploaded successfully, {len(errors)} failed',
                    'files': uploaded_files,
                    'errors': errors
                }), 207
            else:
                return jsonify({
                    'success': False,
                    'error': 'All uploads failed',
                    'errors': errors
                }), 400
        
        except Exception as e:
            logger.error(f"Error uploading files: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def get_files(self):
        """Get list of all files"""
        try:
            chat_id = request.args.get('chat_id')  
            files = list_files(chat_id=chat_id)
            return jsonify({
                'files': files,
                'count': len(files)
            })
        
        except Exception as e:
            logger.error(f"Error getting files: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def delete_file_route(self, file_id):
        """Delete a specific file by ID"""
        try:
            result = delete_file(file_id)
            
            if result['success']:
                return jsonify(result)
            else:
                return jsonify(result), 404 if 'not found' in result['error'].lower() else 500
        
        except Exception as e:
            logger.error(f"Error deleting file: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def batch_delete_files_route(self):
        """Delete multiple files in a single batch operation"""
        try:
            data = request.get_json()
            file_ids = data.get('file_ids', [])
            
            if not file_ids:
                return jsonify({'error': 'file_ids array is required'}), 400
            
            if not isinstance(file_ids, list):
                return jsonify({'error': 'file_ids must be an array'}), 400
            
            logger.info(f"Batch deleting {len(file_ids)} files")
            result = batch_delete_files(file_ids)
            
            if result['success']:
                return jsonify(result)
            else:
                return jsonify(result), 400
        
        except Exception as e:
            logger.error(f"Error in batch delete files: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def rename_file(self, file_id):
        """Rename a file (updates original name)"""
        try:
            data = request.get_json()
            new_name = data.get('new_name')
            
            if not new_name:
                return jsonify({'error': 'new_name is required'}), 400
            
            result = edit_filename(file_id, new_name)
            
            if result['success']:
                return jsonify(result)
            else:
                status_code = 404 if 'not found' in result['error'].lower() else 500
                return jsonify(result), status_code
        
        except Exception as e:
            logger.error(f"Error renaming file: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def download_file(self, file_id):
        """Download a specific file by ID"""
        try:
            file_record = db.get_file_record(file_id)
            if not file_record:
                return jsonify({'error': 'File not found'}), 404
            
            file_path = get_file_path(file_id)
            if not file_path or not file_path.exists():
                return jsonify({'error': 'Physical file not found'}), 404
            
            return send_file(
                str(file_path),
                as_attachment=True,
                download_name=file_record['original_name'] 
            )
        
        except Exception as e:
            logger.error(f"Error downloading file: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def process_files(self):
        """Process multiple files for API upload (markdown conversion + API upload)"""
        try:
            data = request.get_json()
            file_ids = data.get('file_ids', [])
            provider = data.get('provider', 'gemini')
            
            if not file_ids:
                return jsonify({'error': 'file_ids array is required'}), 400
            
            if not isinstance(file_ids, list):
                return jsonify({'error': 'file_ids must be an array'}), 400
            
            logger.info(f"Processing {len(file_ids)} files for provider {provider}")
            
            result = file_provider_manager.process_and_upload_files(file_ids, provider)
            
            return jsonify(result)
        
        except Exception as e:
            logger.error(f"Error processing files: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def check_files_readiness(self):
        """Check if files are ready for use (local + API processing complete)"""
        try:
            data = request.get_json()
            file_ids = data.get('file_ids', [])
            provider = data.get('provider', 'gemini')
            
            if not file_ids:
                return jsonify({'error': 'file_ids array is required'}), 400
            
            if not isinstance(file_ids, list):
                return jsonify({'error': 'file_ids must be an array'}), 400
            
            logger.debug(f"Checking readiness for {len(file_ids)} files")
            
            result = file_provider_manager.check_files_readiness(file_ids, provider)
            
            return jsonify(result)
        
        except Exception as e:
            logger.error(f"Error checking file readiness: {str(e)}")
            return jsonify({'error': str(e)}), 500
    
    def get_files_status(self):
        """Get current status of all files, optionally filtered by chat_id"""
        try:
            chat_id = request.args.get('chat_id')
            files = list_files(chat_id=chat_id)
            
            # Transform files to include current processing status
            files_with_status = []
            for file in files:
                files_with_status.append({
                    'id': file['id'],
                    'name': file['name'],
                    'size': file['size'],
                    'type': file['file_type'],
                    'extension': file['file_extension'],
                    'api_state': file.get('api_state', 'local'),
                    'provider': file.get('provider'),
                    'api_file_name': file.get('api_file_name'),
                    'upload_timestamp': file['upload_timestamp'],
                    'chat_id': file['chat_id']
                })
            
            return jsonify({
                'files': files_with_status,
                'count': len(files_with_status)
            })
        
        except Exception as e:
            logger.error(f"Error getting files status: {str(e)}")
            return jsonify({'error': str(e)}), 500

def register_file_routes(app: Flask):
    """Helper function to register file routes"""
    FileRoute(app)