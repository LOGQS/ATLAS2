Gemini API quickstart

This quickstart shows you how to install your SDK of choice and then make your first Gemini API request.

Python JavaScript REST Go

Install the Gemini API library
Note: We're rolling out a new set of Gemini API libraries, the Google Gen AI SDK.
Using Python 3.9+, install the google-genai package using the following pip command:


pip install -q -U google-genai
Make your first request
Get a Gemini API key in Google AI Studio

Use the generateContent method to send a request to the Gemini API.


from google import genai

client = genai.Client(api_key="YOUR_API_KEY")

response = client.models.generate_content(
    model="gemini-2.0-flash", contents="Explain how AI works in a few words"
)
print(response.text)



Text generation

The Gemini API can generate text output in response to various inputs, including text, images, video, and audio. This guide shows you how to generate text using text and image inputs. It also covers streaming, chat, and system instructions.

Before you begin
Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Text input
The simplest way to generate text using the Gemini API is to provide the model with a single text-only input, as shown in this example:

Python
JavaScript
Go
REST

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents=["How does AI work?"]
)
print(response.text)
Image input
The Gemini API supports multimodal inputs that combine text and media files. The following example shows how to generate text from text and image input:

Python
JavaScript
Go
REST

from PIL import Image
from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

image = Image.open("/path/to/organ.png")
response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents=[image, "Tell me about this instrument"]
)
print(response.text)
Streaming output
By default, the model returns a response after completing the entire text generation process. You can achieve faster interactions by using streaming to return instances of GenerateContentResponse as they're generated.

Python
JavaScript
Go
REST

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

response = client.models.generate_content_stream(
    model="gemini-2.0-flash",
    contents=["Explain how AI works"]
)
for chunk in response:
    print(chunk.text, end="")
Multi-turn conversations
The Gemini SDK lets you collect multiple rounds of questions and responses into a chat. The chat format enables users to step incrementally toward answers and to get help with multipart problems. This SDK implementation of chat provides an interface to keep track of conversation history, but behind the scenes it uses the same generateContent method to create the response.

The following code example shows a basic chat implementation:

Python
JavaScript
Go
REST

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")
chat = client.chats.create(model="gemini-2.0-flash")

response = chat.send_message("I have 2 dogs in my house.")
print(response.text)

response = chat.send_message("How many paws are in my house?")
print(response.text)

for message in chat.get_history():
    print(f'role - {message.role}',end=": ")
    print(message.parts[0].text)
You can also use streaming with chat, as shown in the following example:

Python
JavaScript
Go
REST

from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")
chat = client.chats.create(model="gemini-2.0-flash")

response = chat.send_message_stream("I have 2 dogs in my house.")
for chunk in response:
    print(chunk.text, end="")

response = chat.send_message_stream("How many paws are in my house?")
for chunk in response:
    print(chunk.text, end="")

for message in chat.get_history():
    print(f'role - {message.role}', end=": ")
    print(message.parts[0].text)
Configuration parameters
Every prompt you send to the model includes parameters that control how the model generates responses. You can configure these parameters, or let the model use the default options.

The following example shows how to configure model parameters:

Python
JavaScript
Go
REST

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
Here are some of the model parameters you can configure. (Naming conventions vary by programming language.)

stopSequences: Specifies the set of character sequences (up to 5) that will stop output generation. If specified, the API will stop at the first appearance of a stop_sequence. The stop sequence won't be included as part of the response.
temperature: Controls the randomness of the output. Use higher values for more creative responses, and lower values for more deterministic responses. Values can range from [0.0, 2.0].
maxOutputTokens: Sets the maximum number of tokens to include in a candidate.
topP: Changes how the model selects tokens for output. Tokens are selected from the most to least probable until the sum of their probabilities equals the topP value. The default topP value is 0.95.
topK: Changes how the model selects tokens for output. A topK of 1 means the selected token is the most probable among all the tokens in the model's vocabulary, while a topK of 3 means that the next token is selected from among the 3 most probable using the temperature. Tokens are further filtered based on topP with the final token selected using temperature sampling.
System instructions
System instructions let you steer the behavior of a model based on your specific use case. When you provide system instructions, you give the model additional context to help it understand the task and generate more customized responses. The model should adhere to the system instructions over the full interaction with the user, enabling you to specify product-level behavior separate from the prompts provided by end users.

You can set system instructions when you initialize your model:

Python
JavaScript
Go
REST

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
Then, you can send requests to the model as usual.

Supported models
The entire Gemini family of models supports text generation. To learn more about the models and their capabilities, see Models.

Prompting tips
For basic text generation use cases, your prompt might not need to include any output examples, system instructions, or formatting information. This is a zero-shot approach. For some use cases, a one-shot or few-shot prompt might produce output that's more aligned with user expectations. In some cases, you might also want to provide system instructions to help the model understand the task or follow specific guidelines.


Generate images

The Gemini API supports image generation using Gemini 2.0 Flash Experimental and using Imagen 3. This guide helps you get started with both models.

Before you begin
Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Generate images using Gemini
Gemini 2.0 Flash Experimental supports the ability to output text and inline images. This lets you use Gemini to conversationally edit images or generate outputs with interwoven text (for example, generating a blog post with text and images in a single turn). All generated images include a SynthID watermark, and images in Google AI Studio include a visible watermark as well.

Note: Make sure to include responseModalities: ["Text", "Image"] in your generation configuration for text and image output with gemini-2.0-flash-exp-image-generation. Image only is not allowed.
The following example shows how to use Gemini 2.0 to generate text-and-image output:

Python
JavaScript
REST

from google import genai
from google.genai import types
from PIL import Image
from io import BytesIO
import base64

client = genai.Client()

contents = ('Hi, can you create a 3d rendered image of a pig '
            'with wings and a top hat flying over a happy '
            'futuristic scifi city with lots of greenery?')

response = client.models.generate_content(
    model="gemini-2.0-flash-exp-image-generation",
    contents=contents,
    config=types.GenerateContentConfig(
      response_modalities=['Text', 'Image']
    )
)

for part in response.candidates[0].content.parts:
  if part.text is not None:
    print(part.text)
  elif part.inline_data is not None:
    image = Image.open(BytesIO((part.inline_data.data)))
    image.save('gemini-native-image.png')
    image.show()
AI-generated image of a fantastical flying pig
AI-generated image of a fantastical flying pig
Depending on the prompt and context, Gemini will generate content in different modes (text to image, text to image and text, etc.). Here are some examples:

Text to image
Example prompt: "Generate an image of the Eiffel tower with fireworks in the background."
Text to image(s) and text (interleaved)
Example prompt: "Generate an illustrated recipe for a paella."
Image(s) and text to image(s) and text (interleaved)
Example prompt: (With an image of a furnished room) "What other color sofas would work in my space? can you update the image?"
Image editing (text and image to image)
Example prompt: "Edit this image to make it look like a cartoon"
Example prompt: [image of a cat] + [image of a pillow] + "Create a cross stitch of my cat on this pillow."
Multi-turn image editing (chat)
Example prompts: [upload an image of a blue car.] "Turn this car into a convertible." "Now change the color to yellow."
Image editing with Gemini
To perform image editing, add an image as input. The following example demonstrats uploading base64 encoded images. For multiple images and larger payloads, check the image input section.

Python
JavaScript
REST

from google import genai
from google.genai import types
from PIL import Image
from io import BytesIO

import PIL.Image

image = PIL.Image.open('/path/to/image.png')

client = genai.Client()

text_input = ('Hi, This is a picture of me.'
            'Can you add a llama next to me?',)

response = client.models.generate_content(
    model="gemini-2.0-flash-exp-image-generation",
    contents=[text_input, image],
    config=types.GenerateContentConfig(
      response_modalities=['Text', 'Image']
    )
)

for part in response.candidates[0].content.parts:
  if part.text is not None:
    print(part.text)
  elif part.inline_data is not None:
    image = Image.open(BytesIO(part.inline_data.data))
    image.show()
Limitations
For best performance, use the following languages: EN, es-MX, ja-JP, zh-CN, hi-IN.
Image generation does not support audio or video inputs.
Image generation may not always trigger:
The model may output text only. Try asking for image outputs explicitly (e.g. "generate an image", "provide images as you go along", "update the image").
The model may stop generating partway through. Try again or try a different prompt.
When generating text for an image, Gemini works best if you first generate the text and then ask for an image with the text.
Choose a model
Which model should you use to generate images? It depends on your use case.

Gemini 2.0 is best for producing contextually relevant images, blending text + images, incorporating world knowledge, and reasoning about images. You can use it to create accurate, contextually relevant visuals embedded in long text sequences. You can also edit images conversationally, using natural language, while maintaining context throughout the conversation.

If image quality is your top priority, then Imagen 3 is a better choice. Imagen 3 excels at photorealism, artistic detail, and specific artistic styles like impressionism or anime. Imagen 3 is also a good choice for specialized image editing tasks like updating product backgrounds, upscaling images, and infusing branding and style into visuals. You can use Imagen 3 to create logos or other branded product designs.

Generate images using Imagen 3
The Gemini API provides access to Imagen 3, Google's highest quality text-to-image model, featuring a number of new and improved capabilities. Imagen 3 can do the following:

Generate images with better detail, richer lighting, and fewer distracting artifacts than previous models
Understand prompts written in natural language
Generate images in a wide range of formats and styles
Render text more effectively than previous models
Note: Imagen 3 is only available on the Paid Tier and always includes a SynthID watermark.
Python
JavaScript
REST

from google import genai
from google.genai import types
from PIL import Image
from io import BytesIO

client = genai.Client(api_key='GEMINI_API_KEY')

response = client.models.generate_images(
    model='imagen-3.0-generate-002',
    prompt='Robot holding a red skateboard',
    config=types.GenerateImagesConfig(
        number_of_images= 4,
    )
)
for generated_image in response.generated_images:
  image = Image.open(BytesIO(generated_image.image.image_bytes))
  image.show()
AI-generated image of two fuzzy bunnies in the kitchen
AI-generated image of two fuzzy bunnies in the kitchen
Imagen supports English only prompts at this time and the following parameters:

Imagen model parameters
(Naming conventions vary by programming language.)

numberOfImages: The number of images to generate, from 1 to 4 (inclusive). The default is 4.
aspectRatio: Changes the aspect ratio of the generated image. Supported values are "1:1", "3:4", "4:3", "9:16", and "16:9". The default is "1:1".
personGeneration: Allow the model to generate images of people. The following values are supported:
"DONT_ALLOW": Block generation of images of people.
"ALLOW_ADULT": Generate images of adults, but not children. This is the default.


Explore vision capabilities with the Gemini API

Python Node.js Go REST

Try a Colab notebook
View notebook on GitHub
Gemini models are able to process images and videos, enabling many frontier developer use cases that would have historically required domain specific models. Some of Gemini's vision capabilities include the ability to:

Caption and answer questions about images
Transcribe and reason over PDFs, including up to 2 million tokens
Describe, segment, and extract information from videos up to 90 minutes long
Detect objects in an image and return bounding box coordinates for them
Gemini was built to be multimodal from the ground up and we continue to push the frontier of what is possible.

Before you begin
Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Image input
For total image payload size less than 20MB, we recommend either uploading base64 encoded images or directly uploading locally stored image files.

Working with local images
If you are using the Python imaging library (Pillow), you can use PIL image objects too.


from google import genai
from google.genai import types

import PIL.Image

image = PIL.Image.open('/path/to/image.png')

client = genai.Client(api_key="GEMINI_API_KEY")
response = client.models.generate_content(
    model="gemini-2.0-flash",
    contents=["What is this image?", image])

print(response.text)
Base64 encoded images
You can upload public image URLs by encoding them as Base64 payloads. The following code example shows how to do this using only standard library tools:


from google import genai
from google.genai import types

import requests

image_path = "https://goo.gle/instrument-img"
image = requests.get(image_path)

client = genai.Client(api_key="GEMINI_API_KEY")
response = client.models.generate_content(
    model="gemini-2.0-flash-exp",
    contents=["What is this image?",
              types.Part.from_bytes(data=image.content, mime_type="image/jpeg")])

print(response.text)
Multiple images
To prompt with multiple images, you can provide multiple images in the call to generate_content. These can be in any supported format, including base64 or PIL.


from google import genai
from google.genai import types

import pathlib
import PIL.Image

image_path_1 = "path/to/your/image1.jpeg"  # Replace with the actual path to your first image
image_path_2 = "path/to/your/image2.jpeg" # Replace with the actual path to your second image

image_url_1 = "https://goo.gle/instrument-img" # Replace with the actual URL to your third image

pil_image = PIL.Image.open(image_path_1)

b64_image = types.Part.from_bytes(
    data=pathlib.Path(image_path_2).read_bytes(),
    mime_type="image/jpeg"
)

downloaded_image = requests.get(image_url_1)

client = genai.Client(api_key="GEMINI_API_KEY")
response = client.models.generate_content(
    model="gemini-2.0-flash-exp",
    contents=["What do these images have in common?",
              pil_image, b64_image, downloaded_image])

print(response.text)
Note that these inline data calls don't include many of the features available through the File API, such as getting file metadata, listing, or deleting files.

Large image payloads
When the combination of files and system instructions that you intend to send is larger than 20 MB in size, use the File API to upload those files.

Use the media.upload method of the File API to upload an image of any size.

Note: The File API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB. Files are stored for 48 hours. They can be accessed in that period with your API key, but cannot be downloaded from the API. It is available at no cost in all regions where the Gemini API is available.
After uploading the file, you can make GenerateContent requests that reference the File API URI. Select the generative model and provide it with a text prompt and the uploaded image.


from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

img_path = "/path/to/Cajun_instruments.jpg"
file_ref = client.files.upload(file=img_path)
print(f'{file_ref=}')

client = genai.Client(api_key="GEMINI_API_KEY")
response = client.models.generate_content(
    model="gemini-2.0-flash-exp",
    contents=["What can you tell me about these instruments?",
              file_ref])

print(response.text)
OpenAI Compatibility
You can access Gemini's image understanding capabilities using the OpenAI libraries. This lets you integrate Gemini into existing OpenAI workflows by updating three lines of code and using your Gemini API key. See the Image understanding example for code demonstrating how to send images encoded as Base64 payloads.

Prompting with images
In this tutorial, you will upload images using the File API or as inline data and generate content based on those images.

Technical details (images)
Gemini 2.0 Flash, 1.5 Pro, and 1.5 Flash support a maximum of 3,600 image files.

Images must be in one of the following image data MIME types:

PNG - image/png
JPEG - image/jpeg
WEBP - image/webp
HEIC - image/heic
HEIF - image/heif
Tokens
Here's how tokens are calculated for images:

Gemini 1.0 Pro Vision: Each image accounts for 258 tokens.
Gemini 1.5 Flash and Gemini 1.5 Pro: If both dimensions of an image are less than or equal to 384 pixels, then 258 tokens are used. If one dimension of an image is greater than 384 pixels, then the image is cropped into tiles. Each tile size defaults to the smallest dimension (width or height) divided by 1.5. If necessary, each tile is adjusted so that it's not smaller than 256 pixels and not greater than 768 pixels. Each tile is then resized to 768x768 and uses 258 tokens.
Gemini 2.0 Flash: Image inputs with both dimensions <=384 pixels are counted as 258 tokens. Images larger in one or both dimensions are cropped and scaled as needed into tiles of 768x768 pixels, each counted as 258 tokens.
For best results
Rotate images to the correct orientation before uploading.
Avoid blurry images.
If using a single image, place the text prompt after the image.
Capabilities
This section outlines specific vision capabilities of the Gemini model, including object detection and bounding box coordinates.

Get a bounding box for an object
Gemini models are trained to return bounding box coordinates as relative widths or heights in the range of [0, 1]. These values are then scaled by 1000 and converted to integers. Effectively, the coordinates represent the bounding box on a 1000x1000 pixel version of the image. Therefore, you'll need to convert these coordinates back to the dimensions of your original image to accurately map the bounding boxes.


from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

prompt = (
  "Return a bounding box for each of the objects in this image "
  "in [ymin, xmin, ymax, xmax] format.")

response = client.models.generate_content(
  model="gemini-1.5-pro",
  contents=[sample_file_1, prompt])

print(response.text)
You can use bounding boxes for object detection and localization within images and video. By accurately identifying and delineating objects with bounding boxes, you can unlock a wide range of applications and enhance the intelligence of your projects.

Key Benefits
Simple: Integrate object detection capabilities into your applications with ease, regardless of your computer vision expertise.
Customizable: Produce bounding boxes based on custom instructions (e.g. "I want to see bounding boxes of all the green objects in this image"), without having to train a custom model.
Technical Details
Input: Your prompt and associated images or video frames.
Output: Bounding boxes in the [y_min, x_min, y_max, x_max] format. The top left corner is the origin. The x and y axis go horizontally and vertically, respectively. Coordinate values are normalized to 0-1000 for every image.
Visualization: AI Studio users will see bounding boxes plotted within the UI.
For Python developers, try the 2D spatial understanding notebook or the experimental 3D pointing notebook.

Normalize coordinates
The model returns bounding box coordinates in the format [y_min, x_min, y_max, x_max]. To convert these normalized coordinates to the pixel coordinates of your original image, follow these steps:

Divide each output coordinate by 1000.
Multiply the x-coordinates by the original image width.
Multiply the y-coordinates by the original image height.
To explore more detailed examples of generating bounding box coordinates and visualizing them on images, we encourage you to review our Object Detection cookbook example.

Image segmentation
Starting with the 2.5 generation, Gemini models are trained to not only detect items but segment them and provide a mask of their contour.

The model predicts a JSON list, where each item represents a segmentation mask. Each item has a bounding box ("box_2d") in the format [y0, x0, y1, x1] with normalized coordinates between 0 and 1000, a label ("label") that identifies the object, and finally the segmentation mask inside the bounding box, as base64 encoded png that is a probability map with values between 0 and 255. The mask needs to be resized to match the bounding box dimensions, then binarized at your confidence threshold (127 for the midpoint).


from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

prompt = """
  Give the segmentation masks for the wooden and glass items.
  Output a JSON list of segmentation masks where each entry contains the 2D
  bounding box in the key "box_2d", the segmentation mask in key "mask", and
  the text label in the key "label". Use descriptive labels.
"""

response = client.models.generate_content(
  model="gemini-2.5-pro-exp-03-25",
  contents=[sample_file_1, prompt])

print(response.text)
A table with cupcakes, with the wooden and glass objects highlighted
Mask of the wooden and glass objects found on the picture
Check the segmentation example in the cookbook guide for a more detailed example.

Prompting with video
In this tutorial, you will upload a video using the File API and generate content based on those images.

Technical details (video)
Gemini 1.5 Pro and Flash support up to approximately an hour of video data.

Video must be in one of the following video format MIME types:

video/mp4
video/mpeg
video/mov
video/avi
video/x-flv
video/mpg
video/webm
video/wmv
video/3gpp
The File API service extracts image frames from videos at 1 frame per second (FPS) and audio at 1Kbps, single channel, adding timestamps every second. These rates are subject to change in the future for improvements in inference.

Note: The details of fast action sequences may be lost at the 1 FPS frame sampling rate. Consider slowing down high-speed clips for improved inference quality.
Individual frames are 258 tokens, and audio is 32 tokens per second. With metadata, each second of video becomes ~300 tokens, which means a 1M context window can fit slightly less than an hour of video. As a result, Gemini Pro, which has a 2M context window, can handle a maximum video length of 2 hours, and Gemini Flash, which has a 1M context window, can handle a maximum video length of 1 hour.

To ask questions about time-stamped locations, use the format MM:SS, where the first two digits represent minutes and the last two digits represent seconds.

For best results:

Use one video per prompt.
If using a single video, place the text prompt after the video.
Upload a video file using the File API
Note: The File API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB. Files are stored for 48 hours. They can be accessed in that period with your API key, but they cannot be downloaded using any API. It is available at no cost in all regions where the Gemini API is available.
The File API accepts video file formats directly. This example uses the short NASA film "Jupiter's Great Red Spot Shrinks and Grows". Credit: Goddard Space Flight Center (GSFC)/David Ladd (2018).

"Jupiter's Great Red Spot Shrinks and Grows" is in the public domain and does not show identifiable people. (NASA image and media usage guidelines.)

Start by retrieving the short video:


wget https://storage.googleapis.com/generativeai-downloads/images/GreatRedSpot.mp4
Upload the video using the File API and print the URI.


from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

print("Uploading file...")
video_file = client.files.upload(file="GreatRedSpot.mp4")
print(f"Completed upload: {video_file.uri}")
Verify file upload and check state
Verify the API has successfully received the files by calling the files.get method.

Note: Video files have a State field in the File API. When a video is uploaded, it will be in the PROCESSING state until it is ready for inference. Only ACTIVE files can be used for model inference.

import time

# Check whether the file is ready to be used.
while video_file.state.name == "PROCESSING":
    print('.', end='')
    time.sleep(1)
    video_file = client.files.get(name=video_file.name)

if video_file.state.name == "FAILED":
  raise ValueError(video_file.state.name)

print('Done')
Prompt with a video and text
Once the uploaded video is in the ACTIVE state, you can make GenerateContent requests that specify the File API URI for that video. Select the generative model and provide it with the uploaded video and a text prompt.


from IPython.display import Markdown

# Pass the video file reference like any other media part.
response = client.models.generate_content(
    model="gemini-1.5-pro",
    contents=[
        video_file,
        "Summarize this video. Then create a quiz with answer key "
        "based on the information in the video."])

# Print the response, rendering any Markdown
Markdown(response.text)
Upload a video inline
If your video is less than 20MB, you can include it inline with your request as a data Part.

Here's an example of uploading a video inline:


# Only for videos of size <20Mb
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
Include a YouTube URL
Preview: The YouTube URL feature is in preview and is currently free of charge. Pricing and rate limits are likely to change.
The Gemini API and AI Studio support YouTube URLs as a file data Part. You can include a YouTube URL with a prompt asking the model to summarize, translate, or otherwise interact with the video content.

Limitations:

You can't upload more than 8 hours of YouTube video per day.
You can upload only 1 video per request.
You can only upload public videos (not private or unlisted videos).
Note: Gemini Pro, which has a 2M context window, can handle a maximum video length of 2 hours, and Gemini Flash, which has a 1M context window, can handle a maximum video length of 1 hour.
The following example shows how to include a YouTube URL with a prompt:


response = client.models.generate_content(
    model='models/gemini-2.0-flash',
    contents=types.Content(
        parts=[
            types.Part(text='Can you summarize this video?'),
            types.Part(
                file_data=types.FileData(file_uri='https://www.youtube.com/watch?v=9hE5-98ZeCg')
            )
        ]
    )
)
Refer to timestamps in the content
You can use timestamps of the form MM:SS to refer to specific moments in the video.


prompt = "What are the examples given at 01:05 and 01:19 supposed to show us?"

response = client.models.generate_content(
    model="gemini-1.5-pro",
    contents=[video_file, prompt])

print(response.text)
Transcribe video and provide visual descriptions
The Gemini models can transcribe and provide visual descriptions of video content by processing both the audio track and visual frames. For visual descriptions, the model samples the video at a rate of 1 frame per second. This sampling rate may affect the level of detail in the descriptions, particularly for videos with rapidly changing visuals.


prompt = (
    "Transcribe the audio from this video, giving timestamps for "
    "salient events in the video. Also provide visual descriptions.")

response = client.models.generate_content(
    model="gemini-1.5-pro",
    contents=[video_file, prompt])

print(response.text)
List files
You can list all files uploaded using the File API and their URIs using files.list.


from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

print('My files:')
for f in client.files.list():
  print(" ", f'{f.name}: {f.uri}')
Delete files
Files uploaded using the File API are automatically deleted after 2 days. You can also manually delete them using files.delete.


from google import genai

client = genai.Client(api_key="GEMINI_API_KEY")

# Upload a file
poem_file = client.files.upload(file="poem.txt")

# Files will auto-delete after a period.
print(poem_file.expiration_time)

# Or they can be deleted explicitly.
dr = client.files.delete(name=poem_file.name)

try:
  client.models.generate_content(
      model="gemini-2.0-flash-exp",
      contents=['Finish this poem:', poem_file])
except genai.errors.ClientError as e:
  print(e.code)  # 403
  print(e.status)  # PERMISSION_DENIED
  print(e.message)  # You do not have permission to access the File .. or it may not exist.


  Explore audio capabilities with the Gemini API

Python JavaScript Go REST

Gemini can respond to prompts about audio. For example, Gemini can:

Describe, summarize, or answer questions about audio content.
Provide a transcription of the audio.
Provide answers or a transcription about a specific segment of the audio.
Note: You can't generate audio output with the Gemini API.
This guide demonstrates different ways to interact with audio files and audio content using the Gemini API.

Before you begin
Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Supported audio formats
Gemini supports the following audio format MIME types:

WAV - audio/wav
MP3 - audio/mp3
AIFF - audio/aiff
AAC - audio/aac
OGG Vorbis - audio/ogg
FLAC - audio/flac
Technical details about audio
Gemini imposes the following rules on audio:

Gemini represents each second of audio as 32 tokens; for example, one minute of audio is represented as 1,920 tokens.
Gemini can only infer responses to English-language speech.
Gemini can "understand" non-speech components, such as birdsong or sirens.
The maximum supported length of audio data in a single prompt is 9.5 hours. Gemini doesn't limit the number of audio files in a single prompt; however, the total combined length of all audio files in a single prompt cannot exceed 9.5 hours.
Gemini downsamples audio files to a 16 Kbps data resolution.
If the audio source contains multiple channels, Gemini combines those channels down to a single channel.
Make an audio file available to Gemini
You can make an audio file available to Gemini in either of the following ways:

Upload the audio file prior to making the prompt request.
Provide the audio file as inline data to the prompt request.
Upload an audio file and generate content
You can use the File API to upload an audio file of any size. Always use the File API when the total request size (including the files, text prompt, system instructions, etc.) is larger than 20 MB.

Note: The File API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB. Files are stored for 48 hours. They can be accessed in that period with your API key, but cannot be downloaded from the API. The File API is available at no cost in all regions where the Gemini API is available.
Call media.upload to upload a file using the File API. The following code uploads an audio file and then uses the file in a call to models.generateContent.


from google import genai

client = genai.Client()

myfile = client.files.upload(file='media/sample.mp3')

response = client.models.generate_content(
  model='gemini-2.0-flash',
  contents=['Describe this audio clip', myfile]
)

print(response.text)
Get metadata for a file
You can verify the API successfully stored the uploaded file and get its metadata by calling files.get.


myfile = client.files.upload(file='media/sample.mp3')
file_name = myfile.name
myfile = client.files.get(name=file_name)
print(myfile)
List uploaded files
You can upload multiple audio files (and other kinds of files). The following code generates a list of all the files uploaded:


print('My files:')
for f in client.files.list():
    print(' ', f.name)
Delete uploaded files
Files are automatically deleted after 48 hours. Optionally, you can manually delete an uploaded file. For example:


myfile = client.files.upload(file='media/sample.mp3')
client.files.delete(name=myfile.name)
Provide the audio file as inline data in the request
Instead of uploading an audio file, you can pass audio data in the same call that contains the prompt.

Then, pass that downloaded small audio file along with the prompt to Gemini:


from google.genai import types

with open('media/small-sample.mp3', 'rb') as f:
    audio_bytes = f.read()

response = client.models.generate_content(
  model='gemini-2.0-flash',
  contents=[
    'Describe this audio clip',
    types.Part.from_bytes(
      data=audio_bytes,
      mime_type='audio/mp3',
    )
  ]
)

print(response.text)
Note the following about providing audio as inline data:

The maximum request size is 20 MB, which includes text prompts, system instructions, and files provided inline. If your file's size will make the total request size exceed 20 MB, then use the File API to upload files for use in requests.
If you're using an audio sample multiple times, it is more efficient to use the File API.
More ways to work with audio
This section provides a few additional ways to get more from audio.

Get a transcript of the audio file
To get a transcript, just ask for it in the prompt. For example:


myfile = client.files.upload(file='media/sample.mp3')
prompt = 'Generate a transcript of the speech.'

response = client.models.generate_content(
  model='gemini-2.0-flash',
  contents=[prompt, myfile]
)

print(response.text)
Refer to timestamps in the audio file
A prompt can specify timestamps of the form MM:SS to refer to particular sections in an audio file. For example, the following prompt requests a transcript that:

Starts at 2 minutes 30 seconds from the beginning of the file.
Ends at 3 minutes 29 seconds from the beginning of the file.

# Create a prompt containing timestamps.
prompt = "Provide a transcript of the speech from 02:30 to 03:29."
Count tokens
Call the countTokens method to get a count of the number of tokens in the audio file. For example:


response = client.models.count_tokens(
  model='gemini-2.0-flash',
  contents=[myfile]
)

print(response)



Explore document processing capabilities with the Gemini API

Python JavaScript Go REST

The Gemini API supports PDF input, including long documents (up to 3600 pages). Gemini models process PDFs with native vision, and are therefore able to understand both text and image contents inside documents. With native PDF vision support, Gemini models are able to:

Analyze diagrams, charts, and tables inside documents.
Extract information into structured output formats.
Answer questions about visual and text contents in documents.
Summarize documents.
Transcribe document content (e.g. to HTML) preserving layouts and formatting, for use in downstream applications (such as in RAG pipelines).
This tutorial demonstrates some possible ways to use the Gemini API with PDF documents. All output is text-only.

Before you begin
Before calling the Gemini API, ensure you have your SDK of choice installed, and a Gemini API key configured and ready to use.

Prompting with PDFs
This guide demonstrates how to upload and process PDFs using the File API or by including them as inline data.

Technical details
Gemini 1.5 Pro and 1.5 Flash support a maximum of 3,600 document pages. Document pages must be in one of the following text data MIME types:

PDF - application/pdf
JavaScript - application/x-javascript, text/javascript
Python - application/x-python, text/x-python
TXT - text/plain
HTML - text/html
CSS - text/css
Markdown - text/md
CSV - text/csv
XML - text/xml
RTF - text/rtf
Each document page is equivalent to 258 tokens.

While there are no specific limits to the number of pixels in a document besides the model's context window, larger pages are scaled down to a maximum resolution of 3072x3072 while preserving their original aspect ratio, while smaller pages are scaled up to 768x768 pixels. There is no cost reduction for pages at lower sizes, other than bandwidth, or performance improvement for pages at higher resolution.

For best results:

Rotate pages to the correct orientation before uploading.
Avoid blurry pages.
If using a single page, place the text prompt after the page.
PDF input
For PDF payloads under 20MB, you can choose between uploading base64 encoded documents or directly uploading locally stored files.

As inline data
You can process PDF documents directly from URLs. Here's a code snippet showing how to do this:


from google import genai
from google.genai import types
import httpx

client = genai.Client()

doc_url = "https://discovery.ucl.ac.uk/id/eprint/10089234/1/343019_3_art_0_py4t4l_convrt.pdf"  # Replace with the actual URL of your PDF

# Retrieve and encode the PDF byte
doc_data = httpx.get(doc_url).content

prompt = "Summarize this document"
response = client.models.generate_content(
  model="gemini-1.5-flash",
  contents=[
      types.Part.from_bytes(
        data=doc_data,
        mime_type='application/pdf',
      ),
      prompt])
print(response.text)
Locally stored PDFs
For locally stored PDFs, you can use the following approach:


from google import genai
from google.genai import types
import pathlib
import httpx

client = genai.Client()

doc_url = "https://discovery.ucl.ac.uk/id/eprint/10089234/1/343019_3_art_0_py4t4l_convrt.pdf"  # Replace with the actual URL of your PDF

# Retrieve and encode the PDF byte
filepath = pathlib.Path('file.pdf')
filepath.write_bytes(httpx.get(doc_url).content)

prompt = "Summarize this document"
response = client.models.generate_content(
  model="gemini-1.5-flash",
  contents=[
      types.Part.from_bytes(
        data=filepath.read_bytes(),
        mime_type='application/pdf',
      ),
      prompt])
print(response.text)
Large PDFs
You can use the File API to upload a document of any size. Always use the File API when the total request size (including the files, text prompt, system instructions, etc.) is larger than 20 MB.

Note: The File API lets you store up to 20 GB of files per project, with a per-file maximum size of 2 GB. Files are stored for 48 hours. They can be accessed in that period with your API key, but cannot be downloaded from the API. The File API is available at no cost in all regions where the Gemini API is available.
Call media.upload to upload a file using the File API. The following code uploads a document file and then uses the file in a call to models.generateContent.

Large PDFs from URLs
Use the File API for large PDF files available from URLs, simplifying the process of uploading and processing these documents directly through their URLs:


from google import genai
from google.genai import types
import io
import httpx

client = genai.Client()

long_context_pdf_path = "https://www.nasa.gov/wp-content/uploads/static/history/alsj/a17/A17_FlightPlan.pdf" # Replace with the actual URL of your large PDF

# Retrieve and upload the PDF using the File API
doc_io = io.BytesIO(httpx.get(long_context_pdf_path).content)

sample_doc = client.files.upload(
  # You can pass a path or a file-like object here
  file=doc_io, 
  config=dict(
    # It will guess the mime type from the file extension, but if you pass
    # a file-like object, you need to set the
    mime_type='application/pdf')
)

prompt = "Summarize this document"


response = client.models.generate_content(
  model="gemini-1.5-flash",
  contents=[sample_doc, prompt])
print(response.text)
Large PDFs stored locally

from google import genai
from google.genai import types
import pathlib
import httpx

client = genai.Client()

long_context_pdf_path = "https://www.nasa.gov/wp-content/uploads/static/history/alsj/a17/A17_FlightPlan.pdf" # Replace with the actual URL of your large PDF

# Retrieve the PDF
file_path = pathlib.Path('A17.pdf')
file_path.write_bytes(httpx.get(long_context_pdf_path).content)

# Upload the PDF using the File API
sample_file = client.files.upload(
  file=file_path,
)

prompt="Summarize this document"

response = client.models.generate_content(
  model="gemini-1.5-flash",
  contents=[sample_file, "Summarize this document"])
print(response.text)
You can verify the API successfully stored the uploaded file and get its metadata by calling files.get. Only the name (and by extension, the uri) are unique.


from google import genai
import pathlib

client = genai.Client()

fpath = pathlib.Path('example.txt')
fpath.write_text('hello')

file = client.files.upload('example.txt')

file_info = client.files.get(file.name)
print(file_info.model_dump_json(indent=4))
Multiple PDFs
The Gemini API is capable of processing multiple PDF documents in a single request, as long as the combined size of the documents and the text prompt stays within the model's context window.


from google import genai
import io
import httpx

client = genai.Client()

doc_url_1 = "https://arxiv.org/pdf/2312.11805" # Replace with the URL to your first PDF
doc_url_2 = "https://arxiv.org/pdf/2403.05530" # Replace with the URL to your second PDF

# Retrieve and upload both PDFs using the File API
doc_data_1 = io.BytesIO(httpx.get(doc_url_1).content)
doc_data_2 = io.BytesIO(httpx.get(doc_url_2).content)

sample_pdf_1 = client.files.upload(
  file=doc_data_1,
  config=dict(mime_type='application/pdf')
)
sample_pdf_2 = client.files.upload(
  file=doc_data_2,
  config=dict(mime_type='application/pdf')
)

prompt = "What is the difference between each of the main benchmarks between these two papers? Output these in a table."

response = client.models.generate_content(
  model="gemini-1.5-flash",
  contents=[sample_pdf_1, sample_pdf_2, prompt])
print(response.text)
List files
You can list all files uploaded using the File API and their URIs using files.list.


from google import genai

client = genai.Client()

print("My files:")
for f in client.files.list():
    print("  ", f.name)
Delete files
Files uploaded using the File API are automatically deleted after 2 days. You can also manually delete them using files.delete.


from google import genai
import pathlib

client = genai.Client()

fpath = pathlib.Path('example.txt')
fpath.write_text('hello')

file = client.files.upload('example.txt')

client.files.delete(file.name)
Context caching with PDFs

from google import genai
from google.genai import types
import io
import httpx

client = genai.Client()

long_context_pdf_path = "https://www.nasa.gov/wp-content/uploads/static/history/alsj/a17/A17_FlightPlan.pdf" # Replace with the actual URL of your large PDF

# Retrieve and upload the PDF using the File API
doc_io = io.BytesIO(httpx.get(long_context_pdf_path).content)

document = client.files.upload(
  path=doc_io,
  config=dict(mime_type='application/pdf')
)

# Specify the model name and system instruction for caching
model_name = "gemini-1.5-flash-002" # Ensure this matches the model you intend to use
system_instruction = "You are an expert analyzing transcripts."

# Create a cached content object
cache = client.caches.create(
    model=model_name,
    config=types.CreateCachedContentConfig(
      system_instruction=system_instruction,
      contents=[document], # The document(s) and other content you wish to cache
    )
)

# Display the cache details
print(f'{cache=}')

# Generate content using the cached prompt and document
response = client.models.generate_content(
  model=model_name,
  contents="Please summarize this transcript",
  config=types.GenerateContentConfig(
    cached_content=cache.name
  ))

# (Optional) Print usage metadata for insights into the API call
print(f'{response.usage_metadata=}')

# Print the generated text
print('\n\n', response.text)
List caches
It's not possible to retrieve or view cached content, but you can retrieve cache metadata (name, model, display_name, usage_metadata, create_time, update_time, and expire_time).

To list metadata for all uploaded caches, use CachedContent.list():


from google import genai

client = genai.Client()
for c in client.caches.list():
  print(c)
Update a cache
You can set a new ttl or expire_time for a cache. Changing anything else about the cache isn't supported.

The following example shows how to update the ttl of a cache using CachedContent.update().


from google import genai
from google.genai import types
import datetime

client = genai.Client()

model_name = "models/gemini-1.5-flash-002" 

cache = client.caches.create(
    model=model_name,
    config=types.CreateCachedContentConfig(
      contents=['hello']
    )
)

client.caches.update(
  name = cache.name,
  config=types.UpdateCachedContentConfig(
    ttl=f'{datetime.timedelta(hours=2).total_seconds()}s'
  )
)
Delete a cache
The caching service provides a delete operation for manually removing content from the cache. The following example shows how to delete a cache using CachedContent.delete().


from google import genai
from google.genai import types
import datetime

client = genai.Client()

model_name = "models/gemini-1.5-flash-002" 

cache = client.caches.create(
    model=model_name,
    config=types.CreateCachedContentConfig(
      contents=['hello']
    )
)

client.caches.delete(name = cache.name)