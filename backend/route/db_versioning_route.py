# status: complete
"""Database route handler for message versioning and lineage tracking"""

import random
import time
import json
from typing import Dict, List, Optional, Tuple
from flask import Flask, request
from utils.db_utils import db
from utils.logger import get_logger
from utils.message_versioning import MessageVersioning
from route.db_route_utils import (
    DBRouteConstants,
    ResponseBuilder,
    handle_route_error
)

logger = get_logger(__name__)


class VersioningRoute:
    """Handler for message versioning and chat version tree operations"""

    def __init__(self, app: Flask):
        self.app = app
        self._register_routes()

    def _register_routes(self):
        """Register all versioning-related routes"""
        self.app.route('/api/db/versioning/notify', methods=['POST'])(self.versioning_notify)
        self.app.route('/api/db/chat/<chat_id>/versions', methods=['GET'])(self.get_chat_versions)
        self.app.route('/api/messages/<message_id>/versions', methods=['GET'])(self.get_message_versions)

    def _handle_route_error(self, operation: str, error: Exception, context: dict = None) -> Tuple:
        """Wrapper for standardized error handling"""
        return handle_route_error(operation, error, context, logger)

    def _validate_versioning_request(self, data: Dict) -> Tuple[bool, str, Dict]:
        """Validate and extract versioning request parameters"""
        operation_type = data.get('operation_type')
        message_id = data.get('message_id')
        chat_id = data.get('chat_id')
        new_content = data.get('new_content')

        if not operation_type or not message_id or not chat_id:
            return False, 'operation_type, message_id, and chat_id are required', {}

        if operation_type == 'edit' and not new_content:
            return False, 'Edit requires newContent in payload', {}

        return True, "", {
            'operation_type': operation_type,
            'message_id': message_id,
            'chat_id': chat_id,
            'new_content': new_content
        }

    def _create_version_chat(self, params: Dict, source_chat: Dict, all_chats: List) -> Tuple[bool, str, str]:
        """Create a new version chat with proper naming"""
        chat_id = params['chat_id']
        operation_type = params['operation_type']

        existing_versions = [c for c in all_chats if c.get('belongsto') == chat_id]
        operation_counts = {'edit': 0, 'retry': 0, 'delete': 0}
        for v in existing_versions:
            v_name = v.get('name', '')
            for op in operation_counts:
                if v_name.startswith(op + '_'):
                    try:
                        num = int(v_name.split('_')[1])
                        operation_counts[op] = max(operation_counts[op], num)
                    except:
                        pass

        op_prefix = operation_type
        op_number = operation_counts.get(operation_type, 0) + 1
        version_name = f"{op_prefix}_{op_number}"

        version_chat_id = f"version_{int(time.time())}_{random.randint(DBRouteConstants.IMPORT_ID_RANDOM_MIN, DBRouteConstants.IMPORT_ID_RANDOM_MAX)}"

        success = db.create_chat(
            chat_id=version_chat_id,
            system_prompt=source_chat.get('system_prompt'),
            name=version_name,
            isversion=True,
            belongsto=chat_id
        )

        if not success:
            return False, 'Failed to create version chat', ""

        return True, "", version_chat_id

    def _find_target_message(self, message_id: str, chat_history: List) -> Tuple[Optional[int], Optional[Dict]]:
        """Find target message position and content"""
        if str(message_id).startswith(DBRouteConstants.TEMP_MESSAGE_PREFIX):
            if str(message_id).endswith('_user'):
                for i in range(len(chat_history) - 1, -1, -1):
                    if chat_history[i]['role'] == 'user':
                        return i, chat_history[i]
            elif str(message_id).endswith('_assistant'):
                for i in range(len(chat_history) - 1, -1, -1):
                    if chat_history[i]['role'] == 'assistant':
                        return i, chat_history[i]
        elif '_' in str(message_id):
            try:
                pos_str = str(message_id).split('_')[-1]
                if pos_str.isdigit():
                    target_position = int(pos_str) - 1
                    if 0 <= target_position < len(chat_history):
                        return target_position, chat_history[target_position]
            except:
                pass

        return None, None

    def _apply_versioning_operation(self, params: Dict, target_position: int, target_message: Dict,
                                   chat_history: List) -> Dict:
        """Apply the specific operation logic"""
        operation_type = params['operation_type']
        new_content = params.get('new_content')

        messages_to_copy = []
        needs_streaming = False
        stream_message = None

        if operation_type == 'retry' and target_message['role'] == 'assistant':
            for i in range(target_position - 1, -1, -1):
                if chat_history[i]['role'] == 'user':
                    target_position = i
                    target_message = chat_history[i]
                    break

        if operation_type == 'delete':
            messages_to_copy = chat_history[:target_position]
            needs_streaming = False

        elif operation_type == 'retry':
            messages_to_copy = chat_history[:target_position + 1]
            needs_streaming = True
            stream_message = target_message['content']

        elif operation_type == 'edit':
            if target_message['role'] == 'user':
                messages_to_copy = chat_history[:target_position]
                edited_message = {**target_message, 'content': new_content}
                messages_to_copy.append(edited_message)
                needs_streaming = True
                stream_message = new_content
            else:
                messages_to_copy = chat_history.copy()
                messages_to_copy[target_position] = {
                    **messages_to_copy[target_position],
                    'content': new_content
                }
                needs_streaming = False

        return {
            'messages_to_copy': messages_to_copy,
            'needs_streaming': needs_streaming,
            'stream_message': stream_message,
            'target_position': target_position,
            'target_message': target_message
        }

    def _extract_router_metadata(self, message: Dict) -> Tuple[bool, Optional[str]]:
        """Extract router metadata from a message dict in a normalized form."""
        raw_enabled = message.get('routerEnabled')
        if raw_enabled is None:
            raw_enabled = message.get('router_enabled')

        if isinstance(raw_enabled, str):
            router_enabled = raw_enabled.strip().lower() in ('true', '1', 'yes')
        else:
            router_enabled = bool(raw_enabled)

        router_decision = message.get('routerDecision')
        if router_decision is None:
            router_decision = message.get('router_decision')

        router_decision_str: Optional[str] = None
        if router_decision is not None:
            if isinstance(router_decision, str):
                router_decision_str = router_decision
            else:
                try:
                    router_decision_str = json.dumps(router_decision)
                except (TypeError, ValueError) as exc:
                    logger.warning(
                        "Failed to serialize router decision for message %s: %s",
                        message.get('id'), exc
                    )
                    router_decision_str = None

        return router_enabled, router_decision_str

    def _copy_messages_to_version(self, version_chat_id: str, messages: List) -> Tuple[List[str], List[str]]:
        """Copy messages to the new version chat"""
        new_message_ids = []
        new_roles = []

        for message in messages:
            attached_file_ids = []
            try:
                db_files = db.get_message_files(message['id'])
                attached_file_ids = [f.get('id') for f in db_files if f.get('id')]
            except Exception:
                attached_file_ids = []

            router_enabled, router_decision = self._extract_router_metadata(message)

            new_message_id = db.save_message(
                chat_id=version_chat_id,
                role=message['role'],
                content=message['content'],
                thoughts=message.get('thoughts'),
                provider=message.get('provider'),
                model=message.get('model'),
                attached_file_ids=attached_file_ids if attached_file_ids else None,
                router_enabled=router_enabled,
                router_decision=router_decision
            )

            logger.debug(f"Copied message to version: {new_message_id}")
            new_message_ids.append(new_message_id)
            new_roles.append(message['role'])

        return new_message_ids, new_roles

    def _handle_version_lineage(self, params: Dict, version_chat_id: str, target_position: int,
                               target_message: Dict, new_message_ids: List, messages_to_copy: List,
                               chat_history: List, data: Dict):
        """Handle message versioning and lineage tracking"""
        operation_type = params['operation_type']
        chat_id = params['chat_id']
        new_content = params.get('new_content')

        if operation_type not in ['edit', 'retry'] or not target_message:
            return

        try:
            msg_versioning = MessageVersioning(db)

            main_chat_id_for_group = db.find_main_chat(chat_id) or chat_id
            original_msg_id = f"{main_chat_id_for_group}_{target_position + 1}"

            existing_versions = msg_versioning.get_message_versions(original_msg_id)
            if not existing_versions:
                msg_versioning.record_message_version(
                    original_message_id=original_msg_id,
                    chat_version_id=chat_id,
                    operation='original',
                    content=target_message['content']
                )

            msg_versioning.record_message_version(
                original_message_id=original_msg_id,
                chat_version_id=version_chat_id,
                operation=operation_type,
                content=new_content if operation_type == 'edit' else target_message['content']
            )

            if operation_type == 'retry' and data.get('message_id') and '_' in str(data.get('message_id')):
                original_retry_msg_id = str(data.get('message_id'))
                try:
                    orig_pos_str = original_retry_msg_id.split('_')[-1]
                    if orig_pos_str.isdigit():
                        orig_pos = int(orig_pos_str) - 1
                        if 0 <= orig_pos < len(chat_history) and chat_history[orig_pos]['role'] == 'assistant':
                            assistant_original_id = f"{main_chat_id_for_group}_{orig_pos + 1}"
                            assistant_existing = msg_versioning.get_message_versions(assistant_original_id)
                            if not assistant_existing:
                                msg_versioning.record_message_version(
                                    original_message_id=assistant_original_id,
                                    chat_version_id=chat_id,
                                    operation='original',
                                    content=chat_history[orig_pos]['content']
                                )
                            msg_versioning.record_message_version(
                                original_message_id=assistant_original_id,
                                chat_version_id=version_chat_id,
                                operation='retry',
                                content=chat_history[orig_pos]['content']
                            )
                except Exception as ae:
                    logger.debug(f"Could not record assistant version during retry: {ae}")
        except Exception as e:
            logger.warning(f"Could not record message version: {e}")

        try:
            if target_message['role'] == 'user' or operation_type == 'retry':
                new_user_id = new_message_ids[-1] if new_message_ids else f"{version_chat_id}_{len(messages_to_copy)}"
                db.record_lineage(
                    message_id=new_user_id,
                    role='user',
                    parent_message_id=f"{chat_id}_{target_position + 1}"
                )

            if target_message['role'] == 'assistant' and operation_type == 'edit':
                new_assistant_id = new_message_ids[target_position] if 0 <= target_position < len(new_message_ids) else None
                if new_assistant_id:
                    db.record_lineage(
                        message_id=new_assistant_id,
                        role='assistant',
                        parent_message_id=f"{chat_id}_{target_position + 1}"
                    )

            for idx, nid in enumerate(new_message_ids):
                if idx < target_position:
                    try:
                        with db.get_connection() as conn:
                            c = conn.cursor()
                            c.execute("DELETE FROM message_lineage WHERE message_id = ?", (nid,))
                            conn.commit()
                    except Exception as ce:
                        logger.warning(f"[LINEAGE] Cleanup failed for earlier copy idx={idx} id={nid}: {ce}")
        except Exception as e:
            logger.warning(f"[LINEAGE] Failed to record lineage for operation {operation_type}: {e}")

    def versioning_notify(self):
        """Handle versioning system notifications for edit/retry/delete operations

        Creates a new version with the operation already applied.
        """
        try:
            data = request.get_json()

            is_valid, error_msg, params = self._validate_versioning_request(data)
            if not is_valid:
                return ResponseBuilder.error(error_msg, 400)

            logger.info(f"Versioning notification: {params['operation_type']} operation on message {params['message_id']} in chat {params['chat_id']}")

            if not db.chat_exists(params['chat_id']):
                return ResponseBuilder.error(f"Source chat {params['chat_id']} not found", 404)

            chat_history = db.get_chat_history(params['chat_id'])
            all_chats = db.get_all_chats()
            source_chat = next((chat for chat in all_chats if chat['id'] == params['chat_id']), None)
            if not source_chat:
                return ResponseBuilder.error(f"Source chat metadata not found for {params['chat_id']}", 404)

            success, error_msg, version_chat_id = self._create_version_chat(params, source_chat, all_chats)
            if not success:
                return ResponseBuilder.error(error_msg, 500)

            target_position, target_message = self._find_target_message(params['message_id'], chat_history)
            if target_position is None or target_message is None:
                return ResponseBuilder.error(f"Could not find target message {params['message_id']}", 400)

            operation_result = self._apply_versioning_operation(params, target_position, target_message, chat_history)

            new_message_ids, new_roles = self._copy_messages_to_version(
                version_chat_id,
                operation_result['messages_to_copy']
            )

            self._handle_version_lineage(
                params, version_chat_id, operation_result['target_position'],
                operation_result['target_message'], new_message_ids,
                operation_result['messages_to_copy'], chat_history, data
            )

            logger.info(f"Created version {version_chat_id} with {params['operation_type']} applied")
            logger.info(f"Original: {len(chat_history)} msgs -> Version: {len(operation_result['messages_to_copy'])} msgs")

            attached_for_stream = []
            if operation_result['needs_streaming']:
                try:
                    if params['operation_type'] == 'edit':
                        tgt_id = f"{version_chat_id}_{len(operation_result['messages_to_copy'])}"
                        new_files = db.get_message_files(tgt_id)
                        attached_for_stream = [f.get('id') for f in new_files if f.get('id')]
                    elif params['operation_type'] == 'retry':
                        idx = operation_result['target_position'] if operation_result['target_position'] is not None else len(operation_result['messages_to_copy']) - 1
                        tgt_id = f"{version_chat_id}_{(idx + 1)}"
                        new_files = db.get_message_files(tgt_id)
                        attached_for_stream = [f.get('id') for f in new_files if f.get('id')]
                except Exception as e:
                    logger.warning(f"Failed to compute attached_file_ids for stream: {e}")

            response_data = {
                'success': True,
                'version_chat_id': version_chat_id,
                'operation_type': params['operation_type'],
                'original_chat_id': params['chat_id'],
                'belongsto': params['chat_id'],
                'operation_applied': True,
                'message_count': len(operation_result['messages_to_copy']),
                'needs_streaming': operation_result['needs_streaming'],
                'attached_file_ids': attached_for_stream
            }

            if operation_result['needs_streaming'] and operation_result['stream_message']:
                response_data['stream_message'] = operation_result['stream_message']

            if params['operation_type'] != 'delete' and len(operation_result['messages_to_copy']) > 0:
                response_data['target_message_id'] = f"{version_chat_id}_{len(operation_result['messages_to_copy'])}"

            return ResponseBuilder.success(data=response_data)

        except Exception as e:
            return self._handle_route_error("handling versioning notification", e)

    def _build_lineage_versions_response(self, lineage_versions: List, message_id: str, base_chat_id: str,
                                        main_chat_id_for_group: str, group_msg_id: str, msg_position: int) -> Tuple:
        """Build response from lineage-based versions"""
        filtered_versions = []
        active_version_number = None

        for v in lineage_versions:
            op = v.get('operation') or 'original'
            if not op:
                try:
                    ch_meta = db.get_chat_meta(v.get('chat_version_id'))
                    nm = (ch_meta or {}).get('name', '').lower()
                    if nm.startswith('edit_'):
                        op = 'edit'
                    elif nm.startswith('retry_'):
                        op = 'retry'
                    else:
                        op = 'original'
                except Exception:
                    op = 'original'

            item = {
                'version_number': v.get('version_number'),
                'chat_version_id': v.get('chat_version_id'),
                'operation': op,
                'created_at': v.get('created_at')
            }
            filtered_versions.append(item)

            if v.get('message_id') == message_id:
                active_version_number = v.get('version_number')

        if active_version_number is None and filtered_versions:
            active_version_number = max(v.get('version_number', 1) for v in filtered_versions)

        return ResponseBuilder.success(
            success=True,
            message_id=message_id,
            versions=filtered_versions,
            active_version_number=active_version_number,
            debug={
                'source': 'lineage',
                'base_chat_id': base_chat_id,
                'main_chat_id': main_chat_id_for_group,
                'group_msg_id': group_msg_id,
                'msg_position': msg_position,
                'count': len(filtered_versions)
            }
        )

    def _apply_version_fallbacks(self, base_chat_id: str, msg_position: int, main_chat_id_for_group: str,
                                group_msg_id: str, msg_versioning: MessageVersioning) -> List:
        """Apply various fallbacks when no versions found"""
        versions = []

        role = None
        content = None
        base_exists = db.chat_exists(base_chat_id)

        if base_exists:
            try:
                base_hist = db.get_chat_history(base_chat_id)
                if 1 <= msg_position <= len(base_hist):
                    base_msg = base_hist[msg_position - 1]
                    role = base_msg.get('role')
                    content = base_msg.get('content')
            except Exception:
                pass

        if role == 'assistant' and msg_position > 1:
            prev_group_id = f"{main_chat_id_for_group}_{msg_position - 1}"
            prev_versions = msg_versioning.get_message_versions(prev_group_id)
            if prev_versions:
                versions = prev_versions
                logger.debug(f"[MSG_VERSIONS] Assistant fallback: using previous user group {prev_group_id}")
                return versions

        if not versions and role == 'user' and content:
            try:
                if db.chat_exists(main_chat_id_for_group):
                    main_hist = db.get_chat_history(main_chat_id_for_group)
                    for idx, m in enumerate(main_hist):
                        if m.get('role') == 'user' and (m.get('content') or '') == content:
                            mapped_pos = idx + 1
                            mapped_group_id = f"{main_chat_id_for_group}_{mapped_pos}"
                            mapped_versions = msg_versioning.get_message_versions(mapped_group_id)
                            if mapped_versions:
                                versions = mapped_versions
                                logger.debug(f"[MSG_VERSIONS] User content map: using mapped group {mapped_group_id}")
                                return versions
            except Exception:
                pass

        if not versions:
            if db.chat_exists(main_chat_id_for_group):
                chat_history = db.get_chat_history(main_chat_id_for_group)
                if msg_position <= len(chat_history):
                    msg = chat_history[msg_position - 1]
                    all_chats = db.get_all_chats()
                    chat_meta = next((c for c in all_chats if c['id'] == main_chat_id_for_group), None)
                    versions = [{
                        'version_number': 1,
                        'chat_version_id': main_chat_id_for_group,
                        'operation': 'original',
                        'content': msg.get('content', ''),
                        'created_at': chat_meta.get('created_at') if chat_meta else None
                    }]
                    logger.debug(f"[MSG_VERSIONS] Main original fallback at position {msg_position}")
                    return versions

        if not versions and base_exists:
            try:
                base_hist2 = db.get_chat_history(base_chat_id)
                if 1 <= msg_position <= len(base_hist2):
                    msg2 = base_hist2[msg_position - 1]
                    all_chats = db.get_all_chats()
                    chat_meta2 = next((c for c in all_chats if c['id'] == base_chat_id), None)
                    versions = [{
                        'version_number': 1,
                        'chat_version_id': base_chat_id,
                        'operation': 'original',
                        'content': msg2.get('content', ''),
                        'created_at': chat_meta2.get('created_at') if chat_meta2 else None
                    }]
                    logger.debug(f"[MSG_VERSIONS] Base original fallback at position {msg_position}")
                    return versions
            except Exception as e:
                logger.error(f"[MSG_VERSIONS] Error in base original fallback: {e}")

        if not versions or len(versions) <= 1:
            versions = self._build_synthetic_lineage(main_chat_id_for_group, msg_position, role)

        return versions

    def _build_synthetic_lineage(self, main_chat_id_for_group: str, msg_position: int, role: str) -> List:
        """Build synthetic lineage from chat tree"""
        try:
            all_chats = db.get_all_chats()
            tree = []
            for ch in all_chats:
                try:
                    if ch.get('id') == main_chat_id_for_group or (ch.get('isversion') and db.find_main_chat(ch.get('id')) == main_chat_id_for_group):
                        tree.append(ch)
                except Exception:
                    continue

            lineage_pos = msg_position - 1 if role == 'assistant' and msg_position > 1 else msg_position
            if lineage_pos < 1:
                lineage_pos = 1

            synth = []
            for ch in tree:
                ch_id = ch.get('id')
                try:
                    hist = db.get_chat_history(ch_id)
                    if 1 <= lineage_pos <= len(hist):
                        m = hist[lineage_pos - 1]
                        if m.get('role') == 'user':
                            op = 'original'
                            name = (ch.get('name') or '').lower()
                            if ch_id != main_chat_id_for_group:
                                if name.startswith('edit_'):
                                    op = 'edit'
                                elif name.startswith('retry_'):
                                    op = 'retry'
                                else:
                                    op = 'retry'
                            synth.append({
                                'chat_version_id': ch_id,
                                'operation': op,
                                'content': m.get('content', ''),
                                'created_at': ch.get('created_at')
                            })
                except Exception:
                    continue

            if len(synth) > 0:
                def sort_key(item):
                    return (0 if item['chat_version_id'] == main_chat_id_for_group else 1, item['created_at'] or '')
                synth.sort(key=sort_key)
                for idx, it in enumerate(synth, start=1):
                    it['version_number'] = idx
                logger.debug(f"[MSG_VERSIONS] Synthetic lineage built with {len(synth)} entries")
                return synth
        except Exception as e:
            logger.warning(f"[MSG_VERSIONS] Synthetic lineage failed: {e}")

        return []

    def get_message_versions(self, message_id: str):
        """Get all versions of a specific message using the message_versions table"""
        try:
            if message_id.startswith(DBRouteConstants.TEMP_MESSAGE_PREFIX):
                return ResponseBuilder.success(versions=[])

            msg_versioning = MessageVersioning(db)

            if '_' not in message_id:
                return ResponseBuilder.error(DBRouteConstants.INVALID_MESSAGE_ID, 400)

            parts = message_id.rsplit('_', 1)
            if len(parts) != 2 or not parts[1].isdigit():
                return ResponseBuilder.error(DBRouteConstants.INVALID_MESSAGE_ID, 400)

            base_chat_id = parts[0]
            msg_position = int(parts[1])
            main_chat_id_for_group = db.find_main_chat(base_chat_id) or base_chat_id
            group_msg_id = f"{main_chat_id_for_group}_{msg_position}"
            logger.debug(f"[MSG_VERSIONS] Request={message_id} -> base={base_chat_id}, main={main_chat_id_for_group}, pos={msg_position}, group={group_msg_id}")

            lineage_versions = db.get_lineage_versions(message_id)
            if lineage_versions:
                return self._build_lineage_versions_response(lineage_versions, message_id, base_chat_id,
                                                            main_chat_id_for_group, group_msg_id, msg_position)

            versions = msg_versioning.get_message_versions(group_msg_id)

            if not versions:
                versions = self._apply_version_fallbacks(base_chat_id, msg_position, main_chat_id_for_group,
                                                        group_msg_id, msg_versioning)

            filtered_versions = [v for v in versions if v.get('operation', '') in ['original', 'edit', 'retry']]

            active_version_number = max((v.get('version_number', 1) for v in filtered_versions), default=1)

            return ResponseBuilder.success(
                success=True,
                message_id=message_id,
                versions=filtered_versions,
                active_version_number=active_version_number,
                debug={
                    'base_chat_id': base_chat_id,
                    'main_chat_id': main_chat_id_for_group,
                    'group_msg_id': group_msg_id,
                    'msg_position': msg_position,
                    'count': len(filtered_versions)
                }
            )

        except Exception as e:
            return self._handle_route_error("getting message versions", e, {"message_id": message_id})

    def get_chat_versions(self, chat_id: str):
        """Get the full version tree for a chat"""
        try:
            main_chat_id = db.find_main_chat(chat_id)
            if main_chat_id is None:
                return ResponseBuilder.error(f'Could not find main chat for {chat_id}', 404)

            all_chats = db.get_all_chats()

            main_chat = next((chat for chat in all_chats if chat['id'] == main_chat_id), None)
            if not main_chat:
                return ResponseBuilder.error(f'Main chat {main_chat_id} not found', 404)

            tree_versions = []
            for chat in all_chats:
                if chat.get('isversion') and db.find_main_chat(chat['id']) == main_chat_id:
                    tree_versions.append(chat)

            def build_children(parent_id):
                if not parent_id or not tree_versions:
                    return []

                children = []
                direct_children = [v for v in tree_versions if v.get('belongsto') == parent_id]

                if not direct_children:
                    return []

                direct_children.sort(key=lambda x: x.get('created_at', ''))

                for child in direct_children:
                    child_node = {
                        'id': child['id'],
                        'name': child.get('name') or 'New Chat',
                        'isversion': True,
                        'belongsto': child.get('belongsto'),
                        'created_at': child['created_at'],
                        'is_active': child['id'] == chat_id,
                        'children': build_children(child['id'])
                    }
                    children.append(child_node)

                return children

            version_tree = {
                'id': main_chat['id'],
                'name': main_chat.get('name') or 'New Chat',
                'isversion': False,
                'belongsto': None,
                'created_at': main_chat['created_at'],
                'is_active': main_chat['id'] == chat_id,
                'children': build_children(main_chat['id'])
            }

            return ResponseBuilder.success(
                success=True,
                current_chat_id=chat_id,
                main_chat_id=main_chat_id,
                version_tree=version_tree
            )

        except Exception as e:
            return self._handle_route_error("getting chat versions", e, {"chat_id": chat_id})


def register_db_versioning_routes(app: Flask):
    """Helper function to register versioning routes"""
    VersioningRoute(app)