import re
from typing import Any, Callable, Dict, List, Set


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
    Incrementally parse the coder domain's AGENT_DECISION payload and emit
    granular streaming events for the frontend while the model response is
    still streaming.
    """

    def __init__(self, iteration: int, emitter: Callable[[Dict[str, Any]], None]):
        self.iteration = iteration
        self._emit = emitter
        self._buffer: str = ""

        self._thoughts_started = False
        self._thoughts_complete = False

        self._message_started = False
        self._message_start_offset = 0
        self._message_emitted = 0
        self._message_complete = False

        self._tool_search_pos = 0
        self._tool_states: List[Dict[str, Any]] = []

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
                self._emit({
                    "iteration": self.iteration,
                    "segment": "tool_call",
                    "action": "field",
                    "field": "tool",
                    "value": tool_value,
                    "tool_index": state["index"],
                })
                state["fields_emitted"].add("tool")

        # Reason text
        if "reason" not in state["fields_emitted"]:
            reason_value = self._extract_tag(content, REASON_OPEN, REASON_CLOSE)
            if reason_value is not None:
                self._emit({
                    "iteration": self.iteration,
                    "segment": "tool_call",
                    "action": "field",
                    "field": "reason",
                    "value": reason_value,
                    "tool_index": state["index"],
                })
                state["fields_emitted"].add("reason")

        # Parameters
        for match in PARAM_PATTERN.finditer(content):
            raw = match.group(0)
            if raw in state["params_emitted"]:
                continue
            param_name = match.group(1).strip()
            param_value = match.group(2).strip()
            state["params_emitted"].add(raw)
            self._emit({
                "iteration": self.iteration,
                "segment": "tool_call",
                "action": "param",
                "name": param_name,
                "value": param_value,
                "tool_index": state["index"],
            })

        if close_idx != -1 and not state.get("complete"):
            self._emit({
                "iteration": self.iteration,
                "segment": "tool_call",
                "action": "complete",
                "tool_index": state["index"],
            })
            state["complete"] = True

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
