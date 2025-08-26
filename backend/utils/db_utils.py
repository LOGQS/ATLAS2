# status: complete

import sqlite3
import os
from typing import Dict, Any, Optional, List
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager

logger = get_logger(__name__)

class DatabaseManager:
    """
    Global database manager for ATLAS application
    """
    
    def __init__(self, db_name: str = "atlas.db"):
        backend_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(os.path.dirname(backend_dir))
        self.data_dir = os.path.join(project_root, "data")
        self.db_path = os.path.join(self.data_dir, db_name)
        self._ensure_data_directory()
        self._init_database()
    
    def _connect(self):
        """Create database connection with proper SQLite configuration"""
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA journal_size_limit=104857600")
        conn.execute("PRAGMA busy_timeout=500")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA mmap_size=268435456")
        conn.row_factory = sqlite3.Row
        return conn
    
    def _ensure_data_directory(self):
        """Ensure data directory exists"""
        os.makedirs(self.data_dir, exist_ok=True)
    
    def _init_database(self):
        """Initialize all database tables"""
        with self._connect() as conn:
            cursor = conn.cursor()
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY, 
                    value TEXT
                )
            """)
            cursor.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1')")
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS chats (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    system_prompt TEXT,
                    state TEXT DEFAULT 'static' CHECK(state IN ('thinking', 'responding', 'static')),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
                    content TEXT NOT NULL,
                    thoughts TEXT,
                    provider TEXT,
                    model TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
                )
            """)
            
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at)
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS provider_configs (
                    provider TEXT PRIMARY KEY,
                    config TEXT,
                    is_enabled INTEGER NOT NULL DEFAULT 1 CHECK(is_enabled IN (0,1)),
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS files (
                    id TEXT PRIMARY KEY,
                    original_name TEXT NOT NULL,
                    stored_filename TEXT NOT NULL,
                    file_type TEXT,
                    file_extension TEXT,
                    file_size INTEGER,
                    upload_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    chat_id TEXT,
                    md_filename TEXT,
                    api_file_name TEXT,
                    api_state TEXT DEFAULT 'local' CHECK(api_state IN ('local', 'processing_md', 'uploading', 'uploaded', 'processing', 'ready', 'error')),
                    provider TEXT,
                    temp_id TEXT,  -- Store temp ID for race condition handling
                    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
                )
            """)
            
            
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_files_chat ON files(chat_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_files_upload ON files(upload_timestamp)
            """)
            
            conn.commit()
    
    def create_chat(self, chat_id: str, system_prompt: Optional[str] = None, name: Optional[str] = None) -> bool:
        """Create new chat session"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO chats (id, name, system_prompt) VALUES (?, ?, ?)",
                    (chat_id, name, system_prompt)
                )
                conn.commit()
                logger.info(f"Created new chat: {chat_id}")
                return True
        except sqlite3.IntegrityError:
            logger.warning(f"Chat already exists: {chat_id}")
            return False
    
    def save_message(self, chat_id: str, role: str, content: str, 
                    thoughts: Optional[str] = None, provider: Optional[str] = None, 
                    model: Optional[str] = None) -> Optional[int]:
        """Save message to chat history and return message ID"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                
                cursor.execute("""
                    SELECT id FROM messages 
                    WHERE chat_id = ? AND role = ? AND content = ?
                    AND datetime(timestamp, 'localtime') > datetime('now', '-1 minute', 'localtime')
                    ORDER BY timestamp DESC LIMIT 1
                """, (chat_id, role, content))
                
                existing = cursor.fetchone()
                if existing:
                    logger.warning(f"Duplicate message detected for chat {chat_id}, returning existing ID: {existing[0]}")
                    return existing[0]
                
                cursor.execute("""
                    INSERT INTO messages (chat_id, role, content, thoughts, provider, model)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (chat_id, role, content, thoughts, provider, model))
                message_id = cursor.lastrowid
                conn.commit()
                logger.debug(f"Saved new message {message_id} for chat {chat_id}: {role} - {content[:50]}...")
                return message_id
        except Exception as e:
            logger.error(f"Error saving message: {str(e)}")
            return None
    
    def update_message(self, message_id: int, content: str, thoughts: Optional[str] = None) -> bool:
        """Update existing message content and thoughts"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    UPDATE messages 
                    SET content = ?, thoughts = ?, timestamp = CURRENT_TIMESTAMP
                    WHERE id = ?
                """, (content, thoughts, message_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            logger.error(f"Error updating message: {str(e)}")
            return False
    
    def get_chat_history(self, chat_id: str) -> List[Dict[str, Any]]:
        """Get chat history for a specific chat"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, role, content, thoughts, provider, model, timestamp
                FROM messages 
                WHERE chat_id = ?
                ORDER BY id ASC
            """, (chat_id,))
            
            messages = []
            for row in cursor.fetchall():
                messages.append({
                    "id": row["id"],
                    "role": row["role"],
                    "content": row["content"],
                    "thoughts": row["thoughts"],
                    "provider": row["provider"],
                    "model": row["model"],
                    "timestamp": row["timestamp"]
                })
            return messages
    
    def get_all_chats(self) -> List[Dict[str, Any]]:
        """Get all chat sessions"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, name, system_prompt, state, created_at
                FROM chats
                ORDER BY created_at DESC
            """)
            
            chats = []
            for row in cursor.fetchall():
                chats.append({
                    "id": row["id"],
                    "name": row["name"],
                    "system_prompt": row["system_prompt"],
                    "state": row["state"],
                    "created_at": row["created_at"]
                })
            return chats
    
    def delete_chat(self, chat_id: str) -> bool:
        """Delete chat and all its messages"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
                conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error deleting chat: {str(e)}")
            return False
    
    def chat_exists(self, chat_id: str) -> bool:
        """Check if chat exists"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT 1 FROM chats WHERE id = ? LIMIT 1", (chat_id,))
            return cursor.fetchone() is not None
    
    def save_user_setting(self, key: str, value: str) -> bool:
        """Save user setting"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT OR REPLACE INTO user_settings (key, value, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                """, (key, value))
                conn.commit()
                return True
        except Exception as e:
            logger.error(f"Error saving user setting: {str(e)}")
            return False
    
    def get_user_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Get user setting"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM user_settings WHERE key = ?", (key,))
            result = cursor.fetchone()
            return result["value"] if result else default
    
    def update_chat_name(self, chat_id: str, name: str) -> bool:
        """Update chat name"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("UPDATE chats SET name = ? WHERE id = ?", (name, chat_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            logger.error(f"Error updating chat name: {str(e)}")
            return False
    
    def update_chat_state(self, chat_id: str, state: str) -> bool:
        """Update chat state (thinking/responding/static)"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("UPDATE chats SET state = ? WHERE id = ?", (state, chat_id))
                conn.commit()
                updated = cursor.rowcount > 0
                if updated:
                    logger.debug(f"Updated chat {chat_id} state to '{state}'")
                else:
                    logger.warning(f"Failed to update chat {chat_id} state to '{state}' - chat may not exist")
                return updated
        except Exception as e:
            logger.error(f"Error updating chat state for {chat_id}: {str(e)}")
            return False
    
    def get_chat_state(self, chat_id: str) -> Optional[str]:
        """Get current chat state"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT state FROM chats WHERE id = ?", (chat_id,))
            result = cursor.fetchone()
            return result["state"] if result else None
    
    def save_file_record(self, file_id: str, original_name: str, stored_filename: str, 
                        file_type: str, file_extension: str, file_size: int, 
                        chat_id: Optional[str] = None, md_filename: Optional[str] = None,
                        api_file_name: Optional[str] = None, api_state: str = 'local', 
                        provider: Optional[str] = None, temp_id: Optional[str] = None) -> bool:
        """Save file record to database"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT INTO files (id, original_name, stored_filename, file_type, 
                                     file_extension, file_size, chat_id, md_filename, 
                                     api_file_name, api_state, provider, temp_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (file_id, original_name, stored_filename, file_type, file_extension, file_size, chat_id, md_filename, api_file_name, api_state, provider, temp_id))
                conn.commit()
                logger.info(f"Saved file record: {file_id} - {original_name}")
                return True
        except Exception as e:
            logger.error(f"Error saving file record: {str(e)}")
            return False
    
    def get_file_record(self, file_id: str) -> Optional[Dict[str, Any]]:
        """Get file record by ID"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, original_name, stored_filename, file_type, file_extension, 
                       file_size, upload_timestamp, chat_id, md_filename, api_file_name, 
                       api_state, provider
                FROM files WHERE id = ?
            """, (file_id,))
            result = cursor.fetchone()
            if result:
                return {
                    "id": result["id"],
                    "original_name": result["original_name"],
                    "stored_filename": result["stored_filename"],
                    "file_type": result["file_type"],
                    "file_extension": result["file_extension"],
                    "file_size": result["file_size"],
                    "upload_timestamp": result["upload_timestamp"],
                    "chat_id": result["chat_id"],
                    "md_filename": result["md_filename"],
                    "api_file_name": result["api_file_name"],
                    "api_state": result["api_state"],
                    "provider": result["provider"]
                }
            return None
    
    def get_all_files(self, chat_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get all file records, optionally filtered by chat_id"""
        with self._connect() as conn:
            cursor = conn.cursor()
            if chat_id:
                cursor.execute("""
                    SELECT id, original_name, stored_filename, file_type, file_extension, 
                           file_size, upload_timestamp, chat_id, md_filename, api_file_name, 
                           api_state, provider
                    FROM files WHERE chat_id = ? ORDER BY upload_timestamp DESC
                """, (chat_id,))
            else:
                cursor.execute("""
                    SELECT id, original_name, stored_filename, file_type, file_extension, 
                           file_size, upload_timestamp, chat_id, md_filename, api_file_name, 
                           api_state, provider
                    FROM files ORDER BY upload_timestamp DESC
                """)
            
            files = []
            for row in cursor.fetchall():
                files.append({
                    "id": row["id"],
                    "original_name": row["original_name"],
                    "stored_filename": row["stored_filename"],
                    "file_type": row["file_type"],
                    "file_extension": row["file_extension"],
                    "file_size": row["file_size"],
                    "upload_timestamp": row["upload_timestamp"],
                    "chat_id": row["chat_id"],
                    "md_filename": row["md_filename"],
                    "api_file_name": row["api_file_name"],
                    "api_state": row["api_state"],
                    "provider": row["provider"]
                })
            return files
    
    def delete_file_record(self, file_id: str) -> bool:
        """Delete file record from database"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM files WHERE id = ?", (file_id,))
                conn.commit()
                logger.info(f"Deleted file record: {file_id}")
                return cursor.rowcount > 0
        except Exception as e:
            logger.error(f"Error deleting file record: {str(e)}")
            return False
    
    def file_exists(self, file_id: str) -> bool:
        """Check if file record exists"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT 1 FROM files WHERE id = ? LIMIT 1", (file_id,))
            return cursor.fetchone() is not None
    
    def associate_file_with_chat(self, file_id: str, chat_id: str) -> bool:
        """Associate a file with a chat"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("UPDATE files SET chat_id = ? WHERE id = ?", (chat_id, file_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            logger.error(f"Error associating file with chat: {str(e)}")
            return False
    
    def update_file_api_info(self, file_id: str, api_file_name: Optional[str] = None, 
                            api_state: Optional[str] = None, provider: Optional[str] = None) -> bool:
        """Update API-related information for a file"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                
                updates = []
                params = []
                
                if api_file_name is not None:
                    updates.append("api_file_name = ?")
                    params.append(api_file_name)
                
                if api_state is not None:
                    updates.append("api_state = ?")
                    params.append(api_state)
                
                if provider is not None:
                    updates.append("provider = ?")
                    params.append(provider)
                
                if not updates:
                    return False
                
                params.append(file_id)
                query = f"UPDATE files SET {', '.join(updates)} WHERE id = ?"
                
                cursor.execute(query, params)
                conn.commit()
                
                if cursor.rowcount > 0 and api_state is not None:
                    try:
                        cursor.execute("SELECT temp_id FROM files WHERE id = ?", (file_id,))
                        result = cursor.fetchone()
                        temp_id = result['temp_id'] if result else None
                       
                        if not cancellation_manager.is_cancelled(file_id):
                            # Use dynamic import to avoid circular dependency
                            from route.chat_route import publish_file_state
                            publish_file_state(file_id, api_state, provider, temp_id)
                            logger.info(f"[SSE] File state update broadcast: {file_id} (temp:{temp_id}) -> {api_state}")
                        else:
                            logger.info(f"[SSE] Skipped broadcast for cancelled file: {file_id} (temp:{temp_id}) -> {api_state}")
                    except Exception as sse_error:
                        logger.error(f"Error broadcasting file state via SSE: {str(sse_error)}")
                
                return cursor.rowcount > 0
        except Exception as e:
            logger.error(f"Error updating file API info: {str(e)}")
            return False
    
    def update_file_md_info(self, file_id: str, md_filename: str) -> bool:
        """Update markdown filename for a file"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    UPDATE files SET md_filename = ?
                    WHERE id = ?
                """, (md_filename, file_id))
                conn.commit()
                return cursor.rowcount > 0
        except Exception as e:
            logger.error(f"Error updating file MD info: {str(e)}")
            return False


db = DatabaseManager()