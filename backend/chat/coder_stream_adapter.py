"""
Adapter that wraps agentic's StreamingPatternExtractor for coder domain streaming.

This adapter bridges between the robust pattern extraction of agentic framework
and the granular event emission required by the coder domain frontend.

Key features:
- Uses StreamingPatternExtractor for robust pattern matching
- Parses custom TOOL/REASON/PARAM tag format incrementally
- Emits granular streaming events compatible with frontend expectations
- Handles auto-execution of file.write and file.edit tools
"""
import hashlib
import re
from typing import Any, Callable, Dict, Set

from agentic import StreamingPatternExtractor
from agents.patterns.coder_patterns import CODER_PATTERN_SET
from utils.logger import get_logger

logger = get_logger(__name__)


# Tag constants for nested parsing within TOOL_CALL
TOOL_OPEN = "<TOOL>"
TOOL_CLOSE = "</TOOL>"
REASON_OPEN = "<REASON>"
REASON_CLOSE = "</REASON>"
PARAM_PATTERN = re.compile(r'<PARAM\s+name="([^"]+)">(.*?)</PARAM>', re.DOTALL)


class CoderStreamAdapter:
    """
    Adapter that wraps StreamingPatternExtractor for coder domain streaming.

    Provides granular event streaming with robust pattern extraction.
    """

    def __init__(
        self,
        iteration: int,
        emitter: Callable[[Dict[str, Any]], None],
        auto_exec_callback: Callable[[str, Dict[str, Any], str], None] = None,
    ):
        self.iteration = iteration
        self._emit = emitter
        self._auto_exec_callback = auto_exec_callback

        # Initialize StreamingPatternExtractor with stream_content=True for incremental parsing
        self._extractor = StreamingPatternExtractor(
            pattern_set=CODER_PATTERN_SET,
            stream_content=True,  # Enable streaming content events
        )

        # State for thoughts (handled separately from patterns)
        self._thoughts_started = False
        self._thoughts_complete = False

        # State for agent_response (MESSAGE pattern)
        self._message_started = False
        self._message_emitted = 0
        self._message_complete = False
        self._message_content_buffer = ""  # Accumulate for holdback logic

        # State for tool calls
        self._tool_states: Dict[int, Dict[str, Any]] = {}
        self._current_tool_index = 0

        # Tools that should be auto-executed
        self._AUTO_EXECUTE_TOOLS = {"file.write", "file.edit"}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def handle_thoughts(self, text: str) -> None:
        """Handle thoughts/reasoning from API response (not from pattern extraction)."""
        if not text:
            return

        if not self._thoughts_started:
            self._emit({
                "iteration": self.iteration,
                "segment": "thoughts",
                "action": "start",
            })
            self._thoughts_started = True

        self._emit({
            "iteration": self.iteration,
            "segment": "thoughts",
            "action": "append",
            "text": text,
        })

    def feed_answer(self, text: str) -> None:
        """Feed answer chunk to the pattern extractor."""
        if not text:
            return

        # Feed to StreamingPatternExtractor and process events
        for event in self._extractor.feed_chunk(text):
            self._handle_extractor_event(event)

    def finalize(self) -> None:
        """Finalize extraction and emit completion events."""
        # Finalize pattern extraction
        segments, malformed = self._extractor.finalize(iteration=self.iteration)

        # Log any malformed patterns
        if malformed:
            for key, content in malformed.items():
                logger.warning(f"[ADAPTER] Malformed pattern {key}: {content[:100]}...")

        # Complete thoughts
        self._complete_thoughts()

        # Complete message if needed
        if self._message_started and not self._message_complete:
            self._emit({
                "iteration": self.iteration,
                "segment": "agent_response",
                "action": "complete",
            })
            self._message_complete = True

        # Complete any incomplete tool calls
        for tool_state in self._tool_states.values():
            if not tool_state.get("complete"):
                self._emit({
                    "iteration": self.iteration,
                    "segment": "tool_call",
                    "action": "complete",
                    "tool_index": tool_state["index"],
                })
                tool_state["complete"] = True

    # ------------------------------------------------------------------
    # Internal event handling
    # ------------------------------------------------------------------
    def _handle_extractor_event(self, event: tuple) -> None:
        """Handle events from StreamingPatternExtractor."""
        event_type = event[0]

        if event_type == "pattern_start":
            _, pattern_name, pattern_type = event
            self._handle_pattern_start(pattern_name, pattern_type)

        elif event_type == "pattern_content":
            _, pattern_name, content_chunk = event
            self._handle_pattern_content(pattern_name, content_chunk)

        elif event_type == "pattern_end":
            _, pattern_name, pattern_type, full_content, tool_call = event
            self._handle_pattern_end(pattern_name, pattern_type, full_content, tool_call)

    def _handle_pattern_start(self, pattern_name: str, pattern_type: str) -> None:
        """Handle pattern_start event."""
        if pattern_name == "message":
            if not self._message_started:
                self._message_started = True
                self._emit({
                    "iteration": self.iteration,
                    "segment": "agent_response",
                    "action": "start",
                })
                # Agent response follows the reasoning stream
                self._complete_thoughts()

        elif pattern_name == "tool_call":
            # Create new tool state
            tool_index = self._current_tool_index
            self._current_tool_index += 1

            self._tool_states[tool_index] = {
                "index": tool_index,
                "content_buffer": "",
                "fields_emitted": set(),
                "params_emitted": set(),
                "complete": False,
                "collected_params": {},
                "streaming_params": {},
                "complete_params": set(),
                "last_auto_exec_signature": None,
                "last_sent_param_content": {},
            }

            self._emit({
                "iteration": self.iteration,
                "segment": "tool_call",
                "action": "start",
                "tool_index": tool_index,
            })

    def _handle_pattern_content(self, pattern_name: str, content_chunk: str) -> None:
        """Handle incremental pattern_content event."""
        if pattern_name == "message":
            # Accumulate content for holdback processing
            self._message_content_buffer += content_chunk

            # Apply holdback logic to prevent emitting partial closing tags like "</MES"
            MESSAGE_CLOSE = "</MESSAGE>"
            holdback_len = 0
            max_check = min(len(MESSAGE_CLOSE) - 1, len(self._message_content_buffer))
            for i in range(max_check, 0, -1):
                if MESSAGE_CLOSE.startswith(self._message_content_buffer[-i:]):
                    holdback_len = i
                    break

            # Emit only the safe content (excluding held-back portion)
            safe_end = len(self._message_content_buffer) - holdback_len
            if safe_end > self._message_emitted:
                new_text = self._message_content_buffer[self._message_emitted:safe_end]
                if new_text:
                    self._emit({
                        "iteration": self.iteration,
                        "segment": "agent_response",
                        "action": "append",
                        "text": new_text,
                    })
                    self._message_emitted = safe_end

        elif pattern_name == "tool_call":
            # Find the active tool state (most recent incomplete one)
            active_tool_state = None
            for state in reversed(list(self._tool_states.values())):
                if not state.get("complete"):
                    active_tool_state = state
                    break

            if active_tool_state:
                # Accumulate content in buffer
                active_tool_state["content_buffer"] += content_chunk
                # Process accumulated content to extract fields/params
                self._process_tool_content(active_tool_state)

    def _handle_pattern_end(self, pattern_name: str, pattern_type: str, full_content: str, tool_call: Any) -> None:
        """Handle pattern_end event."""
        if pattern_name == "message":
            if not self._message_complete:
                self._emit({
                    "iteration": self.iteration,
                    "segment": "agent_response",
                    "action": "complete",
                })
                self._message_complete = True

        elif pattern_name == "tool_call":
            # Find the active tool state
            active_tool_state = None
            for state in reversed(list(self._tool_states.values())):
                if not state.get("complete"):
                    active_tool_state = state
                    break

            if active_tool_state:
                # Final processing of content
                active_tool_state["content_buffer"] = full_content
                self._process_tool_content(active_tool_state, final=True)

                # Mark complete
                if not active_tool_state.get("complete"):
                    self._emit({
                        "iteration": self.iteration,
                        "segment": "tool_call",
                        "action": "complete",
                        "tool_index": active_tool_state["index"],
                    })
                    active_tool_state["complete"] = True

                    # Final auto-execution attempt
                    self._attempt_auto_exec(active_tool_state, require_complete=True)

    # ------------------------------------------------------------------
    # Tool content parsing (TOOL, REASON, PARAM tags)
    # ------------------------------------------------------------------
    def _process_tool_content(self, state: Dict[str, Any], final: bool = False) -> None:
        """
        Parse TOOL, REASON, and PARAM tags from accumulated tool_call content.

        Operates on content extracted by StreamingPatternExtractor.
        """
        content = state["content_buffer"]

        # Extract tool name
        if "tool" not in state["fields_emitted"]:
            tool_value = self._extract_tag(content, TOOL_OPEN, TOOL_CLOSE)
            if tool_value is not None:
                logger.debug(f"[ADAPTER-TOOL] Emitting tool name: {tool_value}")
                self._emit({
                    "iteration": self.iteration,
                    "segment": "tool_call",
                    "action": "field",
                    "field": "tool",
                    "value": tool_value,
                    "tool_index": state["index"],
                })
                state["fields_emitted"].add("tool")
                state["tool_name"] = tool_value

        # Extract reason
        if "reason" not in state["fields_emitted"]:
            reason_value = self._extract_tag(content, REASON_OPEN, REASON_CLOSE)
            if reason_value is not None:
                logger.debug(f"[ADAPTER-TOOL] Emitting reason: {reason_value[:50]}...")
                self._emit({
                    "iteration": self.iteration,
                    "segment": "tool_call",
                    "action": "field",
                    "field": "reason",
                    "value": reason_value,
                    "tool_index": state["index"],
                })
                state["fields_emitted"].add("reason")

        # Extract parameters - both streaming and complete
        self._process_params(state, content, final)

    def _process_params(self, state: Dict[str, Any], content: str, final: bool) -> None:
        """Process PARAM tags, handling both streaming and complete params."""
        # Find complete params
        param_matches = list(PARAM_PATTERN.finditer(content))

        # Track streaming params (incomplete - waiting for </PARAM>)
        search_pos = 0
        while True:
            param_open_match = re.search(r'<PARAM\s+name="([^"]+)">', content[search_pos:])
            if not param_open_match:
                break
            param_name = param_open_match.group(1)
            param_start = search_pos + param_open_match.end()

            # Check if there's a closing tag
            param_close_pos = content.find('</PARAM>', param_start)
            if param_close_pos == -1:
                # INCOMPLETE - still streaming! Emit incremental delta updates
                streaming_content = content[param_start:]
                last_sent_content = state["last_sent_param_content"].get(param_name, "")

                # Only emit if content has grown since last time
                if len(streaming_content) > len(last_sent_content):
                    # Check if this is append-only (common case for file.write)
                    if streaming_content.startswith(last_sent_content):
                        # Append-only: send delta
                        delta = streaming_content[len(last_sent_content):]
                        offset = len(last_sent_content)

                        self._emit({
                            "iteration": self.iteration,
                            "segment": "tool_call",
                            "action": "param_delta",
                            "name": param_name,
                            "delta": delta,
                            "offset": offset,
                            "tool_index": state["index"],
                            "complete": False,
                        })
                    else:
                        # Not append-only (rare) - send full content
                        self._emit({
                            "iteration": self.iteration,
                            "segment": "tool_call",
                            "action": "param_update",
                            "name": param_name,
                            "value": streaming_content,
                            "tool_index": state["index"],
                            "complete": False,
                        })

                    state["last_sent_param_content"][param_name] = streaming_content
                    state["streaming_params"][param_name] = len(streaming_content)
                    state["collected_params"][param_name] = streaming_content

                    # Auto-exec check for streaming params
                    if param_name in {"content", "new_content", "create_dirs"}:
                        self._attempt_auto_exec(state)
                break
            search_pos = param_close_pos + len('</PARAM>')

        # Emit complete params
        for match in param_matches:
            raw = match.group(0)
            if raw in state["params_emitted"]:
                continue
            param_name = match.group(1).strip()
            param_value = match.group(2).strip()
            state["params_emitted"].add(raw)

            # Clear streaming tracking for this param
            if param_name in state.get("streaming_params", {}):
                del state["streaming_params"][param_name]
            if param_name in state.get("last_sent_param_content", {}):
                del state["last_sent_param_content"][param_name]

            logger.debug(f"[ADAPTER-TOOL] ✓ Emitting complete param: {param_name}={len(param_value)}b")
            self._emit({
                "iteration": self.iteration,
                "segment": "tool_call",
                "action": "param",
                "name": param_name,
                "value": param_value,
                "tool_index": state["index"],
                "complete": True,
            })
            state["collected_params"][param_name] = param_value
            state["complete_params"].add(param_name)

            # Auto-exec check for complete params
            if param_name in {"file_path", "content", "new_content", "create_dirs"}:
                self._attempt_auto_exec(state)

    @staticmethod
    def _extract_tag(content: str, open_tag: str, close_tag: str) -> Any:
        """Extract content between tags."""
        start_idx = content.find(open_tag)
        if start_idx == -1:
            return None
        start_idx += len(open_tag)
        end_idx = content.find(close_tag, start_idx)
        if end_idx == -1:
            return None
        return content[start_idx:end_idx].strip()

    # ------------------------------------------------------------------
    # Auto-execution support
    # ------------------------------------------------------------------
    def _attempt_auto_exec(
        self,
        state: Dict[str, Any],
        require_complete: bool = False,
    ) -> None:
        """Attempt to auto-execute file.write or file.edit tools."""
        if not self._auto_exec_callback:
            return

        if "tool" not in state.get("fields_emitted", set()):
            return

        tool_name = state.get("tool_name")
        if not tool_name or tool_name not in self._AUTO_EXECUTE_TOOLS:
            return

        is_streaming_tool = tool_name == "file.write"
        if not is_streaming_tool and not require_complete:
            return

        # Get params snapshot
        params_snapshot = dict(state.get("collected_params") or {})

        file_path = params_snapshot.get("file_path")
        if not file_path:
            return

        # Ensure file_path is complete
        if "file_path" in state.get("streaming_params", {}):
            return

        complete_params = state.get("complete_params", set())
        if "file_path" not in complete_params:
            return

        if tool_name == "file.write":
            content_value = params_snapshot.get("content")
            if content_value is None:
                return
            # Use content hash to prevent false deduplication
            signature = hashlib.sha256(content_value.encode('utf-8')).hexdigest()
            if signature == state.get("last_auto_exec_signature"):
                return
            state["last_auto_exec_signature"] = signature

        tool_call_id = f"auto_exec_iter{self.iteration}_tool{state['index']}"
        try:
            self._auto_exec_callback(tool_name, params_snapshot, tool_call_id)
        except Exception as exc:
            logger.error(f"[AUTO-EXEC-TRIGGER] Failed to trigger auto-execution: {exc}", exc_info=True)

    # ------------------------------------------------------------------
    # Helper methods
    # ------------------------------------------------------------------
    def _complete_thoughts(self) -> None:
        """Mark thoughts as complete."""
        if self._thoughts_started and not self._thoughts_complete:
            self._emit({
                "iteration": self.iteration,
                "segment": "thoughts",
                "action": "complete",
            })
            self._thoughts_complete = True
