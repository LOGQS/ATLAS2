# status: complete

import asyncio
import threading
import atexit
import concurrent.futures
from typing import Dict, Any, Optional, List, Coroutine
from utils.logger import get_logger
from utils.config import get_provider_map
from utils.db_utils import db

logger = get_logger(__name__)

# Global tracking for async chat tasks
_async_chat_tasks_lock = threading.Lock()
_async_chat_tasks: Dict[str, concurrent.futures.Future] = {}


class _AsyncLoopManager:
    """Persistent asyncio event loop running in a background thread for async chats."""

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(
            target=self._run_loop,
            name="atlas-async-chat-loop",
            daemon=True,
        )
        self._loop_thread.start()

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_forever()
        finally:
            pending = asyncio.all_tasks(self._loop)
            if pending:
                self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self._loop.close()

    def submit(self, coro: Coroutine[Any, Any, Any]) -> concurrent.futures.Future:
        """Schedule coroutine on the persistent loop and return concurrent future."""
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    def call_soon(self, callback, *args):
        """Schedule a callback to run on the managed loop thread."""
        self._loop.call_soon_threadsafe(callback, *args)

    def shutdown(self):
        """Stop the loop and wait for the thread to exit."""
        if not self._loop.is_running():
            return

        def _stop_loop():
            if self._loop.is_running():
                self._loop.stop()

        self.call_soon(_stop_loop)
        self._loop_thread.join(timeout=5)


_async_loop_manager = _AsyncLoopManager()
atexit.register(_async_loop_manager.shutdown)
def is_async_chat_processing(chat_id: str) -> bool:
    """Check if a chat is currently being processed via async engine"""
    with _async_chat_tasks_lock:
        task = _async_chat_tasks.get(chat_id)
        return task is not None and not task.done()


def cancel_async_chat(chat_id: str) -> bool:
    """Cancel an async chat task"""
    with _async_chat_tasks_lock:
        future = _async_chat_tasks.get(chat_id)

    if future and not future.done():
        if future.cancel():
            logger.info(f"[ASYNC-CANCEL] Requested cancellation for async chat {chat_id}")
            return True
        logger.debug(f"[ASYNC-CANCEL] Cancellation request for {chat_id} ignored (already completed)")
    else:
        logger.info(f"[ASYNC-CANCEL] No active async task found for chat {chat_id}")

    return False


def cleanup_async_chat(chat_id: str):
    """Clean up async chat task and associated resources"""
    with _async_chat_tasks_lock:
        future = _async_chat_tasks.pop(chat_id, None)

    if future is None:
        logger.debug(f"[ASYNC-CLEANUP] No async resources found for chat {chat_id}")
        return

    if not future.done():
        future.cancel()
        logger.debug(f"[ASYNC-CLEANUP] Cancelled in-flight async future for chat {chat_id}")

    logger.info(f"[ASYNC-CLEANUP] Cleaned up async resources for chat {chat_id}")


async def _execute_async_streaming(
    chat_id: str,
    message: str,
    provider: str,
    model: str,
    include_reasoning: bool,
    attached_file_ids: List[str],
    user_message_id: int,
    is_retry: bool,
    router_result: Optional[Dict] = None
):
    """
    Execute async streaming chat generation on the shared background event loop.
    """
    from route.chat_route import publish_state, publish_content

    try:
        logger.info(f"[ASYNC-EXEC] Starting async execution for chat {chat_id} with {provider}:{model}")
        logger.info(f"[UX_PERF][BACKEND] stream_init chat={chat_id} provider={provider} model={model} include_reasoning={include_reasoning}")

        # Get provider instance
        providers = get_provider_map()
        if provider not in providers:
            error_msg = f"Provider '{provider}' not found"
            logger.error(f"[ASYNC-EXEC] {error_msg}")
            publish_content(chat_id, 'error', error_msg)
            return

        provider_instance = providers[provider]
        if not provider_instance.is_available():
            error_msg = f"Provider '{provider}' not available"
            logger.error(f"[ASYNC-EXEC] {error_msg}")
            publish_content(chat_id, 'error', error_msg)
            return

        # Check if provider has async streaming method
        if not hasattr(provider_instance, 'generate_text_stream_async'):
            error_msg = f"Provider '{provider}' does not support async streaming"
            logger.error(f"[ASYNC-EXEC] {error_msg}")
            publish_content(chat_id, 'error', error_msg)
            return

        # Get chat history and prepare request
        chat_history = db.get_chat_history(chat_id)
        system_prompt = db.get_chat_system_prompt(chat_id)

        # Filter out the current user message from history
        if chat_history and chat_history[-1]["role"] == "user":
            chat_history = chat_history[:-1]

        # Resolve file attachments
        file_attachments = []
        if attached_file_ids:
            from chat.chat import Chat
            chat_obj = Chat(chat_id=chat_id)
            file_attachments = chat_obj._resolve_api_file_names(attached_file_ids, provider)

        logger.info(f"[ASYNC-EXEC] Calling async stream for {chat_id} with {len(chat_history)} history messages")

        # Set initial state
        if include_reasoning:
            db.update_chat_state(chat_id, "thinking")
            publish_state(chat_id, "thinking")
            current_state = "thinking"
        else:
            db.update_chat_state(chat_id, "responding")
            publish_state(chat_id, "responding")
            current_state = "responding"

        # Optimistically notify clients that the answer stream is about to begin
        answer_started = False
        first_chunk_logged = False
        if not include_reasoning:
            publish_content(chat_id, 'answer_start', '')
            answer_started = True
            logger.info(f"[UX_PERF][BACKEND] optimistic_answer_start chat={chat_id}")

        # Stream the response
        full_text = ""
        full_thoughts = ""

        async for chunk in provider_instance.generate_text_stream_async(
            message,
            model=model,
            include_thoughts=include_reasoning,
            chat_history=chat_history,
            file_attachments=file_attachments
        ):
            chunk_type = chunk.get("type")

            if not first_chunk_logged:
                logger.info(f"[UX_PERF][BACKEND] first_chunk_received chat={chat_id} chunk_type={chunk_type}")
                first_chunk_logged = True

            if chunk_type == "thoughts_start":
                publish_content(chat_id, 'thoughts_start', '')
            elif chunk_type == "thoughts":
                content = chunk.get("content", "")
                full_thoughts += content
                publish_content(chat_id, 'thoughts', content)
            elif chunk_type == "answer_start":
                if current_state == "thinking":
                    db.update_chat_state(chat_id, "responding")
                    publish_state(chat_id, "responding")
                    current_state = "responding"
                if not answer_started:
                    publish_content(chat_id, 'answer_start', '')
                    answer_started = True
            elif chunk_type == "answer":
                content = chunk.get("content", "")
                full_text += content
                if not answer_started:
                    if current_state == "thinking":
                        db.update_chat_state(chat_id, "responding")
                        publish_state(chat_id, "responding")
                        current_state = "responding"
                    publish_content(chat_id, 'answer_start', '')
                    answer_started = True
                publish_content(chat_id, 'answer', content)
            elif chunk_type == "usage" or chunk_type == "usage_metadata":
                usage_data = chunk.get("usage") or chunk.get("usage_metadata")
                if usage_data:
                    publish_content(chat_id, chunk_type, '', usage=usage_data)
            elif chunk_type == "error":
                error_content = chunk.get("content", "Unknown error")
                logger.error(f"[ASYNC-EXEC] Error from provider: {error_content}")
                publish_content(chat_id, 'error', error_content)
                return

        # Update the assistant message in DB
        if user_message_id:
            # Find or create assistant message
            history = db.get_chat_history(chat_id)
            assistant_message_id = None
            for msg in reversed(history):
                if msg.get("role") == "assistant":
                    assistant_message_id = msg.get("id")
                    break

            if assistant_message_id:
                db.update_message(
                    assistant_message_id,
                    full_text,
                    thoughts=full_thoughts if full_thoughts else None
                )
            else:
                db.save_message(
                    chat_id,
                    "assistant",
                    full_text,
                    thoughts=full_thoughts if full_thoughts else None,
                    provider=provider,
                    model=model
                )

        # Set final state
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'complete', '')

        logger.info(f"[ASYNC-EXEC] Completed async execution for chat {chat_id}")
        logger.info(f"[UX_PERF][BACKEND] stream_complete chat={chat_id}")

    except asyncio.CancelledError:
        logger.info(f"[ASYNC-EXEC] Async task cancelled for chat {chat_id}")
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'error', 'Request cancelled')
        raise
    except Exception as e:
        logger.error(f"[ASYNC-EXEC] Unexpected error in async execution for chat {chat_id}: {e}", exc_info=True)
        db.update_chat_state(chat_id, "static")
        publish_state(chat_id, "static")
        publish_content(chat_id, 'error', f"Async execution error: {str(e)}")


def start_async_chat_processing(
    chat_id: str,
    message: str,
    provider: str,
    model: str,
    include_reasoning: bool,
    attached_file_ids: List[str],
    user_message_id: int,
    is_retry: bool = False,
    router_result: Optional[Dict] = None
) -> bool:
    """
    Start async chat processing on the shared asyncio loop thread.
    Returns True if started successfully, False if already running or limit exceeded.
    """
    from utils.config import Config

    with _async_chat_tasks_lock:
        # Check if already processing
        existing_task = _async_chat_tasks.get(chat_id)
        if existing_task and not existing_task.done():
            logger.warning(f"[ASYNC-START] Chat {chat_id} is already processing")
            return False

        # Check concurrent limit
        active_count = sum(1 for task in _async_chat_tasks.values() if not task.done())
        max_concurrent = Config.get_max_async_concurrent_chats()
        if active_count >= max_concurrent:
            logger.warning(f"[ASYNC-START] Concurrent async chat limit reached ({active_count}/{max_concurrent}), rejecting {chat_id}")

            # Publish error message to client
            from route.chat_route import publish_content, publish_state
            from utils.db_utils import db
            db.update_chat_state(chat_id, "static")
            publish_state(chat_id, "static")
            publish_content(
                chat_id,
                'error',
                f'Server is currently at maximum capacity ({max_concurrent} concurrent chats). Please try again in a moment.'
            )
            return False

        # Create the coroutine
        coro = _execute_async_streaming(
            chat_id=chat_id,
            message=message,
            provider=provider,
            model=model,
            include_reasoning=include_reasoning,
            attached_file_ids=attached_file_ids,
            user_message_id=user_message_id,
            is_retry=is_retry,
            router_result=router_result
        )

        future = _async_loop_manager.submit(coro)
        _async_chat_tasks[chat_id] = future

    def _future_finalizer(completed_future: concurrent.futures.Future):
        try:
            completed_future.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug(f"[ASYNC-START] Async task for chat {chat_id} completed with error", exc_info=True)
        finally:
            cleanup_async_chat(chat_id)

    future.add_done_callback(_future_finalizer)

    with _async_chat_tasks_lock:
        active_after = sum(1 for task in _async_chat_tasks.values() if not task.done())

    logger.info(f"[ASYNC-START] Started async processing for chat {chat_id} on persistent loop (concurrent: {active_after}/{max_concurrent})")
    return True
