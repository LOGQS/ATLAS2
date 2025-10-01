# status: complete

import sqlite3
import os
import json
import uuid
from typing import Dict, Any, Optional, List, Callable, Tuple
from utils.logger import get_logger
from utils.cancellation_manager import cancellation_manager
from utils.db_validation import DatabaseValidator
import time
from collections import defaultdict

logger = get_logger(__name__)

class DatabaseManager:
    """
    Global database manager for ATLAS application.

    This class provides a centralized interface for all database operations,
    managing SQLite connections, transactions, and CRUD operations for the
    application's core entities: chats, messages, files, and their relationships.
    """
    
    MAX_LINEAGE_DEPTH = 50
    MAX_DESCENDANT_DEPTH = 50
    MAX_SEARCH_ITERATIONS = 50

    VALID_TASK_STATES = {'PENDING', 'RUNNING', 'PAUSED', 'NEEDS_HUMAN', 'DONE', 'FAILED', 'CANCELED'}

    _validator = DatabaseValidator

    def _handle_db_error(self, operation: str, error: Exception, return_value=None, reraise: bool = False):
        """Centralized error handling for database operations"""
        logger.error(f"Error {operation}: {str(error)}")
        if reraise:
            raise
        return return_value
    
    def _execute_with_connection(self, operation: str, query_func, return_on_error=None, reraise: bool = False):
        """Execute database operation with standardized connection handling and error handling"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                return query_func(conn, cursor)
        except Exception as e:
            return self._handle_db_error(operation, e, return_on_error, reraise)
    
    def _ensure_json_text(self, payload: Any, context: str) -> str:
        """Convert payload to JSON string, logging errors if serialization fails."""
        if isinstance(payload, str):
            return payload
        try:
            return json.dumps(payload)
        except (TypeError, ValueError) as exc:
            logger.error(f"Error serializing JSON during {context}: {exc}")
            return json.dumps({})

    def _generate_ctx_id(self) -> str:
        """Generate a unique context snapshot identifier."""
        return f"ctx_{uuid.uuid4().hex}"

    def _normalize_context_row(self, row: sqlite3.Row) -> Optional[Dict[str, Any]]:
        """Convert an oplog row into an application-level dict."""
        if not row:
            return None
        return {
            'id': row['id'],
            'chat_id': row['chat_id'],
            'base_ctx_id': row['base_ctx_id'],
            'new_ctx_id': row['new_ctx_id'],
            'ops': self._safe_json_parse(row['op_json'], 'context snapshot load'),
            'ts': row['ts']
        }

    def _normalize_plan_row(self, row: sqlite3.Row) -> Optional[Dict[str, Any]]:
        """Convert a plans table row to dict form."""
        if not row:
            return None
        return {
            'id': row['id'],
            'chat_id': row['chat_id'],
            'base_ctx_id': row['base_ctx_id'],
            'ir': self._safe_json_parse(row['ir_json'], 'plan load'),
            'fingerprint': row['fingerprint'],
            'status': row['status'],
            'ts': row['ts']
        }

    def _normalize_task_row(self, row: sqlite3.Row) -> Optional[Dict[str, Any]]:
        """Convert a tasks row to dict form."""
        if not row:
            return None
        return {
            'plan_id': row['plan_id'],
            'task_id': row['id'],
            'state': row['state'],
            'definition': self._safe_json_parse(row['def_json'], 'task load'),
            'base_ctx_id': row['base_ctx_id'],
            'new_ctx_id': row['new_ctx_id'],
            'attempt': row['attempt'],
            'error': row['error'],
            'cost': row['cost'],
            'tokens': row['tokens'],
            'provider': row['provider'],
            'ts': row['ts']
        }

    def _normalize_tool_call_row(self, row: sqlite3.Row) -> Optional[Dict[str, Any]]:
        """Convert a tool_calls row to dict form."""
        if not row:
            return None
        return {
            'id': row['id'],
            'plan_id': row['plan_id'],
            'task_id': row['task_id'],
            'attempt': row['attempt'],
            'tool': row['tool'],
            'provider': row['provider'],
            'model': row['model'],
            'input_hash': row['input_hash'],
            'output_hash': row['output_hash'],
            'ops': self._safe_json_parse(row['ops_json'], 'tool call ops load'),
            'latency_ms': row['latency_ms'],
            'tokens': row['tokens'],
            'cost': row['cost'],
            'ts': row['ts']
        }

    def _safe_json_parse(self, json_string: str, context: str = "JSON parsing") -> Dict[str, Any]:
        """Safely parse JSON with error handling and logging"""
        try:
            return json.loads(json_string) if json_string else {}
        except (json.JSONDecodeError, TypeError) as e:
            logger.error(f"Error parsing JSON during {context}: {str(e)}")
            return {}
    
    def _execute_query_with_params(self, cursor, query: str, params: tuple = (), fetch_one: bool = True):
        """Execute query with parameters and return result with error handling"""
        cursor.execute(query, params)
        return cursor.fetchone() if fetch_one else cursor.fetchall()
    
    def _validate_id(self, id_value, id_name: str = "ID") -> bool:
        """Validate that an ID is a positive integer"""
        return self._validator.validate_id(id_value, id_name)

    def _validate_string(self, string_value, string_name: str = "string", max_length: int = None) -> bool:
        """Validate that a string is non-empty and within length limits"""
        return self._validator.validate_string(string_value, string_name, max_length)

    def _validate_table_column(self, table: str, column: str = None) -> bool:
        """Validate table and column names to prevent SQL injection"""
        return self._validator.validate_table_column(table, column)

    def _exists_in_table(self, table: str, id_column: str, id_value, connection=None) -> bool:
        """Check if a record exists in a table"""
        if not self._validate_table_column(table, id_column):
            return False

        def check_exists(conn, cursor):
            cursor.execute(f"SELECT 1 FROM {table} WHERE {id_column} = ?", (id_value,))
            return cursor.fetchone() is not None

        if connection:
            return check_exists(connection, connection.cursor())
        else:
            return self._execute_with_connection(f"checking existence in {table}", check_exists, False)
    
    def _transaction_wrapper(self, operation: str, transaction_func, *args, **kwargs):
        """Wrapper for database operations that need transaction handling with rollback support"""
        def execute_transaction(conn, cursor):
            try:
                conn.execute("BEGIN IMMEDIATE")
                result = transaction_func(conn, cursor, *args, **kwargs)
                conn.commit()
                return result
            except Exception as e:
                try:
                    conn.rollback()
                except:
                    pass
                raise e
        
        return self._execute_with_connection(operation, execute_transaction, reraise=True)

    def __init__(self, db_name: str = "atlas.db"):
        backend_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(os.path.dirname(backend_dir))
        self.data_dir = os.path.join(project_root, "data")
        self.db_path = os.path.join(self.data_dir, db_name)
        self._file_state_callback = None 
        self._ensure_data_directory()
        self._init_database()
    
    def _connect(self):
        """Create database connection with proper SQLite configuration"""
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA journal_size_limit=104857600")
        conn.execute("PRAGMA busy_timeout=3000")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA mmap_size=268435456")
        conn.row_factory = sqlite3.Row
        return conn
    
    def get_connection(self):
        """Public method to get database connection for other modules"""
        return self._connect()
    
    def _ensure_data_directory(self):
        """Ensure data directory exists"""
        os.makedirs(self.data_dir, exist_ok=True)
    
    def _init_database(self):
        """Initialize all database tables"""
        with self._connect() as conn:
            cursor = conn.cursor()
            
            # No meta/migration tables needed since we are currently in active development
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS chats (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    system_prompt TEXT,
                    state TEXT DEFAULT 'static' CHECK(state IN ('thinking', 'responding', 'static')),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    isversion INTEGER DEFAULT 0 CHECK(isversion IN (0,1)),
                    belongsto TEXT,
                    last_active TEXT
                )
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
                    content TEXT NOT NULL,
                    thoughts TEXT,
                    provider TEXT,
                    model TEXT,
                    router_enabled INTEGER DEFAULT 0 CHECK(router_enabled IN (0,1)),
                    router_decision TEXT,
                    plan_id TEXT,
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
                    api_state TEXT DEFAULT 'local' CHECK(api_state IN ('local', 'processing_md', 'uploading', 'uploaded', 'processing', 'ready', 'error', 'unavailable')),
                    provider TEXT,
                    temp_id TEXT,
                    token_count INTEGER,
                    token_count_provider TEXT,
                    token_count_model TEXT,
                    token_count_method TEXT,
                    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL
                )
            """)
            
            
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_files_chat ON files(chat_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_files_upload ON files(upload_timestamp)
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS message_files (
                    message_id TEXT NOT NULL,
                    file_id TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (message_id, file_id),
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
                    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
                )
            """)
            
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_message_files_message ON message_files(message_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_message_files_file ON message_files(file_id)
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS message_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    original_message_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    chat_version_id TEXT NOT NULL,
                    operation TEXT NOT NULL CHECK(operation IN ('original', 'edit', 'retry')),
                    content TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(original_message_id, chat_version_id),
                    FOREIGN KEY (original_message_id) REFERENCES messages(id) ON DELETE CASCADE,
                    FOREIGN KEY (chat_version_id) REFERENCES chats(id) ON DELETE CASCADE
                )
            """)
            
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_message_versions_original ON message_versions(original_message_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_message_versions_chat ON message_versions(chat_version_id)
            """)

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_chats_belongsto ON chats(belongsto)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_chats_isversion ON chats(isversion)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_files_provider_state ON files(provider, api_state)
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS message_lineage (
                    message_id TEXT PRIMARY KEY,
                    parent_message_id TEXT,
                    root_message_id TEXT NOT NULL,
                    role TEXT CHECK(role IN ('user','assistant')),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
                    FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE SET NULL,
                    FOREIGN KEY (root_message_id) REFERENCES messages(id) ON DELETE CASCADE
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_lineage_root ON message_lineage(root_message_id)
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS oplog (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL,
                    base_ctx_id TEXT NOT NULL,
                    new_ctx_id TEXT NOT NULL UNIQUE,
                    op_json TEXT NOT NULL,
                    ts DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_oplog_chat ON oplog(chat_id, id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_oplog_ctx ON oplog(new_ctx_id)
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS plans (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    base_ctx_id TEXT NOT NULL,
                    ir_json TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'DENIED')),
                    ts DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_plans_chat ON plans(chat_id, ts)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_plans_base_ctx ON plans(base_ctx_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(chat_id, status)
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT NOT NULL,
                    plan_id TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','PAUSED','NEEDS_HUMAN','DONE','FAILED','CANCELED')),
                    def_json TEXT NOT NULL,
                    base_ctx_id TEXT NOT NULL,
                    new_ctx_id TEXT,
                    attempt INTEGER NOT NULL,
                    error TEXT,
                    cost REAL DEFAULT 0,
                    tokens INTEGER DEFAULT 0,
                    provider TEXT,
                    ts DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    PRIMARY KEY (plan_id, id, attempt),
                    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_tasks_plan_state ON tasks(plan_id, state)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_tasks_new_ctx ON tasks(new_ctx_id)
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tool_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    plan_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    attempt INTEGER NOT NULL,
                    tool TEXT NOT NULL,
                    provider TEXT,
                    model TEXT,
                    input_hash TEXT NOT NULL,
                    output_hash TEXT,
                    ops_json TEXT,
                    latency_ms INTEGER NOT NULL,
                    tokens INTEGER DEFAULT 0,
                    cost REAL DEFAULT 0,
                    ts DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
                    FOREIGN KEY (plan_id, task_id, attempt) REFERENCES tasks(plan_id, id, attempt) ON DELETE CASCADE
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_tool_calls_plan ON tool_calls(plan_id, task_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_tool_calls_time ON tool_calls(ts)
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS blobs (
                    hash TEXT PRIMARY KEY,
                    bytes BLOB NOT NULL
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS token_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('router', 'planner', 'assistant', 'agent_tools')),
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    estimated_tokens INTEGER DEFAULT 0,
                    actual_tokens INTEGER DEFAULT 0,
                    message_id TEXT,
                    plan_id TEXT,
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
                )
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_token_usage_chat ON token_usage(chat_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_token_usage_role ON token_usage(role)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp)
            """)

            # No migration logic required fresh schema creation only during development

            conn.commit()


    def create_chat(self, chat_id: str, system_prompt: Optional[str] = None, name: Optional[str] = None,
                   isversion: bool = False, belongsto: Optional[str] = None, last_active: Optional[str] = None) -> bool:
        """
        Create a new chat session.

        Args:
            chat_id: Unique identifier for the chat
            system_prompt: Optional system prompt for the chat
            name: Optional display name for the chat
            isversion: Whether this is a version of another chat
            belongsto: Parent chat ID if this is a version
            last_active: Last active version for this chat

        Returns:
            bool: True if chat was created successfully, False otherwise
        """
        if not self._validate_string(chat_id, "chat_id"):
            return False

        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "INSERT INTO chats (id, name, system_prompt, isversion, belongsto, last_active) VALUES (?, ?, ?, ?, ?, ?)",
                    (chat_id, name, system_prompt, 1 if isversion else 0, belongsto, last_active)
                )
                conn.commit()
                logger.info(f"Created new chat: {chat_id}")
                return True
        except sqlite3.IntegrityError:
            logger.debug(f"Chat already exists: {chat_id}")
            return False
        except Exception as e:
            logger.error(f"Error creating chat: {str(e)}")
            return False

    def _generate_message_id(self, chat_id: str) -> str:
        """Generate position-based message ID in format: {chat_id}_{position}"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                
                cursor.execute("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?", (chat_id,))
                result = cursor.fetchone()
                position = (result['count'] if result else 0) + 1
                
                message_id = f"{chat_id}_{position}"
                logger.debug(f"Generated message ID: {message_id} (position: {position})")
                return message_id
                
        except Exception as e:
            logger.error(f"Error generating message ID for chat {chat_id}: {str(e)}")
            return f"{chat_id}_{int(time.time() * 1000)}"
    
    def save_message(self, chat_id: str, role: str, content: str,
                    thoughts: Optional[str] = None, provider: Optional[str] = None,
                    model: Optional[str] = None, attached_file_ids: Optional[List[str]] = None,
                    router_enabled: bool = False, router_decision: Optional[str] = None,
                    plan_id: Optional[str] = None) -> Optional[str]:
        """
        Save message to chat history with optional file attachments and router metadata.

        Args:
            chat_id: ID of the chat to add message to
            role: Message role (system/user/assistant/tool)
            content: Message content text
            thoughts: Optional thinking/reasoning text
            provider: Optional AI provider used
            model: Optional AI model used
            attached_file_ids: Optional list of file IDs to attach
            router_enabled: Whether router was enabled for this message
            router_decision: JSON string of router decision (route and available routes)
            plan_id: Optional plan ID associated with this message

        Returns:
            Optional[str]: Generated message ID if successful, None if failed
        """
        try:
            with self._connect() as conn:
                cursor = conn.cursor()

                message_id = self._generate_message_id(chat_id)

                cursor.execute("""
                    INSERT INTO messages (id, chat_id, role, content, thoughts, provider, model, router_enabled, router_decision, plan_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (message_id, chat_id, role, content, thoughts, provider, model,
                      1 if router_enabled else 0, router_decision, plan_id))
                
                if attached_file_ids:
                    for file_id in attached_file_ids:
                        cursor.execute("""
                            INSERT OR IGNORE INTO message_files (message_id, file_id)
                            VALUES (?, ?)
                        """, (message_id, file_id))
                    logger.debug(f"Linked {len(attached_file_ids)} files to message {message_id}")
                
                conn.commit()
                
                logger.debug(f"Saved new message {message_id} for chat {chat_id}: {role} - {content[:50]}...")
                return message_id
        except Exception as e:
            logger.error(f"Error saving message: {str(e)}")
            return None

    def get_chat_meta(self, chat_id: str) -> Optional[Dict[str, Any]]:
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT id, name, isversion, belongsto, created_at FROM chats WHERE id = ?", (chat_id,))
                row = cursor.fetchone()
                if not row:
                    return None
                return {
                    'id': row['id'],
                    'name': row['name'],
                    'isversion': bool(row['isversion']),
                    'belongsto': row['belongsto'],
                    'created_at': row['created_at']
                }
        except Exception as e:
            logger.error(f"Error getting chat meta for {chat_id}: {e}")
            return None

    def get_chat_system_prompt(self, chat_id: str) -> Optional[str]:
        """Get the system prompt for a chat."""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT system_prompt FROM chats WHERE id = ?", (chat_id,))
                row = cursor.fetchone()
                return row['system_prompt'] if row else None
        except Exception as e:
            logger.error(f"Error getting system prompt for {chat_id}: {e}")
            return None

    def record_lineage(self, message_id: str, role: str, parent_message_id: Optional[str] = None) -> bool:
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                root_id = message_id
                if parent_message_id:
                    cursor.execute("SELECT 1 FROM message_lineage WHERE message_id = ?", (parent_message_id,))
                    parent_exists = cursor.fetchone() is not None
                    if not parent_exists:
                        cursor.execute("SELECT role FROM messages WHERE id = ?", (parent_message_id,))
                        rrow = cursor.fetchone()
                        parent_role = rrow[0] if rrow else None
                        cursor.execute(
                            """
                            INSERT OR REPLACE INTO message_lineage(message_id, parent_message_id, root_message_id, role)
                            VALUES(?,?,?,?)
                            """,
                            (parent_message_id, None, parent_message_id, parent_role)
                        )
                    cursor.execute("SELECT root_message_id FROM message_lineage WHERE message_id = ?", (parent_message_id,))
                    row = cursor.fetchone()
                    if row and row[0]:
                        root_id = row[0]
                    else:
                        root_id = parent_message_id
                cursor.execute("""
                    INSERT OR REPLACE INTO message_lineage(message_id, parent_message_id, root_message_id, role)
                    VALUES(?,?,?,?)
                """, (message_id, parent_message_id, root_id, role))
                conn.commit()
                logger.info(f"[LINEAGE] Recorded lineage: msg={message_id}, parent={parent_message_id}, root={root_id}, role={role}")
                return True
        except Exception as e:
            logger.error(f"[LINEAGE] Failed to record lineage for {message_id}: {e}")
            return False

    def get_lineage_root(self, message_id: str) -> Optional[str]:
        """
        Find the root message in a lineage chain.

        Traverses the parent relationships upward to find the original
        message that started this conversation branch.

        Args:
            message_id: Message ID to find the root for

        Returns:
            Optional[str]: Root message ID if found, None if error
        """
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                current = message_id
                visited = set()
                for _ in range(self.MAX_SEARCH_ITERATIONS):
                    cursor.execute("SELECT parent_message_id, root_message_id FROM message_lineage WHERE message_id = ?", (current,))
                    row = cursor.fetchone()
                    if not row:
                        return current
                    parent = row[0]
                    root = row[1]
                    if parent is None:
                        return root or current
                    if current in visited:
                        return root or current
                    visited.add(current)
                    current = parent
        except Exception as e:
            logger.error(f"[LINEAGE] Failed to get lineage root for {message_id}: {e}")
            return None

    def get_lineage_versions(self, message_id: str) -> List[Dict[str, Any]]:
        """
        Get all versions in a message's lineage tree.

        Returns all messages that share the same root message, representing
        different versions or branches of the same conversation point.

        Args:
            message_id: Message ID to get lineage versions for

        Returns:
            List[Dict[str, Any]]: List of version information including
                message_id, chat_version_id, operation type, and timestamps
        """
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                root = self.get_lineage_root(message_id) or message_id
                cursor.execute("SELECT message_id, role, created_at FROM message_lineage WHERE root_message_id = ?", (root,))
                rows = cursor.fetchall()
                if not rows:
                    return []
                items = []
                for r in rows:
                    mid = r['message_id']
                    chat_id = mid.rsplit('_', 1)[0] if '_' in mid else None
                    op = 'original'
                    try:
                        if chat_id:
                            cursor.execute("SELECT name, isversion FROM chats WHERE id = ?", (chat_id,))
                            crow = cursor.fetchone()
                            nm = (crow['name'] if crow and 'name' in crow.keys() else '') or ''
                            isv = bool(crow['isversion']) if crow and 'isversion' in crow.keys() else False
                            nml = nm.lower()
                            if isv:
                                if nml.startswith('edit_'):
                                    op = 'edit'
                                elif nml.startswith('retry_'):
                                    op = 'retry'
                                else:
                                    op = 'retry'
                            else:
                                op = 'original'
                    except Exception:
                        op = 'original'
                    items.append({
                        'message_id': mid,
                        'chat_version_id': chat_id,
                        'operation': op,
                        'created_at': r['created_at']
                    })
                items.sort(key=lambda x: (x['created_at'] or ''))
                for idx, it in enumerate(items, start=1):
                    it['version_number'] = idx
                return items
        except Exception as e:
            logger.error(f"[LINEAGE] Failed to get lineage versions for {message_id}: {e}")
            return []
    
    def update_message(self, message_id: str, content: str, thoughts: Optional[str] = None, plan_id: Optional[str] = None) -> bool:
        """Update existing message content, thoughts, and plan_id"""
        if not self._validate_string(message_id, "message_id"):
            return False

        def update_operation(conn, cursor):
            if plan_id is not None:
                cursor.execute("""
                    UPDATE messages
                    SET content = ?, thoughts = ?, plan_id = ?, timestamp = CURRENT_TIMESTAMP
                    WHERE id = ?
                """, (content, thoughts, plan_id, message_id))
            else:
                cursor.execute("""
                    UPDATE messages
                    SET content = ?, thoughts = ?, timestamp = CURRENT_TIMESTAMP
                    WHERE id = ?
                """, (content, thoughts, message_id))
            conn.commit()
            return cursor.rowcount > 0

        return self._execute_with_connection("updating message", update_operation, False)

    def update_message_plan_id(self, message_id: str, plan_id: str) -> bool:
        """Update only the plan_id field of a message"""
        if not self._validate_string(message_id, "message_id"):
            return False

        def update_operation(conn, cursor):
            cursor.execute("""
                UPDATE messages
                SET plan_id = ?
                WHERE id = ?
            """, (plan_id, message_id))
            conn.commit()
            return cursor.rowcount > 0

        return self._execute_with_connection("updating message plan_id", update_operation, False)

    def update_message_router_metadata(self, message_id: str, router_enabled: bool, router_decision: Optional[str]) -> bool:
        """Update router metadata fields of a message"""
        if not self._validate_string(message_id, "message_id"):
            return False

        def update_operation(conn, cursor):
            cursor.execute("""
                UPDATE messages
                SET router_enabled = ?, router_decision = ?
                WHERE id = ?
            """, (1 if router_enabled else 0, router_decision, message_id))
            conn.commit()
            return cursor.rowcount > 0

        return self._execute_with_connection("updating message router metadata", update_operation, False)

    def get_message(self, message_id: str) -> Optional[Dict[str, Any]]:
        """Get a single message by ID"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT id, chat_id, role, content, thoughts, provider, model, plan_id, timestamp
                    FROM messages
                    WHERE id = ?
                """, (message_id,))

                row = cursor.fetchone()
                if row:
                    return {
                        "id": row["id"],
                        "chat_id": row["chat_id"],
                        "role": row["role"],
                        "content": row["content"],
                        "thoughts": row["thoughts"],
                        "provider": row["provider"],
                        "model": row["model"],
                        "plan_id": row["plan_id"],
                        "timestamp": row["timestamp"]
                    }
                return None
        except Exception as e:
            logger.error(f"Error getting message {message_id}: {str(e)}")
            return None

    def get_chat_history(self, chat_id: str) -> List[Dict[str, Any]]:
        """Get chat history for a specific chat including attached files - Optimized to avoid N+1 queries"""
        with self._connect() as conn:
            cursor = conn.cursor()

            cursor.execute("""
                SELECT
                    m.id as message_id, m.role, m.content, m.thoughts,
                    m.provider as message_provider, m.model, m.timestamp,
                    m.router_enabled, m.router_decision, m.plan_id,
                    f.id as file_id, f.original_name, f.file_size, f.file_type,
                    f.api_state, f.provider as file_provider, f.api_file_name,
                    mf.created_at as file_attached_at
                FROM messages m
                LEFT JOIN message_files mf ON m.id = mf.message_id
                LEFT JOIN files f ON mf.file_id = f.id
                WHERE m.chat_id = ?
                ORDER BY m.id ASC, mf.created_at ASC
            """, (chat_id,))

            messages_map = defaultdict(lambda: {
                "id": None,
                "role": None,
                "content": None,
                "thoughts": None,
                "provider": None,
                "model": None,
                "timestamp": None,
                "routerEnabled": False,
                "routerDecision": None,
                "planId": None,
                "attachedFiles": []
            })

            for row in cursor.fetchall():
                message_id = row["message_id"]

                if messages_map[message_id]["id"] is None:
                    messages_map[message_id].update({
                        "id": message_id,
                        "role": row["role"],
                        "content": row["content"],
                        "thoughts": row["thoughts"],
                        "provider": row["message_provider"],
                        "model": row["model"],
                        "timestamp": row["timestamp"],
                        "routerEnabled": bool(row["router_enabled"]),
                        "routerDecision": self._safe_json_parse(row["router_decision"]) if row["router_decision"] else None,
                        "planId": row["plan_id"]
                    })

                if row["file_id"]:
                    messages_map[message_id]["attachedFiles"].append({
                        "id": row["file_id"],
                        "name": row["original_name"],
                        "size": row["file_size"],
                        "type": row["file_type"],
                        "api_state": row["api_state"],
                        "provider": row["file_provider"],
                        "api_file_name": row["api_file_name"]
                    })

            messages = []
            for message_id in sorted(messages_map.keys()):
                message = dict(messages_map[message_id])
                if not message["attachedFiles"]:
                    del message["attachedFiles"]
                messages.append(message)

            return messages
    
    def get_all_chats(self) -> List[Dict[str, Any]]:
        """Get all chat sessions"""
        with self._connect() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, name, system_prompt, state, created_at, isversion, belongsto, last_active
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
                    "created_at": row["created_at"],
                    "isversion": bool(row["isversion"]),
                    "belongsto": row["belongsto"],
                    "last_active": row["last_active"]
                })
            return chats
    
    def delete_chat(self, chat_id: str) -> bool:
        """Delete main chat and all its descendant versions"""
        if not self._validate_string(chat_id, "chat_id"):
            return False
            
        def delete_operation(conn, cursor):
            descendants = self.find_all_descendants(chat_id)
            all_chats_to_delete = descendants + [chat_id]
            
            logger.info(f"[CASCADE_DELETE] Deleting main chat {chat_id} and {len(descendants)} descendants: {all_chats_to_delete}")
            
            for target_chat_id in all_chats_to_delete:
                cursor.execute("DELETE FROM chats WHERE id = ?", (target_chat_id,))
                if cursor.rowcount > 0:
                    logger.info(f"[CASCADE_DELETE] Deleted: {target_chat_id}")
            
            conn.commit()
            return True
            
        return self._execute_with_connection("deleting chat", delete_operation, False)
    
    
    def chat_exists(self, chat_id: str) -> bool:
        """Check if chat exists - REFACTORED to use utility functions"""
        return self._exists_in_table("chats", "id", chat_id)
    
    def find_main_chat(self, chat_id: str) -> Optional[str]:
        """
        Follow belongsto chain to find the main chat (isversion: false).

        This method traverses the chat hierarchy upward through the belongsto
        relationships until it finds a chat where isversion=false (the main chat).
        Includes circular reference detection and depth limiting.

        Args:
            chat_id: Starting chat ID to trace back from

        Returns:
            Optional[str]: Main chat ID if found, None if error or not found
        """
        if not chat_id or chat_id == 'none':
            return chat_id
            
        logger.debug(f"[FIND_MAIN_CHAT] Starting search for main chat from: {chat_id}")
        
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                
                current_chat_id = chat_id
                visited_chats = set()
                depth = 0

                while current_chat_id and depth < self.MAX_LINEAGE_DEPTH:
                    if current_chat_id in visited_chats:
                        logger.error(f"[FIND_MAIN_CHAT] Circular reference detected in belongsto chain starting from {chat_id}")
                        return None
                    
                    visited_chats.add(current_chat_id)
                    
                    cursor.execute("""
                        SELECT isversion, belongsto
                        FROM chats
                        WHERE id = ?
                    """, (current_chat_id,))
                    
                    result = cursor.fetchone()
                    if not result:
                        logger.error(f"[FIND_MAIN_CHAT] Chat {current_chat_id} not found while following belongsto chain")
                        return None
                    
                    is_version = bool(result["isversion"])
                    belongs_to = result["belongsto"]
                    
                    logger.debug(f"[FIND_MAIN_CHAT] Depth {depth}: Chat {current_chat_id} -> isversion: {is_version}, belongsto: {belongs_to}")
                    
                    if not is_version:
                        logger.info(f"[FIND_MAIN_CHAT] Found main chat: {current_chat_id} (started from {chat_id})")
                        return current_chat_id
                    
                    if not belongs_to:
                        logger.warning(f"[FIND_MAIN_CHAT] Version chat {current_chat_id} has no belongsto value")
                        return None
                    
                    current_chat_id = belongs_to
                    depth += 1
                
                if depth >= self.MAX_LINEAGE_DEPTH:
                    logger.error(f"[FIND_MAIN_CHAT] Exceeded max depth while following belongsto chain from {chat_id}")
                
                return None
                
        except Exception as e:
            logger.error(f"Error following belongsto chain from {chat_id}: {str(e)}")
            return None
    
    def find_all_descendants(self, chat_id: str) -> List[str]:
        """
        Find all descendant versions of a chat recursively.

        This method traverses the chat hierarchy downward to find all chats
        that have this chat as an ancestor through belongsto relationships.
        Includes circular reference detection and depth limiting.

        Args:
            chat_id: Parent chat ID to find descendants for

        Returns:
            List[str]: List of descendant chat IDs
        """
        if not chat_id or chat_id == 'none':
            return []
            
        logger.debug(f"[FIND_DESCENDANTS] Starting search for all descendants of: {chat_id}")
        
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                
                descendants = []
                visited_chats = set()

                def find_children(parent_id: str, depth: int = 0):
                    if depth >= self.MAX_DESCENDANT_DEPTH or parent_id in visited_chats:
                        return
                    
                    visited_chats.add(parent_id)
                    
                    cursor.execute("""
                        SELECT id FROM chats 
                        WHERE belongsto = ? AND isversion = 1
                    """, (parent_id,))
                    
                    children = cursor.fetchall()
                    for child in children:
                        child_id = child["id"]
                        descendants.append(child_id)
                        logger.debug(f"[FIND_DESCENDANTS] Depth {depth}: Found child {child_id} of {parent_id}")
                        
                        find_children(child_id, depth + 1)
                
                find_children(chat_id)
                
                logger.info(f"[FIND_DESCENDANTS] Found {len(descendants)} descendants of {chat_id}: {descendants}")
                return descendants
                
        except Exception as e:
            logger.error(f"Error finding descendants of {chat_id}: {str(e)}")
            return []

    def save_user_setting(self, key: str, value: str) -> bool:
        """Save user setting"""
        if not self._validate_string(key, "setting key") or not self._validate_string(value, "setting value", self._validator.SETTING_VALUE_MAX_LENGTH):
            return False
            
        def save_operation(conn, cursor):
            cursor.execute("""
                INSERT OR REPLACE INTO user_settings (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
            """, (key, value))
            conn.commit()
            return True
            
        return self._execute_with_connection("saving user setting", save_operation, False)
    
    def get_user_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Get user setting"""
        if not self._validate_string(key, "setting key"):
            return default
            
        def get_operation(conn, cursor):
            result = self._execute_query_with_params(cursor, 
                "SELECT value FROM user_settings WHERE key = ?", (key,))
            return result["value"] if result else default
            
        return self._execute_with_connection("getting user setting", get_operation, default)
    
    def update_chat_name(self, chat_id: str, name: str) -> bool:
        """Update chat name"""
        if not self._validate_string(chat_id, "chat_id"):
            return False

        def update_operation(conn, cursor):
            cursor.execute("UPDATE chats SET name = ? WHERE id = ?", (name, chat_id))
            conn.commit()
            return cursor.rowcount > 0

        return self._execute_with_connection("updating chat name", update_operation, False)
    
    def update_chat_state(self, chat_id: str, state: str) -> bool:
        """Update chat state (thinking/responding/static)"""
        if not self._validate_string(chat_id, "chat_id") or not self._validator.validate_chat_state(state):
            return False

        def update_operation(conn, cursor):
            cursor.execute("UPDATE chats SET state = ? WHERE id = ?", (state, chat_id))
            conn.commit()
            updated = cursor.rowcount > 0
            if updated:
                logger.debug(f"Updated chat {chat_id} state to '{state}'")
            else:
                logger.warning(f"Failed to update chat {chat_id} state to '{state}' - chat may not exist")
            return updated

        return self._execute_with_connection("updating chat state", update_operation, False)
    
    def update_chat_last_active(self, chat_id: str, last_active_chat_id: str) -> bool:
        """Update last_active field for a chat (used for version memory)"""
        if not self._validate_string(chat_id, "chat_id"):
            return False

        def update_operation(conn, cursor):
            cursor.execute("UPDATE chats SET last_active = ? WHERE id = ?", (last_active_chat_id, chat_id))
            conn.commit()
            updated = cursor.rowcount > 0
            if updated:
                logger.debug(f"Updated chat {chat_id} last_active to '{last_active_chat_id}'")
            else:
                logger.warning(f"Failed to update chat {chat_id} last_active - chat may not exist")
            return updated

        return self._execute_with_connection("updating chat last_active", update_operation, False)

    def set_all_chats_static(self) -> int:
        """Set all non-static chats to static state. Returns number of chats updated."""
        def update_operation(conn, cursor):
            cursor.execute("""
                UPDATE chats
                SET state = 'static'
                WHERE state IN ('thinking', 'responding')
            """)
            conn.commit()
            updated_count = cursor.rowcount
            if updated_count > 0:
                logger.info(f"Set {updated_count} active chat(s) to static state during shutdown")
            else:
                logger.debug("No active chats to set to static during shutdown")
            return updated_count

        return self._execute_with_connection("setting all chats to static", update_operation, 0)

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
    
    def _get_file_base_query(self) -> str:
        """Common file query to reduce duplication"""
        return """
            SELECT id, original_name, stored_filename, file_type, file_extension,
                   file_size, upload_timestamp, chat_id, md_filename, api_file_name,
                   api_state, provider
            FROM files
        """

    def _build_file_dict(self, row) -> Dict[str, Any]:
        """Build file dictionary from database row to reduce duplication"""
        if not row:
            return None
        return {
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
            "provider": row["provider"],
            "token_count": row.get("token_count"),
            "token_count_provider": row.get("token_count_provider"),
            "token_count_model": row.get("token_count_model"),
            "token_count_method": row.get("token_count_method")
        }

    def get_file_record(self, file_id: str) -> Optional[Dict[str, Any]]:
        """Get file record by ID"""
        with self._connect() as conn:
            cursor = conn.cursor()
            query = self._get_file_base_query() + " WHERE id = ?"
            cursor.execute(query, (file_id,))
            result = cursor.fetchone()
            return self._build_file_dict(result)
    
    def get_all_files(self, chat_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get all file records, optionally filtered by chat_id"""
        with self._connect() as conn:
            cursor = conn.cursor()
            query = self._get_file_base_query()

            if chat_id:
                query += " WHERE chat_id = ? ORDER BY upload_timestamp DESC"
                cursor.execute(query, (chat_id,))
            else:
                query += " ORDER BY upload_timestamp DESC"
                cursor.execute(query)

            files = []
            for row in cursor.fetchall():
                file_dict = self._build_file_dict(row)
                if file_dict:
                    files.append(file_dict)
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
        if not self._validate_string(file_id, "file_id") or not self._validate_string(chat_id, "chat_id"):
            return False

        def associate_operation(conn, cursor):
            cursor.execute("UPDATE files SET chat_id = ? WHERE id = ?", (chat_id, file_id))
            conn.commit()
            return cursor.rowcount > 0

        return self._execute_with_connection("associating file with chat", associate_operation, False)
    
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
                rows_affected = cursor.rowcount
                conn.commit()

                if rows_affected > 0 and api_state is not None:
                    try:
                        cursor.execute("SELECT temp_id FROM files WHERE id = ?", (file_id,))
                        result = cursor.fetchone()
                        temp_id = result['temp_id'] if result else None

                        if not cancellation_manager.is_cancelled(file_id):
                            if hasattr(self, '_file_state_callback') and self._file_state_callback:
                                try:
                                    self._file_state_callback(file_id, api_state, provider, temp_id)
                                    logger.info(f"[SSE] File state update signaled: {file_id} (temp:{temp_id}) -> {api_state}")
                                except Exception as callback_error:
                                    logger.error(f"Error in file state callback: {str(callback_error)}")
                            else:
                                logger.debug(f"No file state callback registered for {file_id}")
                        else:
                            logger.info(f"[SSE] Skipped signal for cancelled file: {file_id} (temp:{temp_id}) -> {api_state}")
                    except Exception as sse_error:
                        logger.error(f"Error broadcasting file state via SSE: {str(sse_error)}")

                return rows_affected > 0
        except Exception as e:
            logger.error(f"Error updating file API info: {str(e)}")
            return False
    
    def update_file_md_info(self, file_id: str, md_filename: str) -> bool:
        """Update markdown filename for a file"""
        if not self._validate_string(file_id, "file_id"):
            return False

        def update_operation(conn, cursor):
            cursor.execute("""
                UPDATE files SET md_filename = ?
                WHERE id = ?
            """, (md_filename, file_id))
            conn.commit()
            return cursor.rowcount > 0

        return self._execute_with_connection("updating file MD info", update_operation, False)

    def update_file_token_count(
        self,
        file_id: str,
        token_count: int,
        provider: str,
        model: str,
        method: str
    ) -> bool:
        """
        Update cached token count for a file.

        Args:
            file_id: File identifier
            token_count: Token count for the file
            provider: Provider used for counting
            model: Model used for counting
            method: Method used (native/tiktoken/fallback)

        Returns:
            bool: True if updated successfully
        """
        if not self._validate_string(file_id, "file_id"):
            return False

        def update_operation(conn, cursor):
            cursor.execute("""
                UPDATE files
                SET token_count = ?,
                    token_count_provider = ?,
                    token_count_model = ?,
                    token_count_method = ?
                WHERE id = ?
            """, (token_count, provider, model, method, file_id))
            conn.commit()
            return cursor.rowcount > 0

        return self._execute_with_connection("updating file token count", update_operation, False)

    def get_file_token_count(
        self,
        file_id: str,
        provider: str,
        model: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get cached token count for a file if it matches the provider and model.

        Args:
            file_id: File identifier
            provider: Provider to match
            model: Model to match

        Returns:
            Dict with token_count and method if cache is valid, None otherwise
        """
        if not self._validate_string(file_id, "file_id"):
            return None

        def query(conn, cursor):
            cursor.execute("""
                SELECT token_count, token_count_provider, token_count_model, token_count_method
                FROM files
                WHERE id = ?
            """, (file_id,))
            row = cursor.fetchone()

            if not row or not row["token_count"]:
                return None

            cached_provider = row["token_count_provider"]
            cached_model = row["token_count_model"]

            if cached_provider == provider and cached_model == model:
                return {
                    "token_count": row["token_count"],
                    "method": row["token_count_method"]
                }

            return None

        return self._execute_with_connection("getting file token count", query, None)

    def link_files_to_message(self, message_id: str, file_ids: List[str]) -> bool:
        """Link multiple files to a message"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                for file_id in file_ids:
                    cursor.execute("""
                        INSERT OR IGNORE INTO message_files (message_id, file_id)
                        VALUES (?, ?)
                    """, (message_id, file_id))
                conn.commit()
                logger.debug(f"Linked {len(file_ids)} files to message {message_id}")
                return True
        except Exception as e:
            logger.error(f"Error linking files to message: {str(e)}")
            return False

    def unlink_file_from_message(self, message_id: str, file_id: str) -> bool:
        """Unlink a single file from a specific message without deleting the file"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "DELETE FROM message_files WHERE message_id = ? AND file_id = ?",
                    (message_id, file_id)
                )
                conn.commit()
                success = cursor.rowcount > 0
                if success:
                    logger.info(f"Unlinked file {file_id} from message {message_id}")
                else:
                    logger.warning(f"No link found to unlink for file {file_id} and message {message_id}")
                return success
        except Exception as e:
            logger.error(f"Error unlinking file from message: {str(e)}")
            return False
    
    def get_message_files(self, message_id: str) -> List[Dict[str, Any]]:
        """Get all files attached to a specific message"""
        def get_files_operation(conn, cursor):
            cursor.execute("""
                SELECT f.id, f.original_name, f.file_size, f.file_type, f.api_state, f.provider, f.api_file_name
                FROM message_files mf
                JOIN files f ON mf.file_id = f.id
                WHERE mf.message_id = ?
                ORDER BY mf.created_at ASC
            """, (message_id,))

            files = []
            for row in cursor.fetchall():
                files.append({
                    "id": row["id"],
                    "name": row["original_name"],
                    "size": row["file_size"],
                    "type": row["file_type"],
                    "api_state": row["api_state"],
                    "provider": row["provider"],
                    "api_file_name": row["api_file_name"]
                })
            return files

        return self._execute_with_connection("getting message files", get_files_operation, [])
    
    def get_chat_file_attachments_for_provider(self, chat_id: str, provider: str) -> List[Dict[str, Any]]:
        """Get list of file attachments that are ready to be included in requests for this chat and provider"""
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT DISTINCT f.id, f.provider, f.api_file_name, f.api_state
                    FROM files f
                    JOIN message_files mf ON f.id = mf.file_id
                    JOIN messages m ON mf.message_id = m.id
                    WHERE m.chat_id = ?
                    AND f.provider = ? 
                    AND f.api_file_name IS NOT NULL
                    AND f.api_state IN ('uploaded', 'processing', 'ready')
                """, (chat_id, provider))
                
                files = []
                for row in cursor.fetchall():
                    files.append({
                        'id': row['id'],
                        'provider': row['provider'],
                        'api_file_name': row['api_file_name'],
                        'api_state': row['api_state']
                    })
                
                logger.debug(f"Found {len(files)} file attachments for chat {chat_id} and provider {provider}")
                return files
                
        except Exception as e:
            logger.error(f"Error getting file attachments for chat {chat_id} and provider {provider}: {str(e)}")
            return []

    def verify_files_availability(self, chat_id: str) -> Dict[str, Any]:
        """
        Verify which files are still available in the API and update their states.

        This method checks all files associated with a chat against the API
        provider to ensure they are still accessible, updating their states
        to 'unavailable' if they have been deleted from the provider.

        Args:
            chat_id: ID of the chat to verify files for

        Returns:
            Dict[str, Any]: Verification results including counts of available
                and unavailable files
        """
        try:
            from utils.config import get_provider_map
            
            providers = get_provider_map()
            gemini_provider = providers.get('gemini')
            
            if not gemini_provider or not gemini_provider.is_available():
                logger.warning("Gemini provider not available for file verification")
                return {
                    'success': False,
                    'error': 'Gemini provider not available',
                    'verified_count': 0,
                    'unavailable_count': 0
                }
            
            chat_files = self.get_all_files(chat_id=chat_id)
            api_files = [f for f in chat_files if f.get('api_file_name') and f.get('provider') == 'gemini']
            
            if not api_files:
                return {
                    'success': True,
                    'verified_count': 0,
                    'unavailable_count': 0,
                    'message': 'No API files to verify'
                }
            
            list_result = gemini_provider.list_files()
            if not list_result['success']:
                logger.error(f"Failed to list files from Gemini: {list_result.get('error')}")
                return {
                    'success': False,
                    'error': f"Failed to list files from API: {list_result.get('error')}",
                    'verified_count': 0,
                    'unavailable_count': 0
                }
            
            available_api_file_names = set(f['api_file_name'] for f in list_result['files'])
            verified_count = 0
            unavailable_count = 0
            
            with self._connect() as conn:
                cursor = conn.cursor()
                
                for file_record in api_files:
                    file_id = file_record['id']
                    api_file_name = file_record['api_file_name']
                    current_state = file_record.get('api_state', 'unknown')
                    
                    if api_file_name in available_api_file_names:
                        if current_state in ['error', 'unavailable']:
                            cursor.execute("""
                                UPDATE files SET api_state = 'ready' WHERE id = ?
                            """, (file_id,))
                            logger.info(f"File {file_id} ({api_file_name}) is now available again")
                        verified_count += 1
                    else:
                        if current_state != 'unavailable':
                            cursor.execute("""
                                UPDATE files SET api_state = 'unavailable' WHERE id = ?
                            """, (file_id,))
                            logger.info(f"File {file_id} ({api_file_name}) is no longer available in API")
                        unavailable_count += 1
                
                conn.commit()
            
            logger.info(f"File verification for chat {chat_id}: {verified_count} available, {unavailable_count} unavailable")
            return {
                'success': True,
                'verified_count': verified_count,
                'unavailable_count': unavailable_count,
                'total_checked': len(api_files)
            }
            
        except Exception as e:
            logger.error(f"Error verifying files availability: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'verified_count': 0,
                'unavailable_count': 0
            }


    def cascade_delete_message(self, message_id: str, chat_id: str) -> int:
        """
        Delete a message and all messages after it in the conversation.

        This performs a cascade delete of the specified message and all
        subsequent messages in the chat, maintaining referential integrity.

        Args:
            message_id: ID of the message to start deletion from
            chat_id: ID of the chat containing the message

        Returns:
            int: Number of messages deleted
        """
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                
                cursor.execute("""
                    SELECT id FROM messages 
                    WHERE chat_id = ?
                    ORDER BY id ASC
                """, (chat_id,))
                
                all_message_ids = [row["id"] for row in cursor.fetchall()]
                
                if message_id not in all_message_ids:
                    logger.warning(f"Message {message_id} not found in chat {chat_id}")
                    return 0
                
                message_index = all_message_ids.index(message_id)
                messages_to_delete = all_message_ids[message_index:]
                
                if not messages_to_delete:
                    return 0
                
                ids_str = ','.join('?' * len(messages_to_delete))
                
                cursor.execute(f"""
                    DELETE FROM message_files 
                    WHERE message_id IN ({ids_str})
                """, messages_to_delete)
                
                cursor.execute(f"""
                    DELETE FROM messages 
                    WHERE id IN ({ids_str})
                """, messages_to_delete)
                
                deleted_count = cursor.rowcount
                conn.commit()
                
                logger.info(f"Cascade deleted {deleted_count} messages starting from {message_id}")
                return deleted_count
                
        except Exception as e:
            logger.error(f"Error cascade deleting messages: {str(e)}")
            return 0

    def cascade_delete_message_after(self, message_id: str, chat_id: str) -> int:
        """
        Delete all messages after a specific message (not including the message itself).

        This is useful for retrying from a specific point in the conversation
        while preserving the current message.

        Args:
            message_id: ID of the message to keep (delete everything after)
            chat_id: ID of the chat containing the message

        Returns:
            int: Number of messages deleted
        """
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                
                cursor.execute("""
                    SELECT id FROM messages 
                    WHERE chat_id = ?
                    ORDER BY id ASC
                """, (chat_id,))
                
                all_message_ids = [row["id"] for row in cursor.fetchall()]
                
                if message_id not in all_message_ids:
                    logger.warning(f"Message {message_id} not found in chat {chat_id}")
                    return 0
                
                message_index = all_message_ids.index(message_id)
                messages_to_delete = all_message_ids[message_index + 1:]
                
                if not messages_to_delete:
                    return 0
                
                ids_str = ','.join('?' * len(messages_to_delete))
                
                cursor.execute(f"""
                    DELETE FROM message_files 
                    WHERE message_id IN ({ids_str})
                """, messages_to_delete)
                
                cursor.execute(f"""
                    DELETE FROM messages 
                    WHERE id IN ({ids_str})
                """, messages_to_delete)
                
                deleted_count = cursor.rowcount
                conn.commit()
                
                logger.info(f"Cascade deleted {deleted_count} messages after {message_id}")
                return deleted_count
                
        except Exception as e:
            logger.error(f"Error cascade deleting messages after {message_id}: {str(e)}")
            return 0

    # === Agentic context and planning operations ===

    def create_context_snapshot(self, chat_id: str, base_ctx_id: str, ops: Any, new_ctx_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Append a new snapshot to the context oplog for a chat."""
        if not self._validate_string(chat_id, "chat_id"):
            return None
        if not isinstance(base_ctx_id, str) or not base_ctx_id.strip():
            logger.warning("Invalid base_ctx_id provided for context snapshot")
            return None

        def transaction(conn, cursor):
            ctx_id = new_ctx_id or self._generate_ctx_id()
            payload = self._ensure_json_text(ops, "context snapshot serialization")
            try:
                cursor.execute(
                    "INSERT INTO oplog (chat_id, base_ctx_id, new_ctx_id, op_json) VALUES (?, ?, ?, ?)",
                    (chat_id, base_ctx_id, ctx_id, payload)
                )
            except sqlite3.IntegrityError as exc:
                logger.error(f"Failed to insert context snapshot for {chat_id}: {exc}")
                raise

            cursor.execute("SELECT id, chat_id, base_ctx_id, new_ctx_id, op_json, ts FROM oplog WHERE new_ctx_id = ?", (ctx_id,))
            row = cursor.fetchone()
            return self._normalize_context_row(row)

        return self._transaction_wrapper("creating context snapshot", transaction)

    def get_context_snapshot(self, chat_id: str, ctx_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a specific context snapshot by chat and context id."""
        if not self._validate_string(chat_id, "chat_id") or not isinstance(ctx_id, str):
            return None

        def query(conn, cursor):
            cursor.execute("SELECT id, chat_id, base_ctx_id, new_ctx_id, op_json, ts FROM oplog WHERE chat_id = ? AND new_ctx_id = ?", (chat_id, ctx_id))
            row = cursor.fetchone()
            return self._normalize_context_row(row)

        return self._execute_with_connection("fetching context snapshot", query)

    def get_context_snapshot_by_id(self, ctx_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a context snapshot using only the context identifier."""
        if not isinstance(ctx_id, str):
            return None

        def query(conn, cursor):
            cursor.execute("SELECT id, chat_id, base_ctx_id, new_ctx_id, op_json, ts FROM oplog WHERE new_ctx_id = ?", (ctx_id,))
            row = cursor.fetchone()
            return self._normalize_context_row(row)

        return self._execute_with_connection("fetching context snapshot by id", query)

    def list_context_snapshots(self, chat_id: str, limit: int = 50, before_id: Optional[int] = None) -> List[Dict[str, Any]]:
        """List context snapshots for a chat ordered from oldest to newest."""
        if not self._validate_string(chat_id, "chat_id"):
            return []

        limit = max(1, min(limit, 500))

        def query(conn, cursor):
            if before_id is not None:
                cursor.execute(
                    "SELECT id, chat_id, base_ctx_id, new_ctx_id, op_json, ts FROM oplog WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                    (chat_id, before_id, limit)
                )
            else:
                cursor.execute(
                    "SELECT id, chat_id, base_ctx_id, new_ctx_id, op_json, ts FROM oplog WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
                    (chat_id, limit)
                )
            rows = cursor.fetchall()
            snapshots = [self._normalize_context_row(row) for row in rows if row]
            snapshots = [snap for snap in snapshots if snap]
            snapshots.reverse()
            return snapshots

        return self._execute_with_connection("listing context snapshots", query, return_on_error=[]) or []

    def get_latest_context_id(self, chat_id: str) -> Optional[str]:
        """Return the most recent context identifier for a chat."""
        if not self._validate_string(chat_id, "chat_id"):
            return None

        def query(conn, cursor):
            cursor.execute("SELECT new_ctx_id FROM oplog WHERE chat_id = ? ORDER BY id DESC LIMIT 1", (chat_id,))
            row = cursor.fetchone()
            return row[0] if row else None

        return self._execute_with_connection("fetching latest context id", query)

    def ensure_context_root(self, chat_id: str) -> str:
        """Ensure a chat has at least one context snapshot and return the base ctx id."""
        if not self._validate_string(chat_id, "chat_id"):
            raise ValueError("Invalid chat_id for ensure_context_root")

        def transaction(conn, cursor):
            cursor.execute("SELECT new_ctx_id FROM oplog WHERE chat_id = ? ORDER BY id ASC LIMIT 1", (chat_id,))
            row = cursor.fetchone()
            if row:
                return row[0]

            root_ctx_id = self._generate_ctx_id()
            cursor.execute(
                "INSERT INTO oplog (chat_id, base_ctx_id, new_ctx_id, op_json) VALUES (?, ?, ?, ?)",
                (chat_id, 'root', root_ctx_id, json.dumps({'ops': []}))
            )
            return root_ctx_id

        return self._transaction_wrapper("ensuring context root", transaction)

    def create_plan_record(self, plan_id: str, chat_id: str, base_ctx_id: str, ir_data: Any, fingerprint: str) -> Optional[Dict[str, Any]]:
        """Insert or update a plan record."""
        if not self._validate_string(plan_id, "plan_id") or not self._validate_string(chat_id, "chat_id"):
            return None
        if not isinstance(base_ctx_id, str) or not base_ctx_id.strip():
            logger.warning("Invalid base_ctx_id provided for plan")
            return None
        if not isinstance(fingerprint, str) or not fingerprint.strip():
            logger.warning("Invalid fingerprint provided for plan")
            return None

        def transaction(conn, cursor):
            payload = self._ensure_json_text(ir_data, "plan serialization")
            try:
                cursor.execute(
                    "INSERT INTO plans (id, chat_id, base_ctx_id, ir_json, fingerprint) VALUES (?, ?, ?, ?, ?)",
                    (plan_id, chat_id, base_ctx_id, payload, fingerprint)
                )
            except sqlite3.IntegrityError:
                cursor.execute(
                    "UPDATE plans SET chat_id = ?, base_ctx_id = ?, ir_json = ?, fingerprint = ?, ts = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                    (chat_id, base_ctx_id, payload, fingerprint, plan_id)
                )

            cursor.execute("SELECT id, chat_id, base_ctx_id, ir_json, fingerprint, status, ts FROM plans WHERE id = ?", (plan_id,))
            row = cursor.fetchone()
            return self._normalize_plan_row(row)

        return self._transaction_wrapper("creating plan record", transaction)

    def get_plan_record(self, plan_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve a plan record by id."""
        if not self._validate_string(plan_id, "plan_id"):
            return None

        def query(conn, cursor):
            cursor.execute("SELECT id, chat_id, base_ctx_id, ir_json, fingerprint, status, ts FROM plans WHERE id = ?", (plan_id,))
            row = cursor.fetchone()
            return self._normalize_plan_row(row)

        return self._execute_with_connection("fetching plan record", query)

    def list_plan_records(self, chat_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        """List recent plan records for a chat."""
        if not self._validate_string(chat_id, "chat_id"):
            return []

        limit = max(1, min(limit, 200))

        def query(conn, cursor):
            cursor.execute("SELECT id, chat_id, base_ctx_id, ir_json, fingerprint, status, ts FROM plans WHERE chat_id = ? ORDER BY ts DESC LIMIT ?", (chat_id, limit))
            rows = cursor.fetchall()
            plans = [self._normalize_plan_row(row) for row in rows if row]
            return [plan for plan in plans if plan]

        return self._execute_with_connection("listing plan records", query, return_on_error=[]) or []

    def update_plan_status(self, plan_id: str, status: str) -> Optional[Dict[str, Any]]:
        """Update the approval status of a plan."""
        if not self._validate_string(plan_id, "plan_id"):
            return None
        if status not in {'PENDING_APPROVAL', 'APPROVED', 'DENIED'}:
            raise ValueError(f"Invalid plan status: {status}")

        def transaction(conn, cursor):
            cursor.execute(
                "UPDATE plans SET status = ?, ts = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
                (status, plan_id)
            )
            if cursor.rowcount == 0:
                return None

            cursor.execute("SELECT id, chat_id, base_ctx_id, ir_json, fingerprint, status, ts FROM plans WHERE id = ?", (plan_id,))
            row = cursor.fetchone()
            return self._normalize_plan_row(row)

        return self._transaction_wrapper("updating plan status", transaction)

    def get_plans_by_status(self, chat_id: str, status: str, limit: int = 20) -> List[Dict[str, Any]]:
        """Get plans filtered by status for a chat."""
        if not self._validate_string(chat_id, "chat_id"):
            return []
        if status not in {'PENDING_APPROVAL', 'APPROVED', 'DENIED'}:
            return []

        limit = max(1, min(limit, 200))

        def query(conn, cursor):
            cursor.execute("SELECT id, chat_id, base_ctx_id, ir_json, fingerprint, status, ts FROM plans WHERE chat_id = ? AND status = ? ORDER BY ts DESC LIMIT ?", (chat_id, status, limit))
            rows = cursor.fetchall()
            plans = [self._normalize_plan_row(row) for row in rows if row]
            return [plan for plan in plans if plan]

        return self._execute_with_connection("listing plans by status", query, return_on_error=[]) or []

    def insert_task_attempt(self, plan_id: str, task_id: str, definition: Any, base_ctx_id: str, state: str = 'PENDING', attempt: Optional[int] = None, provider: Optional[str] = None, new_ctx_id: Optional[str] = None, error: Optional[str] = None, cost: float = 0.0, tokens: int = 0) -> Optional[Dict[str, Any]]:
        """Insert a task attempt for a plan."""
        if state.upper() not in self.VALID_TASK_STATES:
            raise ValueError(f"Invalid task state: {state}")
        if not self._validate_string(plan_id, "plan_id") or not self._validate_string(task_id, "task_id"):
            return None
        if not isinstance(base_ctx_id, str) or not base_ctx_id.strip():
            logger.warning("Invalid base_ctx_id provided for task")
            return None

        def transaction(conn, cursor):
            current_attempt = attempt
            if current_attempt is None:
                cursor.execute("SELECT COALESCE(MAX(attempt), 0) FROM tasks WHERE plan_id = ? AND id = ?", (plan_id, task_id))
                row = cursor.fetchone()
                current_attempt = (row[0] if row else 0) + 1

            payload = self._ensure_json_text(definition, "task serialization")
            try:
                cursor.execute(
                    "INSERT INTO tasks (id, plan_id, state, def_json, base_ctx_id, new_ctx_id, attempt, error, cost, tokens, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (task_id, plan_id, state.upper(), payload, base_ctx_id, new_ctx_id, current_attempt, error, cost, tokens, provider)
                )
            except sqlite3.IntegrityError:
                cursor.execute(
                    "UPDATE tasks SET state = ?, def_json = ?, base_ctx_id = ?, new_ctx_id = ?, error = ?, cost = ?, tokens = ?, provider = ?, ts = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE plan_id = ? AND id = ? AND attempt = ?",
                    (state.upper(), payload, base_ctx_id, new_ctx_id, error, cost, tokens, provider, plan_id, task_id, current_attempt)
                )

            cursor.execute("SELECT plan_id, id, state, def_json, base_ctx_id, new_ctx_id, attempt, error, cost, tokens, provider, ts FROM tasks WHERE plan_id = ? AND id = ? AND attempt = ?", (plan_id, task_id, current_attempt))
            row = cursor.fetchone()
            return self._normalize_task_row(row)

        return self._transaction_wrapper("inserting task attempt", transaction)

    def get_task_attempt(self, plan_id: str, task_id: str, attempt: int) -> Optional[Dict[str, Any]]:
        """Retrieve a specific task attempt."""
        def query(conn, cursor):
            cursor.execute("SELECT plan_id, id, state, def_json, base_ctx_id, new_ctx_id, attempt, error, cost, tokens, provider, ts FROM tasks WHERE plan_id = ? AND id = ? AND attempt = ?", (plan_id, task_id, attempt))
            row = cursor.fetchone()
            return self._normalize_task_row(row)

        return self._execute_with_connection("fetching task attempt", query)

    def update_task_attempt_state(self, plan_id: str, task_id: str, attempt: int, *, state: Optional[str] = None, new_ctx_id: Optional[str] = None, error: Optional[str] = None, cost: Optional[float] = None, tokens: Optional[int] = None, provider: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Update mutable fields on an existing task attempt."""
        updates = []
        params: List[Any] = []
        if state is not None:
            state_value = state.upper()
            if state_value not in self.VALID_TASK_STATES:
                raise ValueError(f"Invalid task state: {state}")
            updates.append("state = ?")
            params.append(state_value)
        if new_ctx_id is not None:
            updates.append("new_ctx_id = ?")
            params.append(new_ctx_id)
        if error is not None:
            updates.append("error = ?")
            params.append(error)
        if cost is not None:
            updates.append("cost = ?")
            params.append(cost)
        if tokens is not None:
            updates.append("tokens = ?")
            params.append(tokens)
        if provider is not None:
            updates.append("provider = ?")
            params.append(provider)

        updates.append("ts = strftime('%Y-%m-%dT%H:%M:%fZ','now')")

        if not updates:
            return self.get_task_attempt(plan_id, task_id, attempt)

        def transaction(conn, cursor):
            cursor.execute(
                f"UPDATE tasks SET {', '.join(updates)} WHERE plan_id = ? AND id = ? AND attempt = ?",
                (*params, plan_id, task_id, attempt)
            )
            cursor.execute("SELECT plan_id, id, state, def_json, base_ctx_id, new_ctx_id, attempt, error, cost, tokens, provider, ts FROM tasks WHERE plan_id = ? AND id = ? AND attempt = ?", (plan_id, task_id, attempt))
            row = cursor.fetchone()
            return self._normalize_task_row(row)

        return self._transaction_wrapper("updating task attempt", transaction)

    def list_tasks_for_plan(self, plan_id: str) -> List[Dict[str, Any]]:
        """List all task attempts for a plan ordered by task id and attempt."""
        if not self._validate_string(plan_id, "plan_id"):
            return []

        def query(conn, cursor):
            cursor.execute("SELECT plan_id, id, state, def_json, base_ctx_id, new_ctx_id, attempt, error, cost, tokens, provider, ts FROM tasks WHERE plan_id = ? ORDER BY id ASC, attempt ASC", (plan_id,))
            rows = cursor.fetchall()
            tasks = [self._normalize_task_row(row) for row in rows if row]
            return [task for task in tasks if task]

        return self._execute_with_connection("listing tasks for plan", query, return_on_error=[]) or []

    def record_tool_call(self, plan_id: str, task_id: str, attempt: int, tool: str, *, provider: Optional[str] = None, model: Optional[str] = None, input_hash: str, output_hash: Optional[str] = None, ops: Optional[Any] = None, latency_ms: int = 0, tokens: int = 0, cost: float = 0.0) -> Optional[Dict[str, Any]]:
        """Record a tool call emitted during task execution."""
        if not self._validate_string(plan_id, "plan_id") or not self._validate_string(task_id, "task_id"):
            return None
        if not isinstance(tool, str) or not tool.strip():
            logger.warning("Invalid tool name provided for tool call")
            return None
        if not isinstance(input_hash, str) or not input_hash.strip():
            logger.warning("Invalid input hash provided for tool call")
            return None

        def transaction(conn, cursor):
            ops_payload = self._ensure_json_text(ops, "tool call ops serialization") if ops is not None else None
            cursor.execute(
                "INSERT INTO tool_calls (plan_id, task_id, attempt, tool, provider, model, input_hash, output_hash, ops_json, latency_ms, tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (plan_id, task_id, attempt, tool, provider, model, input_hash, output_hash, ops_payload, latency_ms, tokens, cost)
            )
            row_id = cursor.lastrowid
            cursor.execute("SELECT id, plan_id, task_id, attempt, tool, provider, model, input_hash, output_hash, ops_json, latency_ms, tokens, cost, ts FROM tool_calls WHERE id = ?", (row_id,))
            row = cursor.fetchone()
            return self._normalize_tool_call_row(row)

        return self._transaction_wrapper("recording tool call", transaction)

    def list_tool_calls_for_plan(self, plan_id: str) -> List[Dict[str, Any]]:
        """List tool calls associated with a plan ordered by creation."""
        if not self._validate_string(plan_id, "plan_id"):
            return []

        def query(conn, cursor):
            cursor.execute("SELECT id, plan_id, task_id, attempt, tool, provider, model, input_hash, output_hash, ops_json, latency_ms, tokens, cost, ts FROM tool_calls WHERE plan_id = ? ORDER BY id ASC", (plan_id,))
            rows = cursor.fetchall()
            calls = [self._normalize_tool_call_row(row) for row in rows if row]
            return [call for call in calls if call]

        return self._execute_with_connection("listing tool calls", query, return_on_error=[]) or []

    def store_blob(self, hash_value: str, data: bytes) -> bool:
        """Store a binary blob keyed by hash."""
        if not isinstance(hash_value, str) or not hash_value.strip():
            logger.warning("Invalid hash for blob storage")
            return False
        if not isinstance(data, (bytes, bytearray)):
            logger.warning("Blob data must be bytes-like")
            return False

        def transaction(conn, cursor):
            cursor.execute("INSERT OR IGNORE INTO blobs (hash, bytes) VALUES (?, ?)", (hash_value, sqlite3.Binary(bytes(data))))
            return True

        return bool(self._transaction_wrapper("storing blob", transaction, True))

    def get_blob(self, hash_value: str) -> Optional[bytes]:
        """Retrieve a stored blob by hash."""
        if not isinstance(hash_value, str) or not hash_value.strip():
            return None

        def query(conn, cursor):
            cursor.execute("SELECT bytes FROM blobs WHERE hash = ?", (hash_value,))
            row = cursor.fetchone()
            if not row:
                return None
            blob = row['bytes']
            if isinstance(blob, memoryview):
                blob = blob.tobytes()
            return bytes(blob) if isinstance(blob, (bytes, bytearray)) else blob

        return self._execute_with_connection("fetching blob", query)

    def set_file_state_callback(self, callback: Callable[[str, str, str, str], None]) -> None:
        """Set callback for file state changes to avoid circular imports"""
        self._file_state_callback = callback

    def save_token_usage(
        self,
        chat_id: str,
        role: str,
        provider: str,
        model: str,
        estimated_tokens: int = 0,
        actual_tokens: int = 0,
        message_id: Optional[str] = None,
        plan_id: Optional[str] = None
    ) -> bool:
        """
        Save token usage for a specific role in a chat.

        Args:
            chat_id: Chat identifier
            role: One of 'router', 'planner', 'assistant', 'agent_tools'
            provider: Provider name (e.g., 'gemini', 'groq')
            model: Model name
            estimated_tokens: Estimated token count
            actual_tokens: Actual token count from provider response
            message_id: Optional message ID this usage is associated with
            plan_id: Optional plan ID this usage is associated with

        Returns:
            bool: True if saved successfully
        """
        if not self._validate_string(chat_id, "chat_id"):
            return False

        if role not in {'router', 'planner', 'assistant', 'agent_tools'}:
            logger.warning(f"Invalid token usage role: {role}")
            return False

        def transaction(conn, cursor):
            cursor.execute(
                """INSERT INTO token_usage
                   (chat_id, role, provider, model, estimated_tokens, actual_tokens, message_id, plan_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (chat_id, role, provider, model, estimated_tokens, actual_tokens, message_id, plan_id)
            )
            logger.debug(f"[TokenUsage] Saved {role} token usage for chat {chat_id}: estimated={estimated_tokens}, actual={actual_tokens}")
            return True

        return bool(self._transaction_wrapper("saving token usage", transaction))

    def get_token_usage_by_chat(self, chat_id: str) -> Dict[str, Dict[str, int]]:
        """
        Get aggregated token usage for a chat, broken down by role.

        Args:
            chat_id: Chat identifier

        Returns:
            Dict with structure:
            {
                'router': {'estimated': int, 'actual': int, 'calls': int},
                'planner': {'estimated': int, 'actual': int, 'calls': int},
                'assistant': {'estimated': int, 'actual': int, 'calls': int},
                'agent_tools': {'estimated': int, 'actual': int, 'calls': int}
            }
        """
        if not self._validate_string(chat_id, "chat_id"):
            return {
                'router': {'estimated': 0, 'actual': 0, 'calls': 0},
                'planner': {'estimated': 0, 'actual': 0, 'calls': 0},
                'assistant': {'estimated': 0, 'actual': 0, 'calls': 0},
                'agent_tools': {'estimated': 0, 'actual': 0, 'calls': 0}
            }

        def query(conn, cursor):
            cursor.execute(
                """SELECT role,
                          SUM(estimated_tokens) as total_estimated,
                          SUM(actual_tokens) as total_actual,
                          COUNT(*) as call_count
                   FROM token_usage
                   WHERE chat_id = ?
                   GROUP BY role""",
                (chat_id,)
            )
            rows = cursor.fetchall()

            result = {
                'router': {'estimated': 0, 'actual': 0, 'calls': 0},
                'planner': {'estimated': 0, 'actual': 0, 'calls': 0},
                'assistant': {'estimated': 0, 'actual': 0, 'calls': 0},
                'agent_tools': {'estimated': 0, 'actual': 0, 'calls': 0}
            }

            for row in rows:
                role = row['role']
                if role in result:
                    result[role] = {
                        'estimated': row['total_estimated'] or 0,
                        'actual': row['total_actual'] or 0,
                        'calls': row['call_count'] or 0
                    }

            return result

        return self._execute_with_connection("fetching token usage by chat", query, return_on_error={
            'router': {'estimated': 0, 'actual': 0, 'calls': 0},
            'planner': {'estimated': 0, 'actual': 0, 'calls': 0},
            'assistant': {'estimated': 0, 'actual': 0, 'calls': 0},
            'agent_tools': {'estimated': 0, 'actual': 0, 'calls': 0}
        })

    def get_most_recent_token_usage(self, chat_id: str, role: str) -> Optional[Dict[str, Any]]:
        """
        Get the most recent token usage entry for a specific role in a chat.
        Used to determine the last-used provider/model for that role.

        Args:
            chat_id: Chat identifier
            role: Role to query ('router', 'planner', 'assistant', 'agent_tools')

        Returns:
            Dict with provider, model, timestamp, etc. or None if no usage found
        """
        if not self._validate_string(chat_id, "chat_id"):
            return None

        if role not in {'router', 'planner', 'assistant', 'agent_tools'}:
            logger.warning(f"Invalid token usage role: {role}")
            return None

        def query(conn, cursor):
            cursor.execute(
                """SELECT provider, model, estimated_tokens, actual_tokens, timestamp
                   FROM token_usage
                   WHERE chat_id = ? AND role = ?
                   ORDER BY timestamp DESC
                   LIMIT 1""",
                (chat_id, role)
            )
            row = cursor.fetchone()

            if not row:
                return None

            return {
                'provider': row['provider'],
                'model': row['model'],
                'estimated_tokens': row['estimated_tokens'],
                'actual_tokens': row['actual_tokens'],
                'timestamp': row['timestamp']
            }

        return self._execute_with_connection("fetching most recent token usage", query, None)


db = DatabaseManager()
