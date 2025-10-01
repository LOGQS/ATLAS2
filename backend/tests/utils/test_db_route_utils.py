"""Unit tests for database route utilities."""

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

backend_dir = Path(__file__).resolve().parents[2]
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from utils.db_route_utils import (
    DBRouteConstants,
    ResponseBuilder,
    validate_api_parameters,
    handle_route_error,
    ensure_chat_exists,
    get_request_data
)


class TestDBRouteConstants(unittest.TestCase):
    """Test constants are properly defined."""

    def test_constants_are_defined(self):
        """All expected constants should be defined with correct types."""
        self.assertIsInstance(DBRouteConstants.MAX_PARAM_LENGTH, int)
        self.assertGreater(DBRouteConstants.MAX_PARAM_LENGTH, 0)

        self.assertIsInstance(DBRouteConstants.DEFAULT_ACTIVE_CHAT, str)
        self.assertIsInstance(DBRouteConstants.TEMP_MESSAGE_PREFIX, str)

        self.assertIsInstance(DBRouteConstants.CANCELLATION_SLEEP_TIME, (int, float))
        self.assertGreater(DBRouteConstants.CANCELLATION_SLEEP_TIME, 0)

        self.assertIsInstance(DBRouteConstants.IMPORT_ID_RANDOM_MIN, int)
        self.assertIsInstance(DBRouteConstants.IMPORT_ID_RANDOM_MAX, int)
        self.assertLess(DBRouteConstants.IMPORT_ID_RANDOM_MIN, DBRouteConstants.IMPORT_ID_RANDOM_MAX)

        self.assertIsInstance(DBRouteConstants.CHAT_NOT_FOUND, str)
        self.assertIsInstance(DBRouteConstants.REQUEST_BODY_REQUIRED, str)
        self.assertIsInstance(DBRouteConstants.INVALID_MESSAGE_ID, str)
        self.assertIsInstance(DBRouteConstants.CHAT_ID_REQUIRED, str)
        self.assertIsInstance(DBRouteConstants.MESSAGE_ID_REQUIRED, str)


class TestResponseBuilder(unittest.TestCase):
    """Test response builder utility."""

    @patch('utils.db_route_utils.jsonify')
    def test_success_with_message_only(self, mock_jsonify):
        """success() with message should build response with message."""
        ResponseBuilder.success(message="Operation successful")

        mock_jsonify.assert_called_once()
        call_args = mock_jsonify.call_args[0][0]
        self.assertEqual(call_args['message'], "Operation successful")

    @patch('utils.db_route_utils.jsonify')
    def test_success_with_data_dict(self, mock_jsonify):
        """success() with data should include all data fields."""
        data = {"id": 123, "name": "test", "status": "active"}
        ResponseBuilder.success(data=data)

        mock_jsonify.assert_called_once()
        call_args = mock_jsonify.call_args[0][0]
        self.assertEqual(call_args['id'], 123)
        self.assertEqual(call_args['name'], "test")
        self.assertEqual(call_args['status'], "active")

    @patch('utils.db_route_utils.jsonify')
    def test_success_with_message_and_data(self, mock_jsonify):
        """success() with both message and data should include both."""
        data = {"count": 5}
        ResponseBuilder.success(message="Done", data=data)

        mock_jsonify.assert_called_once()
        call_args = mock_jsonify.call_args[0][0]
        self.assertEqual(call_args['message'], "Done")
        self.assertEqual(call_args['count'], 5)

    @patch('utils.db_route_utils.jsonify')
    def test_success_with_kwargs(self, mock_jsonify):
        """success() with kwargs should include all kwargs."""
        ResponseBuilder.success(custom_field="value", another_field=42)

        mock_jsonify.assert_called_once()
        call_args = mock_jsonify.call_args[0][0]
        self.assertEqual(call_args['custom_field'], "value")
        self.assertEqual(call_args['another_field'], 42)

    @patch('utils.db_route_utils.jsonify')
    def test_error_returns_error_structure(self, mock_jsonify):
        """error() should return error dict with status code."""
        mock_jsonify.return_value = "mocked_response"

        result = ResponseBuilder.error("Something went wrong", 500)

        self.assertEqual(result, ("mocked_response", 500))
        mock_jsonify.assert_called_once_with({'error': "Something went wrong"})

    @patch('utils.db_route_utils.jsonify')
    def test_error_default_status_code(self, mock_jsonify):
        """error() without status code should default to 400."""
        mock_jsonify.return_value = "mocked_response"

        result = ResponseBuilder.error("Bad request")

        self.assertEqual(result, ("mocked_response", 400))


class TestValidateApiParameters(unittest.TestCase):
    """Test API parameter validation."""

    def test_validates_required_parameters_present(self):
        """All required parameters present should pass validation."""
        is_valid, error = validate_api_parameters(
            message_id="chat_1_5",
            chat_id="chat_1"
        )

        self.assertTrue(is_valid)
        self.assertEqual(error, "")

    def test_rejects_none_parameter(self):
        """None parameter should fail validation."""
        is_valid, error = validate_api_parameters(
            message_id=None,
            chat_id="chat_1"
        )

        self.assertFalse(is_valid)
        self.assertIn("message_id", error)
        self.assertIn("required", error)

    def test_rejects_empty_message_id(self):
        """Empty message_id should fail validation."""
        is_valid, error = validate_api_parameters(
            message_id=""
        )

        self.assertFalse(is_valid)
        self.assertIn("message_id", error)
        self.assertIn("empty", error.lower())

    def test_rejects_whitespace_only_message_id(self):
        """Whitespace-only message_id should fail validation."""
        is_valid, error = validate_api_parameters(
            message_id="   "
        )

        self.assertFalse(is_valid)
        self.assertIn("message_id", error)

    def test_rejects_message_id_without_underscore(self):
        """message_id without underscore should fail validation."""
        is_valid, error = validate_api_parameters(
            message_id="invalidformat"
        )

        self.assertFalse(is_valid)
        self.assertIn("message_id", error)
        self.assertIn("chatid_position", error)

    def test_accepts_valid_message_id_format(self):
        """message_id with chatid_position format should pass."""
        is_valid, error = validate_api_parameters(
            message_id="chat_123_position_456"
        )

        self.assertTrue(is_valid)

    def test_rejects_message_id_exceeding_max_length(self):
        """message_id longer than MAX_PARAM_LENGTH should fail."""
        long_id = "chat_" + "x" * DBRouteConstants.MAX_PARAM_LENGTH

        is_valid, error = validate_api_parameters(
            message_id=long_id
        )

        self.assertFalse(is_valid)
        self.assertIn("message_id", error)
        self.assertIn("too long", error)

    def test_rejects_empty_chat_id(self):
        """Empty chat_id should fail validation."""
        is_valid, error = validate_api_parameters(
            chat_id=""
        )

        self.assertFalse(is_valid)
        self.assertIn("chat_id", error)
        self.assertIn("empty", error.lower())

    def test_rejects_whitespace_only_chat_id(self):
        """Whitespace-only chat_id should fail validation."""
        is_valid, error = validate_api_parameters(
            chat_id="   \t\n  "
        )

        self.assertFalse(is_valid)
        self.assertIn("chat_id", error)

    def test_rejects_chat_id_exceeding_max_length(self):
        """chat_id longer than MAX_PARAM_LENGTH should fail."""
        long_id = "x" * (DBRouteConstants.MAX_PARAM_LENGTH + 1)

        is_valid, error = validate_api_parameters(
            chat_id=long_id
        )

        self.assertFalse(is_valid)
        self.assertIn("chat_id", error)
        self.assertIn("too long", error)

    def test_accepts_valid_chat_id(self):
        """Valid chat_id should pass validation."""
        is_valid, error = validate_api_parameters(
            chat_id="chat_123_valid"
        )

        self.assertTrue(is_valid)

    def test_validates_multiple_parameters(self):
        """Multiple parameters should all be validated."""
        is_valid, error = validate_api_parameters(
            message_id="chat_1_5",
            chat_id="chat_1",
            other_param="value"
        )

        self.assertTrue(is_valid)


class TestHandleRouteError(unittest.TestCase):
    """Test route error handling."""

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_handle_route_error_builds_error_response(self, mock_error_builder):
        """handle_route_error should build error response."""
        mock_error_builder.return_value = ("error_response", 500)
        mock_logger = Mock()

        exception = ValueError("Test error")
        result = handle_route_error(
            operation="testing",
            error=exception,
            context={"file_id": "123"},
            logger=mock_logger
        )

        self.assertEqual(result, ("error_response", 500))
        mock_error_builder.assert_called_once_with("Test error", 500)

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_handle_route_error_logs_with_context(self, mock_error_builder):
        """Error message should include context information."""
        mock_error_builder.return_value = ("error_response", 500)
        mock_logger = Mock()

        exception = ValueError("Test error")
        handle_route_error(
            operation="uploading file",
            error=exception,
            context={"file_id": "123", "user": "test_user"},
            logger=mock_logger
        )

        mock_logger.error.assert_called_once()
        logged_message = mock_logger.error.call_args[0][0]
        self.assertIn("uploading file", logged_message)
        self.assertIn("file_id=123", logged_message)
        self.assertIn("user=test_user", logged_message)
        self.assertIn("Test error", logged_message)

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_handle_route_error_works_without_logger(self, mock_error_builder):
        """handle_route_error should work without logger."""
        mock_error_builder.return_value = ("error_response", 500)

        exception = ValueError("Test error")
        result = handle_route_error(
            operation="testing",
            error=exception
        )

        self.assertEqual(result, ("error_response", 500))

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_handle_route_error_works_without_context(self, mock_error_builder):
        """handle_route_error should work without context."""
        mock_error_builder.return_value = ("error_response", 500)
        mock_logger = Mock()

        exception = ValueError("Test error")
        result = handle_route_error(
            operation="testing",
            error=exception,
            logger=mock_logger
        )

        self.assertEqual(result, ("error_response", 500))
        mock_logger.error.assert_called_once()


class TestEnsureChatExists(unittest.TestCase):
    """Test chat existence validation."""

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_returns_none_when_chat_exists(self, mock_error_builder):
        """Should return None when chat exists."""
        mock_db = Mock()
        mock_db.chat_exists.return_value = True

        result = ensure_chat_exists("chat_1", mock_db)

        self.assertIsNone(result)
        mock_db.chat_exists.assert_called_once_with("chat_1")
        mock_error_builder.assert_not_called()

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_returns_error_when_chat_not_found(self, mock_error_builder):
        """Should return error response when chat doesn't exist."""
        mock_error_builder.return_value = ("error_response", 404)
        mock_db = Mock()
        mock_db.chat_exists.return_value = False

        result = ensure_chat_exists("chat_nonexistent", mock_db)

        self.assertEqual(result, ("error_response", 404))
        mock_db.chat_exists.assert_called_once_with("chat_nonexistent")
        mock_error_builder.assert_called_once_with(DBRouteConstants.CHAT_NOT_FOUND, 404)


class TestGetRequestData(unittest.TestCase):
    """Test request data extraction and validation."""

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_extracts_json_data_successfully(self, mock_error_builder):
        """Should extract JSON data from request."""
        mock_request = Mock()
        mock_request.get_json.return_value = {"key": "value", "number": 42}

        data, error = get_request_data(mock_request)

        self.assertEqual(data, {"key": "value", "number": 42})
        self.assertIsNone(error)
        mock_error_builder.assert_not_called()

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_returns_error_when_no_json_and_required_fields(self, mock_error_builder):
        """Should return error when no JSON and fields are required."""
        mock_error_builder.return_value = ("error_response", 400)
        mock_request = Mock()
        mock_request.get_json.return_value = None

        data, error = get_request_data(mock_request, required_fields=["field1"])

        self.assertIsNone(data)
        self.assertEqual(error, ("error_response", 400))
        mock_error_builder.assert_called_once()

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_accepts_empty_json_when_no_required_fields(self, mock_error_builder):
        """Should accept None/empty JSON when no fields are required."""
        mock_request = Mock()
        mock_request.get_json.return_value = None

        data, error = get_request_data(mock_request, required_fields=None)

        self.assertIsNone(data)
        self.assertIsNone(error)
        mock_error_builder.assert_not_called()

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_validates_required_fields_present(self, mock_error_builder):
        """Should validate that all required fields are present."""
        mock_request = Mock()
        mock_request.get_json.return_value = {
            "field1": "value1",
            "field2": "value2",
            "field3": "value3"
        }

        data, error = get_request_data(
            mock_request,
            required_fields=["field1", "field2", "field3"]
        )

        self.assertEqual(data["field1"], "value1")
        self.assertEqual(data["field2"], "value2")
        self.assertEqual(data["field3"], "value3")
        self.assertIsNone(error)

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_returns_error_when_required_field_missing(self, mock_error_builder):
        """Should return error when required field is missing."""
        mock_error_builder.return_value = ("error_response", 400)
        mock_request = Mock()
        mock_request.get_json.return_value = {"field1": "value1"}

        data, error = get_request_data(
            mock_request,
            required_fields=["field1", "field2"]
        )

        self.assertIsNone(data)
        self.assertEqual(error, ("error_response", 400))

        call_args = mock_error_builder.call_args[0][0]
        self.assertIn("field2", call_args)
        self.assertIn("required", call_args)

    @patch('utils.db_route_utils.ResponseBuilder.error')
    def test_returns_error_when_required_field_is_none(self, mock_error_builder):
        """Should return error when required field is present but None."""
        mock_error_builder.return_value = ("error_response", 400)
        mock_request = Mock()
        mock_request.get_json.return_value = {"field1": "value1", "field2": None}

        data, error = get_request_data(
            mock_request,
            required_fields=["field1", "field2"]
        )

        self.assertIsNone(data)
        self.assertEqual(error, ("error_response", 400))

        call_args = mock_error_builder.call_args[0][0]
        self.assertIn("field2", call_args)
        self.assertIn("required", call_args)


if __name__ == "__main__":
    unittest.main()
