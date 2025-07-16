# status: to clean up later

import json
from google.genai import types
from openai import OpenAI
from utils.prompts import summary_system_instruction, full_classifier_prompt
from utils.logger import safe_debug, safe_info, safe_warning, safe_error, safe_exception
from utils.extra import initialize_whisper_model
import re

client = None
openrouter_client = None
groq_client = None
GEMINI_API_KEY = None
OPENROUTER_API_KEY = None
GROQ_API_KEY = None
settings = None
whisper_model = None

def initialize_ai_functions(app_client, app_openrouter_client, app_groq_client, 
                           app_gemini_key, app_openrouter_key, app_groq_key, 
                           app_settings, app_whisper_model):
    """Initialize global variables from app.py"""
    global client, openrouter_client, groq_client, GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, settings, whisper_model
    client = app_client
    openrouter_client = app_openrouter_client
    groq_client = app_groq_client
    GEMINI_API_KEY = app_gemini_key
    OPENROUTER_API_KEY = app_openrouter_key
    GROQ_API_KEY = app_groq_key
    settings = app_settings
    whisper_model = app_whisper_model

def load_whisper_model():
    """
    Get the Whisper model - either the global one or initialize if needed
    """
    global whisper_model
    if whisper_model is None:
        safe_info("Whisper model not initialized at startup, loading now...")
        try:
            return initialize_whisper_model()
        except Exception as e:
            safe_exception(f"Error loading Whisper model: {str(e)}", e)
            raise e
    return whisper_model

def check_gemini_client():
    """
    Check if Gemini client is available and return an error response if not
    """
    if client is None:
        return {"error": "Gemini API client not available. Please check your GEMINI_API_KEY environment variable."}, 503
    return None, None

def is_openrouter_model(model_name):
    """
    Check if the given model name is an OpenRouter model
    """
    openrouter_models = ["deepseek/deepseek-r1-0528:free", "tngtech/deepseek-r1t-chimera:free", "deepseek/deepseek-chat-v3-0324:free", "qwen/qwen3-30b-a3b:free"]
    return model_name in openrouter_models

def is_groq_model(model_name):
    """
    Check if the given model name is a Groq model
    """
    groq_models = ["llama-3.3-70b-versatile", "qwen-qwq-32b"]
    return model_name in groq_models

def is_gemini_model(model_name):
    """
    Check if the given model name is a Gemini model
    """
    return model_name.startswith("gemini-")

def supports_file_attachments(model_name):
    """
    Check if the model supports file attachments
    """
    return is_gemini_model(model_name)

def get_openai_client_for_model(model_name):
    """
    Get the appropriate OpenAI client based on the model type
    """
    if is_groq_model(model_name):
        if not GROQ_API_KEY:
            raise Exception("Groq API key not available")
        return OpenAI(
            base_url="https://api.groq.com/openai/v1",
            api_key=GROQ_API_KEY,
        )
    elif is_openrouter_model(model_name):
        if not openrouter_client:
            raise Exception("OpenRouter client not available")
        return openrouter_client
    elif is_gemini_model(model_name):
        if not GEMINI_API_KEY:
            raise Exception("Gemini API key not available")
        return OpenAI(
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key=GEMINI_API_KEY,
        )
    else:
        raise Exception(f"No client available for model: {model_name}")

def generate_chat_summary(messages, model_name):
    """Generate a summary of the conversation using Gemini Flash"""
    summary_model = "gemini-2.5-flash-preview-05-20"
    
    try:
        if client is None:
            safe_error("Gemini client not available")
            return "Failed to generate summary: Gemini client not available"

        conversation_parts = [summary_system_instruction + "\n\nConversation to summarize:"]

        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")
            if role in ["user", "assistant"] and content.strip():
                conversation_parts.append(f"{role.title()}: {content}")

        full_prompt = "\n\n".join(conversation_parts)
        
        response = client.models.generate_content(
            model=summary_model,
            contents=[full_prompt],
            config=types.GenerateContentConfig(
                safety_settings=[
                    {
                        "category": "HARM_CATEGORY_HARASSMENT",
                        "threshold": "BLOCK_NONE"
                    },
                    {
                        "category": "HARM_CATEGORY_HATE_SPEECH",
                        "threshold": "BLOCK_NONE"
                    },
                    {
                        "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                        "threshold": "BLOCK_NONE"
                    },
                    {
                        "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                        "threshold": "BLOCK_NONE"
                    }
                ]
            )
        )

        if response and response.candidates and len(response.candidates) > 0:
            candidate = response.candidates[0]
            if hasattr(candidate, 'content') and hasattr(candidate.content, 'parts') and len(candidate.content.parts) > 0:
                summary = candidate.content.parts[0].text.strip()
                safe_debug(f"Summary generated successfully, length: {len(summary)} chars")
                return summary
            else:
                safe_error("No content found in Gemini response")
                return "Failed to generate summary: No content in response"
        else:
            safe_error(f"Invalid response format from Gemini API. Response: {response}")
            return "Failed to generate summary: Invalid response format"
    except Exception as e:
        safe_exception(f"Error in generate_chat_summary: {str(e)}", e)
        return f"Failed to generate summary: {str(e)}"

class GeminiToOpenAIAdapter:
    """Adapter to make Gemini streaming responses compatible with OpenAI format"""
    def __init__(self, gemini_stream):
        self.gemini_stream = gemini_stream
    
    def __iter__(self):
        return self
    
    def __next__(self):
        try:
            chunk = next(self.gemini_stream)
            return self._convert_chunk(chunk)
        except StopIteration:
            raise
    
    def _convert_chunk(self, gemini_chunk):
        """Convert Gemini chunk to OpenAI-compatible chunk"""
        class MockChoice:
            def __init__(self, content):
                self.delta = MockDelta(content)
        
        class MockDelta:
            def __init__(self, content):
                self.content = content
        
        class MockChunk:
            def __init__(self, content):
                self.choices = [MockChoice(content)]
        
        content = getattr(gemini_chunk, 'text', '') if hasattr(gemini_chunk, 'text') else ''
        return MockChunk(content)

def should_include_creations_prompt(messages):
    """
    Use gemini-2.0-flash-lite as a classifier to determine if creations prompt should be included
    Returns True if creations prompt should be included, False otherwise
    """
    try:
        if not messages or not client:
            return True
        
        safe_info("[CLASSIFIER] Starting creations prompt classification")
        
        conversation_parts = []
        current_user_request = ""
        
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")
            if role in ["user", "assistant"] and content.strip():
                truncated_content = content[:500] + "..." if len(content) > 500 else content
                conversation_parts.append(f"{role.title()}: {truncated_content}")
                
                if role == "user":
                    current_user_request = content

        classifier_prompt = full_classifier_prompt
        
        past_context = "\n".join(conversation_parts[:-1]) if len(conversation_parts) > 1 else "No previous context"
        
        current_request_section = f"""

CURRENT USER REQUEST (make your decision based on THIS):
User: {current_user_request}

Analyze the CURRENT USER REQUEST above and return your JSON response:"""
        
        full_prompt = classifier_prompt + past_context + current_request_section
        
        response = client.models.generate_content(
            model="gemini-2.0-flash-lite",
            contents=[full_prompt],
            config=types.GenerateContentConfig(
                temperature=0.1,
                response_mime_type="application/json"
            )
        )
        
        if response and response.candidates and len(response.candidates) > 0:
            candidate = response.candidates[0]
            if hasattr(candidate, 'content') and hasattr(candidate.content, 'parts') and len(candidate.content.parts) > 0:
                result_text = candidate.content.parts[0].text.strip()
                safe_info(f"[CLASSIFIER] Raw response: {result_text[:200]}...")
                
                
                json_match = re.search(r'```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```', result_text, re.DOTALL)
                if json_match:
                    result_text = json_match.group(1)
                    safe_info("[CLASSIFIER] Extracted JSON from markdown wrapper")
                
                try:
                    result = json.loads(result_text)
                    
                    if isinstance(result, list):
                        for item in result:
                            if isinstance(item, dict) and "include_creations" in item:
                                include_creations = item.get("include_creations", True)
                                user_understanding = item.get("user_request_understanding", "No understanding provided")
                                reasoning = item.get("reasoning", "No reasoning provided")
                                safe_info(f"[CLASSIFIER] Decision from array: include_creations = {include_creations}")
                                safe_info(f"[CLASSIFIER] User Request Understanding: {user_understanding}")
                                safe_info(f"[CLASSIFIER] Reasoning: {reasoning}")
                                return include_creations
                        # If no valid object found in array, try regex fallback
                        safe_warning("[CLASSIFIER] No valid object found in JSON array, trying regex fallback")
                    elif isinstance(result, dict):
                        include_creations = result.get("include_creations", True)
                        user_understanding = result.get("user_request_understanding", "No understanding provided")
                        reasoning = result.get("reasoning", "No reasoning provided")
                        safe_info(f"[CLASSIFIER] Decision from object: include_creations = {include_creations}")
                        safe_info(f"[CLASSIFIER] User Request Understanding: {user_understanding}")
                        safe_info(f"[CLASSIFIER] Reasoning: {reasoning}")
                        return include_creations
                    else:
                        safe_warning(f"[CLASSIFIER] Unexpected JSON type: {type(result)}, trying regex fallback")
                    
                except json.JSONDecodeError as e:
                    safe_warning(f"[CLASSIFIER] Failed to parse JSON response: {e}, trying regex fallback")
                
                # Robust regex fallback to find the include_creations value
                # Look for patterns like "include_creations": true/false or 'include_creations': true/false
                include_pattern = re.search(r'["\']include_creations["\']\s*:\s*(true|false)', result_text, re.IGNORECASE)
                if include_pattern:
                    include_creations = include_pattern.group(1).lower() == 'true'
                    safe_info(f"[CLASSIFIER] Decision from regex extraction: include_creations = {include_creations}")
                    return include_creations
                
                safe_warning("[CLASSIFIER] Could not extract include_creations value, defaulting to True")
                return True
        
        safe_warning("[CLASSIFIER] No valid response from classifier, defaulting to include")
        return True
        
    except Exception as e:
        safe_warning(f"[CLASSIFIER] Error in classification: {e}")
        return True  # Default to including on any error

def create_unified_chat_response(messages, model_name, system_instruction=None, files=None, temperature=None, max_tokens=None):
    """
    Create a chat response using unified OpenAI-compatible APIs for all providers
    """
    client_for_model = get_openai_client_for_model(model_name)
    
    # Convert messages to OpenAI format
    openai_messages = []
    
    # Add system message first if provided
    if system_instruction:
        openai_messages.append({
            "role": "system",
            "content": system_instruction
        })
    
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content", "")
        
        # Convert role if needed
        if role == "assistant":
            role = "assistant"
        elif role == "user":
            role = "user"
        else:
            continue  # Skip unsupported roles
            
        openai_messages.append({
            "role": role,
            "content": content
        })
    
    # Create request parameters
    params = {
        "model": model_name,
        "messages": openai_messages,
        "stream": True
    }
    if temperature is not None:
        params["temperature"] = float(temperature)
    if max_tokens is not None:
        params["max_tokens"] = int(max_tokens)
    
    # Add reasoning tokens for OpenRouter models that support it
    if is_openrouter_model(model_name):
        params["extra_body"] = {"include_reasoning": True}
    
    # Use the OpenAI client to create the response
    response = client_for_model.chat.completions.create(**params)
    
    # Return the response object that can be iterated over for streaming
    return response

def create_gemini_chat_with_files(parts, model_name, system_instruction=None):
    """
    Create a Gemini chat response with files using native API
    Returns OpenAI-compatible format for streaming
    """
    # Count actual files vs text parts
    file_count = sum(1 for part in parts if not isinstance(part, str))
    text_parts = sum(1 for part in parts if isinstance(part, str))
    safe_debug(f"Using native Gemini API for model {model_name} with {len(parts)} parts ({file_count} files, {text_parts} text)")
    
    # Prepare safety settings
    safety_settings = []
    if settings.get("safety_settings"):
        safety_settings = [
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": settings.get("safety_settings", {}).get("harassment", "BLOCK_NONE")
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": settings.get("safety_settings", {}).get("hate_speech", "BLOCK_NONE")
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": settings.get("safety_settings", {}).get("sexually_explicit", "BLOCK_NONE")
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": settings.get("safety_settings", {}).get("dangerous_content", "BLOCK_NONE")
            }
        ]

    # Configure the model with safety settings and system instruction
    config = types.GenerateContentConfig(
        safety_settings=safety_settings,
        system_instruction=system_instruction if system_instruction else None
    )
    
    # For Gemini with files, use the native API with files as parts
    response = client.models.generate_content_stream(
        model=model_name,
        contents=parts,  # parts contains the array with text and file objects
        config=config
    )
    
    # Wrap Gemini response to be OpenAI-compatible
    return GeminiToOpenAIAdapter(response)

def create_openai_compatible_chat_response(messages, model_name, system_instruction=None, temperature=None, max_tokens=None):
    """
    Create a chat response using OpenAI-compatible APIs (OpenRouter, Groq, etc.)
    """
    client_for_model = get_openai_client_for_model(model_name)
    
    # Convert messages to OpenAI format
    openai_messages = []
    
    # Add system message first if provided
    if system_instruction:
        openai_messages.append({
            "role": "system",
            "content": system_instruction
        })
    
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content", "")
        
        # Convert role if needed
        if role == "assistant":
            role = "assistant"
        elif role == "user":
            role = "user"
        else:
            continue  # Skip unsupported roles
            
        openai_messages.append({
            "role": role,
            "content": content
        })
    
    # Create request parameters
    params = {
        "model": model_name,
        "messages": openai_messages,
        "stream": True
    }
    if temperature is not None:
        params["temperature"] = float(temperature)
    if max_tokens is not None:
        params["max_tokens"] = int(max_tokens)
    
    # Add reasoning tokens for OpenRouter models that support it
    if is_openrouter_model(model_name):
        params["extra_body"] = {"include_reasoning": True}
    
    # Use the OpenAI client to create the response
    response = client_for_model.chat.completions.create(**params)
    
    # Return the response object that can be iterated over for streaming
    return response