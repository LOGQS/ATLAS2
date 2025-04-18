# Gemini API - Comprehensive Guide

## Table of Contents
- [Introduction](#introduction)
- [Text Generation](#text-generation)
  - [Basic Text Input](#basic-text-input)
  - [Streaming Output](#streaming-output)
  - [Multi-turn Conversations (Chat)](#multi-turn-conversations-chat)
  - [Configuration Parameters](#configuration-parameters)
  - [System Instructions](#system-instructions)
- [Multimodal Capabilities](#multimodal-capabilities)
  - [Image Input](#image-input)
  - [Video Input](#video-input)
  - [Object Detection & Bounding Boxes](#object-detection--bounding-boxes)
  - [Image Segmentation](#image-segmentation)
- [Code Execution](#code-execution)
  - [Enabling Code Execution](#enabling-code-execution)
  - [Code Execution in Chat](#code-execution-in-chat)
  - [Input/Output with Code Execution](#inputoutput-with-code-execution)
- [Function Calling](#function-calling)
  - [How Function Calling Works](#how-function-calling-works)
  - [Function Declarations](#function-declarations)
  - [Parallel Function Calling](#parallel-function-calling)
  - [Compositional Function Calling](#compositional-function-calling)
  - [Function Calling Modes](#function-calling-modes)
  - [Automatic Function Calling (Python Only)](#automatic-function-calling-python-only)
  - [Multi-tool Use](#multi-tool-use)
- [PDF Processing](#pdf-processing)
  - [Working with PDFs](#working-with-pdf-documents)
  - [Context Caching with PDFs](#context-caching-with-pdfs)
- [Grounding with Google Search](#grounding-with-google-search)
  - [Search as a Tool](#search-as-a-tool)
  - [Google Search Suggestions](#google-search-suggestions)
  - [Dynamic Retrieval](#dynamic-retrieval)
- [Live API](#live-api)
  - [Text and Audio Input/Output](#text-and-audio-inputoutput)
  - [Voice Configuration](#voice-configuration)
  - [Session Management](#session-management)
- [Token Management](#token-management)
  - [Context Windows](#context-windows)
  - [Counting Tokens](#counting-tokens)
  - [Multimodal Token Counting](#multimodal-token-counting)

## Introduction

The Gemini API provides access to Google's advanced generative AI models. This guide covers how to use the API for text generation, multimodal inputs (images, video, PDFs), code execution, function calling, and more.

## Text Generation

### Basic Text Input

The simplest way to generate text is to provide a single text-only input:

```python
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content(
    model="gemini-2.0-flash", 
    contents=["How does AI work?"]
)
print(response.text)
```

### Streaming Output

For faster interactions, you can use streaming to return instances of the response as they're generated:

```python
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content_stream(
    model="gemini-2.0-flash",
    contents=["Explain how AI works"]
)
for chunk in response:
    print(chunk.text, end="")
```

### Multi-turn Conversations (Chat)

The Gemini SDK lets you collect multiple rounds of questions and responses into a chat:

```python
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")
chat = client.chats.create(model="gemini-2.0-flash")

response = chat.send_message("I have 2 dogs in my house.")
print(response.text)

response = chat.send_message("How many paws are in my house?")
print(response.text)

# View conversation history
for message in chat.get_history():
    print(f'role - {message.role}:', message.parts[0].text)
```

You can also use streaming with chat:

```python
response = chat.send_message_stream("How many paws are in my house?")
for chunk in response:
    print(chunk.text, end="")
```

### Configuration Parameters

You can configure model parameters to control how the model generates responses:

```python
from google import genai
from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents=["Explain how AI works"],
    config=types.GenerateContentConfig(
        max_output_tokens=500,
        temperature=0.1
    )
)
print(response.text)
```

Important parameters include:
- `temperature`: Controls randomness (0.0-2.0)
- `maxOutputTokens`: Maximum tokens in the response
- `topP`: Token selection probability threshold
- `topK`: Token selection count threshold
- `stopSequences`: Character sequences that will stop output generation

### System Instructions

System instructions help you steer the model's behavior:

```python
from google import genai
from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content(
    model="gemini-2.0-flash",
    config=types.GenerateContentConfig(
        system_instruction="You are a cat. Your name is Neko."),
    contents="Hello there"
)

print(response.text)
```

## Multimodal Capabilities

### Image Input

Gemini can generate text from text and image inputs:

```python
from google import genai
from google.genai import types
from PIL import Image

client = genai.Client(api_key="GEMINI_API_KEY")

image = Image.open("/path/to/image.png")
response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents=[image, "Tell me about this instrument"]
)
print(response.text)
```

For images larger than 20MB, use the File API:

```python
client = genai.Client(api_key="GEMINI_API_KEY")

img_path = "/path/to/image.jpg"
file_ref = client.files.upload(file=img_path)

response = client.models.generate_content(
    model="gemini-2.0-flash-exp",
    contents=["What can you tell me about these instruments?", file_ref])

print(response.text)
```

**Technical Details for Images**:
- Gemini models support a maximum of 3,600 image files
- Supported formats: PNG, JPEG, WEBP, HEIC, HEIF
- Token calculation: Images ≤384px in both dimensions count as 258 tokens. Larger images are tiled into 768x768 pixels (258 tokens per tile)

### Video Input

Upload a video using the File API and generate content:

```python
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

print("Uploading file...")
video_file = client.files.upload(file="video.mp4")
print(f"Completed upload: {video_file.uri}")

# Check if video processing is complete
import time
while video_file.state.name == "PROCESSING":
    print('.', end='')
    time.sleep(1)
    video_file = client.files.get(name=video_file.name)

if video_file.state.name == "FAILED":
    raise ValueError(video_file.state.name)

response = client.models.generate_content(
    model="gemini-1.5-pro",
    contents=[
        video_file, 
        "Summarize this video."
    ])
print(response.text)
```

For videos under 20MB, you can include them inline:

```python
video_file_name = "/path/to/your/video.mp4"
video_bytes = open(video_file_name, 'rb').read()

response = client.models.generate_content(
    model='models/gemini-2.0-flash',
    contents=types.Content(
        parts=[
            types.Part(text='Can you summarize this video?'),
            types.Part(
                inline_data=types.Blob(data=video_bytes, mime_type='video/mp4')
            )
        ]
    )
)
```

You can also include YouTube URLs:

```python
response = client.models.generate_content(
    model='models/gemini-2.0-flash',
    contents=types.Content(
        parts=[
            types.Part(text='Can you summarize this video?'),
            types.Part(
                file_data=types.FileData(file_uri='https://www.youtube.com/watch?v=VIDEO_ID')
            )
        ]
    )
)
```

**Technical Details for Video**:
- Supports up to approximately 1 hour of video
- Supported formats: MP4, MPEG, MOV, AVI, FLV, MPG, WEBM, WMV, 3GPP
- Token calculation: 263 tokens per second for video, 32 tokens per second for audio

### Object Detection & Bounding Boxes

Gemini models can return bounding box coordinates for objects in images:

```python
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

prompt = (
    "Return a bounding box for each of the objects in this image "
    "in [ymin, xmin, ymax, xmax] format."
)

response = client.models.generate_content(
    model="gemini-1.5-pro",
    contents=[image_file, prompt])

print(response.text)
```

The model returns coordinates in the format [y_min, x_min, y_max, x_max] normalized to 0-1000.

### Image Segmentation

Starting with the 2.5 generation, Gemini models can segment images and provide mask contours:

```python
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

prompt = """
Give the segmentation masks for the wooden and glass items.
Output a JSON list of segmentation masks where each entry contains
the 2D bounding box in the key "box_2d", the segmentation mask in key "mask",
and the text label in the key "label". Use descriptive labels.
"""

response = client.models.generate_content(
    model="gemini-2.5-pro-exp-03-25",
    contents=[image_file, prompt])

print(response.text)
```

## Code Execution

The code execution feature enables the model to generate and run Python code and learn from the results.

### Enabling Code Execution

```python
from google import genai
from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content(
    model='gemini-2.0-flash',
    contents='What is the sum of the first 50 prime numbers?',
    config=types.GenerateContentConfig(
        tools=[types.Tool(
            code_execution=types.ToolCodeExecution
        )]
    )
)
```

### Code Execution in Chat

You can use code execution in chat contexts:

```python
chat = client.chats.create(
    model='gemini-2.0-flash',
    config=types.GenerateContentConfig(
        tools=[types.Tool(
            code_execution=types.ToolCodeExecution
        )]
    )
)

response = chat.send_message("Can you run some code to sort this list of numbers?: [2,34,1,65,4]")
```

### Input/Output with Code Execution

Starting with Gemini 2.0 Flash, code execution supports file input and graph output:

- Maximum runtime: 30 seconds
- Maximum file input size: 1 million tokens (roughly 2MB for text files)
- Supported libraries: altair, chess, cv2, matplotlib, mpmath, numpy, pandas, pdfminer, reportlab, seaborn, sklearn, statsmodels, striprtf, sympy, and tabulate

## Function Calling

Function calling lets you connect models to external tools and APIs, allowing the model to act as a bridge between natural language and real-world actions.

### How Function Calling Works

1. **Define Function Declaration**: Define the function and its declaration
2. **Call LLM with function declarations**: Send user prompt with function declarations to the model
3. **Execute Function Code**: Process the model's response and execute the corresponding function
4. **Create User-friendly response**: Send the function result back to the model for a final response

### Function Declarations

Function declarations are defined using JSON in the OpenAPI schema format:

```python
set_light_values_declaration = {
    "name": "set_light_values",
    "description": "Sets the brightness and color temperature of a light.",
    "parameters": {
        "type": "object",
        "properties": {
            "brightness": {
                "type": "integer",
                "description": "Light level from 0 to 100. Zero is off and 100 is full brightness",
            },
            "color_temp": {
                "type": "string",
                "enum": ["daylight", "cool", "warm"],
                "description": "Color temperature of the light fixture.",
            },
        },
        "required": ["brightness", "color_temp"],
    },
}

# Configure client with function declaration
tools = types.Tool(function_declarations=[set_light_values_declaration])
config = types.GenerateContentConfig(tools=[tools])
```

Key components of a function declaration:
- `name`: Unique name for the function
- `description`: Clear explanation of the function's purpose
- `parameters`: Input parameters with their types and descriptions
- `required`: List of mandatory parameters

### Parallel Function Calling

Parallel function calling lets you execute multiple independent functions at once:

```python
# Define multiple function declarations
power_disco_ball = {...}  # Function to power disco ball
start_music = {...}       # Function to start music
dim_lights = {...}        # Function to dim lights

# Configure with multiple functions
house_tools = [
    types.Tool(function_declarations=[power_disco_ball, start_music, dim_lights])
]

config = {
    "tools": house_tools,
    "tool_config": {"function_calling_config": {"mode": "any"}},
}

response = chat.send_message("Turn this place into a party!")

# Process multiple function calls
for fn in response.function_calls:
    args = ", ".join(f"{key}={val}" for key, val in fn.args.items())
    print(f"{fn.name}({args})")
```

### Compositional Function Calling

Gemini 2.0 supports compositional function calling, where the model can chain multiple function calls together. For example, to answer "Get the temperature in my current location," the model might invoke both `get_current_location()` and `get_weather()` functions.

### Function Calling Modes

Control how the model uses provided tools through function calling modes:

- `AUTO` (Default): Model decides whether to generate text or suggest a function call
- `ANY`: Model always predicts a function call
- `NONE`: Model is prohibited from making function calls

```python
tool_config = types.ToolConfig(
    function_calling_config=types.FunctionCallingConfig(
        mode="ANY",
        allowed_function_names=["get_current_temperature"]
    )
)

config = types.GenerateContentConfig(
    temperature=0,
    tools=[tools],
    tool_config=tool_config,
)
```

### Automatic Function Calling (Python Only)

The Python SDK can automatically handle function execution:

```python
from google import genai
from google.genai import types

# Define a function with type hints and docstring
def get_current_temperature(location: str) -> dict:
    """Gets the current temperature for a given location.
    
    Args:
        location: The city and state, e.g. San Francisco, CA
        
    Returns:
        A dictionary containing the temperature and unit.
    """
    return {"temperature": 25, "unit": "Celsius"}

# Configure with the function itself (not the declaration)
config = types.GenerateContentConfig(
    tools=[get_current_temperature]
)

response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents="What's the temperature in Boston?",
    config=config,
)
```

### Multi-tool Use

With Gemini 2.0, you can enable multiple tools simultaneously, combining native tools with function calling:

```python
tools = [
    {'google_search': {}},
    {'code_execution': {}},
    {'function_declarations': [turn_on_the_lights_schema, turn_off_the_lights_schema]}
]
```

## PDF Processing

### Working with PDF Documents

The Gemini API supports processing PDFs, including long documents (up to 3,600 pages):

```python
from google import genai
from google.genai import types
import httpx

client = genai.Client()

# For PDFs under 20MB
doc_url = "https://example.com/document.pdf"
doc_data = httpx.get(doc_url).content

prompt = "Summarize this document"
response = client.models.generate_content(
    model="gemini-1.5-flash",
    contents=[
        types.Part.from_bytes(
            data=doc_data,
            mime_type='application/pdf',
        ),
        prompt
    ]
)
print(response.text)
```

For large PDFs, use the File API:

```python
sample_doc = client.files.upload(
    file=doc_io,
    config=dict(mime_type='application/pdf')
)

response = client.models.generate_content(
    model="gemini-1.5-flash",
    contents=[sample_doc, "Summarize this document"]
)
```

**Technical Details for PDFs**:
- Supports up to 3,600 document pages
- Supported formats: PDF, JavaScript, Python, TXT, HTML, CSS, Markdown, CSV, XML, RTF
- Token calculation: Each document page is equivalent to 258 tokens

### Context Caching with PDFs

You can cache document content to improve performance for repeated queries:

```python
from google import genai
from google.genai import types

client = genai.Client()

document = client.files.upload(
    file=doc_io,
    config=dict(mime_type='application/pdf')
)

# Create a cached content object
cache = client.caches.create(
    model=model_name,
    config=types.CreateCachedContentConfig(
        system_instruction=system_instruction,
        contents=[document],
    )
)

# Generate content using the cached prompt and document
response = client.models.generate_content(
    model=model_name,
    contents="Please summarize this transcript",
    config=types.GenerateContentConfig(
        cached_content=cache.name
    )
)
```

## Grounding with Google Search

The Grounding with Google Search feature improves the accuracy and recency of model responses.

### Search as a Tool

Starting with Gemini 2.0, Google Search is available as a tool:

```python
from google import genai
from google.genai.types import Tool, GenerateContentConfig, GoogleSearch

client = genai.Client()
model_id = "gemini-2.0-flash"

google_search_tool = Tool(
    google_search = GoogleSearch()
)

response = client.models.generate_content(
    model=model_id,
    contents="When is the next total solar eclipse in the United States?",
    config=GenerateContentConfig(
        tools=[google_search_tool],
        response_modalities=["TEXT"],
    )
)

# Get the regular response
print(response.candidates[0].content.parts[0].text)

# Get grounding metadata as web content
print(response.candidates[0].grounding_metadata.search_entry_point.rendered_content)
```

### Google Search Suggestions

When using Grounding with Google Search, you need to display Google Search Suggestions, which are included in the metadata of grounded responses.

### Dynamic Retrieval

Dynamic retrieval gives you control over when to use Grounding with Google Search:

```python
from google import genai
from google.genai import types

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content(
    model='gemini-1.5-flash',
    contents="Who won Roland Garros this year?",
    config=types.GenerateContentConfig(
        tools=[types.Tool(
            google_search_retrieval=types.GoogleSearchRetrieval(
                dynamic_retrieval_config=types.DynamicRetrievalConfig(
                    mode=types.DynamicRetrievalConfigMode.MODE_DYNAMIC,
                    dynamic_threshold=0.6
                )
            )
        )]
    )
)
```

The threshold is a value between 0 and 1:
- If threshold=0, the response is always grounded with Google Search
- If threshold=1, the response is never grounded
- For other values, grounding depends on the model's prediction score for the prompt

## Live API

The Live API provides real-time interaction capabilities through WebSockets.

### Text and Audio Input/Output

To send and receive text:

```python
import asyncio
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")
model = "gemini-2.0-flash-live-001"

config = {"response_modalities": ["TEXT"]}

async def main():
    async with client.aio.live.connect(model=model, config=config) as session:
        while True:
            message = input("User> ")
            if message.lower() == "exit":
                break
            await session.send_client_content(
                turns={"role": "user", "parts": [{"text": message}]},
                turn_complete=True
            )

            async for response in session.receive():
                if response.text is not None:
                    print(response.text, end="")

if __name__ == "__main__":
    asyncio.run(main())
```

To receive audio:

```python
import asyncio
import wave
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY", http_options={'api_version': 'v1alpha'})
model = "gemini-2.0-flash-live-001"

config = {"response_modalities": ["AUDIO"]}

async def main():
    async with client.aio.live.connect(model=model, config=config) as session:
        wf = wave.open("audio.wav", "wb")
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)

        message = "Hello? Gemini are you there?"
        await session.send_client_content(
            turns={"role": "user", "parts": [{"text": message}]},
            turn_complete=True
        )

        async for idx, response in enumerate(session.receive()):
            if response.data is not None:
                wf.writeframes(response.data)

        wf.close()
```

### Voice Configuration

The Live API supports multiple voices:

```python
from google.genai import types

config = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
        )
    )
)
```

Available voices: Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, and Zephyr.

### Session Management

To enable longer sessions, you can use context window compression:

```python
from google.genai import types

config = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    context_window_compression=(
        types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow(),
        )
    ),
)
```

**Limitations**:
- Without compression, audio-only sessions are limited to 15 minutes
- Audio plus video sessions are limited to 2 minutes
- Context window limit is 32k tokens

## Token Management

### Context Windows

Models have context windows measured in tokens:

```python
import google.generativeai as genai

model_info = genai.get_model("models/gemini-1.5-flash")

print(f"{model_info.input_token_limit=}")
print(f"{model_info.output_token_limit=}")
```

### Counting Tokens

You can count tokens in two ways:
1. Call `count_tokens` before making a request
2. Check `usage_metadata` in the response

```python
import google.generativeai as genai

model = genai.GenerativeModel("models/gemini-1.5-flash")

prompt = "The quick brown fox jumps over the lazy dog."

# Get input token count
print("total_tokens: ", model.count_tokens(prompt))

response = model.generate_content(prompt)

# Get complete token usage information
print(response.usage_metadata)
```

### Multimodal Token Counting

All input to the Gemini API is tokenized, including text, images, videos, and other modalities:

- **Images**: With Gemini 2.0, images ≤384 pixels in both dimensions count as 258 tokens. Larger images are tiled into 768x768 pixels (258 tokens per tile)
- **Video**: 263 tokens per second
- **Audio**: 32 tokens per second
- **Documents**: 258 tokens per page

System instructions and tools also count toward the total token count.
