import re
from typing import Any, Callable, Dict, List, Set
from utils.logger import get_logger

logger = get_logger(__name__)


MESSAGE_OPEN = "<MESSAGE>"
MESSAGE_CLOSE = "</MESSAGE>"
TOOL_CALL_OPEN = "<TOOL_CALL>"
TOOL_CALL_CLOSE = "</TOOL_CALL>"
TOOL_OPEN = "<TOOL>"
TOOL_CLOSE = "</TOOL>"
REASON_OPEN = "<REASON>"
REASON_CLOSE = "</REASON>"
PARAM_PATTERN = re.compile(r'<PARAM\s+name="([^"]+)">(.*?)</PARAM>', re.DOTALL)


class CoderStreamParser:
    """
    Incrementally parse the coder domain's response and emit
    granular streaming events for the frontend while the model response is
    still streaming.
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
        self._buffer: str = ""

        self._thoughts_started = False
        self._thoughts_complete = False

        self._message_started = False
        self._message_start_offset = 0
        self._message_emitted = 0
        self._message_complete = False

        self._tool_search_pos = 0
        self._tool_states: List[Dict[str, Any]] = []

        # Tools that should be auto-executed
        self._AUTO_EXECUTE_TOOLS = {"file.write", "file.edit"}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def handle_thoughts(self, text: str) -> None:
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
        if not text:
            return

        self._buffer += text
        self._process_message()
        self._process_tool_calls()

    def finalize(self) -> None:
        """
        Ensure any partially streamed sections are marked complete when the
        agent response finishes.
        """
        # Process any remaining buffered data one last time
        self._process_message()
        self._process_tool_calls()

        # Thoughts conclude once the message stream has ended
        self._complete_thoughts()

        if self._message_started and not self._message_complete:
            self._emit({
                "iteration": self.iteration,
                "segment": "agent_response",
                "action": "complete",
            })
            self._message_complete = True

        for state in self._tool_states:
            if not state.get("complete"):
                self._emit({
                    "iteration": self.iteration,
                    "segment": "tool_call",
                    "action": "complete",
                    "tool_index": state["index"],
                })
                state["complete"] = True

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _complete_thoughts(self) -> None:
        if self._thoughts_started and not self._thoughts_complete:
            self._emit({
                "iteration": self.iteration,
                "segment": "thoughts",
                "action": "complete",
            })
            self._thoughts_complete = True

    def _process_message(self) -> None:
        if self._message_complete:
            return

        if not self._message_started:
            start_idx = self._buffer.find(MESSAGE_OPEN)
            if start_idx != -1:
                self._message_started = True
                self._message_start_offset = start_idx + len(MESSAGE_OPEN)
                self._emit({
                    "iteration": self.iteration,
                    "segment": "agent_response",
                    "action": "start",
                })
                # Agent response follows the reasoning stream
                self._complete_thoughts()

        if not self._message_started:
            return

        close_idx = self._buffer.find(MESSAGE_CLOSE, self._message_start_offset)
        if close_idx == -1:
            content = self._buffer[self._message_start_offset:]
            # Hold back potential partial closing tag to avoid emitting "</MES" etc.
            # Find longest suffix of content that matches prefix of "</MESSAGE>"
            holdback = 0
            max_check = min(len(MESSAGE_CLOSE) - 1, len(content))
            for i in range(max_check, 0, -1):
                if MESSAGE_CLOSE.startswith(content[-i:]):
                    holdback = i
                    break
            if holdback > 0:
                content = content[:-holdback]
        else:
            content = self._buffer[self._message_start_offset:close_idx]

        if len(content) > self._message_emitted:
            new_text = content[self._message_emitted:]
            if new_text:
                self._emit({
                    "iteration": self.iteration,
                    "segment": "agent_response",
                    "action": "append",
                    "text": new_text,
                })
                self._message_emitted += len(new_text)

        if close_idx != -1 and not self._message_complete:
            self._emit({
                "iteration": self.iteration,
                "segment": "agent_response",
                "action": "complete",
            })
            self._message_complete = True

    def _process_tool_calls(self) -> None:
        while True:
            start_idx = self._buffer.find(TOOL_CALL_OPEN, self._tool_search_pos)
            if start_idx == -1:
                break

            content_start = start_idx + len(TOOL_CALL_OPEN)
            tool_state = {
                "index": len(self._tool_states),
                "content_start": content_start,
                "fields_emitted": set(),  # type: Set[str]
                "params_emitted": set(),  # type: Set[str]
                "complete": False,
                "collected_params": {},
                "streaming_params": {},
                "complete_params": set(),
                "last_auto_exec_signature": None,
            }
            self._tool_states.append(tool_state)
            self._tool_search_pos = content_start

            self._emit({
                "iteration": self.iteration,
                "segment": "tool_call",
                "action": "start",
                "tool_index": tool_state["index"],
            })

        for state in self._tool_states:
            if state.get("complete"):
                continue
            self._process_tool_state(state)

    def _process_tool_state(self, state: Dict[str, Any]) -> None:
        content_start = state["content_start"]
        close_idx = self._buffer.find(TOOL_CALL_CLOSE, content_start)
        if close_idx == -1:
            content_end = len(self._buffer)
        else:
            content_end = close_idx

        content = self._buffer[content_start:content_end]

        # Tool name
        if "tool" not in state["fields_emitted"]:
            tool_value = self._extract_tag(content, TOOL_OPEN, TOOL_CLOSE)
            if tool_value is not None:
                logger.debug(f"[PARSER-TOOL] Emitting tool name: {tool_value}")
                self._emit({
                    "iteration": self.iteration,
                    "segment": "tool_call",
                    "action": "field",
                    "field": "tool",
                    "value": tool_value,
                    "tool_index": state["index"],
                })
                state["fields_emitted"].add("tool")
                state["tool_name"] = tool_value  # Store for auto-execution check

        # Reason text
        if "reason" not in state["fields_emitted"]:
            reason_value = self._extract_tag(content, REASON_OPEN, REASON_CLOSE)
            if reason_value is not None:
                logger.debug(f"[PARSER-TOOL] Emitting reason: {reason_value[:50]}...")
            self._emit({
                "iteration": self.iteration,
                "segment": "tool_call",
                "action": "field",
                "field": "reason",
                "value": reason_value,
                "tool_index": state["index"],
            })
            state["fields_emitted"].add("reason")

        # Parameters - find complete params
        param_matches = list(PARAM_PATTERN.finditer(content))

        # Track and emit STREAMING params (incomplete - waiting for </PARAM>)
        # Initialize streaming_params tracking if not present
        if "streaming_params" not in state:
            state["streaming_params"] = {}  # type: Dict[str, int]

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
                # INCOMPLETE - still streaming! Emit incremental updates
                streaming_content = content[param_start:]
                last_emitted_size = state["streaming_params"].get(param_name, 0)

                # Only emit if content has grown since last time
                if len(streaming_content) > last_emitted_size:
                    self._emit({
                        "iteration": self.iteration,
                        "segment": "tool_call",
                        "action": "param_update",  # NEW ACTION for streaming params
                        "name": param_name,
                        "value": streaming_content,
                        "tool_index": state["index"],
                        "complete": False,
                    })
                    state["streaming_params"][param_name] = len(streaming_content)
                    state["collected_params"][param_name] = streaming_content
                    if param_name in {"content", "new_content", "create_dirs"}:
                        self._attempt_auto_exec(state, content)
                break
            search_pos = param_close_pos + len('</PARAM>')

        # Emit COMPLETE params
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

            logger.debug(f"[PARSER-TOOL] ✓ Emitting complete param: {param_name}={len(param_value)}b")
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
            if param_name in {"file_path", "content", "new_content", "create_dirs"}:
                self._attempt_auto_exec(state, content)

        if close_idx != -1 and not state.get("complete"):
            self._emit({
                "iteration": self.iteration,
                "segment": "tool_call",
                "action": "complete",
                "tool_index": state["index"],
            })
            state["complete"] = True

            self._attempt_auto_exec(state, content, require_complete=True)

    @staticmethod
    def _preserve_whitespace(param_name: str) -> bool:
        return param_name in {"content", "new_content"}

    def _attempt_auto_exec(
        self,
        state: Dict[str, Any],
        content: str,
        require_complete: bool = False,
    ) -> None:
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

        # Get params from PARAM tags only (no simplified tag support)
        params_snapshot = dict(state.get("collected_params") or {})

        file_path = params_snapshot.get("file_path")
        if not file_path:
            return

        if "file_path" in state.get("streaming_params", {}):
            return

        complete_params = state.get("complete_params", set())
        if "file_path" not in complete_params:
            return

        if tool_name == "file.write":
            content_value = params_snapshot.get("content")
            if content_value is None:
                return
            signature = len(content_value)
            if signature == state.get("last_auto_exec_signature"):
                return
            state["last_auto_exec_signature"] = signature

        tool_call_id = f"auto_exec_iter{self.iteration}_tool{state['index']}"
        try:
            self._auto_exec_callback(tool_name, params_snapshot, tool_call_id)
        except Exception as exc:
            logger.error(f"[AUTO-EXEC-TRIGGER] Failed to trigger auto-execution: {exc}", exc_info=True)

    @staticmethod
    def _extract_tag(content: str, open_tag: str, close_tag: str) -> Any:
        start_idx = content.find(open_tag)
        if start_idx == -1:
            return None
        start_idx += len(open_tag)
        end_idx = content.find(close_tag, start_idx)
        if end_idx == -1:
            return None
        return content[start_idx:end_idx].strip()
